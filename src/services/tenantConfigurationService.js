const Redis = require('redis');
const { getDatabase } = require('../db/appDatabase');

/**
 * Tenant Configuration Service
 * 
 * Handles feature flag evaluation with Redis caching for sub-1ms performance.
 * Supports LaunchDarkly-style boolean flags with audit logging.
 */
class TenantConfigurationService {
  constructor() {
    this.redis = null;
    this.cacheTTL = 300; // 5 minutes
    this.auditBatch = [];
    this.auditBatchSize = 100;
    this.auditFlushInterval = 5000; // 5 seconds
  }

  /**
   * Initialize Redis connection and start audit batch processing
   */
  async initialize() {
    const config = require('../config').loadConfig();
    
    this.redis = Redis.createClient({
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password || undefined,
      db: config.redis.db,
    });

    await this.redis.connect();
    
    // Start audit batch processing
    setInterval(() => this.flushAuditBatch(), this.auditFlushInterval);
  }

  /**
   * Evaluate a feature flag for a tenant with caching
   * @param {string} tenantId - Tenant UUID
   * @param {string} flagName - Feature flag name
   * @returns {Promise<boolean>} Flag value
   */
  async evaluateFeatureFlag(tenantId, flagName) {
    const startTime = process.hrtime.bigint();
    
    try {
      // Check cache first
      const cacheKey = `feature_flag:${tenantId}:${flagName}`;
      const cachedValue = await this.redis.get(cacheKey);
      
      if (cachedValue !== null) {
        return cachedValue === 'true';
      }

      // Cache miss - fetch from database
      const db = getDatabase();
      const result = await db('tenant_configurations')
        .select('flag_value')
        .where({
          tenant_id: tenantId,
          flag_name: flagName
        })
        .first();

      const flagValue = result ? result.flag_value : false;

      // Cache the result
      await this.redis.setEx(cacheKey, this.cacheTTL, flagValue.toString());

      // Log performance metrics
      const endTime = process.hrtime.bigint();
      const duration = Number(endTime - startTime) / 1000000; // Convert to milliseconds

      if (duration > 1) {
        console.warn(`Feature flag evaluation took ${duration.toFixed(2)}ms for ${flagName} on tenant ${tenantId}`);
      }

      return flagValue;
    } catch (error) {
      console.error('Error evaluating feature flag:', error);
      return false; // Fail safe - return false on errors
    }
  }

  /**
   * Update a feature flag for a tenant with audit logging
   * @param {string} tenantId - Tenant UUID
   * @param {string} flagName - Feature flag name
   * @param {boolean} newValue - New flag value
   * @param {string} changedBy - Who made the change
   * @param {string} reason - Reason for the change
   */
  async updateFeatureFlag(tenantId, flagName, newValue, changedBy, reason = '') {
    const db = getDatabase();
    
    try {
      // Get current value for audit
      const current = await db('tenant_configurations')
        .select('flag_value')
        .where({
          tenant_id: tenantId,
          flag_name: flagName
        })
        .first();

      const oldValue = current ? current.flag_value : false;

      // Update or insert the flag
      await db('tenant_configurations')
        .insert({
          tenant_id: tenantId,
          flag_name: flagName,
          flag_value: newValue,
          updated_at: new Date(),
          metadata: JSON.stringify({
            last_updated_by: changedBy,
            update_reason: reason
          })
        })
        .onConflict(['tenant_id', 'flag_name'])
        .merge({
          flag_value: newValue,
          updated_at: new Date(),
          metadata: JSON.stringify({
            last_updated_by: changedBy,
            update_reason: reason
          })
        });

      // Invalidate cache
      const cacheKey = `feature_flag:${tenantId}:${flagName}`;
      await this.redis.del(cacheKey);

      // Add to audit batch
      this.auditBatch.push({
        tenant_id: tenantId,
        flag_name: flagName,
        old_value: oldValue,
        new_value: newValue,
        changed_by: changedBy,
        change_reason: reason,
        metadata: JSON.stringify({
          timestamp: new Date().toISOString(),
          source: 'tenant_configuration_service'
        })
      });

      // Flush batch immediately if it's full
      if (this.auditBatch.length >= this.auditBatchSize) {
        await this.flushAuditBatch();
      }

      return true;
    } catch (error) {
      console.error('Error updating feature flag:', error);
      throw error;
    }
  }

  /**
   * Get all feature flags for a tenant
   * @param {string} tenantId - Tenant UUID
   * @returns {Promise<Object>} All flags as key-value pairs
   */
  async getAllTenantFlags(tenantId) {
    const db = getDatabase();
    
    try {
      const flags = await db('tenant_configurations')
        .select('flag_name', 'flag_value')
        .where('tenant_id', tenantId);

      const result = {};
      flags.forEach(flag => {
        result[flag.flag_name] = flag.flag_value;
      });

      return result;
    } catch (error) {
      console.error('Error getting tenant flags:', error);
      return {};
    }
  }

  /**
   * Flush audit batch to database
   */
  async flushAuditBatch() {
    if (this.auditBatch.length === 0) return;

    const db = getDatabase();
    
    try {
      await db('feature_flag_audit_log').insert(this.auditBatch);
      this.auditBatch = [];
    } catch (error) {
      console.error('Error flushing audit batch:', error);
      // Don't clear the batch - retry on next flush
    }
  }

  /**
   * Get audit history for a specific flag
   * @param {string} tenantId - Tenant UUID
   * @param {string} flagName - Feature flag name
   * @param {number} limit - Maximum number of records to return
   * @returns {Promise<Array>} Audit history
   */
  async getFlagAuditHistory(tenantId, flagName, limit = 50) {
    const db = getDatabase();
    
    try {
      return await db('feature_flag_audit_log')
        .select('*')
        .where({
          tenant_id: tenantId,
          flag_name: flagName
        })
        .orderBy('created_at', 'desc')
        .limit(limit);
    } catch (error) {
      console.error('Error getting audit history:', error);
      return [];
    }
  }

  /**
   * Clear cache for all flags of a tenant
   * @param {string} tenantId - Tenant UUID
   */
  async clearTenantCache(tenantId) {
    try {
      const pattern = `feature_flag:${tenantId}:*`;
      const keys = await this.redis.keys(pattern);
      
      if (keys.length > 0) {
        await this.redis.del(keys);
      }
    } catch (error) {
      console.error('Error clearing tenant cache:', error);
    }
  }

  /**
   * Get performance metrics
   * @returns {Object} Performance statistics
   */
  getMetrics() {
    return {
      cacheTTL: this.cacheTTL,
      auditBatchSize: this.auditBatchSize,
      currentAuditBatchSize: this.auditBatch.length,
      auditFlushInterval: this.auditFlushInterval
    };
  }

  /**
   * Graceful shutdown
   */
  async shutdown() {
    if (this.auditBatch.length > 0) {
      await this.flushAuditBatch();
    }
    
    if (this.redis) {
      await this.redis.quit();
    }
  }
}

// Singleton instance
const tenantConfigurationService = new TenantConfigurationService();

module.exports = tenantConfigurationService;
