const ApiKeyService = require('../src/services/apiKeyService');

/**
 * API Key Authentication Middleware
 * Handles API key authentication and authorization
 */

/**
 * Create API key authentication middleware
 * @param {object} database - Database instance
 * @param {object} redisService - Redis service instance
 * @returns {function} Express middleware function
 */
function createApiKeyAuthMiddleware(database, redisService) {
  const apiKeyService = new ApiKeyService(database, redisService);

  return async (req, res, next) => {
    try {
      const apiKey = extractApiKeyFromRequest(req);
      
      if (!apiKey) {
        // No API key provided, continue to next middleware
        return next();
      }

      // Validate API key
      const keyInfo = await apiKeyService.validateApiKey(apiKey);
      
      if (!keyInfo) {
        return res.status(401).json({
          success: false,
          error: 'Invalid API key',
          code: 'INVALID_API_KEY'
        });
      }

      // Attach API key info to request
      req.apiKey = keyInfo;
      req.apiKeyService = apiKeyService;
      req.tenantId = keyInfo.tenantId;

      // Log API key usage
      await logApiKeyUsage(keyInfo.id, req);

      next();
    } catch (error) {
      console.error('API key authentication error:', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        code: 'AUTH_ERROR'
      });
    }
  };
}

/**
 * Create API key authorization middleware
 * @param {string} requiredPermission - Required permission
 * @returns {function} Express middleware function
 */
function createApiKeyPermissionMiddleware(requiredPermission) {
  return async (req, res, next) => {
    try {
      // Check if request has API key authentication
      if (!req.apiKey) {
        return res.status(401).json({
          success: false,
          error: 'API key required',
          code: 'API_KEY_REQUIRED'
        });
      }

      // Check permission
      const hasPermission = req.apiKeyService.hasPermission(req.apiKey, requiredPermission);
      
      if (!hasPermission) {
        return res.status(403).json({
          success: false,
          error: 'Insufficient permissions',
          code: 'INSUFFICIENT_PERMISSIONS',
          required: requiredPermission
        });
      }

      next();
    } catch (error) {
      console.error('API key authorization error:', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        code: 'AUTH_ERROR'
      });
    }
  };
}

/**
 * Create multiple permissions middleware
 * @param {Array} requiredPermissions - Array of required permissions
 * @param {string} mode - 'all' or 'any' - whether all or any permissions are required
 * @returns {function} Express middleware function
 */
function createApiKeyMultiplePermissionsMiddleware(requiredPermissions, mode = 'all') {
  return async (req, res, next) => {
    try {
      if (!req.apiKey) {
        return res.status(401).json({
          success: false,
          error: 'API key required',
          code: 'API_KEY_REQUIRED'
        });
      }

      const permissionResults = requiredPermissions.map(permission => ({
        permission,
        granted: req.apiKeyService.hasPermission(req.apiKey, permission)
      }));

      const hasRequiredPermissions = mode === 'all' 
        ? permissionResults.every(result => result.granted)
        : permissionResults.some(result => result.granted);

      if (!hasRequiredPermissions) {
        return res.status(403).json({
          success: false,
          error: 'Insufficient permissions',
          code: 'INSUFFICIENT_PERMISSIONS',
          required: requiredPermissions,
          mode,
          results: permissionResults
        });
      }

      next();
    } catch (error) {
      console.error('API key authorization error:', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        code: 'AUTH_ERROR'
      });
    }
  };
}

/**
 * Create read-only API key middleware
 * @returns {function} Express middleware function
 */
function createReadOnlyApiKeyMiddleware() {
  return createApiKeyMultiplePermissionsMiddleware(
    ['read:subscriptions', 'read:billing_events', 'read:users', 'read:analytics', 'read:videos'],
    'any'
  );
}

/**
 * Create write access API key middleware
 * @returns {function} Express middleware function
 */
function createWriteAccessApiKeyMiddleware() {
  return createApiKeyMultiplePermissionsMiddleware(
    ['write:subscriptions', 'write:billing_events', 'write:users', 'write:analytics', 'write:videos'],
    'any'
  );
}

/**
 * Create admin API key middleware
 * @returns {function} Express middleware function
 */
function createAdminApiKeyMiddleware() {
  return createApiKeyPermissionMiddleware('admin:all');
}

/**
 * Extract API key from request
 * @param {object} req - Express request object
 * @returns {string|null} API key or null
 */
function extractApiKeyFromRequest(req) {
  // Check x-api-key header first
  const headerKey = req.headers['x-api-key'];
  if (headerKey && typeof headerKey === 'string') {
    return headerKey.trim();
  }

  // Check Authorization header with Bearer token
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    if (token.startsWith('sk_')) {
      return token.trim();
    }
  }

  // Check query parameter (less secure, but supported for some use cases)
  const queryKey = req.query.api_key;
  if (queryKey && typeof queryKey === 'string' && queryKey.startsWith('sk_')) {
    return queryKey.trim();
  }

  return null;
}

/**
 * Log API key usage for security audit
 * @param {string} keyId - API key ID
 * @param {object} req - Express request object
 * @returns {Promise<void>}
 */
async function logApiKeyUsage(keyId, req) {
  try {
    // This would log to the database via the API key service
    // For now, we'll just log to console
    console.log(`API Key Usage: ${keyId} - ${req.method} ${req.path} - ${req.ip}`);
    
    // In a full implementation, this would call:
    // await apiKeyService.logApiKeyEvent(tenantId, keyId, 'used', {
    //   method: req.method,
    //   path: req.path,
    //   ip: req.ip,
    //   userAgent: req.headers['user-agent']
    // });
  } catch (error) {
    console.error('Error logging API key usage:', error);
  }
}

/**
 * Create API key rate limiting middleware
 * @param {object} redisClient - Redis client
 * @param {object} options - Rate limiting options
 * @returns {function} Express middleware function
 */
function createApiKeyRateLimitMiddleware(redisClient, options = {}) {
  const {
    windowMs = 60000, // 1 minute
    maxRequests = 1000, // 1000 requests per minute
    keyGenerator = (req) => `api_key_rate_limit:${req.apiKey?.id || req.ip}`
  } = options;

  return async (req, res, next) => {
    try {
      if (!req.apiKey) {
        return next(); // Skip rate limiting for non-API key requests
      }

      const key = keyGenerator(req);
      const current = await redisClient.incr(key);
      
      if (current === 1) {
        await redisClient.expire(key, Math.ceil(windowMs / 1000));
      }

      // Set rate limit headers
      res.set({
        'X-RateLimit-Limit': maxRequests,
        'X-RateLimit-Remaining': Math.max(0, maxRequests - current),
        'X-RateLimit-Reset': new Date(Date.now() + windowMs).toISOString()
      });

      if (current > maxRequests) {
        return res.status(429).json({
          success: false,
          error: 'Too many requests',
          code: 'RATE_LIMIT_EXCEEDED',
          retryAfter: Math.ceil(windowMs / 1000)
        });
      }

      next();
    } catch (error) {
      console.error('Rate limiting error:', error);
      next(); // Continue on error
    }
  };
}

/**
 * Create API key security headers middleware
 * @returns {function} Express middleware function
 */
function createApiKeySecurityHeadersMiddleware() {
  return (req, res, next) => {
    // Set security headers for API requests
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'X-XSS-Protection': '1; mode=block',
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
      'Referrer-Policy': 'strict-origin-when-cross-origin'
    });

    next();
  };
}

/**
 * Create API key context middleware
 * @returns {function} Express middleware function
 */
function createApiKeyContextMiddleware() {
  return (req, res, next) => {
    // Add helper methods to request for API key operations
    req.hasApiKeyPermission = (permission) => {
      return req.apiKeyService ? req.apiKeyService.hasPermission(req.apiKey, permission) : false;
    };

    req.getApiKeyInfo = () => {
      return req.apiKey;
    };

    req.isApiKeyRequest = () => {
      return !!req.apiKey;
    };

    next();
  };
}

module.exports = {
  createApiKeyAuthMiddleware,
  createApiKeyPermissionMiddleware,
  createApiKeyMultiplePermissionsMiddleware,
  createReadOnlyApiKeyMiddleware,
  createWriteAccessApiKeyMiddleware,
  createAdminApiKeyMiddleware,
  createApiKeyRateLimitMiddleware,
  createApiKeySecurityHeadersMiddleware,
  createApiKeyContextMiddleware,
  extractApiKeyFromRequest
};
