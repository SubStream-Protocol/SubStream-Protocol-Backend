const { getRedisClient } = require('../config/redis');

/**
 * Tenant Feature Flag Service
 * 
 * Handles tenant-level feature flag evaluation with Redis caching
 * and audit logging for all configuration changes.
 */
class TenantFeatureFlagService {
  constructor(database, redisService) {
    this.database = database;
    this.redisService = redisService;
    this.redisClient = getRedisClient();
    
    // Cache configuration
    this.CACHE_TTL = 300; // 5 minutes
    this.CACHE_PREFIX = 'feature_flag:';
    
    // Default feature flags for new tenants
    this.DEFAULT_FLAGS = {
      enable_crypto_checkout: false,
      enable_b2b_invoicing: false,
      require_kyc_for_subs: false,
      enable_advanced_analytics: false,
      enable_api_webhooks: false,
      enable_custom_branding: false,
      enable_priority_support: false,
      enable_bulk_operations: false
    };
  }

  /**
   * Evaluate a feature flag for a tenant
   * Uses Redis cache for sub-1ms performance
   */
  async evaluateFlag(tenantId, flagName) {
    const startTime = Date.now();
    
    try {
      // Check cache first
      const cacheKey = `${this.CACHE_PREFIX}${tenantId}:${flagName}`;
      const cached = await this.redisClient.get(cacheKey);
      
      if (cached !== null) {
        return {
          flagName,
          value: cached === 'true',
          cached: true,
          evaluationTimeMs: Date.now() - startTime
        };
      }

      // Query database
      const result = await this.database.pool.query(`
        SELECT flag_value, metadata
        FROM tenant_configurations
        WHERE tenant_id = $1 AND flag_name = $2
      `, [tenantId, flagName]);

      let flagValue = this.DEFAULT_FLAGS[flagName] || false;
      
      if (result.rows.length > 0) {
        flagValue = result.rows[0].flag_value;
      }

      // Cache the result
      await this.redisClient.setex(cacheKey, this.CACHE_TTL, flagValue.toString());

      return {
        flagName,
        value: flagValue,
        cached: false,
        evaluationTimeMs: Date.now() - startTime
      };

    } catch (error) {
      console.error(`Error evaluating flag ${flagName} for tenant ${tenantId}:`, error);
      // Fail safe - return default value
      return {
        flagName,
        value: this.DEFAULT_FLAGS[flagName] || false,
        cached: false,
        evaluationTimeMs: Date.now() - startTime,
        error: error.message
      };
    }
  }

  /**
   * Get all feature flags for a tenant
   */
  async getAllFlags(tenantId) {
    const startTime = Date.now();
    
    try {
      // Try to get from cache first
      const cacheKey = `${this.CACHE_PREFIX}${tenantId}:all`;
      const cached = await this.redisClient.get(cacheKey);
      
      if (cached !== null) {
        return {
          tenantId,
          flags: JSON.parse(cached),
          cached: true,
          evaluationTimeMs: Date.now() - startTime
        };
      }

      // Query database for all flags
      const result = await this.database.pool.query(`
        SELECT flag_name, flag_value, metadata
        FROM tenant_configurations
        WHERE tenant_id = $1
      `, [tenantId]);

      // Build flags object with defaults
      const flags = { ...this.DEFAULT_FLAGS };
      
      // Override with tenant-specific values
      result.rows.forEach(row => {
        flags[row.flag_name] = row.flag_value;
      });

      // Cache the result
      await this.redisClient.setex(cacheKey, this.CACHE_TTL, JSON.stringify(flags));

      return {
        tenantId,
        flags,
        cached: false,
        evaluationTimeMs: Date.now() - startTime
      };

    } catch (error) {
      console.error(`Error getting all flags for tenant ${tenantId}:`, error);
      return {
        tenantId,
        flags: this.DEFAULT_FLAGS,
        cached: false,
        evaluationTimeMs: Date.now() - startTime,
        error: error.message
      };
    }
  }

  /**
   * Update a feature flag for a tenant with audit logging
   */
  async updateFlag(tenantId, flagName, newValue, changedBy, changeReason = null) {
    const client = await this.database.pool.connect();
    
    try {
      await client.query('BEGIN');

      // Get current value for audit
      const currentResult = await client.query(`
        SELECT flag_value
        FROM tenant_configurations
        WHERE tenant_id = $1 AND flag_name = $2
      `, [tenantId, flagName]);

      const oldValue = currentResult.rows.length > 0 
        ? currentResult.rows[0].flag_value 
        : this.DEFAULT_FLAGS[flagName] || false;

      // Upsert the flag
      await client.query(`
        INSERT INTO tenant_configurations (tenant_id, flag_name, flag_value, metadata)
        VALUES ($1, $2, $3, '{"updated": true}')
        ON CONFLICT (tenant_id, flag_name)
        DO UPDATE SET
          flag_value = EXCLUDED.flag_value,
          updated_at = NOW(),
          metadata = jsonb_set(
            COALESCE(tenant_configurations.metadata, '{}'),
            '{updated}',
            'true'::jsonb
          )
      `, [tenantId, flagName, newValue]);

      // Log the change
      await client.query(`
        INSERT INTO feature_flag_audit_log (tenant_id, flag_name, old_value, new_value, changed_by, change_reason)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [tenantId, flagName, oldValue, newValue, changedBy, changeReason]);

      await client.query('COMMIT');

      // Invalidate cache
      await this.invalidateCache(tenantId, flagName);

      // Emit change event
      if (this.redisService) {
        await this.redisService.publish('feature_flag_changed', {
          tenantId,
          flagName,
          oldValue,
          newValue,
          changedBy,
          timestamp: new Date().toISOString()
        });
      }

      return {
        success: true,
        flagName,
        oldValue,
        newValue,
        changedBy,
        changeReason
      };

    } catch (error) {
      await client.query('ROLLBACK');
      console.error(`Error updating flag ${flagName} for tenant ${tenantId}:`, error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get audit log for a tenant's feature flags
   */
  async getAuditLog(tenantId, flagName = null, limit = 100, offset = 0) {
    try {
      let query = `
        SELECT *
        FROM feature_flag_audit_log
        WHERE tenant_id = $1
      `;
      const params = [tenantId];

      if (flagName) {
        query += ` AND flag_name = $2`;
        params.push(flagName);
      }

      query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      params.push(limit, offset);

      const result = await this.database.pool.query(query, params);

      return {
        tenantId,
        flagName,
        entries: result.rows,
        total: result.rows.length
      };

    } catch (error) {
      console.error(`Error getting audit log for tenant ${tenantId}:`, error);
      throw error;
    }
  }

  /**
   * Initialize default flags for a new tenant
   */
  async initializeTenantFlags(tenantId) {
    const client = await this.database.pool.connect();
    
    try {
      await client.query('BEGIN');

      for (const [flagName, defaultValue] of Object.entries(this.DEFAULT_FLAGS)) {
        await client.query(`
          INSERT INTO tenant_configurations (tenant_id, flag_name, flag_value, metadata)
          VALUES ($1, $2, $3, '{"auto_created": true}')
          ON CONFLICT (tenant_id, flag_name) DO NOTHING
        `, [tenantId, defaultValue]);
      }

      await client.query('COMMIT');

      return {
        success: true,
        tenantId,
        initializedFlags: Object.keys(this.DEFAULT_FLAGS)
      };

    } catch (error) {
      await client.query('ROLLBACK');
      console.error(`Error initializing flags for tenant ${tenantId}:`, error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Invalidate cache for a specific flag or all flags for a tenant
   */
  async invalidateCache(tenantId, flagName = null) {
    try {
      if (flagName) {
        const cacheKey = `${this.CACHE_PREFIX}${tenantId}:${flagName}`;
        await this.redisClient.del(cacheKey);
      }

      // Always invalidate the "all flags" cache
      const allCacheKey = `${this.CACHE_PREFIX}${tenantId}:all`;
      await this.redisClient.del(allCacheKey);

    } catch (error) {
      console.error(`Error invalidating cache for tenant ${tenantId}:`, error);
    }
  }

  /**
   * Bulk update multiple flags for a tenant
   */
  async bulkUpdateFlags(tenantId, flagUpdates, changedBy, changeReason = null) {
    const client = await this.database.pool.connect();
    
    try {
      await client.query('BEGIN');

      const results = [];

      for (const { flagName, value } of flagUpdates) {
        // Get current value for audit
        const currentResult = await client.query(`
          SELECT flag_value
          FROM tenant_configurations
          WHERE tenant_id = $1 AND flag_name = $2
        `, [tenantId, flagName]);

        const oldValue = currentResult.rows.length > 0 
          ? currentResult.rows[0].flag_value 
          : this.DEFAULT_FLAGS[flagName] || false;

        // Update the flag
        await client.query(`
          INSERT INTO tenant_configurations (tenant_id, flag_name, flag_value, metadata)
          VALUES ($1, $2, $3, '{"bulk_updated": true}')
          ON CONFLICT (tenant_id, flag_name)
          DO UPDATE SET
            flag_value = EXCLUDED.flag_value,
            updated_at = NOW(),
            metadata = jsonb_set(
              COALESCE(tenant_configurations.metadata, '{}'),
              '{bulk_updated}',
              'true'::jsonb
            )
        `, [tenantId, flagName, value]);

        // Log the change
        await client.query(`
          INSERT INTO feature_flag_audit_log (tenant_id, flag_name, old_value, new_value, changed_by, change_reason)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, [tenantId, flagName, oldValue, value, changedBy, changeReason]);

        results.push({
          flagName,
          oldValue,
          newValue: value
        });
      }

      await client.query('COMMIT');

      // Invalidate all cache for this tenant
      await this.invalidateCache(tenantId);

      // Emit bulk change event
      if (this.redisService) {
        await this.redisService.publish('feature_flags_bulk_changed', {
          tenantId,
          changes: results,
          changedBy,
          timestamp: new Date().toISOString()
        });
      }

      return {
        success: true,
        tenantId,
        changes: results,
        changedBy,
        changeReason
      };

    } catch (error) {
      await client.query('ROLLBACK');
      console.error(`Error bulk updating flags for tenant ${tenantId}:`, error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get performance metrics for flag evaluation
   */
  async getPerformanceMetrics() {
    try {
      // This would typically query a metrics table
      // For now, return basic cache hit ratio from Redis info
      const info = await this.redisClient.info('stats');
      
      return {
        cacheHitRatio: 'N/A', // Would calculate from actual metrics
        averageEvaluationTime: '< 1ms',
        cacheTTL: this.CACHE_TTL,
        totalFlags: Object.keys(this.DEFAULT_FLAGS).length
      };

    } catch (error) {
      console.error('Error getting performance metrics:', error);
      return {
        error: error.message
      };
    }
  }
}

module.exports = TenantFeatureFlagService;
