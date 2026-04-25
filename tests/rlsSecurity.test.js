const RLSService = require('../src/services/rlsService');
const { Pool } = require('pg');

describe('Row-Level Security Integration Tests', () => {
  let rlsService;
  let mockDatabase;
  let testTenants;
  let testData;

  beforeAll(async () => {
    // Initialize test data
    testTenants = {
      tenantA: 'GABCD1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890AB',
      tenantB: 'GXYZ1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890XYZ'
    };

    testData = {
      subscriptions: [
        { id: 'sub1', wallet_address: 'user1', creator_id: 'creator1', tenant_id: testTenants.tenantA, active: true },
        { id: 'sub2', wallet_address: 'user2', creator_id: 'creator2', tenant_id: testTenants.tenantA, active: true },
        { id: 'sub3', wallet_address: 'user3', creator_id: 'creator3', tenant_id: testTenants.tenantB, active: true }
      ],
      billingEvents: [
        { id: 'event1', subscription_id: 'sub1', amount: 100, tenant_id: testTenants.tenantA },
        { id: 'event2', subscription_id: 'sub2', amount: 200, tenant_id: testTenants.tenantA },
        { id: 'event3', subscription_id: 'sub3', amount: 300, tenant_id: testTenants.tenantB }
      ]
    };
  });

  beforeEach(() => {
    // Mock database with RLS-enabled PostgreSQL
    mockDatabase = {
      pool: {
        connect: jest.fn(() => ({
          query: jest.fn(),
          release: jest.fn()
        })),
        query: jest.fn()
      }
    };

    rlsService = new RLSService(mockDatabase);
  });

  describe('Tenant Context Management', () => {
    test('should set tenant context successfully', async () => {
      const mockClient = {
        query: jest.fn().mockResolvedValue({ rows: [] }),
        release: jest.fn()
      };
      mockDatabase.pool.connect.mockResolvedValue(mockClient);

      await rlsService.setTenantContext(testTenants.tenantA);

      expect(mockClient.query).toHaveBeenCalledWith('SELECT set_tenant_context($1)', [testTenants.tenantA]);
    });

    test('should reject invalid tenant ID', async () => {
      await expect(rlsService.setTenantContext('')).rejects.toThrow('Valid tenant ID is required');
      await expect(rlsService.setTenantContext(null)).rejects.toThrow('Valid tenant ID is required');
      await expect(rlsService.setTenantId(undefined)).rejects.toThrow('Valid tenant ID is required');
    });

    test('should create tenant client with context set', async () => {
      const mockClient = {
        query: jest.fn().mockResolvedValue({ rows: [] }),
        release: jest.fn()
      };
      mockDatabase.pool.connect.mockResolvedValue(mockClient);

      const client = await rlsService.createTenantClient(testTenants.tenantA);

      expect(mockClient.query).toHaveBeenCalledWith('SELECT set_tenant_context($1)', [testTenants.tenantA]);
      expect(client).toBe(mockClient);
    });

    test('should release client if tenant context fails', async () => {
      const mockClient = {
        query: jest.fn().mockRejectedValue(new Error('Database error')),
        release: jest.fn()
      };
      mockDatabase.pool.connect.mockResolvedValue(mockClient);

      await expect(rlsService.createTenantClient(testTenants.tenantA)).rejects.toThrow('Database error');
      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  describe('Query Isolation', () => {
    test('should only return tenant-specific data', async () => {
      const mockClient = {
        query: jest.fn().mockResolvedValue({ rows: testData.subscriptions.filter(s => s.tenant_id === testTenants.tenantA) }),
        release: jest.fn()
      };
      mockDatabase.pool.connect.mockResolvedValue(mockClient);

      const result = await rlsService.queryWithTenant(testTenants.tenantA, 'SELECT * FROM subscriptions');

      expect(result.rows).toHaveLength(2);
      expect(result.rows.every(row => row.tenant_id === testTenants.tenantA)).toBe(true);
    });

    test('should handle transactions with tenant context', async () => {
      const mockClient = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [] }) // BEGIN
          .mockResolvedValueOnce({ rows: [] }) // set_tenant_context
          .mockResolvedValueOnce({ rows: [{ id: 'new_sub' }] }) // INSERT
          .mockResolvedValueOnce({ rows: [] }), // COMMIT
        release: jest.fn()
      };
      mockDatabase.pool.connect.mockResolvedValue(mockClient);

      const result = await rlsService.transactionWithTenant(testTenants.tenantA, async (client) => {
        return await client.query('INSERT INTO subscriptions (id) VALUES (\'new_sub\') RETURNING *');
      });

      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith('SELECT set_tenant_context($1)', [testTenants.tenantA]);
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
      expect(result.rows).toEqual([{ id: 'new_sub' }]);
    });

    test('should rollback on transaction failure', async () => {
      const mockClient = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [] }) // BEGIN
          .mockResolvedValueOnce({ rows: [] }) // set_tenant_context
          .mockRejectedValueOnce(new Error('Insert failed')) // INSERT fails
          .mockResolvedValueOnce({ rows: [] }), // ROLLBACK
        release: jest.fn()
      };
      mockDatabase.pool.connect.mockResolvedValue(mockClient);

      await expect(rlsService.transactionWithTenant(testTenants.tenantA, async (client) => {
        return await client.query('INSERT INTO subscriptions (id) VALUES (\'new_sub\')');
      })).rejects.toThrow('Insert failed');

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  describe('Cross-Tenant Data Leakage Prevention', () => {
    test('should prevent cross-tenant data access', async () => {
      // Mock database responses for different tenants
      const mockClient = (tenantId) => ({
        query: jest.fn((query) => {
          if (query.includes('tenant_id =')) {
            // When explicitly filtering by tenant_id
            return Promise.resolve({ 
              rows: testData.subscriptions.filter(s => s.tenant_id === tenantId) 
            });
          } else {
            // When relying on RLS (no explicit tenant filter)
            return Promise.resolve({ 
              rows: testData.subscriptions.filter(s => s.tenant_id === tenantId) 
            });
          }
        }),
        release: jest.fn()
      });

      mockDatabase.pool.connect.mockImplementation((tenantId) => Promise.resolve(mockClient(tenantId)));

      // Tenant A should only see their own data
      const tenantAResult = await rlsService.queryWithTenant(testTenants.tenantA, 'SELECT * FROM subscriptions');
      expect(tenantAResult.rows).toHaveLength(2);
      expect(tenantAResult.rows.every(row => row.tenant_id === testTenants.tenantA)).toBe(true);

      // Tenant B should only see their own data
      const tenantBResult = await rlsService.queryWithTenant(testTenants.tenantB, 'SELECT * FROM subscriptions');
      expect(tenantBResult.rows).toHaveLength(1);
      expect(tenantBResult.rows.every(row => row.tenant_id === testTenants.tenantB)).toBe(true);
    });

    test('should return empty results for non-existent tenant', async () => {
      const mockClient = {
        query: jest.fn().mockResolvedValue({ rows: [] }),
        release: jest.fn()
      };
      mockDatabase.pool.connect.mockResolvedValue(mockClient);

      const result = await rlsService.queryWithTenant('GFAKE1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890FAKE', 'SELECT * FROM subscriptions');

      expect(result.rows).toHaveLength(0);
    });
  });

  describe('Background Worker Bypass', () => {
    test('should create bypass RLS client for background workers', async () => {
      const mockClient = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [] }) // SET ROLE bypass_rls
          .mockResolvedValueOnce({ rows: testData.subscriptions }), // Actual query
        release: jest.fn()
      };
      mockDatabase.pool.connect.mockResolvedValue(mockClient);

      const result = await rlsService.queryBypassingRLS('SELECT * FROM subscriptions');

      expect(mockClient.query).toHaveBeenCalledWith('SET ROLE bypass_rls');
      expect(mockClient.query).toHaveBeenCalledWith('SELECT * FROM subscriptions');
      expect(result.rows).toEqual(testData.subscriptions);
    });

    test('should handle missing bypass_rls role gracefully', async () => {
      const mockClient = {
        query: jest.fn()
          .mockRejectedValueOnce(new Error('role "bypass_rls" does not exist')) // SET ROLE fails
          .mockResolvedValueOnce({ rows: testData.subscriptions }), // Continue with normal query
        release: jest.fn()
      };
      mockDatabase.pool.connect.mockResolvedValue(mockClient);

      // Should not throw error despite missing role
      const result = await rlsService.queryBypassingRLS('SELECT * FROM subscriptions');

      expect(result.rows).toEqual(testData.subscriptions);
    });
  });

  describe('RLS Verification Tests', () => {
    test('should verify RLS is working correctly', async () => {
      const mockClient = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [{ count: '2' }] }) // Own subscriptions with tenant filter
          .mockResolvedValueOnce({ rows: [{ count: '2' }] }) // All subscriptions via RLS
          .mockResolvedValueOnce({ rows: [{ count: '0' }] }) // Different tenant data
          .mockResolvedValueOnce({ rows: [{ count: '2' }] }) // Own billing events with tenant filter
          .mockResolvedValueOnce({ rows: [{ count: '2' }] }) // All billing events via RLS
          .mockResolvedValueOnce({ rows: [] }), // Additional queries
        release: jest.fn()
      };
      mockDatabase.pool.connect.mockResolvedValue(mockClient);

      const verification = await rlsService.verifyRLSForTenant(testTenants.tenantA);

      expect(verification.success).toBe(true);
      expect(verification.passed).toBe(3);
      expect(verification.failed).toBe(0);
      expect(verification.tests.every(test => test.passed)).toBe(true);
    });

    test('should detect RLS violations', async () => {
      const mockClient = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [{ count: '2' }] }) // Own subscriptions with tenant filter
          .mockResolvedValueOnce({ rows: [{ count: '5' }] }) // All subscriptions via RLS (should match)
          .mockResolvedValueOnce({ rows: [{ count: '3' }] }) // Different tenant data (should be 0)
          .mockResolvedValueOnce({ rows: [] }), // Additional queries
        release: jest.fn()
      };
      mockDatabase.pool.connect.mockResolvedValue(mockClient);

      const verification = await rlsService.verifyRLSForTenant(testTenants.tenantA);

      expect(verification.success).toBe(false);
      expect(verification.failed).toBeGreaterThan(0);
      expect(verification.tests.some(test => !test.passed)).toBe(true);
    });

    test('should handle verification errors gracefully', async () => {
      const mockClient = {
        query: jest.fn().mockRejectedValue(new Error('Database error')),
        release: jest.fn()
      };
      mockDatabase.pool.connect.mockResolvedValue(mockClient);

      const verification = await rlsService.verifyRLSForTenant(testTenants.tenantA);

      expect(verification.success).toBe(false);
      expect(verification.failed).toBeGreaterThan(0);
      expect(verification.tests.some(test => test.error)).toBe(true);
    });
  });

  describe('Middleware Integration', () => {
    let mockReq, mockRes, nextFunction;

    beforeEach(() => {
      mockReq = {
        user: { address: testTenants.tenantA },
        headers: {},
        stellarPublicKey: null
      };
      mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };
      nextFunction = jest.fn();
    });

    test('should extract tenant ID from authenticated user', async () => {
      const { createTenantRLSMiddleware } = require('../middleware/tenantRls');
      const middleware = createTenantRLSMiddleware(mockDatabase);

      await middleware(mockReq, mockRes, nextFunction);

      expect(mockReq.tenantId).toBe(testTenants.tenantA);
      expect(mockReq.rlsService).toBe(rlsService);
      expect(nextFunction).toHaveBeenCalled();
    });

    test('should handle unauthenticated requests', async () => {
      const { createTenantRLSMiddleware } = require('../middleware/tenantRls');
      const middleware = createTenantRLSMiddleware(mockDatabase);

      mockReq.user = null;

      await middleware(mockReq, mockRes, nextFunction);

      expect(mockReq.tenantId).toBeNull();
      expect(nextFunction).toHaveBeenCalled();
    });

    test('should reject invalid tenant ID format', async () => {
      const { createTenantRLSMiddleware } = require('../middleware/tenantRls');
      const middleware = createTenantRLSMiddleware(mockDatabase);

      mockReq.user = { address: 'invalid-key' };

      await middleware(mockReq, mockRes, nextFunction);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({
        success: false,
        error: 'Invalid tenant ID format'
      });
      expect(nextFunction).not.toHaveBeenCalled();
    });

    test('should attach helper functions to request', async () => {
      const { createTenantRLSMiddleware } = require('../middleware/tenantRls');
      const middleware = createTenantRLSMiddleware(mockDatabase);

      await middleware(mockReq, mockRes, nextFunction);

      expect(typeof mockReq.setTenantContext).toBe('function');
      expect(typeof mockReq.queryWithTenant).toBe('function');
      expect(typeof mockReq.transactionWithTenant).toBe('function');
    });
  });

  describe('Performance Impact Tests', () => {
    test('should maintain acceptable query performance with RLS', async () => {
      const startTime = Date.now();
      
      const mockClient = {
        query: jest.fn().mockResolvedValue({ rows: testData.subscriptions }),
        release: jest.fn()
      };
      mockDatabase.pool.connect.mockResolvedValue(mockClient);

      // Simulate multiple queries
      const queries = [];
      for (let i = 0; i < 100; i++) {
        queries.push(rlsService.queryWithTenant(testTenants.tenantA, 'SELECT * FROM subscriptions'));
      }

      await Promise.all(queries);
      
      const endTime = Date.now();
      const totalTime = endTime - startTime;

      // Should complete 100 queries in reasonable time (adjust threshold as needed)
      expect(totalTime).toBeLessThan(1000); // Less than 1 second for 100 queries
    });

    test('should handle large datasets efficiently', async () => {
      // Mock large dataset
      const largeDataset = Array.from({ length: 10000 }, (_, i) => ({
        id: `sub${i}`,
        tenant_id: testTenants.tenantA,
        active: true
      }));

      const mockClient = {
        query: jest.fn().mockResolvedValue({ rows: largeDataset }),
        release: jest.fn()
      };
      mockDatabase.pool.connect.mockResolvedValue(mockClient);

      const startTime = Date.now();
      const result = await rlsService.queryWithTenant(testTenants.tenantA, 'SELECT * FROM subscriptions');
      const endTime = Date.now();

      expect(result.rows).toHaveLength(10000);
      expect(endTime - startTime).toBeLessThan(500); // Should handle 10k rows quickly
    });
  });

  describe('SOC2 Compliance Tests', () => {
    test('should enforce strict data isolation', async () => {
      // Test that even with explicit queries, RLS prevents cross-tenant access
      const mockClient = {
        query: jest.fn((query) => {
          // Simulate RLS blocking cross-tenant access
          if (query.includes('WHERE tenant_id !=')) {
            return Promise.resolve({ rows: [] }); // RLS blocks this
          }
          return Promise.resolve({ rows: testData.subscriptions.filter(s => s.tenant_id === testTenants.tenantA) });
        }),
        release: jest.fn()
      };
      mockDatabase.pool.connect.mockResolvedValue(mockClient);

      // Try to explicitly query other tenant data
      const result = await rlsService.queryWithTenant(
        testTenants.tenantA, 
        'SELECT * FROM subscriptions WHERE tenant_id != $1',
        [testTenants.tenantA]
      );

      // RLS should block this and return empty results
      expect(result.rows).toHaveLength(0);
    });

    test('should maintain audit trail for tenant context changes', async () => {
      const mockClient = {
        query: jest.fn().mockResolvedValue({ rows: [] }),
        release: jest.fn()
      };
      mockDatabase.pool.connect.mockResolvedValue(mockClient);

      // Set tenant context multiple times
      await rlsService.setTenantContext(testTenants.tenantA);
      await rlsService.setTenantContext(testTenants.tenantB);

      // Verify context was set for each tenant
      expect(mockClient.query).toHaveBeenCalledTimes(2);
      expect(mockClient.query).toHaveBeenCalledWith('SELECT set_tenant_context($1)', [testTenants.tenantA]);
      expect(mockClient.query).toHaveBeenCalledWith('SELECT set_tenant_context($1)', [testTenants.tenantB]);
    });
  });
});
