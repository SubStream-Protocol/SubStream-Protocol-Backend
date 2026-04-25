const TenantFeatureFlagService = require('../services/tenantFeatureFlagService');

/**
 * Feature Flag Middleware
 * 
 * Protects endpoints based on tenant feature flags
 * Returns 403 Forbidden if flag is disabled
 */
class FeatureFlagMiddleware {
  constructor(database, redisService) {
    this.featureFlagService = new TenantFeatureFlagService(database, redisService);
  }

  /**
   * Create middleware for a specific feature flag
   */
  requireFlag(flagName) {
    return async (req, res, next) => {
      try {
        // Get tenant_id from authenticated request
        const tenantId = this.extractTenantId(req);
        
        if (!tenantId) {
          return res.status(401).json({
            error: 'Unauthorized',
            message: 'Tenant ID required for feature flag evaluation'
          });
        }

        // Evaluate the feature flag
        const result = await this.featureFlagService.evaluateFlag(tenantId, flagName);
        
        // Log evaluation for monitoring
        console.log(`Feature flag evaluation: ${flagName} = ${result.value} for tenant ${tenantId} (${result.evaluationTimeMs}ms, cached: ${result.cached})`);

        if (!result.value) {
          return res.status(403).json({
            error: 'Feature not available',
            message: `The feature '${flagName}' is not enabled for your account`,
            flagName,
            tenantId: tenantId
          });
        }

        // Add flag info to request for downstream use
        req.featureFlag = result;
        req.tenantId = tenantId;
        
        next();

      } catch (error) {
        console.error(`Error evaluating feature flag ${flagName}:`, error);
        
        // Fail safe - deny access if evaluation fails
        return res.status(500).json({
          error: 'Feature evaluation failed',
          message: 'Unable to evaluate feature access'
        });
      }
    };
  }

  /**
   * Create middleware that requires multiple flags (AND logic)
   */
  requireAllFlags(flagNames) {
    return async (req, res, next) => {
      try {
        const tenantId = this.extractTenantId(req);
        
        if (!tenantId) {
          return res.status(401).json({
            error: 'Unauthorized',
            message: 'Tenant ID required for feature flag evaluation'
          });
        }

        const evaluationResults = [];
        let allFlagsEnabled = true;

        // Evaluate each flag
        for (const flagName of flagNames) {
          const result = await this.featureFlagService.evaluateFlag(tenantId, flagName);
          evaluationResults.push(result);
          
          if (!result.value) {
            allFlagsEnabled = false;
          }
        }

        if (!allFlagsEnabled) {
          const disabledFlags = evaluationResults
            .filter(r => !r.value)
            .map(r => r.flagName);

          return res.status(403).json({
            error: 'Features not available',
            message: `The following features are not enabled: ${disabledFlags.join(', ')}`,
            disabledFlags,
            tenantId
          });
        }

        // Add evaluation results to request
        req.featureFlags = evaluationResults;
        req.tenantId = tenantId;
        
        next();

      } catch (error) {
        console.error(`Error evaluating multiple feature flags:`, error);
        
        return res.status(500).json({
          error: 'Feature evaluation failed',
          message: 'Unable to evaluate feature access'
        });
      }
    };
  }

  /**
   * Create middleware that requires at least one flag (OR logic)
   */
  requireAnyFlag(flagNames) {
    return async (req, res, next) => {
      try {
        const tenantId = this.extractTenantId(req);
        
        if (!tenantId) {
          return res.status(401).json({
            error: 'Unauthorized',
            message: 'Tenant ID required for feature flag evaluation'
          });
        }

        const evaluationResults = [];
        let anyFlagEnabled = false;

        // Evaluate each flag
        for (const flagName of flagNames) {
          const result = await this.featureFlagService.evaluateFlag(tenantId, flagName);
          evaluationResults.push(result);
          
          if (result.value) {
            anyFlagEnabled = true;
          }
        }

        if (!anyFlagEnabled) {
          return res.status(403).json({
            error: 'No features available',
            message: `None of the required features are enabled: ${flagNames.join(', ')}`,
            requiredFlags: flagNames,
            tenantId
          });
        }

        // Add evaluation results to request
        req.featureFlags = evaluationResults;
        req.tenantId = tenantId;
        
        next();

      } catch (error) {
        console.error(`Error evaluating any feature flags:`, error);
        
        return res.status(500).json({
          error: 'Feature evaluation failed',
          message: 'Unable to evaluate feature access'
        });
      }
    };
  }

  /**
   * Extract tenant ID from request
   * Supports various authentication methods
   */
  extractTenantId(req) {
    // Try different sources of tenant ID based on auth method
    
    // 1. From JWT token (if using auth middleware)
    if (req.user && req.user.tenantId) {
      return req.user.tenantId;
    }

    // 2. From SEP-10 authentication
    if (req.auth && req.auth.tenantId) {
      return req.auth.tenantId;
    }

    // 3. From API key authentication
    if (req.apiKey && req.apiKey.tenantId) {
      return req.apiKey.tenantId;
    }

    // 4. From header (for testing or internal services)
    if (req.headers['x-tenant-id']) {
      return req.headers['x-tenant-id'];
    }

    // 5. From query parameter (for debugging)
    if (req.query.tenant_id) {
      return req.query.tenant_id;
    }

    return null;
  }

  /**
   * Middleware to add feature flag info to request without restricting access
   */
  addFlagInfo(flagName) {
    return async (req, res, next) => {
      try {
        const tenantId = this.extractTenantId(req);
        
        if (tenantId) {
          const result = await this.featureFlagService.evaluateFlag(tenantId, flagName);
          req.featureFlag = result;
          req.tenantId = tenantId;
        }
        
        next();

      } catch (error) {
        console.error(`Error adding flag info for ${flagName}:`, error);
        // Don't block the request, just continue without flag info
        next();
      }
    };
  }

  /**
   * Middleware to add all feature flags to request without restricting access
   */
  addAllFlagInfo() {
    return async (req, res, next) => {
      try {
        const tenantId = this.extractTenantId(req);
        
        if (tenantId) {
          const result = await this.featureFlagService.getAllFlags(tenantId);
          req.featureFlags = result.flags;
          req.tenantId = tenantId;
        }
        
        next();

      } catch (error) {
        console.error('Error adding all flag info:', error);
        // Don't block the request, just continue without flag info
        next();
      }
    };
  }
}

module.exports = FeatureFlagMiddleware;
