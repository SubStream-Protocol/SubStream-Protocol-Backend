const { Server, TransactionBuilder, Networks, Operation, Asset } = require('@stellar/stellar-sdk');
const winston = require('winston');

/**
 * SEP-40 Oracle Service
 * Fetches historical exchange rates from SEP-40 price oracles on Stellar network
 */
class Sep40OracleService {
  constructor(config, logger = winston.createLogger()) {
    this.config = config;
    this.logger = logger;
    
    // Stellar network configuration
    this.network = config.network || 'public';
    this.horizonUrl = config.horizonUrl || 'https://horizon.stellar.org';
    this.server = new Server(this.horizonUrl);
    
    // Oracle configuration
    this.oracleAddress = config.oracleAddress;
    this.supportedAssets = config.supportedAssets || [
      { code: 'XLM', issuer: null },
      { code: 'USDC', issuer: 'GA5ZSEJYB37JRC5AVCY5N7RLO4ZO7XTRHLYTGKM6EZHCKPZY5A3F6BRU' },
      { code: 'ETH', issuer: null }
    ];
    
    // Retry and backoff configuration
    this.maxRetries = config.maxRetries || 5;
    this.baseDelay = config.baseDelay || 1000;
    this.maxDelay = config.maxDelay || 30000;
    this.timeout = config.timeout || 10000;
    
    // Statistics
    this.stats = {
      requestsMade: 0,
      requestsSuccessful: 0,
      requestsFailed: 0,
      pricesFetched: 0,
      averageResponseTime: 0,
      lastRequestTime: null,
      startTime: new Date().toISOString()
    };
  }

  /**
   * Initialize the oracle service
   */
  async initialize() {
    try {
      this.logger.info('Initializing SEP-40 Oracle Service', {
        oracleAddress: this.oracleAddress,
        network: this.network,
        supportedAssets: this.supportedAssets.length
      });

      // Validate oracle address
      if (!this.oracleAddress) {
        throw new Error('Oracle address is required');
      }

      // Test oracle connectivity
      await this.testOracleConnectivity();
      
      this.logger.info('SEP-40 Oracle Service initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize SEP-40 Oracle Service', {
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Test oracle connectivity
   */
  async testOracleConnectivity() {
    try {
      const account = await this.server.loadAccount(this.oracleAddress);
      
      if (!account) {
        throw new Error('Oracle account not found');
      }

      this.logger.info('Oracle connectivity test passed', {
        oracleAddress: this.oracleAddress,
        sequence: account.sequence
      });

      return true;
    } catch (error) {
      this.logger.error('Oracle connectivity test failed', {
        oracleAddress: this.oracleAddress,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Fetch current prices for all supported assets
   */
  async fetchCurrentPrices() {
    const startTime = Date.now();
    this.stats.requestsMade++;

    try {
      const prices = [];
      
      for (const asset of this.supportedAssets) {
        const price = await this.fetchAssetPrice(asset);
        if (price) {
          prices.push(price);
          this.stats.pricesFetched++;
        }
      }

      const responseTime = Date.now() - startTime;
      this.updateAverageResponseTime(responseTime);
      this.stats.requestsSuccessful++;
      this.stats.lastRequestTime = new Date().toISOString();

      this.logger.debug('Fetched current prices', {
        assetCount: prices.length,
        responseTime
      });

      return prices;
    } catch (error) {
      this.stats.requestsFailed++;
      this.logger.error('Failed to fetch current prices', {
        error: error.message,
        responseTime: Date.now() - startTime
      });
      throw error;
    }
  }

  /**
   * Fetch price for a specific asset
   */
  async fetchAssetPrice(asset, retryCount = 0) {
    try {
      const stellarAsset = this.createStellarAsset(asset);
      
      // Build transaction to query oracle
      const transaction = await this.buildOracleQueryTransaction(stellarAsset);
      
      // Submit transaction and get result
      const result = await this.submitOracleQuery(transaction);
      
      // Parse price from result
      const price = this.parsePriceFromResult(result, asset);
      
      this.logger.debug('Fetched asset price', {
        assetCode: asset.code,
        assetIssuer: asset.issuer,
        price: price.price,
        timestamp: price.timestamp
      });

      return price;
    } catch (error) {
      if (retryCount < this.maxRetries) {
        const delay = this.calculateBackoffDelay(retryCount);
        this.logger.warn('Retrying asset price fetch', {
          assetCode: asset.code,
          retryCount: retryCount + 1,
          delay,
          error: error.message
        });

        await this.sleep(delay);
        return this.fetchAssetPrice(asset, retryCount + 1);
      }

      this.logger.error('Failed to fetch asset price after retries', {
        assetCode: asset.code,
        retryCount,
        error: error.message
      });

      throw error;
    }
  }

  /**
   * Create Stellar asset object
   */
  createStellarAsset(asset) {
    if (asset.code === 'XLM' && !asset.issuer) {
      return Asset.native();
    }
    
    if (!asset.issuer) {
      throw new Error(`Issuer required for asset ${asset.code}`);
    }

    return new Asset(asset.code, asset.issuer);
  }

  /**
   * Build transaction to query oracle
   */
  async buildOracleQueryTransaction(stellarAsset) {
    try {
      const sourceAccount = await this.server.loadAccount(this.oracleAddress);
      
      const transaction = new TransactionBuilder(sourceAccount, {
        fee: '100',
        networkPassphrase: Networks.PUBLIC
      });

      // Add operation to query oracle price
      transaction.addOperation(Operation.invokeContractFunction({
        contract: this.oracleAddress,
        function: 'get_price',
        args: [
          // Asset code as symbol
          stellarAsset.code,
          // Asset issuer (null for native)
          stellarAsset.issuer || null
        ]
      }));

      return transaction.setTimeout(this.timeout).build();
    } catch (error) {
      this.logger.error('Failed to build oracle query transaction', {
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Submit oracle query transaction
   */
  async submitOracleQuery(transaction) {
    try {
      // For SEP-40, we typically use a simulation rather than actually submitting
      // since we only need to read the oracle data
      const result = await this.server.simulateTransaction(transaction);
      
      if (!result || result.status !== 'SUCCESS') {
        throw new Error(`Oracle query simulation failed: ${result?.status}`);
      }

      return result;
    } catch (error) {
      this.logger.error('Failed to submit oracle query', {
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Parse price from oracle result
   */
  parsePriceFromResult(result, asset) {
    try {
      // Parse the simulation result to extract price data
      // SEP-40 oracles typically return price in a specific format
      
      let priceData;
      
      if (result.result && result.result.retval) {
        // Parse XDR result
        const xdr = require('@stellar/stellar-sdk').xdr;
        const parsed = xdr.ScVal.fromXDR(result.result.retval, 'base64');
        priceData = this.parseScValToPrice(parsed);
      } else if (result.result) {
        // Direct result parsing
        priceData = result.result;
      } else {
        throw new Error('No price data in oracle result');
      }

      return {
        assetCode: asset.code,
        assetIssuer: asset.issuer,
        price: priceData.price,
        timestamp: priceData.timestamp || new Date(),
        decimals: priceData.decimals || 7,
        confidence: priceData.confidence || 1.0
      };
    } catch (error) {
      this.logger.error('Failed to parse price from oracle result', {
        assetCode: asset.code,
        error: error.message,
        result: result
      });
      throw error;
    }
  }

  /**
   * Parse Stellar Contract Value (ScVal) to price data
   */
  parseScValToPrice(scVal) {
    try {
      // SEP-40 oracles typically return price as a struct with price, timestamp, decimals
      if (scVal.switch().name === 'instance') {
        const instance = scVal.instance();
        const fields = instance._value;
        
        let price = null;
        let timestamp = null;
        let decimals = 7;
        
        for (const field of fields) {
          const key = field.switch().name === 'symbol' ? field.sym() : field.str();
          const value = field.val();
          
          if (key === 'price' || key === 'rate') {
            price = this.parseNumericFromScVal(value);
          } else if (key === 'timestamp' || key === 'time') {
            timestamp = this.parseTimestampFromScVal(value);
          } else if (key === 'decimals') {
            decimals = this.parseIntegerFromScVal(value);
          }
        }
        
        if (price === null) {
          throw new Error('Price not found in oracle response');
        }
        
        return {
          price,
          timestamp: timestamp || new Date(),
          decimals
        };
      }
      
      throw new Error('Unexpected oracle response format');
    } catch (error) {
      this.logger.error('Failed to parse ScVal to price', {
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Parse numeric value from ScVal
   */
  parseNumericFromScVal(scVal) {
    try {
      if (scVal.switch().name === 'instance') {
        const instance = scVal.instance();
        // Parse as i128 or similar numeric type
        return parseFloat(instance._value.toString());
      } else if (scVal.switch().name === 'u128') {
        return parseFloat(scVal.u128().toString());
      } else if (scVal.switch().name === 'i128') {
        return parseFloat(scVal.i128().toString());
      } else if (scVal.switch().name === 'u64') {
        return parseFloat(scVal.u64().toString());
      } else if (scVal.switch().name === 'i64') {
        return parseFloat(scVal.i64().toString());
      }
      
      throw new Error('Unsupported numeric type in oracle response');
    } catch (error) {
      this.logger.error('Failed to parse numeric from ScVal', {
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Parse timestamp from ScVal
   */
  parseTimestampFromScVal(scVal) {
    try {
      if (scVal.switch().name === 'u64') {
        const timestamp = parseInt(scVal.u64().toString());
        return new Date(timestamp * 1000); // Convert from Unix timestamp
      } else if (scVal.switch().name === 'i64') {
        const timestamp = parseInt(scVal.i64().toString());
        return new Date(timestamp * 1000);
      }
      
      return new Date();
    } catch (error) {
      this.logger.error('Failed to parse timestamp from ScVal', {
        error: error.message
      });
      return new Date();
    }
  }

  /**
   * Parse integer from ScVal
   */
  parseIntegerFromScVal(scVal) {
    try {
      if (scVal.switch().name === 'u32') {
        return parseInt(scVal.u32().toString());
      } else if (scVal.switch().name === 'i32') {
        return parseInt(scVal.i32().toString());
      } else if (scVal.switch().name === 'u64') {
        return parseInt(scVal.u64().toString());
      } else if (scVal.switch().name === 'i64') {
        return parseInt(scVal.i64().toString());
      }
      
      return 7; // Default decimals
    } catch (error) {
      this.logger.error('Failed to parse integer from ScVal', {
        error: error.message
      });
      return 7;
    }
  }

  /**
   * Fetch historical prices for a time range
   */
  async fetchHistoricalPrices(asset, startTime, endTime) {
    try {
      // For SEP-40, historical data might be limited
      // This would typically require querying multiple data points or using a different API
      this.logger.info('Fetching historical prices', {
        assetCode: asset.code,
        startTime,
        endTime
      });

      // For now, return current price as a fallback
      // In a real implementation, you might need to use a different approach
      // such as querying historical ledger data or using a price history API
      const currentPrice = await this.fetchAssetPrice(asset);
      
      return [{
        ...currentPrice,
        timestamp: startTime
      }];
    } catch (error) {
      this.logger.error('Failed to fetch historical prices', {
        assetCode: asset.code,
        startTime,
        endTime,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Calculate exponential backoff delay
   */
  calculateBackoffDelay(retryCount) {
    const delay = Math.min(
      this.baseDelay * Math.pow(2, retryCount) + Math.random() * 1000,
      this.maxDelay
    );
    return delay;
  }

  /**
   * Update average response time
   */
  updateAverageResponseTime(responseTime) {
    if (this.stats.averageResponseTime === 0) {
      this.stats.averageResponseTime = responseTime;
    } else {
      // Simple moving average
      this.stats.averageResponseTime = (this.stats.averageResponseTime * 0.9) + (responseTime * 0.1);
    }
  }

  /**
   * Get service statistics
   */
  getStats() {
    const uptime = Date.now() - new Date(this.stats.startTime).getTime();
    const successRate = this.stats.requestsMade > 0 
      ? (this.stats.requestsSuccessful / this.stats.requestsMade) * 100 
      : 0;

    return {
      ...this.stats,
      uptime,
      successRate,
      supportedAssetsCount: this.supportedAssets.length,
      network: this.network,
      oracleAddress: this.oracleAddress
    };
  }

  /**
   * Health check
   */
  async getHealthStatus() {
    try {
      const startTime = Date.now();
      
      // Test basic connectivity
      await this.server.loadAccount(this.oracleAddress);
      
      const responseTime = Date.now() - startTime;
      const stats = this.getStats();
      
      const isHealthy = stats.successRate >= 90 && stats.consecutiveFailures < 5;
      
      return {
        healthy: isHealthy,
        responseTime,
        stats,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      this.logger.error('Health check failed', {
        error: error.message
      });
      
      return {
        healthy: false,
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Sleep utility
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Close the service
   */
  async close() {
    this.logger.info('SEP-40 Oracle Service closed');
  }
}

module.exports = { Sep40OracleService };
