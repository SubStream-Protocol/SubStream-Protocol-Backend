const tenantConfigurationService = require('../src/services/tenantConfigurationService');

/**
 * Feature Flag Middleware
 * 
 * Middleware to protect endpoints based on tenant feature flags.
 * Returns 403 Forbidden if the required flag is disabled for the tenant.
 */
const requireFeatureFlag = (flagName) => {
  return async (req, res, next) => {
    try {
      // Extract tenant_id from authenticated request
      const tenantId = req.user?.tenant_id || req.tenant?.id;
      
      if (!tenantId) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Tenant authentication required'
        });
      }

      // Evaluate the feature flag
      const flagEnabled = await tenantConfigurationService.evaluateFeatureFlag(tenantId, flagName);
      
      if (!flagEnabled) {
        return res.status(403).json({
          error: 'Feature Not Available',
          message: `The feature '${flagName}' is not enabled for your tenant`,
          code: 'FEATURE_FLAG_DISABLED',
          flag_name: flagName
        });
      }

      // Add flag info to request for downstream use
      req.featureFlags = req.featureFlags || {};
      req.featureFlags[flagName] = true;

      next();
    } catch (error) {
      console.error('Feature flag middleware error:', error);
      
      // Fail safe - allow the request but log the error
      // In production, you might want to be more strict
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'Error evaluating feature flags'
      });
    }
  };
};

/**
 * Multiple feature flags middleware
 * Requires ALL specified flags to be enabled
 */
const requireAllFeatureFlags = (flagNames) => {
  return async (req, res, next) => {
    try {
      const tenantId = req.user?.tenant_id || req.tenant?.id;
      
      if (!tenantId) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Tenant authentication required'
        });
      }

      // Evaluate all flags in parallel for performance
      const flagPromises = flagNames.map(flagName => 
        tenantConfigurationService.evaluateFeatureFlag(tenantId, flagName)
      );
      
      const flagResults = await Promise.all(flagPromises);
      
      // Check if all flags are enabled
      const disabledFlags = flagNames.filter((flagName, index) => !flagResults[index]);
      
      if (disabledFlags.length > 0) {
        return res.status(403).json({
          error: 'Features Not Available',
          message: `The following features are not enabled for your tenant: ${disabledFlags.join(', ')}`,
          code: 'FEATURE_FLAGS_DISABLED',
          disabled_flags: disabledFlags
        });
      }

      // Add enabled flags to request
      req.featureFlags = req.featureFlags || {};
      flagNames.forEach((flagName, index) => {
        req.featureFlags[flagName] = flagResults[index];
      });

      next();
    } catch (error) {
      console.error('Multiple feature flags middleware error:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'Error evaluating feature flags'
      });
    }
  };
};

/**
 * Any feature flag middleware
 * Requires AT LEAST ONE of the specified flags to be enabled
 */
const requireAnyFeatureFlag = (flagNames) => {
  return async (req, res, next) => {
    try {
      const tenantId = req.user?.tenant_id || req.tenant?.id;
      
      if (!tenantId) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Tenant authentication required'
        });
      }

      // Evaluate all flags in parallel
      const flagPromises = flagNames.map(flagName => 
        tenantConfigurationService.evaluateFeatureFlag(tenantId, flagName)
      );
      
      const flagResults = await Promise.all(flagPromises);
      
      // Check if any flag is enabled
      const enabledFlags = flagNames.filter((flagName, index) => flagResults[index]);
      
      if (enabledFlags.length === 0) {
        return res.status(403).json({
          error: 'No Features Available',
          message: `None of the required features are enabled for your tenant: ${flagNames.join(', ')}`,
          code: 'NO_FEATURE_FLAGS_ENABLED',
          required_flags: flagNames
        });
      }

      // Add enabled flags to request
      req.featureFlags = req.featureFlags || {};
      flagNames.forEach((flagName, index) => {
        req.featureFlags[flagName] = flagResults[index];
      });

      next();
    } catch (error) {
      console.error('Any feature flag middleware error:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'Error evaluating feature flags'
      });
    }
  };
};

/**
 * Conditional feature flag middleware
 * Executes different middleware based on flag status
 */
const conditionalFeatureFlag = (flagName, ifEnabled, ifDisabled) => {
  return async (req, res, next) => {
    try {
      const tenantId = req.user?.tenant_id || req.tenant?.id;
      
      if (!tenantId) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Tenant authentication required'
        });
      }

      const flagEnabled = await tenantConfigurationService.evaluateFeatureFlag(tenantId, flagName);
      
      // Add flag info to request
      req.featureFlags = req.featureFlags || {};
      req.featureFlags[flagName] = flagEnabled;

      // Execute appropriate middleware
      if (flagEnabled && ifEnabled) {
        return ifEnabled(req, res, next);
      } else if (!flagEnabled && ifDisabled) {
        return ifDisabled(req, res, next);
      } else {
        next();
      }
    } catch (error) {
      console.error('Conditional feature flag middleware error:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'Error evaluating feature flags'
      });
    }
  };
};

module.exports = {
  requireFeatureFlag,
  requireAllFeatureFlags,
  requireAnyFeatureFlag,
  conditionalFeatureFlag
};
