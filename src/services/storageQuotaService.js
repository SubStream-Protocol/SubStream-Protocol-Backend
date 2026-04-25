const { getRedisClient } = require('../config/redis');

/**
 * Storage Quota Service
 * Manages tenant-level storage quotas and enforcement
 */

class StorageQuotaService {
  constructor(database, redisService) {
    this.database = database;
    this.redisService = redisService;
    this.redisClient = getRedisClient();
    
    // Default quota limits by tier
    this.defaultQuotas = {
      free: {
        maxUsers: 10000,
        maxSubscriptions: 10000,
        maxBillingEvents: 50000,
        maxVideos: 100,
        maxStorageBytes: 1073741824, // 1GB
        retentionDays: 730 // 2 years
      },
      pro: {
        maxUsers: 100000,
        maxSubscriptions: 100000,
        maxBillingEvents: 500000,
        maxVideos: 1000,
        maxStorageBytes: 10737418240, // 10GB
        retentionDays: 1825 // 5 years
      },
      enterprise: {
        maxUsers: -1, // Unlimited
        maxSubscriptions: -1,
        maxBillingEvents: -1,
        maxVideos: -1,
        maxStorageBytes: -1,
        retentionDays: -1 // Unlimited
      }
    };
  }

  /**
   * Get quota limits for a tenant based on their tier
   * @param {string} tenantId - Tenant ID
   * @returns {Promise<object>} Quota limits
   */
  async getTenantQuotaLimits(tenantId) {
    try {
      // Get tenant tier from database
      const tier = await this.getTenantTier(tenantId);
      const quotas = this.defaultQuotas[tier] || this.defaultQuotas.free;
      
      // Check for custom quota overrides
      const customQuotas = await this.getCustomQuotas(tenantId);
      
      return {
        ...quotas,
        ...customQuotas,
        tier
      };
    } catch (error) {
      console.error('Error getting tenant quota limits:', error);
      return this.defaultQuotas.free;
    }
  }

  /**
   * Get current storage usage for a tenant
   * @param {string} tenantId - Tenant ID
   * @returns {Promise<object>} Current usage statistics
   */
  async getTenantUsage(tenantId) {
    const cacheKey = `usage:${tenantId}`;
    
    try {
      // Try to get from cache first
      const cached = await this.redisClient.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }

      const usage = await this.calculateTenantUsage(tenantId);
      
      // Cache for 5 minutes
      await this.redisClient.setex(cacheKey, 300, JSON.stringify(usage));
      
      return usage;
    } catch (error) {
      console.error('Error getting tenant usage:', error);
      throw error;
    }
  }

  /**
   * Calculate current storage usage for a tenant
   * @param {string} tenantId - Tenant ID
   * @returns {Promise<object>} Usage statistics
   */
  async calculateTenantUsage(tenantId) {
    const client = await this.database.pool.connect();
    
    try {
      // Get table counts and sizes
      const [usersResult, subscriptionsResult, billingEventsResult, videosResult] = await Promise.all([
        client.query(`
          SELECT 
            COUNT(*) as count,
            pg_total_relation_size('users') as bytes
          FROM users 
          WHERE tenant_id = $1
        `, [tenantId]),
        
        client.query(`
          SELECT 
            COUNT(*) as count,
            pg_total_relation_size('subscriptions') as bytes
          FROM subscriptions 
          WHERE tenant_id = $1
        `, [tenantId]),
        
        client.query(`
          SELECT 
            COUNT(*) as count,
            pg_total_relation_size('billing_events') as bytes
          FROM billing_events 
          WHERE tenant_id = $1
        `, [tenantId]),
        
        client.query(`
          SELECT 
            COUNT(*) as count,
            COALESCE(SUM(file_size), 0) as bytes
          FROM videos 
          WHERE tenant_id = $1
        `, [tenantId])
      ]);

      return {
        users: {
          count: parseInt(usersResult.rows[0].count),
          bytes: parseInt(usersResult.rows[0].bytes) || 0
        },
        subscriptions: {
          count: parseInt(subscriptionsResult.rows[0].count),
          bytes: parseInt(subscriptionsResult.rows[0].bytes) || 0
        },
        billingEvents: {
          count: parseInt(billingEventsResult.rows[0].count),
          bytes: parseInt(billingEventsResult.rows[0].bytes) || 0
        },
        videos: {
          count: parseInt(videosResult.rows[0].count),
          bytes: parseInt(videosResult.rows[0].bytes) || 0
        },
        total: {
          count: parseInt(usersResult.rows[0].count) + 
                 parseInt(subscriptionsResult.rows[0].count) + 
                 parseInt(billingEventsResult.rows[0].count) + 
                 parseInt(videosResult.rows[0].count),
          bytes: (parseInt(usersResult.rows[0].bytes) || 0) + 
                 (parseInt(subscriptionsResult.rows[0].bytes) || 0) + 
                 (parseInt(billingEventsResult.rows[0].bytes) || 0) + 
                 (parseInt(videosResult.rows[0].bytes) || 0)
        }
      };
    } finally {
      client.release();
    }
  }

  /**
   * Check if tenant has exceeded their quota
   * @param {string} tenantId - Tenant ID
   * @param {string} resourceType - Type of resource (users, subscriptions, etc.)
   * @param {number} additionalCount - Additional items to add
   * @returns {Promise<object>} Quota check result
   */
  async checkQuota(tenantId, resourceType, additionalCount = 1) {
    try {
      const [limits, usage] = await Promise.all([
        this.getTenantQuotaLimits(tenantId),
        this.getTenantUsage(tenantId)
      ]);

      const limit = limits[`max${resourceType.charAt(0).toUpperCase() + resourceType.slice(1)}`];
      const current = usage[resourceType]?.count || 0;
      
      // Unlimited quota (-1 means unlimited)
      if (limit === -1) {
        return {
          allowed: true,
          current,
          limit: -1,
          remaining: -1,
          percentage: 0
        };
      }

      const remaining = limit - current;
      const allowed = remaining >= additionalCount;
      const percentage = (current / limit) * 100;

      return {
        allowed,
        current,
        limit,
        remaining,
        percentage,
        additionalCount,
        wouldExceed: !allowed
      };
    } catch (error) {
      console.error('Error checking quota:', error);
      // Fail open - allow operation if quota check fails
      return {
        allowed: true,
        error: error.message
      };
    }
  }

  /**
   * Create middleware for quota enforcement
   * @returns {function} Express middleware
   */
  createQuotaMiddleware() {
    return async (req, res, next) => {
      try {
        // Skip quota check for background workers
        if (req.isBackgroundWorker) {
          return next();
        }

        const tenantId = req.tenantId;
        if (!tenantId) {
          return next();
        }

        // Determine resource type based on request
        const resourceType = this.getResourceTypeFromRequest(req);
        if (!resourceType) {
          return next();
        }

        // Only check quota for POST/PUT requests that create resources
        if (!['POST', 'PUT'].includes(req.method)) {
          return next();
        }

        const quotaCheck = await this.checkQuota(tenantId, resourceType);
        
        if (!quotaCheck.allowed) {
          const statusCode = quotaCheck.percentage >= 100 ? 413 : 402;
          return res.status(statusCode).json({
            success: false,
            error: quotaCheck.percentage >= 100 ? 'Payload Too Large' : 'Payment Required',
            message: `Storage quota exceeded for ${resourceType}`,
            quota: {
              current: quotaCheck.current,
              limit: quotaCheck.limit,
              remaining: quotaCheck.remaining,
              percentage: Math.round(quotaCheck.percentage)
            }
          });
        }

        // Attach quota info to request
        req.quotaInfo = quotaCheck;
        next();
      } catch (error) {
        console.error('Quota middleware error:', error);
        next();
      }
    };
  }

  /**
   * Determine resource type from Express request
   * @param {object} req - Express request
   * @returns {string|null} Resource type
   */
  getResourceTypeFromRequest(req) {
    const path = req.path;
    const method = req.method;

    // Map routes to resource types
    const routeMappings = {
      '/api/users': 'users',
      '/api/subscriptions': 'subscriptions',
      '/api/billing-events': 'billingEvents',
      '/api/videos': 'videos'
    };

    for (const [route, resourceType] of Object.entries(routeMappings)) {
      if (path.startsWith(route) && ['POST', 'PUT'].includes(method)) {
        return resourceType;
      }
    }

    return null;
  }

  /**
   * Get tenant tier from database
   * @param {string} tenantId - Tenant ID
   * @returns {Promise<string>} Tenant tier
   */
  async getTenantTier(tenantId) {
    const client = await this.database.pool.connect();
    
    try {
      const result = await client.query(
        'SELECT tier FROM creators WHERE id = $1',
        [tenantId]
      );
      
      return result.rows[0]?.tier || 'free';
    } finally {
      client.release();
    }
  }

  /**
   * Get custom quota overrides for tenant
   * @param {string} tenantId - Tenant ID
   * @returns {Promise<object>} Custom quotas
   */
  async getCustomQuotas(tenantId) {
    const client = await this.database.pool.connect();
    
    try {
      const result = await client.query(
        'SELECT quota_config FROM tenant_quotas WHERE tenant_id = $1',
        [tenantId]
      );
      
      if (result.rows.length > 0) {
        return JSON.parse(result.rows[0].quota_config);
      }
      
      return {};
    } catch (error) {
      console.error('Error getting custom quotas:', error);
      return {};
    } finally {
      client.release();
    }
  }

  /**
   * Set custom quota overrides for tenant
   * @param {string} tenantId - Tenant ID
   * @param {object} quotas - Custom quota configuration
   * @returns {Promise<void>}
   */
  async setCustomQuotas(tenantId, quotas) {
    const client = await this.database.pool.connect();
    
    try {
      await client.query(`
        INSERT INTO tenant_quotas (tenant_id, quota_config, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (tenant_id) 
        DO UPDATE SET 
          quota_config = EXCLUDED.quota_config,
          updated_at = NOW()
      `, [tenantId, JSON.stringify(quotas)]);

      // Clear usage cache
      await this.redisClient.del(`usage:${tenantId}`);
    } finally {
      client.release();
    }
  }

  /**
   * Get quota usage report for tenant
   * @param {string} tenantId - Tenant ID
   * @returns {Promise<object>} Detailed quota report
   */
  async getQuotaReport(tenantId) {
    const [limits, usage] = await Promise.all([
      this.getTenantQuotaLimits(tenantId),
      this.getTenantUsage(tenantId)
    ]);

    const report = {
      tenantId,
      tier: limits.tier,
      limits: {},
      usage: {},
      status: 'healthy'
    };

    // Calculate usage for each resource type
    const resourceTypes = ['users', 'subscriptions', 'billingEvents', 'videos'];
    
    for (const resourceType of resourceTypes) {
      const limitKey = `max${resourceType.charAt(0).toUpperCase() + resourceType.slice(1)}`;
      const limit = limits[limitKey];
      const current = usage[resourceType]?.count || 0;
      
      let percentage = 0;
      let status = 'healthy';
      
      if (limit !== -1) {
        percentage = (current / limit) * 100;
        
        if (percentage >= 100) {
          status = 'exceeded';
          report.status = 'critical';
        } else if (percentage >= 90) {
          status = 'warning';
          if (report.status === 'healthy') report.status = 'warning';
        }
      }

      report.limits[resourceType] = limit;
      report.usage[resourceType] = {
        current,
        limit,
        percentage: Math.round(percentage),
        status
      };
    }

    // Add storage usage
    const storageLimit = limits.maxStorageBytes;
    const storageUsed = usage.total?.bytes || 0;
    
    let storagePercentage = 0;
    let storageStatus = 'healthy';
    
    if (storageLimit !== -1) {
      storagePercentage = (storageUsed / storageLimit) * 100;
      
      if (storagePercentage >= 100) {
        storageStatus = 'exceeded';
        report.status = 'critical';
      } else if (storagePercentage >= 90) {
        storageStatus = 'warning';
        if (report.status === 'healthy') report.status = 'warning';
      }
    }

    report.limits.storage = storageLimit;
    report.usage.storage = {
      current: storageUsed,
      limit: storageLimit,
      percentage: Math.round(storagePercentage),
      status: storageStatus
    };

    return report;
  }

  /**
   * Invalidate usage cache for tenant
   * @param {string} tenantId - Tenant ID
   * @returns {Promise<void>}
   */
  async invalidateUsageCache(tenantId) {
    await this.redisClient.del(`usage:${tenantId}`);
  }
}

module.exports = StorageQuotaService;
