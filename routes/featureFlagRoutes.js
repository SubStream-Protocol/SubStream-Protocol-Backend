const express = require('express');
const FeatureFlagController = require('../src/controllers/featureFlagController');
const FeatureFlagMiddleware = require('../src/middleware/featureFlagMiddleware');

/**
 * Feature Flag Routes
 * 
 * Defines API endpoints for tenant feature flag management
 */
function createFeatureFlagRoutes(database, redisService) {
  const router = express.Router();
  const controller = new FeatureFlagController(database, redisService);
  const middleware = new FeatureFlagMiddleware(database, redisService);

  // Public/Authenticated endpoints for tenants to check their flags
  
  /**
   * GET /api/v1/config/flags
   * Get all feature flags for the authenticated tenant
   */
  router.get('/flags', controller.getFlags.bind(controller));

  /**
   * GET /api/v1/config/flags/:flagName
   * Get a specific feature flag
   */
  router.get('/flags/:flagName', controller.getFlag.bind(controller));

  // Admin-only endpoints for managing flags
  
  /**
   * PUT /api/v1/admin/config/flags/:tenantId/:flagName
   * Update a feature flag for a specific tenant
   * 
   * Body: { value: boolean, changeReason?: string }
   */
  router.put('/admin/config/flags/:tenantId/:flagName', 
    // TODO: Add admin authentication middleware
    controller.updateFlag.bind(controller)
  );

  /**
   * PUT /api/v1/admin/config/flags/:tenantId/bulk
   * Bulk update multiple flags for a specific tenant
   * 
   * Body: { flags: [{ flagName: string, value: boolean }], changeReason?: string }
   */
  router.put('/admin/config/flags/:tenantId/bulk',
    // TODO: Add admin authentication middleware
    controller.bulkUpdateFlags.bind(controller)
  );

  /**
   * GET /api/v1/admin/config/flags/:tenantId/audit
   * Get audit log for a tenant's feature flags
   * 
   * Query: { flagName?: string, limit?: number, offset?: number }
   */
  router.get('/admin/config/flags/:tenantId/audit',
    // TODO: Add admin authentication middleware
    controller.getAuditLog.bind(controller)
  );

  /**
   * POST /api/v1/admin/config/flags/:tenantId/initialize
   * Initialize default flags for a new tenant
   */
  router.post('/admin/config/flags/:tenantId/initialize',
    // TODO: Add admin authentication middleware
    controller.initializeTenantFlags.bind(controller)
  );

  /**
   * GET /api/v1/admin/config/flags/performance
   * Get feature flag performance metrics
   */
  router.get('/admin/config/flags/performance',
    // TODO: Add admin authentication middleware
    controller.getPerformanceMetrics.bind(controller)
  );

  // Example of protected endpoints using feature flags
  
  /**
   * GET /api/v1/crypto/checkout
   * Example: Crypto checkout endpoint protected by feature flag
   */
  router.get('/crypto/checkout', 
    middleware.requireFlag('enable_crypto_checkout'),
    (req, res) => {
      res.json({
        success: true,
        message: 'Crypto checkout is enabled for your account',
        tenantId: req.tenantId
      });
    }
  );

  /**
   * GET /api/v1/b2b/invoicing
   * Example: B2B invoicing endpoint protected by feature flag
   */
  router.get('/b2b/invoicing',
    middleware.requireFlag('enable_b2b_invoicing'),
    (req, res) => {
      res.json({
        success: true,
        message: 'B2B invoicing is enabled for your account',
        tenantId: req.tenantId
      });
    }
  );

  /**
   * GET /api/v1/analytics/advanced
   * Example: Advanced analytics endpoint protected by feature flag
   */
  router.get('/analytics/advanced',
    middleware.requireFlag('enable_advanced_analytics'),
    (req, res) => {
      res.json({
        success: true,
        message: 'Advanced analytics is enabled for your account',
        tenantId: req.tenantId
      });
    }
  );

  /**
   * GET /api/v1/webhooks/configure
   * Example: API webhooks endpoint protected by feature flag
   */
  router.get('/webhooks/configure',
    middleware.requireFlag('enable_api_webhooks'),
    (req, res) => {
      res.json({
        success: true,
        message: 'API webhooks are enabled for your account',
        tenantId: req.tenantId
      });
    }
  );

  /**
   * GET /api/v1/branding/custom
   * Example: Custom branding endpoint protected by feature flag
   */
  router.get('/branding/custom',
    middleware.requireFlag('enable_custom_branding'),
    (req, res) => {
      res.json({
        success: true,
        message: 'Custom branding is enabled for your account',
        tenantId: req.tenantId
      });
    }
  );

  /**
   * GET /api/v1/support/priority
   * Example: Priority support endpoint protected by feature flag
   */
  router.get('/support/priority',
    middleware.requireFlag('enable_priority_support'),
    (req, res) => {
      res.json({
        success: true,
        message: 'Priority support is enabled for your account',
        tenantId: req.tenantId
      });
    }
  );

  /**
   * GET /api/v1/operations/bulk
   * Example: Bulk operations endpoint protected by feature flag
   */
  router.get('/operations/bulk',
    middleware.requireFlag('enable_bulk_operations'),
    (req, res) => {
      res.json({
        success: true,
        message: 'Bulk operations are enabled for your account',
        tenantId: req.tenantId
      });
    }
  );

  /**
   * GET /api/v1/subscription/create
   * Example: Subscription creation with optional KYC requirement
   */
  router.get('/subscription/create',
    middleware.addFlagInfo('require_kyc_for_subs'),
    (req, res) => {
      const kycRequired = req.featureFlag?.value || false;
      
      res.json({
        success: true,
        message: 'Subscription creation endpoint',
        tenantId: req.tenantId,
        kycRequired,
        kycMessage: kycRequired 
          ? 'KYC verification is required before creating subscriptions'
          : 'KYC verification is not required'
      });
    }
  );

  return router;
}

module.exports = createFeatureFlagRoutes;
