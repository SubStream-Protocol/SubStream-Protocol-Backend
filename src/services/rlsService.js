/**
 * Row-Level Security Service
 * Handles tenant context injection for PostgreSQL RLS policies
 */

class RLSService {
  constructor(database) {
    this.database = database;
  }

  /**
   * Set tenant context for the current database session
   * This must be called before any queries that require RLS filtering
   * @param {string} tenantId - The tenant ID (Stellar public key)
   * @param {object} client - Database client (optional, will use pool if not provided)
   */
  async setTenantContext(tenantId, client = null) {
    if (!tenantId || typeof tenantId !== 'string') {
      throw new Error('Valid tenant ID is required');
    }

    const dbClient = client || this.database.pool;
    
    try {
      await dbClient.query('SELECT set_tenant_context($1)', [tenantId]);
    } catch (error) {
      console.error('Failed to set tenant context:', error);
      throw new Error(`Failed to set tenant context: ${error.message}`);
    }
  }

  /**
   * Create a database client with tenant context automatically set
   * @param {string} tenantId - The tenant ID
   * @returns {Promise<object>} Database client with tenant context
   */
  async createTenantClient(tenantId) {
    const client = await this.database.pool.connect();
    
    try {
      await this.setTenantContext(tenantId, client);
      return client;
    } catch (error) {
      client.release();
      throw error;
    }
  }

  /**
   * Execute a query with automatic tenant context
   * @param {string} tenantId - The tenant ID
   * @param {string} query - SQL query
   * @param {array} params - Query parameters
   * @returns {Promise<object>} Query result
   */
  async queryWithTenant(tenantId, query, params = []) {
    const client = await this.createTenantClient(tenantId);
    
    try {
      const result = await client.query(query, params);
      return result;
    } finally {
      client.release();
    }
  }

  /**
   * Execute multiple queries in a transaction with tenant context
   * @param {string} tenantId - The tenant ID
   * @param {function} callback - Function that receives the client and should perform queries
   * @returns {Promise<any>} Result of the callback
   */
  async transactionWithTenant(tenantId, callback) {
    const client = await this.createTenantClient(tenantId);
    
    try {
      await client.query('BEGIN');
      await this.setTenantContext(tenantId, client);
      
      const result = await callback(client);
      
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Create a middleware function for Express that sets tenant context
   * @param {function} getTenantId - Function to extract tenant ID from request
   * @returns {function} Express middleware function
   */
  createTenantMiddleware(getTenantId) {
    return async (req, res, next) => {
      try {
        const tenantId = getTenantId(req);
        
        if (!tenantId) {
          return res.status(401).json({
            success: false,
            error: 'Tenant ID required'
          });
        }

        // Attach RLS service and tenant ID to request
        req.rlsService = this;
        req.tenantId = tenantId;

        // Set tenant context for any database operations in this request
        req.setTenantContext = async (client = null) => {
          await this.setTenantContext(tenantId, client);
        };

        next();
      } catch (error) {
        console.error('Tenant middleware error:', error);
        res.status(500).json({
          success: false,
          error: 'Internal server error'
        });
      }
    };
  }

  /**
   * Verify that RLS is working correctly for a tenant
   * @param {string} tenantId - The tenant ID to test
   * @returns {Promise<object>} Test results
   */
  async verifyRLSForTenant(tenantId) {
    const results = {
      tenantId,
      tests: [],
      passed: 0,
      failed: 0
    };

    try {
      // Test 1: Can only access own subscriptions
      try {
        const ownSubscriptions = await this.queryWithTenant(
          tenantId,
          'SELECT COUNT(*) as count FROM subscriptions WHERE tenant_id = $1',
          [tenantId]
        );

        const allSubscriptions = await this.queryWithTenant(
          tenantId,
          'SELECT COUNT(*) as count FROM subscriptions'
        );

        const testPassed = ownSubscriptions.rows[0].count === allSubscriptions.rows[0].count;
        
        results.tests.push({
          name: 'Own subscriptions access',
          passed: testPassed,
          details: {
            ownCount: ownSubscriptions.rows[0].count,
            totalCount: allSubscriptions.rows[0].count
          }
        });

        if (testPassed) results.passed++;
        else results.failed++;

      } catch (error) {
        results.tests.push({
          name: 'Own subscriptions access',
          passed: false,
          error: error.message
        });
        results.failed++;
      }

      // Test 2: Cannot access other tenants' data
      try {
        // Try to access data with a different tenant context
        const otherTenantData = await this.queryWithTenant(
          'different-tenant-id',
          'SELECT COUNT(*) as count FROM subscriptions'
        );

        const testPassed = parseInt(otherTenantData.rows[0].count) === 0;
        
        results.tests.push({
          name: 'Other tenant data isolation',
          passed: testPassed,
          details: {
            otherTenantCount: otherTenantData.rows[0].count
          }
        });

        if (testPassed) results.passed++;
        else results.failed++;

      } catch (error) {
        results.tests.push({
          name: 'Other tenant data isolation',
          passed: false,
          error: error.message
        });
        results.failed++;
      }

      // Test 3: Billing events isolation
      try {
        const ownBillingEvents = await this.queryWithTenant(
          tenantId,
          'SELECT COUNT(*) as count FROM billing_events WHERE tenant_id = $1',
          [tenantId]
        );

        const allBillingEvents = await this.queryWithTenant(
          tenantId,
          'SELECT COUNT(*) as count FROM billing_events'
        );

        const testPassed = ownBillingEvents.rows[0].count === allBillingEvents.rows[0].count;
        
        results.tests.push({
          name: 'Billing events isolation',
          passed: testPassed,
          details: {
            ownCount: ownBillingEvents.rows[0].count,
            totalCount: allBillingEvents.rows[0].count
          }
        });

        if (testPassed) results.passed++;
        else results.failed++;

      } catch (error) {
        results.tests.push({
          name: 'Billing events isolation',
          passed: false,
          error: error.message
        });
        results.failed++;
      }

    } catch (error) {
      results.tests.push({
        name: 'RLS verification setup',
        passed: false,
        error: error.message
      });
      results.failed++;
    }

    results.success = results.failed === 0;
    return results;
  }

  /**
   * Get current tenant ID from database context
   * @param {object} client - Database client (optional)
   * @returns {Promise<string|null>} Current tenant ID
   */
  async getCurrentTenantId(client = null) {
    const dbClient = client || this.database.pool;
    
    try {
      const result = await dbClient.query('SELECT get_current_tenant_id() as tenant_id');
      return result.rows[0]?.tenant_id || null;
    } catch (error) {
      console.error('Failed to get current tenant ID:', error);
      return null;
    }
  }

  /**
   * Create a background worker client that bypasses RLS
   * @returns {Promise<object>} Database client with RLS bypass
   */
  async createBypassRLSClient() {
    const client = await this.database.pool.connect();
    
    try {
      // Set role to bypass_rls if it exists
      await client.query('SET ROLE bypass_rls');
      return client;
    } catch (error) {
      // If bypass_rls role doesn't exist, continue with normal client
      console.warn('bypass_rls role not found, using normal client:', error.message);
      return client;
    }
  }

  /**
   * Execute a query bypassing RLS (for background workers)
   * @param {string} query - SQL query
   * @param {array} params - Query parameters
   * @returns {Promise<object>} Query result
   */
  async queryBypassingRLS(query, params = []) {
    const client = await this.createBypassRLSClient();
    
    try {
      const result = await client.query(query, params);
      return result;
    } finally {
      client.release();
    }
  }
}

module.exports = RLSService;
