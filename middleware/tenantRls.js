const RLSService = require('../src/services/rlsService');

/**
 * Tenant RLS Middleware
 * Integrates Row-Level Security with existing authentication system
 * Extracts tenant_id from authenticated user and sets database context
 */

/**
 * Create tenant RLS middleware
 * @param {object} database - Database instance
 * @returns {function} Express middleware function
 */
function createTenantRLSMiddleware(database) {
  const rlsService = new RLSService(database);

  return async (req, res, next) => {
    try {
      // Extract tenant ID from authenticated user
      const tenantId = extractTenantIdFromRequest(req);
      
      if (!tenantId) {
        // For unauthenticated requests, we don't set tenant context
        // RLS policies will return empty results
        req.tenantId = null;
        req.rlsService = rlsService;
        return next();
      }

      // Validate tenant ID format (should be Stellar public key)
      if (!isValidStellarPublicKey(tenantId)) {
        return res.status(401).json({
          success: false,
          error: 'Invalid tenant ID format'
        });
      }

      // Attach RLS service and tenant ID to request
      req.tenantId = tenantId;
      req.rlsService = rlsService;

      // Create helper function for setting tenant context in database operations
      req.setTenantContext = async (client = null) => {
        await rlsService.setTenantContext(tenantId, client);
      };

      // Create helper function for tenant-aware queries
      req.queryWithTenant = async (query, params = []) => {
        return await rlsService.queryWithTenant(tenantId, query, params);
      };

      // Create helper function for tenant transactions
      req.transactionWithTenant = async (callback) => {
        return await rlsService.transactionWithTenant(tenantId, callback);
      };

      next();
    } catch (error) {
      console.error('Tenant RLS middleware error:', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error'
      });
    }
  };
}

/**
 * Extract tenant ID from request based on authentication method
 * @param {object} req - Express request object
 * @returns {string|null} Tenant ID or null if not authenticated
 */
function extractTenantIdFromRequest(req) {
  // Check for SEP-10 JWT authentication (Stellar public key)
  if (req.user && req.user.address) {
    return req.user.address;
  }

  // Check for API key authentication
  if (req.apiKeyTenant) {
    return req.apiKeyTenant;
  }

  // Check for direct tenant header (for internal services)
  if (req.headers['x-tenant-id']) {
    return req.headers['x-tenant-id'];
  }

  // Check for legacy authentication methods
  if (req.stellarPublicKey) {
    return req.stellarPublicKey;
  }

  return null;
}

/**
 * Validate Stellar public key format
 * @param {string} publicKey - Stellar public key to validate
 * @returns {boolean} True if valid format
 */
function isValidStellarPublicKey(publicKey) {
  if (!publicKey || typeof publicKey !== 'string') {
    return false;
  }

  // Stellar public keys are 56 characters long and start with 'G'
  const stellarPublicKeyRegex = /^G[A-Z0-9]{55}$/;
  return stellarPublicKeyRegex.test(publicKey);
}

/**
 * Create API key tenant extraction middleware
 * This middleware should run before the tenant RLS middleware
 * @returns {function} Express middleware function
 */
function createApiKeyTenantMiddleware() {
  return async (req, res, next) => {
    try {
      const apiKey = req.headers['x-api-key'];
      
      if (!apiKey) {
        return next();
      }

      // Look up API key in database to get associated tenant
      // This would be implemented with the API key service
      // For now, we'll extract tenant from API key format
      // In production, this should validate against the database
      
      // Skip API key validation for now - will be implemented in issue #159
      next();
    } catch (error) {
      console.error('API key tenant middleware error:', error);
      next();
    }
  };
}

/**
 * Background worker middleware that bypasses RLS
 * @param {object} database - Database instance
 * @returns {function} Express middleware function
 */
function createBackgroundWorkerMiddleware(database) {
  const rlsService = new RLSService(database);

  return async (req, res, next) => {
    try {
      // Attach RLS service with bypass capabilities
      req.rlsService = rlsService;
      req.isBackgroundWorker = true;

      // Create helper function for bypassing RLS
      req.queryBypassingRLS = async (query, params = []) => {
        return await rlsService.queryBypassingRLS(query, params);
      };

      // Create helper function for bypass client
      req.createBypassRLSClient = async () => {
        return await rlsService.createBypassRLSClient();
      };

      next();
    } catch (error) {
      console.error('Background worker middleware error:', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error'
      });
    }
  };
}

/**
 * Security verification middleware for RLS compliance
 * This can be used in development/testing to verify RLS is working
 * @param {object} database - Database instance
 * @returns {function} Express middleware function
 */
function createRLSVerificationMiddleware(database) {
  const rlsService = new RLSService(database);

  return async (req, res, next) => {
    // Only run in development or when explicitly requested
    if (process.env.NODE_ENV !== 'development' && !req.headers['x-verify-rls']) {
      return next();
    }

    try {
      if (!req.tenantId) {
        return next();
      }

      const verification = await rlsService.verifyRLSForTenant(req.tenantId);
      
      if (!verification.success) {
        console.error('RLS verification failed:', verification);
        
        // In development, return the verification results
        if (process.env.NODE_ENV === 'development') {
          return res.status(500).json({
            success: false,
            error: 'RLS verification failed',
            verification
          });
        }
      }

      // Attach verification results to request for monitoring
      req.rlsVerification = verification;
      next();
    } catch (error) {
      console.error('RLS verification middleware error:', error);
      next();
    }
  };
}

module.exports = {
  createTenantRLSMiddleware,
  createApiKeyTenantMiddleware,
  createBackgroundWorkerMiddleware,
  createRLSVerificationMiddleware,
  extractTenantIdFromRequest,
  isValidStellarPublicKey
};
