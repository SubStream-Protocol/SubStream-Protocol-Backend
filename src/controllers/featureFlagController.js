const TenantFeatureFlagService = require('../services/tenantFeatureFlagService');

/**
 * Feature Flag Controller
 * 
 * Handles HTTP requests for tenant feature flag management
 */
class FeatureFlagController {
  constructor(database, redisService) {
    this.featureFlagService = new TenantFeatureFlagService(database, redisService);
  }

  /**
   * GET /api/v1/config/flags
   * Get all feature flags for the authenticated tenant
   */
  async getFlags(req, res) {
    try {
      const tenantId = req.tenantId || this.extractTenantId(req);
      
      if (!tenantId) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Tenant ID required'
        });
      }

      const result = await this.featureFlagService.getAllFlags(tenantId);

      res.json({
        success: true,
        data: {
          tenantId: result.tenantId,
          flags: result.flags,
          cached: result.cached,
          evaluationTimeMs: result.evaluationTimeMs
        }
      });

    } catch (error) {
      console.error('Error getting feature flags:', error);
      res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to retrieve feature flags'
      });
    }
  }

  /**
   * GET /api/v1/config/flags/:flagName
   * Get a specific feature flag
   */
  async getFlag(req, res) {
    try {
      const { flagName } = req.params;
      const tenantId = req.tenantId || this.extractTenantId(req);
      
      if (!tenantId) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Tenant ID required'
        });
      }

      const result = await this.featureFlagService.evaluateFlag(tenantId, flagName);

      res.json({
        success: true,
        data: {
          tenantId,
          flagName: result.flagName,
          value: result.value,
          cached: result.cached,
          evaluationTimeMs: result.evaluationTimeMs
        }
      });

    } catch (error) {
      console.error(`Error getting feature flag ${req.params.flagName}:`, error);
      res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to retrieve feature flag'
      });
    }
  }

  /**
   * PUT /api/v1/config/flags/:flagName
   * Update a feature flag (admin only)
   */
  async updateFlag(req, res) {
    try {
      const { flagName } = req.params;
      const { value, changeReason } = req.body;
      const tenantId = req.params.tenantId || req.body.tenantId || this.extractTenantId(req);
      
      if (!tenantId) {
        return res.status(400).json({
          error: 'Bad request',
          message: 'Tenant ID required'
        });
      }

      if (typeof value !== 'boolean') {
        return res.status(400).json({
          error: 'Bad request',
          message: 'Flag value must be a boolean'
        });
      }

      const changedBy = req.user?.email || req.auth?.email || 'system';
      
      const result = await this.featureFlagService.updateFlag(
        tenantId, 
        flagName, 
        value, 
        changedBy, 
        changeReason
      );

      res.json({
        success: true,
        data: result
      });

    } catch (error) {
      console.error(`Error updating feature flag ${req.params.flagName}:`, error);
      res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to update feature flag'
      });
    }
  }

  /**
   * PUT /api/v1/admin/config/flags/:tenantId/bulk
   * Bulk update multiple flags (admin only)
   */
  async bulkUpdateFlags(req, res) {
    try {
      const { tenantId } = req.params;
      const { flags, changeReason } = req.body;
      
      if (!tenantId) {
        return res.status(400).json({
          error: 'Bad request',
          message: 'Tenant ID required'
        });
      }

      if (!Array.isArray(flags) || flags.length === 0) {
        return res.status(400).json({
          error: 'Bad request',
          message: 'Flags array is required'
        });
      }

      // Validate flag format
      for (const flag of flags) {
        if (!flag.flagName || typeof flag.value !== 'boolean') {
          return res.status(400).json({
            error: 'Bad request',
            message: 'Each flag must have flagName (string) and value (boolean)'
          });
        }
      }

      const changedBy = req.user?.email || req.auth?.email || 'system';
      
      const result = await this.featureFlagService.bulkUpdateFlags(
        tenantId, 
        flags, 
        changedBy, 
        changeReason
      );

      res.json({
        success: true,
        data: result
      });

    } catch (error) {
      console.error(`Error bulk updating flags for tenant ${req.params.tenantId}:`, error);
      res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to bulk update feature flags'
      });
    }
  }

  /**
   * GET /api/v1/admin/config/flags/:tenantId/audit
   * Get audit log for a tenant's flags (admin only)
   */
  async getAuditLog(req, res) {
    try {
      const { tenantId } = req.params;
      const { flagName, limit = 100, offset = 0 } = req.query;
      
      const result = await this.featureFlagService.getAuditLog(
        tenantId, 
        flagName, 
        parseInt(limit), 
        parseInt(offset)
      );

      res.json({
        success: true,
        data: result
      });

    } catch (error) {
      console.error(`Error getting audit log for tenant ${req.params.tenantId}:`, error);
      res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to retrieve audit log'
      });
    }
  }

  /**
   * POST /api/v1/admin/config/flags/:tenantId/initialize
   * Initialize default flags for a new tenant (admin only)
   */
  async initializeTenantFlags(req, res) {
    try {
      const { tenantId } = req.params;
      
      const result = await this.featureFlagService.initializeTenantFlags(tenantId);

      res.json({
        success: true,
        data: result
      });

    } catch (error) {
      console.error(`Error initializing flags for tenant ${req.params.tenantId}:`, error);
      res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to initialize tenant flags'
      });
    }
  }

  /**
   * GET /api/v1/admin/config/flags/performance
   * Get feature flag performance metrics (admin only)
   */
  async getPerformanceMetrics(req, res) {
    try {
      const metrics = await this.featureFlagService.getPerformanceMetrics();

      res.json({
        success: true,
        data: metrics
      });

    } catch (error) {
      console.error('Error getting performance metrics:', error);
      res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to retrieve performance metrics'
      });
    }
  }

  /**
   * Extract tenant ID from request
   */
  extractTenantId(req) {
    // Try different sources of tenant ID based on auth method
    
    if (req.user && req.user.tenantId) {
      return req.user.tenantId;
    }

    if (req.auth && req.auth.tenantId) {
      return req.auth.tenantId;
    }

    if (req.apiKey && req.apiKey.tenantId) {
      return req.apiKey.tenantId;
    }

    if (req.headers['x-tenant-id']) {
      return req.headers['x-tenant-id'];
    }

    if (req.query.tenant_id) {
      return req.query.tenant_id;
    }

    return null;
  }
}

module.exports = FeatureFlagController;
