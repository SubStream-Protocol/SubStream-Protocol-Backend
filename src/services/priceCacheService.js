const { AppDatabase } = require('../db/appDatabase');
const { Sep40OracleService } = require('./sep40OracleService');
const { FallbackPriceService } = require('./fallbackPriceService');
const winston = require('winston');

/**
 * Price Cache Service
 * Manages the price cache with 5-minute intervals and robust backoff strategy
 */
class PriceCacheService {
  constructor(config, dependencies = {}) {
    this.config = config;
    this.logger = dependencies.logger || winston.createLogger({
      level: config.logLevel || 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      ),
      transports: [new winston.transports.Console()]
    });
    
    this.database = dependencies.database || new AppDatabase(config.database);
    
    // Oracle service
    this.oracleService = new Sep40OracleService(config.oracle, this.logger);
    
    // Fallback price service
    this.fallbackService = new FallbackPriceService(config.fallback || {}, this.logger);
    
    // Configuration
    this.syncIntervalMs = config.syncIntervalMs || 5 * 60 * 1000; // 5 minutes
    this.maxAgeMinutes = config.maxAgeMinutes || 60; // 1 hour for price lookup
    this.retentionDays = config.retentionDays || 90; // 90 days for data retention
    this.enableFallback = config.enableFallback !== false;
    
    // Sync state
    this.isRunning = false;
    this.syncTimer = null;
    this.currentSyncId = null;
    
    // Statistics
    this.stats = {
      syncsCompleted: 0,
      syncsFailed: 0,
      pricesStored: 0,
      averageSyncDuration: 0,
      lastSyncTime: null,
      startTime: new Date().toISOString()
    };
  }

  /**
   * Initialize the price cache service
   */
  async initialize() {
    try {
      this.logger.info('Initializing Price Cache Service...');
      
      // Initialize oracle service
      await this.oracleService.initialize();
      
      // Initialize metadata if not exists
      await this.initializeMetadata();
      
      // Start the sync timer
      this.startSyncTimer();
      
      this.logger.info('Price Cache Service initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize Price Cache Service', {
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Initialize metadata if not exists
   */
  async initializeMetadata() {
    try {
      const stmt = this.database.db.prepare(`
        SELECT COUNT(*) as count FROM price_cache_metadata
      `);
      
      const result = stmt.get();
      
      if (result.count === 0) {
        this.logger.info('Initializing price cache metadata...');
        
        const insertStmt = this.database.db.prepare(`
          INSERT INTO price_cache_metadata (
            oracle_address,
            supported_assets,
            sync_interval_seconds,
            created_at
          ) VALUES (?, ?, ?, NOW())
        `);
        
        insertStmt.run(
          this.config.oracle.oracleAddress,
          JSON.stringify(this.config.oracle.supportedAssets || []),
          Math.floor(this.syncIntervalMs / 1000)
        );
        
        this.logger.info('Price cache metadata initialized');
      }
    } catch (error) {
      this.logger.error('Failed to initialize metadata', {
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Start the sync timer
   */
  startSyncTimer() {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
    }

    this.isRunning = true;
    
    // Run initial sync immediately
    this.performSync().catch(error => {
      this.logger.error('Initial sync failed', { error: error.message });
    });
    
    // Set up recurring sync
    this.syncTimer = setInterval(() => {
      this.performSync().catch(error => {
        this.logger.error('Scheduled sync failed', { error: error.message });
      });
    }, this.syncIntervalMs);
    
    this.logger.info('Price cache sync timer started', {
      intervalMs: this.syncIntervalMs
    });
  }

  /**
   * Stop the sync timer
   */
  stopSyncTimer() {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    
    this.isRunning = false;
    this.logger.info('Price cache sync timer stopped');
  }

  /**
   * Perform price sync
   */
  async performSync() {
    const syncId = this.generateSyncId();
    this.currentSyncId = syncId;
    
    const startTime = Date.now();
    
    try {
      this.logger.info('Starting price cache sync', { syncId });
      
      // Update sync status
      await this.updateSyncStatus('syncing');
      
      // Fetch current prices from oracle
      const prices = await this.oracleService.fetchCurrentPrices();
      
      // Store prices in database
      const storedCount = await this.storePrices(prices);
      
      // Mark stale prices
      const staleCount = await this.markStalePrices();
      
      // Clean up old data
      const cleanupCount = await this.cleanupOldData();
      
      // Update sync status to success
      await this.updateSyncStatus('success', null, storedCount);
      
      // Update statistics
      const syncDuration = Date.now() - startTime;
      this.updateAverageSyncDuration(syncDuration);
      this.stats.syncsCompleted++;
      this.stats.pricesStored += storedCount;
      this.stats.lastSyncTime = new Date().toISOString();
      
      this.logger.info('Price cache sync completed', {
        syncId,
        pricesFetched: prices.length,
        pricesStored: storedCount,
        staleMarked: staleCount,
        cleanupCount,
        syncDuration
      });
      
      return {
        success: true,
        syncId,
        pricesFetched: prices.length,
        pricesStored: storedCount,
        syncDuration
      };
      
    } catch (error) {
      this.stats.syncsFailed++;
      
      // Update sync status to error
      await this.updateSyncStatus('error', error.message);
      
      this.logger.error('Price cache sync failed', {
        syncId,
        error: error.message,
        syncDuration: Date.now() - startTime
      });
      
      throw error;
    } finally {
      this.currentSyncId = null;
    }
  }

  /**
   * Store prices in database
   */
  async storePrices(prices) {
    let storedCount = 0;
    
    try {
      const stmt = this.database.db.prepare(`
        INSERT OR REPLACE INTO price_cache (
          asset_code,
          asset_issuer,
          asset_type,
          base_asset,
          price,
          price_timestamp,
          ledger_sequence,
          oracle_address,
          oracle_timestamp,
          price_decimals,
          fetched_at,
          confidence_score,
          is_stale,
          backfill_required
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?)
      `);
      
      for (const price of prices) {
        const assetType = price.assetCode === 'XLM' && !price.assetIssuer 
          ? 'native' 
          : price.assetIssuer?.length === 56 ? 'credit_alphanum12' : 'credit_alphanum4';
        
        stmt.run(
          price.assetCode,
          price.assetIssuer || null,
          assetType,
          'USD',
          price.price,
          price.timestamp,
          null, // ledger_sequence - can be populated if available
          this.config.oracle.oracleAddress,
          price.timestamp,
          price.decimals || 7,
          price.confidence || 1.0,
          false, // is_stale
          false  // backfill_required
        );
        
        storedCount++;
      }
      
      // Update metadata
      await this.updateMetadata(storedCount);
      
      this.logger.debug('Prices stored in database', {
        storedCount,
        assets: prices.map(p => p.assetCode)
      });
      
      return storedCount;
    } catch (error) {
      this.logger.error('Failed to store prices', {
        error: error.message,
        pricesCount: prices.length
      });
      throw error;
    }
  }

  /**
   * Find closest price to a given timestamp
   */
  async findClosestPrice(assetCode, assetIssuer, targetTimestamp) {
    try {
      const stmt = this.database.db.prepare(`
        SELECT * FROM find_closest_price(?, ?, ?, ?)
      `);
      
      const result = stmt.get(assetCode, assetIssuer, targetTimestamp, this.maxAgeMinutes);
      
      if (!result) {
        this.logger.warn('No price found for asset', {
          assetCode,
          assetIssuer,
          targetTimestamp,
          maxAgeMinutes: this.maxAgeMinutes
        });
        return null;
      }
      
      this.logger.debug('Found closest price', {
        assetCode,
        targetTimestamp,
        foundPrice: result.price,
        foundTimestamp: result.price_timestamp,
        timeDiffMinutes: result.time_diff_minutes
      });
      
      return result;
    } catch (error) {
      this.logger.error('Failed to find closest price', {
        assetCode,
        assetIssuer,
        targetTimestamp,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Get USD equivalent for a crypto amount at a specific time
   */
  async getUsdEquivalent(assetCode, assetIssuer, amount, timestamp) {
    try {
      // First try to get price from cache
      const priceData = await this.findClosestPrice(assetCode, assetIssuer, timestamp);
      
      if (priceData) {
        const usdEquivalent = parseFloat(amount) * parseFloat(priceData.price);
        
        this.logger.debug('USD equivalent calculated from cache', {
          assetCode,
          amount,
          price: priceData.price,
          usdEquivalent,
          priceTimestamp: priceData.price_timestamp
        });
        
        return {
          usdEquivalent,
          priceTimestamp: priceData.price_timestamp,
          confidence: priceData.confidence_score,
          backfillRequired: false,
          source: 'cache'
        };
      }
      
      // If cache miss and fallback is enabled, try fallback service
      if (this.enableFallback) {
        this.logger.info('Cache miss, trying fallback service', {
          assetCode,
          assetIssuer,
          amount,
          timestamp
        });
        
        const fallbackResult = await this.fallbackService.getUsdEquivalent(
          assetCode,
          assetIssuer,
          amount,
          timestamp
        );
        
        if (fallbackResult.usdEquivalent) {
          this.logger.info('USD equivalent calculated from fallback', {
            assetCode,
            amount,
            usdEquivalent: fallbackResult.usdEquivalent,
            source: fallbackResult.source
          });
          
          return fallbackResult;
        }
      }
      
      // No price available anywhere
      this.logger.warn('No price data available for USD conversion', {
        assetCode,
        assetIssuer,
        amount,
        timestamp,
        fallbackEnabled: this.enableFallback
      });
      
      return {
        usdEquivalent: null,
        priceTimestamp: null,
        confidence: null,
        backfillRequired: true,
        source: 'none'
      };
    } catch (error) {
      this.logger.error('Failed to calculate USD equivalent', {
        assetCode,
        assetIssuer,
        amount,
        timestamp,
        error: error.message
      });
      
      return {
        usdEquivalent: null,
        priceTimestamp: null,
        confidence: null,
        backfillRequired: true,
        source: 'error'
      };
    }
  }

  /**
   * Update sync status
   */
  async updateSyncStatus(status, errorMessage = null, pricesStored = 0) {
    try {
      const stmt = this.database.db.prepare(`
        UPDATE price_cache_metadata 
        SET 
          sync_status = ?,
          last_sync_at = NOW(),
          last_successful_sync_at = CASE WHEN ? = 'success' THEN NOW() ELSE last_successful_sync_at END,
          last_error_message = ?,
          consecutive_failures = CASE WHEN ? = 'error' THEN consecutive_failures + 1 ELSE 0 END,
          last_sync_duration_ms = CASE WHEN ? IS NOT NULL THEN ? * 1000 ELSE last_sync_duration_ms END,
          total_prices_cached = total_prices_cached + COALESCE(?, 0),
          updated_at = NOW()
        WHERE id = (SELECT id FROM price_cache_metadata ORDER BY created_at DESC LIMIT 1)
      `);
      
      stmt.run(status, status, errorMessage, status, pricesStored, pricesStored, pricesStored);
    } catch (error) {
      this.logger.error('Failed to update sync status', {
        status,
        error: error.message
      });
    }
  }

  /**
   * Update metadata
   */
  async updateMetadata(pricesStored) {
    try {
      const stmt = this.database.db.prepare(`
        UPDATE price_cache_metadata 
        SET 
          total_prices_cached = total_prices_cached + ?,
          newest_price_timestamp = (SELECT MAX(price_timestamp) FROM price_cache),
          updated_at = NOW()
        WHERE id = (SELECT id FROM price_cache_metadata ORDER BY created_at DESC LIMIT 1)
      `);
      
      stmt.run(pricesStored);
    } catch (error) {
      this.logger.error('Failed to update metadata', {
        pricesStored,
        error: error.message
      });
    }
  }

  /**
   * Mark stale prices
   */
  async markStalePrices() {
    try {
      const stmt = this.database.db.prepare(`
        SELECT mark_stale_prices() as count
      `);
      
      const result = stmt.get();
      return result.count || 0;
    } catch (error) {
      this.logger.error('Failed to mark stale prices', {
        error: error.message
      });
      return 0;
    }
  }

  /**
   * Clean up old data
   */
  async cleanupOldData() {
    try {
      const stmt = this.database.db.prepare(`
        SELECT cleanup_old_price_data() as count
      `);
      
      const result = stmt.get();
      return result.count || 0;
    } catch (error) {
      this.logger.error('Failed to cleanup old data', {
        error: error.message
      });
      return 0;
    }
  }

  /**
   * Get price cache statistics
   */
  async getStats() {
    try {
      const summaryStmt = this.database.db.prepare(`
        SELECT * FROM price_cache_summary
      `);
      
      const healthStmt = this.database.db.prepare(`
        SELECT * FROM price_cache_health
      `);
      
      const summary = summaryStmt.all();
      const health = healthStmt.get();
      
      const uptime = Date.now() - new Date(this.stats.startTime).getTime();
      const successRate = (this.stats.syncsCompleted + this.stats.syncsFailed) > 0
        ? (this.stats.syncsCompleted / (this.stats.syncsCompleted + this.stats.syncsFailed)) * 100
        : 0;
      
      return {
        ...this.stats,
        uptime,
        successRate,
        database: {
          summary,
          health
        },
        oracle: this.oracleService.getStats(),
        isRunning: this.isRunning,
        currentSyncId: this.currentSyncId
      };
    } catch (error) {
      this.logger.error('Failed to get price cache stats', {
        error: error.message
      });
      return this.stats;
    }
  }

  /**
   * Get health status
   */
  async getHealthStatus() {
    try {
      const stats = await this.getStats();
      const oracleHealth = await this.oracleService.getHealthStatus();
      
      const isHealthy = stats.isRunning && 
                       stats.successRate >= 90 && 
                       stats.database.health?.health_status !== 'critical' &&
                       oracleHealth.healthy;
      
      return {
        healthy: isHealthy,
        stats,
        oracle: oracleHealth,
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
   * Update average sync duration
   */
  updateAverageSyncDuration(duration) {
    if (this.stats.averageSyncDuration === 0) {
      this.stats.averageSyncDuration = duration;
    } else {
      // Simple moving average
      this.stats.averageSyncDuration = (this.stats.averageSyncDuration * 0.9) + (duration * 0.1);
    }
  }

  /**
   * Generate sync ID
   */
  generateSyncId() {
    return `sync_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Close the service
   */
  async close() {
    try {
      this.stopSyncTimer();
      await this.oracleService.close();
      
      this.logger.info('Price Cache Service closed');
    } catch (error) {
      this.logger.error('Error closing Price Cache Service', {
        error: error.message
      });
    }
  }
}

module.exports = { PriceCacheService };
