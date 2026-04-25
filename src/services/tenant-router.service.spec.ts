import { Test, TestingModule } from '@nestjs/testing';
import { TenantRouterService } from './tenant-router.service';
import { Redis } from 'ioredis';

describe('TenantRouterService', () => {
  let service: TenantRouterService;
  let redisMock: jest.Mocked<Redis>;

  beforeEach(async () => {
    const mockRedis = {
      hset: jest.fn(),
      hgetall: jest.fn(),
      hincrby: jest.fn(),
      expire: jest.fn(),
      keys: jest.fn(),
      lpush: jest.fn(),
      ltrim: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TenantRouterService,
        {
          provide: 'REDIS_CLIENT',
          useValue: mockRedis,
        },
      ],
    }).compile();

    service = module.get<TenantRouterService>(TenantRouterService);
    redisMock = module.get('REDIS_CLIENT');
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getTenantDatabase', () => {
    it('should return enterprise database for enterprise tenant', async () => {
      const tenantId = 'enterprise-tenant-123';
      const enterpriseDb = 'postgres://enterprise-db:5432/substream';
      
      redisMock.hgetall.mockResolvedValue({
        tier: 'enterprise',
        connectionString: enterpriseDb,
        maxConnections: '50',
        connectionTimeout: '60000',
      });

      const result = await service.getTenantDatabase(tenantId);
      
      expect(result).toBe(enterpriseDb);
      expect(redisMock.hgetall).toHaveBeenCalledWith(`tenant_db_registry:${tenantId}`);
    });

    it('should return shared database for standard tenant', async () => {
      const tenantId = 'standard-tenant-456';
      const sharedDb = 'postgres://shared-db:5432/substream';
      const tenantDb = 'postgres://tenant-db:5432/substream';
      
      // Mock tenant config
      redisMock.hgetall
        .mockResolvedValueOnce({
          tier: 'standard',
          connectionString: tenantDb,
          maxConnections: '20',
          connectionTimeout: '30000',
        })
        .mockResolvedValueOnce({
          connectionString: sharedDb,
        });

      const result = await service.getTenantDatabase(tenantId);
      
      expect(result).toBe(sharedDb);
    });

    it('should throw error for non-existent tenant', async () => {
      const tenantId = 'non-existent-tenant';
      
      redisMock.hgetall.mockResolvedValue({});

      await expect(service.getTenantDatabase(tenantId)).rejects.toThrow(
        `Tenant ${tenantId} not found in registry`
      );
    });
  });

  describe('registerTenant', () => {
    it('should register a new tenant successfully', async () => {
      const config = {
        tenantId: 'new-tenant-123',
        tier: 'standard' as const,
        connectionString: 'postgres://db:5432/substream',
        maxConnections: 20,
        connectionTimeout: 30000,
      };

      redisMock.hset.mockResolvedValue(1);
      redisMock.hincrby.mockResolvedValue(1);
      redisMock.expire.mockResolvedValue(1);

      await service.registerTenant(config);

      expect(redisMock.hset).toHaveBeenCalledWith(
        `tenant_db_registry:${config.tenantId}`,
        expect.objectContaining({
          tier: config.tier,
          connectionString: config.connectionString,
          maxConnections: config.maxConnections.toString(),
          connectionTimeout: config.connectionTimeout.toString(),
        })
      );
    });

    it('should use default values when not provided', async () => {
      const config = {
        tenantId: 'new-tenant-456',
        tier: 'enterprise' as const,
        connectionString: 'postgres://enterprise-db:5432/substream',
      };

      redisMock.hset.mockResolvedValue(1);
      redisMock.hincrby.mockResolvedValue(1);
      redisMock.expire.mockResolvedValue(1);

      await service.registerTenant(config);

      expect(redisMock.hset).toHaveBeenCalledWith(
        `tenant_db_registry:${config.tenantId}`,
        expect.objectContaining({
          maxConnections: '20',
          connectionTimeout: '30000',
        })
      );
    });
  });

  describe('migrateToEnterprise', () => {
    it('should migrate standard tenant to enterprise successfully', async () => {
      const tenantId = 'migrating-tenant-123';
      const enterpriseDb = 'postgres://enterprise-db:5432/substream';
      const currentDb = 'postgres://shared-db:5432/substream';

      // Mock current tenant config
      redisMock.hgetall.mockResolvedValue({
        tier: 'standard',
        connectionString: currentDb,
        maxConnections: '20',
        connectionTimeout: '30000',
      });

      // Mock registration and stats updates
      redisMock.hset.mockResolvedValue(1);
      redisMock.hincrby.mockResolvedValue(1);
      redisMock.expire.mockResolvedValue(1);

      await service.migrateToEnterprise(tenantId, enterpriseDb);

      expect(redisMock.hset).toHaveBeenCalledWith(
        expect.stringContaining(`migration:${tenantId}:`),
        expect.objectContaining({
          status: 'in_progress',
          fromDb: currentDb,
          toDb: enterpriseDb,
        })
      );

      expect(redisMock.hset).toHaveBeenCalledWith(
        expect.stringContaining(`migration:${tenantId}:`),
        expect.objectContaining({
          status: 'completed',
        })
      );
    });

    it('should throw error for non-existent tenant', async () => {
      const tenantId = 'non-existent-tenant';
      const enterpriseDb = 'postgres://enterprise-db:5432/substream';

      redisMock.hgetall.mockResolvedValue({});

      await expect(service.migrateToEnterprise(tenantId, enterpriseDb)).rejects.toThrow(
        `Tenant ${tenantId} not found`
      );
    });

    it('should throw error for already enterprise tenant', async () => {
      const tenantId = 'already-enterprise-tenant';
      const enterpriseDb = 'postgres://enterprise-db:5432/substream';

      redisMock.hgetall.mockResolvedValue({
        tier: 'enterprise',
        connectionString: enterpriseDb,
      });

      await expect(service.migrateToEnterprise(tenantId, enterpriseDb)).rejects.toThrow(
        `Tenant ${tenantId} is already on enterprise tier`
      );
    });

    it('should handle migration failures', async () => {
      const tenantId = 'failing-tenant-123';
      const enterpriseDb = 'postgres://enterprise-db:5432/substream';
      const currentDb = 'postgres://shared-db:5432/substream';

      redisMock.hgetall.mockResolvedValue({
        tier: 'standard',
        connectionString: currentDb,
      });

      // Mock failure during registration
      redisMock.hset.mockRejectedValue(new Error('Redis error'));

      await expect(service.migrateToEnterprise(tenantId, enterpriseDb)).rejects.toThrow();

      // Verify failure was logged
      expect(redisMock.hset).toHaveBeenCalledWith(
        expect.stringContaining(`migration:${tenantId}:`),
        expect.objectContaining({
          status: 'failed',
        })
      );
    });
  });

  describe('isEnterpriseTenant', () => {
    it('should return true for enterprise tenant', async () => {
      const tenantId = 'enterprise-tenant-123';

      redisMock.hgetall.mockResolvedValue({
        tier: 'enterprise',
        connectionString: 'postgres://enterprise-db:5432/substream',
      });

      const result = await service.isEnterpriseTenant(tenantId);
      expect(result).toBe(true);
    });

    it('should return false for standard tenant', async () => {
      const tenantId = 'standard-tenant-456';

      redisMock.hgetall.mockResolvedValue({
        tier: 'standard',
        connectionString: 'postgres://shared-db:5432/substream',
      });

      const result = await service.isEnterpriseTenant(tenantId);
      expect(result).toBe(false);
    });

    it('should return false for non-existent tenant', async () => {
      const tenantId = 'non-existent-tenant';

      redisMock.hgetall.mockResolvedValue({});

      const result = await service.isEnterpriseTenant(tenantId);
      expect(result).toBe(false);
    });
  });

  describe('getClusterStats', () => {
    it('should return cluster statistics', async () => {
      const keys = [
        'cluster_stats:enterprise:12345',
        'cluster_stats:standard:67890',
      ];

      redisMock.keys.mockResolvedValue(keys);
      redisMock.hgetall.mockImplementation((key) => {
        if (key.includes('enterprise')) {
          return Promise.resolve({ tenantCount: '5' });
        } else if (key.includes('standard')) {
          return Promise.resolve({ tenantCount: '100' });
        }
        return Promise.resolve({});
      });

      const stats = await service.getClusterStats();

      expect(stats).toHaveLength(2);
      expect(stats[0]).toMatchObject({
        id: '12345',
        type: 'enterprise',
        maxConnections: 50,
        currentConnections: 5,
      });
      expect(stats[1]).toMatchObject({
        id: '67890',
        type: 'shared',
        maxConnections: 20,
        currentConnections: 100,
      });
    });

    it('should return empty array when no clusters exist', async () => {
      redisMock.keys.mockResolvedValue([]);

      const stats = await service.getClusterStats();
      expect(stats).toHaveLength(0);
    });
  });

  describe('initializeSharedDatabase', () => {
    it('should initialize shared database configuration', async () => {
      const connectionString = 'postgres://shared-db:5432/substream';

      redisMock.hset.mockResolvedValue(1);

      await service.initializeSharedDatabase(connectionString);

      expect(redisMock.hset).toHaveBeenCalledWith('shared_cluster', {
        connectionString,
        type: 'shared',
        maxConnections: '20',
        initializedAt: expect.any(String),
      });
    });
  });

  describe('hashConnectionString', () => {
    it('should generate consistent hash for same connection string', async () => {
      // This is a private method, so we need to test it indirectly
      // through other methods that use it
      const connectionString = 'postgres://test-db:5432/substream';
      
      redisMock.hset.mockResolvedValue(1);
      redisMock.hincrby.mockResolvedValue(1);
      redisMock.expire.mockResolvedValue(1);

      await service.registerTenant({
        tenantId: 'test-tenant',
        tier: 'standard',
        connectionString,
      });

      // The hash should be used in the cluster stats key
      expect(redisMock.hincrby).toHaveBeenCalledWith(
        expect.stringContaining('cluster_stats:standard:'),
        'tenantCount',
        1
      );
    });
  });
});
