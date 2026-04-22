const { Sep40OracleService } = require('../src/services/sep40OracleService');

// Mock dependencies
jest.mock('@stellar/stellar-sdk');

describe('Sep40OracleService', () => {
  let oracleService;
  let mockServer;
  let mockConfig;

  beforeEach(() => {
    // Mock Stellar SDK Server
    mockServer = {
      loadAccount: jest.fn(),
      simulateTransaction: jest.fn()
    };

    const { Server } = require('@stellar/stellar-sdk');
    Server.mockImplementation(() => mockServer);

    mockConfig = {
      oracleAddress: 'GABC123...',
      horizonUrl: 'https://horizon.stellar.org',
      network: 'public',
      maxRetries: 3,
      baseDelay: 1000,
      maxDelay: 30000,
      timeout: 10000,
      supportedAssets: [
        { code: 'XLM', issuer: null },
        { code: 'USDC', issuer: 'GA5ZSEJYB37JRC5AVCY5N7RLO4ZO7XTRHLYTGKM6EZHCKPZY5A3F6BRU' }
      ]
    };

    oracleService = new Sep40OracleService(mockConfig);
  });

  describe('constructor', () => {
    test('should initialize with correct configuration', () => {
      expect(oracleService.config).toBe(mockConfig);
      expect(oracleService.oracleAddress).toBe(mockConfig.oracleAddress);
      expect(oracleService.maxRetries).toBe(3);
      expect(oracleService.supportedAssets).toEqual(mockConfig.supportedAssets);
    });

    test('should use default values when not provided', () => {
      const minimalConfig = { oracleAddress: 'GABC123' };
      const minimalService = new Sep40OracleService(minimalConfig);

      expect(minimalService.maxRetries).toBe(5);
      expect(minimalService.baseDelay).toBe(1000);
      expect(minimalService.maxDelay).toBe(30000);
    });
  });

  describe('initialize', () => {
    test('should initialize successfully', async () => {
      // Mock successful account load
      mockServer.loadAccount.mockResolvedValue({
        sequence: '12345'
      });

      await oracleService.initialize();

      expect(mockServer.loadAccount).toHaveBeenCalledWith(mockConfig.oracleAddress);
    });

    test('should throw error when oracle address is missing', async () => {
      const invalidConfig = { ...mockConfig, oracleAddress: null };
      const invalidService = new Sep40OracleService(invalidConfig);

      await expect(invalidService.initialize()).rejects.toThrow('Oracle address is required');
    });

    test('should throw error when oracle account not found', async () => {
      mockServer.loadAccount.mockResolvedValue(null);

      await expect(oracleService.initialize()).rejects.toThrow('Oracle account not found');
    });

    test('should handle network errors', async () => {
      mockServer.loadAccount.mockRejectedValue(new Error('Network error'));

      await expect(oracleService.initialize()).rejects.toThrow('Network error');
    });
  });

  describe('testOracleConnectivity', () => {
    test('should test connectivity successfully', async () => {
      mockServer.loadAccount.mockResolvedValue({
        sequence: '12345'
      });

      const result = await oracleService.testOracleConnectivity();

      expect(result).toBe(true);
      expect(mockServer.loadAccount).toHaveBeenCalledWith(mockConfig.oracleAddress);
    });

    test('should handle connectivity test failure', async () => {
      mockServer.loadAccount.mockRejectedValue(new Error('Connection failed'));

      await expect(oracleService.testOracleConnectivity()).rejects.toThrow('Connection failed');
    });
  });

  describe('fetchCurrentPrices', () => {
    beforeEach(async () => {
      mockServer.loadAccount.mockResolvedValue({
        sequence: '12345'
      });
      await oracleService.initialize();
    });

    test('should fetch prices for all supported assets', async () => {
      const mockPrices = [
        {
          assetCode: 'XLM',
          assetIssuer: null,
          price: 0.1234,
          timestamp: new Date(),
          decimals: 7,
          confidence: 1.0
        },
        {
          assetCode: 'USDC',
          assetIssuer: 'GA5ZSEJYB37JRC5AVCY5N7RLO4ZO7XTRHLYTGKM6EZHCKPZY5A3F6BRU',
          price: 1.0,
          timestamp: new Date(),
          decimals: 7,
          confidence: 1.0
        }
      ];

      // Mock fetchAssetPrice for each asset
      jest.spyOn(oracleService, 'fetchAssetPrice')
        .mockResolvedValueOnce(mockPrices[0])
        .mockResolvedValueOnce(mockPrices[1]);

      const result = await oracleService.fetchCurrentPrices();

      expect(result).toEqual(mockPrices);
      expect(result).toHaveLength(2);
      expect(oracleService.fetchAssetPrice).toHaveBeenCalledTimes(2);
    });

    test('should handle fetch failures', async () => {
      jest.spyOn(oracleService, 'fetchAssetPrice')
        .mockRejectedValueOnce(new Error('Asset not found'))
        .mockRejectedValueOnce(new Error('Asset not found'));

      await expect(oracleService.fetchCurrentPrices()).rejects.toThrow('Asset not found');

      expect(oracleService.stats.requestsFailed).toBe(1);
    });
  });

  describe('fetchAssetPrice', () => {
    beforeEach(async () => {
      mockServer.loadAccount.mockResolvedValue({
        sequence: '12345'
      });
      await oracleService.initialize();
    });

    test('should fetch price for XLM successfully', async () => {
      const asset = { code: 'XLM', issuer: null };
      const mockTransaction = {
        build: jest.fn().mockReturnValue('mock-transaction')
      };

      // Mock buildOracleQueryTransaction
      jest.spyOn(oracleService, 'buildOracleQueryTransaction')
        .mockResolvedValue(mockTransaction);

      // Mock submitOracleQuery
      jest.spyOn(oracleService, 'submitOracleQuery')
        .mockResolvedValue({
          status: 'SUCCESS',
          result: {
            retval: 'base64-encoded-xdr'
          }
        });

      // Mock parsePriceFromResult
      const expectedPrice = {
        assetCode: 'XLM',
        assetIssuer: null,
        price: 0.1234,
        timestamp: new Date(),
        decimals: 7,
        confidence: 1.0
      };
      jest.spyOn(oracleService, 'parsePriceFromResult')
        .mockReturnValue(expectedPrice);

      const result = await oracleService.fetchAssetPrice(asset);

      expect(result).toEqual(expectedPrice);
      expect(oracleService.buildOracleQueryTransaction).toHaveBeenCalled();
      expect(oracleService.submitOracleQuery).toHaveBeenCalledWith(mockTransaction);
      expect(oracleService.parsePriceFromResult).toHaveBeenCalled();
    });

    test('should retry on failure', async () => {
      const asset = { code: 'XLM', issuer: null };

      jest.spyOn(oracleService, 'buildOracleQueryTransaction')
        .mockRejectedValue(new Error('Network error'));

      // Should retry maxRetries times
      await expect(oracleService.fetchAssetPrice(asset)).rejects.toThrow('Network error');

      expect(oracleService.buildOracleQueryTransaction).toHaveBeenCalledTimes(3);
    });

    test('should handle non-native assets', async () => {
      const asset = { code: 'USDC', issuer: 'GA5ZSEJYB37JRC5AVCY5N7RLO4ZO7XTRHLYTGKM6EZHCKPZY5A3F6BRU' };

      const mockTransaction = {
        build: jest.fn().mockReturnValue('mock-transaction')
      };

      jest.spyOn(oracleService, 'buildOracleQueryTransaction')
        .mockResolvedValue(mockTransaction);

      jest.spyOn(oracleService, 'submitOracleQuery')
        .mockResolvedValue({
          status: 'SUCCESS',
          result: {
            retval: 'base64-encoded-xdr'
          }
        });

      const expectedPrice = {
        assetCode: 'USDC',
        assetIssuer: 'GA5ZSEJYB37JRC5AVCY5N7RLO4ZO7XTRHLYTGKM6EZHCKPZY5A3F6BRU',
        price: 1.0,
        timestamp: new Date(),
        decimals: 7,
        confidence: 1.0
      };

      jest.spyOn(oracleService, 'parsePriceFromResult')
        .mockReturnValue(expectedPrice);

      const result = await oracleService.fetchAssetPrice(asset);

      expect(result).toEqual(expectedPrice);
    });
  });

  describe('buildOracleQueryTransaction', () => {
    test('should build transaction for native asset', async () => {
      const asset = { code: 'XLM', issuer: null };

      // Mock account loading
      mockServer.loadAccount.mockResolvedValue({
        sequence: '12345'
      });

      // Mock TransactionBuilder
      const mockTransaction = {
        addOperation: jest.fn().mockReturnThis(),
        setTimeout: jest.fn().mockReturnThis(),
        build: jest.fn().mockReturnValue('built-transaction')
      };

      const { TransactionBuilder, Operation, Networks, Asset } = require('@stellar/stellar-sdk');
      TransactionBuilder.mockReturnValue(mockTransaction);

      const result = await oracleService.buildOracleQueryTransaction(asset);

      expect(result).toBe('built-transaction');
      expect(TransactionBuilder).toHaveBeenCalled();
      expect(mockTransaction.addOperation).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'invokeContractFunction',
          contract: mockConfig.oracleAddress,
          function: 'get_price'
        })
      );
    });

    test('should build transaction for issued asset', async () => {
      const asset = { code: 'USDC', issuer: 'GA5ZSEJYB37JRC5AVCY5N7RLO4ZO7XTRHLYTGKM6EZHCKPZY5A3F6BRU' };

      mockServer.loadAccount.mockResolvedValue({
        sequence: '12345'
      });

      const mockTransaction = {
        addOperation: jest.fn().mockReturnThis(),
        setTimeout: jest.fn().mockReturnThis(),
        build: jest.fn().mockReturnValue('built-transaction')
      };

      const { TransactionBuilder, Operation, Networks, Asset } = require('@stellar/stellar-sdk');
      TransactionBuilder.mockReturnValue(mockTransaction);

      const result = await oracleService.buildOracleQueryTransaction(asset);

      expect(result).toBe('built-transaction');
    });

    test('should throw error when issuer is missing for non-native asset', async () => {
      const asset = { code: 'USDC', issuer: null };

      await expect(oracleService.buildOracleQueryTransaction(asset))
        .rejects.toThrow('Issuer required for asset USDC');
    });
  });

  describe('submitOracleQuery', () => {
    test('should submit transaction successfully', async () => {
      const transaction = 'mock-transaction';

      mockServer.simulateTransaction.mockResolvedValue({
        status: 'SUCCESS',
        result: {
          retval: 'base64-encoded-xdr'
        }
      });

      const submitResult = await oracleService.submitOracleQuery(transaction);

      expect(submitResult).toEqual({
        status: 'SUCCESS',
        result: {
          retval: 'base64-encoded-xdr'
        }
      });
      expect(mockServer.simulateTransaction).toHaveBeenCalledWith(transaction);
    });

    test('should handle simulation failure', async () => {
      const transaction = 'mock-transaction';

      mockServer.simulateTransaction.mockResolvedValue({
        status: 'FAILED'
      });

      await expect(oracleService.submitOracleQuery(transaction))
        .rejects.toThrow('Oracle query simulation failed: FAILED');
    });

    test('should handle network errors', async () => {
      const transaction = 'mock-transaction';

      mockServer.simulateTransaction.mockRejectedValue(new Error('Network error'));

      await expect(oracleService.submitOracleQuery(transaction))
        .rejects.toThrow('Network error');
    });
  });

  describe('parsePriceFromResult', () => {
    test('should parse price from result with retval', () => {
      const result = {
        result: {
          retval: 'base64-encoded-xdr'
        }
      };

      const asset = { code: 'XLM', issuer: null };

      // Mock XDR parsing
      const mockScVal = {
        switch: jest.fn().mockReturnValue({ name: 'instance' })
      };
      const mockXdr = require('@stellar/stellar-sdk').xdr;
      mockXdr.ScVal.fromXDR.mockReturnValue(mockScVal);

      // Mock parseScValToPrice
      const expectedPriceData = {
        price: 0.1234,
        timestamp: new Date(),
        decimals: 7
      };
      jest.spyOn(oracleService, 'parseScValToPrice')
        .mockReturnValue(expectedPriceData);

      const parseResult = oracleService.parsePriceFromResult(result, asset);

      expect(parseResult).toEqual({
        assetCode: 'XLM',
        assetIssuer: null,
        price: 0.1234,
        timestamp: expectedPriceData.timestamp,
        decimals: 7,
        confidence: 1.0
      });
    });

    test('should handle missing price data', () => {
      const result = {
        result: {}
      };

      const asset = { code: 'XLM', issuer: null };

      expect(() => oracleService.parsePriceFromResult(result, asset))
        .toThrow('No price data in oracle result');
    });
  });

  describe('parseScValToPrice', () => {
    test('should parse instance ScVal to price data', () => {
      const mockScVal = {
        switch: jest.fn().mockReturnValue({ name: 'instance' }),
        instance: jest.fn().mockReturnValue({
          _value: [
            { switch: jest.fn().mockReturnValue({ name: 'symbol' }), sym: jest.fn().mockReturnValue('price') },
            { val: jest.fn().mockReturnValue({ u128: jest.fn().mockReturnValue(BigInt(1234)) }) },
            { switch: jest.fn().mockReturnValue({ name: 'symbol' }), sym: jest.fn().mockReturnValue('timestamp') },
            { val: jest.fn().mockReturnValue({ u64: jest.fn().mockReturnValue(BigInt(1640995200)) }) },
            { switch: jest.fn().mockReturnValue({ name: 'symbol' }), sym: jest.fn().mockReturnValue('decimals') },
            { val: jest.fn().mockReturnValue({ u32: jest.fn().mockReturnValue(7) }) }
          ]
        })
      };

      const result = oracleService.parseScValToPrice(mockScVal);

      expect(result).toEqual({
        price: 1234,
        timestamp: new Date(1640995200 * 1000),
        decimals: 7
      });
    });

    test('should handle unexpected format', () => {
      const mockScVal = {
        switch: jest.fn().mockReturnValue({ name: 'other' })
      };

      expect(() => oracleService.parseScValToPrice(mockScVal))
        .toThrow('Unexpected oracle response format');
    });

    test('should handle missing price field', () => {
      const mockScVal = {
        switch: jest.fn().mockReturnValue({ name: 'instance' }),
        instance: jest.fn().mockReturnValue({
          _value: [
            { switch: jest.fn().mockReturnValue({ name: 'symbol' }), sym: jest.fn().mockReturnValue('other') },
            { val: jest.fn().mockReturnValue({ u128: jest.fn().mockReturnValue(BigInt(1234)) }) }
          ]
        })
      };

      expect(() => oracleService.parseScValToPrice(mockScVal))
        .toThrow('Price not found in oracle response');
    });
  });

  describe('parseNumericFromScVal', () => {
    test('should parse i128 ScVal', () => {
      const mockScVal = {
        switch: jest.fn().mockReturnValue({ name: 'i128' }),
        i128: jest.fn().mockReturnValue(BigInt(1234))
      };

      const result = oracleService.parseNumericFromScVal(mockScVal);

      expect(result).toBe(1234);
    });

    test('should parse u128 ScVal', () => {
      const mockScVal = {
        switch: jest.fn().mockReturnValue({ name: 'u128' }),
        u128: jest.fn().mockReturnValue(BigInt(1234))
      };

      const result = oracleService.parseNumericFromScVal(mockScVal);

      expect(result).toBe(1234);
    });

    test('should handle unsupported type', () => {
      const mockScVal = {
        switch: jest.fn().mockReturnValue({ name: 'unsupported' })
      };

      expect(() => oracleService.parseNumericFromScVal(mockScVal))
        .toThrow('Unsupported numeric type in oracle response');
    });
  });

  describe('parseTimestampFromScVal', () => {
    test('should parse u64 timestamp', () => {
      const mockScVal = {
        switch: jest.fn().mockReturnValue({ name: 'u64' }),
        u64: jest.fn().mockReturnValue(BigInt(1640995200))
      };

      const result = oracleService.parseTimestampFromScVal(mockScVal);

      expect(result).toEqual(new Date(1640995200 * 1000));
    });

    test('should return current date for unsupported type', () => {
      const mockScVal = {
        switch: jest.fn().mockReturnValue({ name: 'unsupported' })
      };

      const result = oracleService.parseTimestampFromScVal(mockScVal);

      expect(result).toBeInstanceOf(Date);
    });
  });

  describe('parseIntegerFromScVal', () => {
    test('should parse u32 decimals', () => {
      const mockScVal = {
        switch: jest.fn().mockReturnValue({ name: 'u32' }),
        u32: jest.fn().mockReturnValue(7)
      };

      const result = oracleService.parseIntegerFromScVal(mockScVal);

      expect(result).toBe(7);
    });

    test('should return default for unsupported type', () => {
      const mockScVal = {
        switch: jest.fn().mockReturnValue({ name: 'unsupported' })
      };

      const result = oracleService.parseIntegerFromScVal(mockScVal);

      expect(result).toBe(7); // Default decimals
    });
  });

  describe('getStats', () => {
    test('should return statistics', () => {
      oracleService.stats.requestsMade = 10;
      oracleService.stats.requestsSuccessful = 8;
      oracleService.stats.requestsFailed = 2;
      oracleService.stats.pricesFetched = 15;
      oracleService.stats.averageResponseTime = 250;

      const stats = oracleService.getStats();

      expect(stats.requestsMade).toBe(10);
      expect(stats.requestsSuccessful).toBe(8);
      expect(stats.requestsFailed).toBe(2);
      expect(stats.pricesFetched).toBe(15);
      expect(stats.averageResponseTime).toBe(250);
      expect(stats.successRate).toBe(80);
      expect(stats.supportedAssetsCount).toBe(2);
      expect(stats.network).toBe('public');
      expect(stats.oracleAddress).toBe(mockConfig.oracleAddress);
    });
  });

  describe('getHealthStatus', () => {
    test('should return healthy status', async () => {
      mockServer.loadAccount.mockResolvedValue({
        sequence: '12345'
      });

      oracleService.stats.requestsMade = 10;
      oracleService.stats.requestsSuccessful = 9;

      const health = await oracleService.getHealthStatus();

      expect(health.healthy).toBe(true);
      expect(health.responseTime).toBeDefined();
      expect(health.stats).toBeDefined();
    });

    test('should return unhealthy status on failure', async () => {
      mockServer.loadAccount.mockRejectedValue(new Error('Connection failed'));

      const health = await oracleService.getHealthStatus();

      expect(health.healthy).toBe(false);
      expect(health.error).toBe('Connection failed');
    });
  });

  describe('calculateBackoffDelay', () => {
    test('should calculate exponential backoff with jitter', () => {
      const delay1 = oracleService.calculateBackoffDelay(0);
      const delay2 = oracleService.calculateBackoffDelay(1);
      const delay3 = oracleService.calculateBackoffDelay(2);

      expect(delay1).toBeGreaterThanOrEqual(1000);
      expect(delay1).toBeLessThan(2000); // baseDelay + jitter

      expect(delay2).toBeGreaterThanOrEqual(2000);
      expect(delay2).toBeLessThan(3000); // baseDelay * 2 + jitter

      expect(delay3).toBeGreaterThanOrEqual(4000);
      expect(delay3).toBeLessThan(5000); // baseDelay * 4 + jitter
    });

    test('should cap delay at maxDelay', () => {
      const delay = oracleService.calculateBackoffDelay(10); // Very high retry count

      expect(delay).toBeLessThanOrEqual(30000); // maxDelay
    });
  });

  describe('updateAverageResponseTime', () => {
    test('should update average response time', () => {
      oracleService.updateAverageResponseTime(100);
      expect(oracleService.stats.averageResponseTime).toBe(100);

      oracleService.updateAverageResponseTime(200);
      expect(oracleService.stats.averageResponseTime).toBeCloseTo(110, 0); // Weighted average

      oracleService.updateAverageResponseTime(300);
      expect(oracleService.stats.averageResponseTime).toBeCloseTo(119, 0); // Weighted average
    });
  });
});
