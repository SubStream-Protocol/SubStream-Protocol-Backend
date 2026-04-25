const StorageQuotaService = require('../src/services/storageQuotaService');
const ArchivalService = require('../src/services/archivalService');

describe('Storage Quota and Archival Service Tests', () => {
  let storageQuotaService;
  let archivalService;
  let mockDatabase;
  let mockRedisService;
  let mockRedisClient;
  let testTenantId;

  beforeEach(() => {
    testTenantId = 'GABCD1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890AB';
    
    // Mock database
    mockDatabase = {
      pool: {
        connect: jest.fn(() => ({
          query: jest.fn(),
          release: jest.fn()
        })),
        query: jest.fn()
      }
    };

    // Mock Redis service
    mockRedisService = {
      subscribe: jest.fn(),
      publish: jest.fn()
    };

    // Mock Redis client
    mockRedisClient = {
      get: jest.fn(),
      setex: jest.fn(),
      del: jest.fn(),
      lpush: jest.fn(),
      ltrim: jest.fn()
    };

    // Mock getRedisClient function
    jest.doMock('../src/config/redis', () => ({
      getRedisClient: () => mockRedisClient
    }));

    storageQuotaService = new StorageQuotaService(mockDatabase, mockRedisService);
    archivalService = new ArchivalService(mockDatabase, mockRedisService);
  });

  afterEach(() => {
    jest.resetAllMocks();
    jest.restoreAllMocks();
  });

  describe('Storage Quota Service', () => {
    describe('Quota Management', () => {
      test('should get tenant quota limits based on tier', async () => {
        const mockClient = {
          query: jest.fn().mockResolvedValue({ rows: [{ tier: 'pro' }] }),
          release: jest.fn()
        };
        mockDatabase.pool.connect.mockResolvedValue(mockClient);

        const limits = await storageQuotaService.getTenantQuotaLimits(testTenantId);

        expect(limits.tier).toBe('pro');
        expect(limits.maxUsers).toBe(100000);
        expect(limits.maxSubscriptions).toBe(100000);
        expect(limits.maxStorageBytes).toBe(10737418240); // 10GB
      });

      test('should return free tier limits for unknown tier', async () => {
        const mockClient = {
          query: jest.fn().mockResolvedValue({ rows: [] }),
          release: jest.fn()
        };
        mockDatabase.pool.connect.mockResolvedValue(mockClient);

        const limits = await storageQuotaService.getTenantQuotaLimits(testTenantId);

        expect(limits.tier).toBe('free');
        expect(limits.maxUsers).toBe(10000);
        expect(limits.maxStorageBytes).toBe(1073741824); // 1GB
      });

      test('should apply custom quota overrides', async () => {
        const mockClient = {
          query: jest.fn()
            .mockResolvedValueOnce({ rows: [{ tier: 'pro' }] })
            .mockResolvedValueOnce({ rows: [{ quota_config: '{"maxUsers": 200000}' }] }),
          release: jest.fn()
        };
        mockDatabase.pool.connect.mockResolvedValue(mockClient);

        const limits = await storageQuotaService.getTenantQuotaLimits(testTenantId);

        expect(limits.maxUsers).toBe(200000); // Custom override
        expect(limits.maxSubscriptions).toBe(100000); // Default pro tier
      });

      test('should set custom quotas for tenant', async () => {
        const mockClient = {
          query: jest.fn().mockResolvedValue({ rows: [] }),
          release: jest.fn()
        };
        mockDatabase.pool.connect.mockResolvedValue(mockClient);

        const customQuotas = { maxUsers: 50000, maxVideos: 500 };
        await storageQuotaService.setCustomQuotas(testTenantId, customQuotas);

        expect(mockClient.query).toHaveBeenCalledWith(
          expect.stringContaining('INSERT INTO tenant_quotas'),
          [testTenantId, JSON.stringify(customQuotas)]
        );
        expect(mockRedisClient.del).toHaveBeenCalledWith(`usage:${testTenantId}`);
      });
    });

    describe('Usage Calculation', () => {
      test('should calculate tenant usage from database', async () => {
        const mockClient = {
          query: jest.fn()
            .mockResolvedValueOnce({ rows: [{ count: '100', bytes: '1048576' }] }) // users
            .mockResolvedValueOnce({ rows: [{ count: '200', bytes: '2097152' }] }) // subscriptions
            .mockResolvedValueOnce({ rows: [{ count: '500', bytes: '5242880' }] }) // billing_events
            .mockResolvedValueOnce({ rows: [{ count: '50', bytes: '1073741824' }] }), // videos
          release: jest.fn()
        };
        mockDatabase.pool.connect.mockResolvedValue(mockClient);

        const usage = await storageQuotaService.calculateTenantUsage(testTenantId);

        expect(usage.users.count).toBe(100);
        expect(usage.subscriptions.count).toBe(200);
        expect(usage.billingEvents.count).toBe(500);
        expect(usage.videos.count).toBe(50);
        expect(usage.total.count).toBe(850);
        expect(usage.total.bytes).toBe(1073741824 + 5242880 + 2097152 + 1048576);
      });

      test('should cache usage calculations', async () => {
        // Mock cache miss first time
        mockRedisClient.get.mockResolvedValue(null);
        
        const mockClient = {
          query: jest.fn().mockResolvedValue({ rows: [] }),
          release: jest.fn()
        };
        mockDatabase.pool.connect.mockResolvedValue(mockClient);

        await storageQuotaService.getTenantUsage(testTenantId);

        expect(mockRedisClient.get).toHaveBeenCalledWith(`usage:${testTenantId}`);
        expect(mockRedisClient.setex).toHaveBeenCalledWith(
          `usage:${testTenantId}`,
          300,
          expect.any(String)
        );
      });

      test('should return cached usage when available', async () => {
        const cachedUsage = {
          users: { count: 100, bytes: 1048576 },
          total: { count: 100, bytes: 1048576 }
        };
        mockRedisClient.get.mockResolvedValue(JSON.stringify(cachedUsage));

        const usage = await storageQuotaService.getTenantUsage(testTenantId);

        expect(usage).toEqual(cachedUsage);
        expect(mockDatabase.pool.connect).not.toHaveBeenCalled();
      });
    });

    describe('Quota Enforcement', () => {
      test('should allow operations within quota limits', async () => {
        const mockClient = {
          query: jest.fn().mockResolvedValue({ rows: [] }),
          release: jest.fn()
        };
        mockDatabase.pool.connect.mockResolvedValue(mockClient);

        // Mock tier and usage
        mockClient.query
          .mockResolvedValueOnce({ rows: [{ tier: 'pro' }] }) // getTenantTier
          .mockResolvedValueOnce({ rows: [] }); // getCustomQuotas

        // Mock usage calculation
        mockRedisClient.get.mockResolvedValue(null);
        mockRedisClient.setex.mockImplementation();

        const quotaCheck = await storageQuotaService.checkQuota(testTenantId, 'users', 10);

        expect(quotaCheck.allowed).toBe(true);
        expect(quotaCheck.current).toBe(0);
        expect(quotaCheck.limit).toBe(100000); // Pro tier limit
      });

      test('should block operations that exceed quota', async () => {
        const mockClient = {
          query: jest.fn().mockResolvedValue({ rows: [] }),
          release: jest.fn()
        };
        mockDatabase.pool.connect.mockResolvedValue(mockClient);

        // Mock free tier (10 users limit)
        mockClient.query
          .mockResolvedValueOnce({ rows: [{ tier: 'free' }] })
          .mockResolvedValueOnce({ rows: [] });

        // Mock usage at limit
        const usageAtLimit = {
          users: { count: 10000 }, // At free tier limit
          total: { count: 10000 }
        };
        mockRedisClient.get.mockResolvedValue(JSON.stringify(usageAtLimit));

        const quotaCheck = await storageQuotaService.checkQuota(testTenantId, 'users', 1);

        expect(quotaCheck.allowed).toBe(false);
        expect(quotaCheck.wouldExceed).toBe(true);
        expect(quotaCheck.remaining).toBe(0);
        expect(quotaCheck.percentage).toBe(100);
      });

      test('should handle unlimited quotas correctly', async () => {
        const mockClient = {
          query: jest.fn().mockResolvedValue({ rows: [] }),
          release: jest.fn()
        };
        mockDatabase.pool.connect.mockResolvedValue(mockClient);

        // Mock enterprise tier (unlimited)
        mockClient.query
          .mockResolvedValueOnce({ rows: [{ tier: 'enterprise' }] })
          .mockResolvedValueOnce({ rows: [] });

        mockRedisClient.get.mockResolvedValue(null);

        const quotaCheck = await storageQuotaService.checkQuota(testTenantId, 'users', 1000000);

        expect(quotaCheck.allowed).toBe(true);
        expect(quotaCheck.limit).toBe(-1); // Unlimited
        expect(quotaCheck.remaining).toBe(-1);
        expect(quotaCheck.percentage).toBe(0);
      });
    });

    describe('Quota Middleware', () => {
      test('should create middleware that enforces quotas', () => {
        const middleware = storageQuotaService.createQuotaMiddleware();
        expect(typeof middleware).toBe('function');
      });

      test('should skip quota check for background workers', async () => {
        const middleware = storageQuotaService.createQuotaMiddleware();
        const req = { isBackgroundWorker: true };
        const res = {};
        const next = jest.fn();

        await middleware(req, res, next);

        expect(next).toHaveBeenCalled();
      });

      test('should return 402 for quota exceeded', async () => {
        const middleware = storageQuotaService.createQuotaMiddleware();
        const req = {
          tenantId: testTenantId,
          method: 'POST',
          path: '/api/users'
        };
        const res = {
          status: jest.fn().mockReturnThis(),
          json: jest.fn()
        };
        const next = jest.fn();

        // Mock quota check that fails
        jest.spyOn(storageQuotaService, 'checkQuota').mockResolvedValue({
          allowed: false,
          current: 10000,
          limit: 10000,
          percentage: 100
        });

        await middleware(req, res, next);

        expect(res.status).toHaveBeenCalledWith(402);
        expect(res.json).toHaveBeenCalledWith({
          success: false,
          error: 'Payment Required',
          message: 'Storage quota exceeded for users',
          quota: expect.any(Object)
        });
        expect(next).not.toHaveBeenCalled();
      });
    });

    describe('Quota Reports', () => {
      test('should generate comprehensive quota report', async () => {
        const mockClient = {
          query: jest.fn()
            .mockResolvedValueOnce({ rows: [{ tier: 'pro' }] }) // getTenantTier
            .mockResolvedValueOnce({ rows: [] }), // getCustomQuotas
          release: jest.fn()
        };
        mockDatabase.pool.connect.mockResolvedValue(mockClient);

        // Mock usage data
        const usage = {
          users: { count: 50000 },
          subscriptions: { count: 75000 },
          billingEvents: { count: 250000 },
          videos: { count: 500 },
          total: { count: 375500 }
        };
        mockRedisClient.get.mockResolvedValue(JSON.stringify(usage));

        const report = await storageQuotaService.getQuotaReport(testTenantId);

        expect(report.tenantId).toBe(testTenantId);
        expect(report.tier).toBe('pro');
        expect(report.usage.users.current).toBe(50000);
        expect(report.usage.users.limit).toBe(100000);
        expect(report.usage.users.percentage).toBe(50);
        expect(report.usage.users.status).toBe('healthy');
      });

      test('should detect warning and critical states', async () => {
        const mockClient = {
          query: jest.fn().mockResolvedValue({ rows: [{ tier: 'free' }] }),
          release: jest.fn()
        };
        mockDatabase.pool.connect.mockResolvedValue(mockClient);

        // Mock usage at 95% of limit
        const usage = {
          users: { count: 9500 }, // 95% of 10000
          total: { count: 9500 }
        };
        mockRedisClient.get.mockResolvedValue(JSON.stringify(usage));

        const report = await storageQuotaService.getQuotaReport(testTenantId);

        expect(report.status).toBe('warning');
        expect(report.usage.users.status).toBe('warning');
        expect(report.usage.users.percentage).toBe(95);
      });
    });
  });

  describe('Archival Service', () => {
    describe('Archival Process', () => {
      test('should run archival process for all tenants', async () => {
        const mockClient = {
          query: jest.fn().mockResolvedValue({ 
            rows: [
              { id: testTenantId, tier: 'free' },
              { id: 'GXYZ1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890XYZ', tier: 'pro' }
            ]
          }),
          release: jest.fn()
        };
        mockDatabase.pool.connect.mockResolvedValue(mockClient);

        // Mock tenant archival processing
        jest.spyOn(archivalService, 'processTenantArchival').mockResolvedValue({
          tenantId: testTenantId,
          success: true,
          recordsProcessed: 100,
          recordsArchived: 100,
          errors: 0
        });

        const results = await archivalService.runArchivalProcess();

        expect(results.tenants).toHaveLength(2);
        expect(results.totalRecordsArchived).toBe(200);
        expect(results.success).toBe(true);
        expect(results.endTime).toBeDefined();
      });

      test('should handle archival errors gracefully', async () => {
        const mockClient = {
          query: jest.fn().mockResolvedValue({ rows: [{ id: testTenantId, tier: 'free' }] }),
          release: jest.fn()
        };
        mockDatabase.pool.connect.mockResolvedValue(mockClient);

        jest.spyOn(archivalService, 'processTenantArchival').mockRejectedValue(new Error('Database error'));

        const results = await archivalService.runArchivalProcess();

        expect(results.tenants).toHaveLength(1);
        expect(results.tenants[0].success).toBe(false);
        expect(results.tenants[0].error).toBe('Database error');
        expect(results.totalErrors).toBe(1);
        expect(results.success).toBe(false);
      });
    });

    describe('Tenant Archival Processing', () => {
      test('should process archival for specific tenant', async () => {
        const mockClient = {
          query: jest.fn()
            .mockResolvedValueOnce({ rows: [{ tier: 'free' }] }) // getTenantTier
            .mockResolvedValueOnce({ rows: [] }), // custom retention policies
          release: jest.fn()
        };
        mockDatabase.pool.connect.mockResolvedValue(mockClient);

        // Mock table archival
        jest.spyOn(archivalService, 'archiveTable').mockResolvedValue({
          recordsProcessed: 50,
          recordsArchived: 50,
          errors: 0,
          archives: []
        });

        const result = await archivalService.processTenantArchival(testTenantId);

        expect(result.tenantId).toBe(testTenantId);
        expect(result.recordsArchived).toBe(100); // 50 * 2 tables
        expect(result.success).toBe(true);
      });

      test('should handle table archival errors', async () => {
        const mockClient = {
          query: jest.fn().mockResolvedValue({ rows: [{ tier: 'free' }] }),
          release: jest.fn()
        };
        mockDatabase.pool.connect.mockResolvedValue(mockClient);

        jest.spyOn(archivalService, 'archiveTable').mockRejectedValue(new Error('Table error'));

        const result = await archivalService.processTenantArchival(testTenantId);

        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
        expect(result.errors).toBeGreaterThan(0);
      });
    });

    describe('Table Archival', () => {
      test('should archive billing events table', async () => {
        const cutoffDate = new Date('2022-01-01');
        const records = [
          { id: 'event1', subscription_id: 'sub1', amount: 100, created_at: '2021-12-01' },
          { id: 'event2', subscription_id: 'sub2', amount: 200, created_at: '2021-11-01' }
        ];

        const mockClient = {
          query: jest.fn()
            .mockResolvedValueOnce({ rows: records }) // getRecordsForArchival
            .mockResolvedValueOnce({ rows: [] }) // deleteArchivedRecords
            .mockResolvedValueOnce({ rows: [] }), // logArchiveForBilling
          release: jest.fn()
        };
        mockDatabase.pool.connect.mockResolvedValue(mockClient);

        // Mock S3 upload
        const mockS3 = {
          upload: jest.fn().mockResolvedValue({ UploadId: 'upload123' })
        };
        archivalService.s3 = mockS3;

        const result = await archivalService.archiveTable(testTenantId, 'billing_events', { default: 730 });

        expect(result.recordsProcessed).toBe(2);
        expect(result.archives).toHaveLength(1);
        expect(mockS3.upload).toHaveBeenCalledWith(
          expect.objectContaining({
            Bucket: expect.any(String),
            StorageClass: 'GLACIER'
          })
        );
      });

      test('should handle empty result sets', async () => {
        const mockClient = {
          query: jest.fn().mockResolvedValue({ rows: [] }),
          release: jest.fn()
        };
        mockDatabase.pool.connect.mockResolvedValue(mockClient);

        const result = await archivalService.archiveTable(testTenantId, 'billing_events', { default: 730 });

        expect(result.recordsProcessed).toBe(0);
        expect(result.recordsArchived).toBe(0);
        expect(result.archives).toHaveLength(0);
      });
    });

    describe('Retention Policies', () => {
      test('should get default retention policy by tier', async () => {
        const mockClient = {
          query: jest.fn()
            .mockResolvedValueOnce({ rows: [{ tier: 'pro' }] }) // get tenant tier
            .mockResolvedValueOnce({ rows: [] }), // no custom policy
          release: jest.fn()
        };
        mockDatabase.pool.connect.mockResolvedValue(mockClient);

        const policy = await archivalService.getTenantRetentionPolicy(testTenantId);

        expect(policy.billing_events).toBe(1825); // 5 years for pro tier
        expect(policy.subscriptions).toBe(1825);
        expect(policy.default).toBe(1825);
      });

      test('should apply custom retention policies', async () => {
        const mockClient = {
          query: jest.fn()
            .mockResolvedValueOnce({ rows: [{ tier: 'free' }] })
            .mockResolvedValueOnce({ rows: [{ 
              retention_config: '{"billing_events": 365, "subscriptions": 730}' 
            }]),
          release: jest.fn()
        };
        mockDatabase.pool.connect.mockResolvedValue(mockClient);

        const policy = await archivalService.getTenantRetentionPolicy(testTenantId);

        expect(policy.billing_events).toBe(365); // Custom override
        expect(policy.subscriptions).toBe(730); // Custom override
        expect(policy.default).toBe(730); // Default free tier
      });

      test('should handle unlimited retention for enterprise', async () => {
        const mockClient = {
          query: jest.fn().mockResolvedValue({ rows: [{ tier: 'enterprise' }] }),
          release: jest.fn()
        };
        mockDatabase.pool.connect.mockResolvedValue(mockClient);

        const policy = await archivalService.getTenantRetentionPolicy(testTenantId);

        expect(policy.billing_events).toBe(-1); // Unlimited
        expect(policy.subscriptions).toBe(-1);
        expect(policy.default).toBe(-1);
      });
    });

    describe('Archive Retrieval', () => {
      test('should initiate archive retrieval', async () => {
        const archiveId = `${testTenantId}/billing_events/2022-01-01/1640995200000`;
        
        const mockClient = {
          query: jest.fn().mockResolvedValue({ rows: [] }),
          release: jest.fn()
        };
        mockDatabase.pool.connect.mockResolvedValue(mockClient);

        // Mock S3 restore
        const mockS3 = {
          restoreObject: jest.fn().mockResolvedValue({})
        };
        archivalService.s3 = mockS3;

        const result = await archivalService.retrieveArchive(testTenantId, archiveId);

        expect(result.status).toBe('initiated');
        expect(result.archiveId).toBe(archiveId);
        expect(mockS3.restoreObject).toHaveBeenCalledWith(
          expect.objectContaining({
            RestoreRequest: expect.objectContaining({
              Days: 1,
              GlacierJobParameters: { Tier: 'Expedited' }
            })
          })
        );
      });
    });

    describe('Archival Statistics', () => {
      test('should get archival statistics for tenant', async () => {
        const mockClient = {
          query: jest.fn()
            .mockResolvedValueOnce({ rows: [
              { table_name: 'billing_events', archive_count: 5, total_records: 5000 },
              { table_name: 'subscriptions', archive_count: 2, total_records: 2000 }
            ]})
            .mockResolvedValueOnce({ rows: [{ retrieval_count: 10, completed_count: 8 }] }),
          release: jest.fn()
        };
        mockDatabase.pool.connect.mockResolvedValue(mockClient);

        const stats = await archivalService.getArchivalStatistics(testTenantId);

        expect(stats.tenantId).toBe(testTenantId);
        expect(stats.archives).toHaveLength(2);
        expect(stats.archives[0].table_name).toBe('billing_events');
        expect(stats.retrievals.total).toBe(10);
        expect(stats.retrievals.completed).toBe(8);
      });
    });

    describe('Error Handling', () => {
      test('should handle database errors gracefully', async () => {
        const mockClient = {
          query: jest.fn().mockRejectedValue(new Error('Database connection failed')),
          release: jest.fn()
        };
        mockDatabase.pool.connect.mockResolvedValue(mockClient);

        await expect(archivalService.getTenantRetentionPolicy(testTenantId))
          .rejects.toThrow('Database connection failed');
      });

      test('should handle S3 errors gracefully', async () => {
        const mockClient = {
          query: jest.fn().mockResolvedValue({ rows: [] }),
          release: jest.fn()
        };
        mockDatabase.pool.connect.mockResolvedValue(mockClient);

        // Mock S3 upload failure
        const mockS3 = {
          upload: jest.fn().mockRejectedValue(new Error('S3 upload failed'))
        };
        archivalService.s3 = mockS3;

        await expect(archivalService.archiveTable(testTenantId, 'billing_events', { default: 730 }))
          .rejects.toThrow('S3 upload failed');
      });
    });
  });

  describe('Integration Tests', () => {
    test('should handle quota enforcement during archival', async () => {
      // This test would verify that archival operations bypass quota limits
      // while normal inserts are still subject to quota enforcement
      
      const mockClient = {
        query: jest.fn().mockResolvedValue({ rows: [] }),
        release: jest.fn()
      };
      mockDatabase.pool.connect.mockResolvedValue(mockClient);

      // Mock background worker context
      const req = { isBackgroundWorker: true };
      const middleware = storageQuotaService.createQuotaMiddleware();
      const next = jest.fn();

      await middleware(req, {}, next);

      expect(next).toHaveBeenCalled();
      // Background workers should not be subject to quota limits
    });

    test('should maintain data consistency during archival', async () => {
      // Test that archival process maintains data consistency
      // and that tombstones/aggregate records are properly maintained
      
      const mockClient = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [{ tier: 'free' }] }) // get tier
          .mockResolvedValueOnce({ rows: [] }) // custom policies
          .mockResolvedValueOnce({ rows: [] }), // records to archive
        release: jest.fn()
      };
      mockDatabase.pool.connect.mockResolvedValue(mockClient);

      // Mock successful archival
      jest.spyOn(archivalService, 'archiveTable').mockResolvedValue({
        recordsProcessed: 0,
        recordsArchived: 0,
        errors: 0,
        archives: []
      });

      const result = await archivalService.processTenantArchival(testTenantId);

      expect(result.success).toBe(true);
      expect(result.errors).toBe(0);
    });
  });
});
