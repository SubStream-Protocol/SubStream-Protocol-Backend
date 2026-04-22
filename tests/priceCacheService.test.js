const { PriceCacheService } = require('../src/services/priceCacheService');

// Mock dependencies
jest.mock('../src/db/appDatabase');
jest.mock('../src/services/sep40OracleService');
jest.mock('../src/services/fallbackPriceService');

describe('PriceCacheService', () => {
  let priceCacheService;
  let mockDatabase;
  let mockOracleService;
  let mockFallbackService;
  let mockConfig;

  beforeEach(() => {
    // Mock database
    mockDatabase = {
      db: {
        prepare: jest.fn()
      }
    };

    // Mock oracle service
    mockOracleService = {
      initialize: jest.fn(),
      fetchCurrentPrices: jest.fn(),
      getStats: jest.fn(),
      getHealthStatus: jest.fn(),
      close: jest.fn()
    };

    // Mock fallback service
    mockFallbackService = {
      getUsdEquivalent: jest.fn(),
      getStats: jest.fn(),
      getHealthStatus: jest.fn()
    };

    mockConfig = {
      oracle: {
        oracleAddress: 'GABC123...',
        supportedAssets: [
          { code: 'XLM', issuer: null },
          { code: 'USDC', issuer: 'GA5ZSEJYB37JRC5AVCY5N7RLO4ZO7XTRHLYTGKM6EZHCKPZY5A3F6BRU' }
        ]
      },
      fallback: {
        enableFallback: true
      },
      syncIntervalMs: 300000, // 5 minutes
      maxAgeMinutes: 60,
      retentionDays: 90
    };

    priceCacheService = new PriceCacheService(mockConfig, {
      database: mockDatabase,
      oracleService: mockOracleService,
      fallbackService: mockFallbackService
    });
  });

  describe('constructor', () => {
    test('should initialize with correct configuration', () => {
      expect(priceCacheService.config).toBe(mockConfig);
      expect(priceCacheService.database).toBe(mockDatabase);
      expect(priceCacheService.oracleService).toBe(mockOracleService);
      expect(priceCacheService.fallbackService).toBe(mockFallbackService);
      expect(priceCacheService.syncIntervalMs).toBe(300000);
      expect(priceCacheService.maxAgeMinutes).toBe(60);
      expect(priceCacheService.enableFallback).toBe(true);
    });

    test('should use default values when not provided', () => {
      const minimalConfig = {};
      const minimalService = new PriceCacheService(minimalConfig, {
        database: mockDatabase
      });

      expect(minimalService.syncIntervalMs).toBe(5 * 60 * 1000);
      expect(minimalService.maxAgeMinutes).toBe(60);
      expect(minimalService.enableFallback).toBe(true);
    });
  });

  describe('initialize', () => {
    test('should initialize all services successfully', async () => {
      // Mock database operations
      const mockStmt = { get: jest.fn().mockReturnValue({ count: 0 }) };
      mockDatabase.db.prepare.mockReturnValue(mockStmt);

      await priceCacheService.initialize();

      expect(mockOracleService.initialize).toHaveBeenCalled();
      expect(priceCacheService.isRunning).toBe(true);
    });

    test('should handle initialization errors', async () => {
      mockOracleService.initialize.mockRejectedValue(new Error('Oracle init failed'));

      await expect(priceCacheService.initialize()).rejects.toThrow('Oracle init failed');
    });
  });

  describe('performSync', () => {
    beforeEach(async () => {
      // Mock metadata initialization
      const mockStmt = { get: jest.fn().mockReturnValue({ count: 1 }) };
      mockDatabase.db.prepare.mockReturnValue(mockStmt);
      
      await priceCacheService.initialize();
    });

    test('should perform successful sync', async () => {
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

      mockOracleService.fetchCurrentPrices.mockResolvedValue(mockPrices);

      // Mock storePrices
      const mockStoreStmt = { run: jest.fn() };
      mockDatabase.db.prepare.mockReturnValue(mockStoreStmt);

      // Mock updateSyncStatus
      const mockStatusStmt = { run: jest.fn() };
      mockDatabase.db.prepare.mockReturnValue(mockStatusStmt);

      // Mock markStalePrices and cleanupOldData
      const mockCleanupStmt = { get: jest.fn().mockReturnValue({ count: 0 }) };
      mockDatabase.db.prepare.mockReturnValue(mockCleanupStmt);

      const result = await priceCacheService.performSync();

      expect(result.success).toBe(true);
      expect(result.pricesFetched).toBe(2);
      expect(result.pricesStored).toBe(2);
      expect(mockOracleService.fetchCurrentPrices).toHaveBeenCalled();
    });

    test('should handle sync failures', async () => {
      mockOracleService.fetchCurrentPrices.mockRejectedValue(new Error('Network error'));

      await expect(priceCacheService.performSync()).rejects.toThrow('Network error');

      expect(priceCacheService.stats.syncsFailed).toBe(1);
    });
  });

  describe('findClosestPrice', () => {
    test('should find closest price to timestamp', async () => {
      const mockPrice = {
        price: 0.1234,
        price_timestamp: new Date('2023-01-01T12:00:00Z'),
        confidence_score: 1.0,
        time_diff_minutes: 5
      };

      const mockStmt = { get: jest.fn().mockReturnValue(mockPrice) };
      mockDatabase.db.prepare.mockReturnValue(mockStmt);

      const result = await priceCacheService.findClosestPrice(
        'XLM',
        null,
        new Date('2023-01-01T12:05:00Z')
      );

      expect(result).toEqual(mockPrice);
      expect(mockDatabase.db.prepare).toHaveBeenCalledWith(
        expect.stringContaining('find_closest_price'),
        'XLM',
        null,
        expect.any(Date),
        60
      );
    });

    test('should return null when no price found', async () => {
      const mockStmt = { get: jest.fn().mockReturnValue(null) };
      mockDatabase.db.prepare.mockReturnValue(mockStmt);

      const result = await priceCacheService.findClosestPrice(
        'XLM',
        null,
        new Date('2023-01-01T12:05:00Z')
      );

      expect(result).toBeNull();
    });
  });

  describe('getUsdEquivalent', () => {
    test('should calculate USD equivalent from cache', async () => {
      const mockPrice = {
        price: 0.1234,
        price_timestamp: new Date('2023-01-01T12:00:00Z'),
        confidence_score: 1.0
      };

      // Mock findClosestPrice
      const mockStmt = { get: jest.fn().mockReturnValue(mockPrice) };
      mockDatabase.db.prepare.mockReturnValue(mockStmt);

      const result = await priceCacheService.getUsdEquivalent(
        'XLM',
        null,
        100,
        new Date('2023-01-01T12:05:00Z')
      );

      expect(result.usdEquivalent).toBe(12.34);
      expect(result.priceTimestamp).toBe(mockPrice.price_timestamp);
      expect(result.confidence).toBe(1.0);
      expect(result.backfillRequired).toBe(false);
      expect(result.source).toBe('cache');
    });

    test('should use fallback when cache miss', async () => {
      // Mock cache miss
      const mockStmt = { get: jest.fn().mockReturnValue(null) };
      mockDatabase.db.prepare.mockReturnValue(mockStmt);

      // Mock fallback service
      const fallbackResult = {
        usdEquivalent: 12.34,
        priceTimestamp: new Date('2023-01-01T12:00:00Z'),
        confidence: 0.8,
        backfillRequired: true,
        source: 'fallback-coingecko'
      };
      mockFallbackService.getUsdEquivalent.mockResolvedValue(fallbackResult);

      const result = await priceCacheService.getUsdEquivalent(
        'XLM',
        null,
        100,
        new Date('2023-01-01T12:05:00Z')
      );

      expect(result).toEqual(fallbackResult);
      expect(mockFallbackService.getUsdEquivalent).toHaveBeenCalledWith(
        'XLM',
        null,
        100,
        expect.any(Date)
      );
    });

    test('should return null when no price available', async () => {
      // Mock cache miss
      const mockStmt = { get: jest.fn().mockReturnValue(null) };
      mockDatabase.db.prepare.mockReturnValue(mockStmt);

      // Mock fallback failure
      mockFallbackService.getUsdEquivalent.mockResolvedValue({
        usdEquivalent: null,
        priceTimestamp: null,
        confidence: null,
        backfillRequired: true,
        source: 'fallback-failed'
      });

      const result = await priceCacheService.getUsdEquivalent(
        'XLM',
        null,
        100,
        new Date('2023-01-01T12:05:00Z')
      );

      expect(result.usdEquivalent).toBeNull();
      expect(result.backfillRequired).toBe(true);
      expect(result.source).toBe('fallback-failed');
    });

    test('should handle errors gracefully', async () => {
      // Mock database error
      mockDatabase.db.prepare.mockImplementation(() => {
        throw new Error('Database error');
      });

      const result = await priceCacheService.getUsdEquivalent(
        'XLM',
        null,
        100,
        new Date('2023-01-01T12:05:00Z')
      );

      expect(result.usdEquivalent).toBeNull();
      expect(result.backfillRequired).toBe(true);
      expect(result.source).toBe('error');
    });
  });

  describe('storePrices', () => {
    test('should store prices successfully', async () => {
      const prices = [
        {
          assetCode: 'XLM',
          assetIssuer: null,
          price: 0.1234,
          timestamp: new Date(),
          decimals: 7,
          confidence: 1.0
        }
      ];

      const mockStmt = { run: jest.fn() };
      mockDatabase.db.prepare.mockReturnValue(mockStmt);

      const storedCount = await priceCacheService.storePrices(prices);

      expect(storedCount).toBe(1);
      expect(mockStmt.run).toHaveBeenCalledWith(
        'XLM',
        null,
        'native',
        'USD',
        0.1234,
        expect.any(Date),
        null,
        mockConfig.oracle.oracleAddress,
        expect.any(Date),
        7,
        expect.any(String),
        1.0,
        false,
        false
      );
    });

    test('should handle storage errors', async () => {
      const prices = [
        {
          assetCode: 'XLM',
          assetIssuer: null,
          price: 0.1234,
          timestamp: new Date(),
          decimals: 7,
          confidence: 1.0
        }
      ];

      mockDatabase.db.prepare.mockImplementation(() => {
        throw new Error('Storage error');
      });

      await expect(priceCacheService.storePrices(prices)).rejects.toThrow('Storage error');
    });
  });

  describe('markStalePrices', () => {
    test('should mark stale prices', async () => {
      const mockStmt = { get: jest.fn().mockReturnValue({ count: 5 }) };
      mockDatabase.db.prepare.mockReturnValue(mockStmt);

      const result = await priceCacheService.markStalePrices();

      expect(result).toBe(5);
      expect(mockDatabase.db.prepare).toHaveBeenCalledWith(
        expect.stringContaining('mark_stale_prices')
      );
    });
  });

  describe('cleanupOldData', () => {
    test('should clean up old data', async () => {
      const mockStmt = { get: jest.fn().mockReturnValue({ count: 10 }) };
      mockDatabase.db.prepare.mockReturnValue(mockStmt);

      const result = await priceCacheService.cleanupOldData();

      expect(result).toBe(10);
      expect(mockDatabase.db.prepare).toHaveBeenCalledWith(
        expect.stringContaining('cleanup_old_price_data')
      );
    });
  });

  describe('getStats', () => {
    test('should return statistics', async () => {
      // Mock database queries
      const mockSummaryStmt = { all: jest.fn().mockReturnValue([]) };
      const mockHealthStmt = { get: jest.fn().mockReturnValue({
        health_status: 'healthy'
      }) };
      mockDatabase.db.prepare
        .mockReturnValueOnce(mockSummaryStmt)
        .mockReturnValueOnce(mockHealthStmt);

      const stats = await priceCacheService.getStats();

      expect(stats).toHaveProperty('syncsCompleted');
      expect(stats).toHaveProperty('uptime');
      expect(stats).toHaveProperty('database');
      expect(stats).toHaveProperty('oracle');
      expect(stats.isRunning).toBeDefined();
    });
  });

  describe('getHealthStatus', () => {
    test('should return healthy status', async () => {
      mockOracleService.getHealthStatus.mockResolvedValue({
        healthy: true,
        responseTime: 150
      });

      // Mock stats
      const mockSummaryStmt = { all: jest.fn().mockReturnValue([]) };
      const mockHealthStmt = { get: jest.fn().mockReturnValue({
        health_status: 'healthy'
      }) };
      mockDatabase.db.prepare
        .mockReturnValueOnce(mockSummaryStmt)
        .mockReturnValueOnce(mockHealthStmt);

      const health = await priceCacheService.getHealthStatus();

      expect(health.healthy).toBe(true);
      expect(health.oracle).toBeDefined();
    });

    test('should return unhealthy status on oracle failure', async () => {
      mockOracleService.getHealthStatus.mockResolvedValue({
        healthy: false,
        error: 'Oracle unavailable'
      });

      const health = await priceCacheService.getHealthStatus();

      expect(health.healthy).toBe(false);
    });
  });

  describe('close', () => {
    test('should close all services', async () => {
      await priceCacheService.close();

      expect(priceCacheService.isRunning).toBe(false);
      expect(mockOracleService.close).toHaveBeenCalled();
    });
  });
});
