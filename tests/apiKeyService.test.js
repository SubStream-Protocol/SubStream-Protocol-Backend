const ApiKeyService = require('../src/services/apiKeyService');
const bcrypt = require('bcrypt');

describe('API Key Service Tests', () => {
  let apiKeyService;
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
      keys: jest.fn(),
      incr: jest.fn(),
      expire: jest.fn()
    };

    // Mock getRedisClient function
    jest.doMock('../src/config/redis', () => ({
      getRedisClient: () => mockRedisClient
    }));

    apiKeyService = new ApiKeyService(mockDatabase, mockRedisService);
  });

  afterEach(() => {
    jest.resetAllMocks();
    jest.restoreAllMocks();
  });

  describe('API Key Generation', () => {
    test('should generate API key with correct format', async () => {
      const mockClient = {
        query: jest.fn().mockResolvedValue({
          rows: [{ id: 'key-id-123', created_at: '2023-01-01T00:00:00Z' }]
        }),
        release: jest.fn()
      };
      mockDatabase.pool.connect.mockResolvedValue(mockClient);

      const result = await apiKeyService.generateApiKey(testTenantId, {
        name: 'Test Key',
        permissions: ['read:subscriptions']
      });

      expect(result.id).toBe('key-id-123');
      expect(result.apiKey).toMatch(/^sk_[a-f0-9]{64}$/);
      expect(result.name).toBe('Test Key');
      expect(result.permissions).toEqual(['read:subscriptions']);
      expect(result.isActive).toBe(true);
    });

    test('should hash API key before storage', async () => {
      const mockClient = {
        query: jest.fn().mockResolvedValue({
          rows: [{ id: 'key-id-123', created_at: '2023-01-01T00:00:00Z' }]
        }),
        release: jest.fn()
      };
      mockDatabase.pool.connect.mockResolvedValue(mockClient);

      const result = await apiKeyService.generateApiKey(testTenantId);

      // Verify the hashed key was stored, not the raw key
      const insertCall = mockClient.query.mock.calls.find(call => 
        call[0].includes('INSERT INTO api_keys')
      );
      const hashedKey = insertCall[0].match(/\$4, '([^']+)'/)[1];
      
      expect(hashedKey).toMatch(/^\$2[aby]\$\d+\$/); // bcrypt hash format
      expect(hashedKey).not.toBe(result.apiKey); // Should not be the raw key
    });

    test('should set default expiration if not provided', async () => {
      const mockClient = {
        query: jest.fn().mockResolvedValue({
          rows: [{ id: 'key-id-123', created_at: '2023-01-01T00:00:00Z' }]
        }),
        release: jest.fn()
      };
      mockDatabase.pool.connect.mockResolvedValue(mockClient);

      const result = await apiKeyService.generateApiKey(testTenantId);

      const insertCall = mockClient.query.mock.calls.find(call => 
        call[0].includes('INSERT INTO api_keys')
      );
      const expiresAt = insertCall[0].match(/\$5, '([^']+)'/)[1];
      
      const expirationDate = new Date(expiresAt);
      const expectedDate = new Date();
      expectedDate.setDate(expectedDate.getDate() + 365); // Default 1 year
      
      expect(Math.abs(expirationDate.getTime() - expectedDate.getTime())).toBeLessThan(60000); // Within 1 minute
    });

    test('should log API key creation event', async () => {
      const mockClient = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [{ id: 'key-id-123', created_at: '2023-01-01T00:00:00Z' }] })
          .mockResolvedValueOnce({ rows: [] }), // audit log insert
        release: jest.fn()
      };
      mockDatabase.pool.connect.mockResolvedValue(mockClient);

      await apiKeyService.generateApiKey(testTenantId, {
        name: 'Test Key',
        permissions: ['read:subscriptions']
      });

      // Verify audit log was created
      const auditCall = mockClient.query.mock.calls.find(call => 
        call[0].includes('INSERT INTO api_key_audit_logs')
      );
      
      expect(auditCall).toBeDefined();
      expect(auditCall[0]).toContain('created');
    });
  });

  describe('API Key Validation', () => {
    test('should validate correct API key', async () => {
      const rawKey = 'sk_abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
      const hashedKey = await bcrypt.hash(rawKey, 12);

      const mockClient = {
        query: jest.fn().mockResolvedValue({
          rows: [{
            id: 'key-id-123',
            tenant_id: testTenantId,
            name: 'Test Key',
            hashed_key: hashedKey,
            permissions: ['read:subscriptions'],
            expires_at: null,
            created_at: '2023-01-01T00:00:00Z',
            last_used_at: null
          }]
        }),
        release: jest.fn()
      };
      mockDatabase.pool.connect.mockResolvedValue(mockClient);

      const result = await apiKeyService.validateApiKey(rawKey);

      expect(result).toEqual({
        id: 'key-id-123',
        tenantId: testTenantId,
        name: 'Test Key',
        permissions: ['read:subscriptions'],
        expiresAt: null,
        createdAt: '2023-01-01T00:00:00Z',
        lastUsedAt: null,
        isValid: true
      });
    });

    test('should cache successful validation', async () => {
      const rawKey = 'sk_abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
      const hashedKey = await bcrypt.hash(rawKey, 12);

      const mockClient = {
        query: jest.fn().mockResolvedValue({
          rows: [{
            id: 'key-id-123',
            tenant_id: testTenantId,
            name: 'Test Key',
            hashed_key: hashedKey,
            permissions: ['read:subscriptions'],
            expires_at: null,
            created_at: '2023-01-01T00:00:00Z',
            last_used_at: null
          }]
        }),
        release: jest.fn()
      };
      mockDatabase.pool.connect.mockResolvedValue(mockClient);

      // First call - should hit database
      await apiKeyService.validateApiKey(rawKey);
      
      // Second call - should hit cache
      mockRedisClient.get.mockResolvedValue(JSON.stringify({
        id: 'key-id-123',
        tenantId: testTenantId,
        isValid: true
      }));

      const result = await apiKeyService.validateApiKey(rawKey);

      expect(result.isValid).toBe(true);
      expect(mockRedisClient.get).toHaveBeenCalledWith(`api_key:${rawKey}`);
      expect(mockDatabase.pool.connect).toHaveBeenCalledTimes(1); // Only called once for cache miss
    });

    test('should reject expired API key', async () => {
      const rawKey = 'sk_abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
      const hashedKey = await bcrypt.hash(rawKey, 12);
      const pastDate = new Date('2020-01-01T00:00:00Z');

      const mockClient = {
        query: jest.fn()
          .mockResolvedValueOnce({ // getActiveApiKeys
            rows: [{
              id: 'key-id-123',
              tenant_id: testTenantId,
              name: 'Test Key',
              hashed_key: hashedKey,
              permissions: ['read:subscriptions'],
              expires_at: pastDate.toISOString(),
              created_at: '2023-01-01T00:00:00Z',
              last_used_at: null
            }]
          })
          .mockResolvedValueOnce({ rows: [] }), // deactivateApiKey
        release: jest.fn()
      };
      mockDatabase.pool.connect.mockResolvedValue(mockClient);

      const result = await apiKeyService.validateApiKey(rawKey);

      expect(result).toBeNull();
      expect(mockClient.query).toHaveBeenCalledWith(
        'UPDATE api_keys SET is_active = false WHERE id = $1',
        ['key-id-123']
      );
    });

    test('should reject invalid API key format', async () => {
      const invalidKeys = [
        '',
        null,
        undefined,
        'invalid-key',
        'sk_short',
        'not_sk_prefix'
      ];

      for (const key of invalidKeys) {
        const result = await apiKeyService.validateApiKey(key);
        expect(result).toBeNull();
      }
    });
  });

  describe('Permission Management', () => {
    test('should check permission correctly', () => {
      const apiKeyInfo = {
        permissions: ['read:subscriptions', 'write:users']
      };

      expect(apiKeyService.hasPermission(apiKeyInfo, 'read:subscriptions')).toBe(true);
      expect(apiKeyService.hasPermission(apiKeyInfo, 'write:users')).toBe(true);
      expect(apiKeyService.hasPermission(apiKeyInfo, 'admin:all')).toBe(false);
      expect(apiKeyService.hasPermission(apiKeyInfo, 'delete:videos')).toBe(false);
    });

    test('should grant all permissions with admin:all', () => {
      const apiKeyInfo = {
        permissions: ['admin:all']
      };

      expect(apiKeyService.hasPermission(apiKeyInfo, 'read:subscriptions')).toBe(true);
      expect(apiKeyService.hasPermission(apiKeyInfo, 'delete:everything')).toBe(true);
      expect(apiKeyService.hasPermission(apiKeyInfo, 'any:permission')).toBe(true);
    });

    test('should handle null/undefined API key info', () => {
      expect(apiKeyService.hasPermission(null, 'read:subscriptions')).toBe(false);
      expect(apiKeyService.hasPermission(undefined, 'read:subscriptions')).toBe(false);
      expect(apiKeyService.hasPermission({}, 'read:subscriptions')).toBe(false);
    });
  });

  describe('API Key Management', () => {
    test('should revoke API key successfully', async () => {
      const mockClient = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [{ id: 'key-id-123' }] }) // DELETE
          .mockResolvedValueOnce({ rows: [] }), // audit log
        release: jest.fn()
      };
      mockDatabase.pool.connect.mockResolvedValue(mockClient);

      const result = await apiKeyService.revokeApiKey('key-id-123', testTenantId);

      expect(result).toBe(true);
      expect(mockClient.query).toHaveBeenCalledWith(
        'DELETE FROM api_keys WHERE id = $1 AND tenant_id = $2 RETURNING id',
        ['key-id-123', testTenantId]
      );
    });

    test('should return false for non-existent key revocation', async () => {
      const mockClient = {
        query: jest.fn().mockResolvedValue({ rows: [] }), // DELETE returns no rows
        release: jest.fn()
      };
      mockDatabase.pool.connect.mockResolvedValue(mockClient);

      const result = await apiKeyService.revokeApiKey('non-existent-key', testTenantId);

      expect(result).toBe(false);
    });

    test('should list API keys for tenant', async () => {
      const mockClient = {
        query: jest.fn().mockResolvedValue({
          rows: [
            {
              id: 'key-1',
              name: 'Key 1',
              permissions: ['read:subscriptions'],
              expires_at: null,
              created_at: '2023-01-01T00:00:00Z',
              last_used_at: '2023-01-02T00:00:00Z',
              is_active: true
            },
            {
              id: 'key-2',
              name: 'Key 2',
              permissions: ['write:users'],
              expires_at: '2024-01-01T00:00:00Z',
              created_at: '2023-01-01T00:00:00Z',
              last_used_at: null,
              is_active: true
            }
          ]
        }),
        release: jest.fn()
      };
      mockDatabase.pool.connect.mockResolvedValue(mockClient);

      const result = await apiKeyService.listApiKeys(testTenantId);

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('key-1');
      expect(result[0].permissions).toEqual(['read:subscriptions']);
      expect(result[1].expiresAt).toBe('2024-01-01T00:00:00Z');
    });

    test('should update API key permissions', async () => {
      const mockClient = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [{ id: 'key-id-123' }] }) // UPDATE
          .mockResolvedValueOnce({ rows: [] }), // audit log
        release: jest.fn()
      };
      mockDatabase.pool.connect.mockResolvedValue(mockClient);

      const newPermissions = ['admin:all', 'read:subscriptions'];
      const result = await apiKeyService.updateApiKeyPermissions('key-id-123', testTenantId, newPermissions);

      expect(result).toBe(true);
      expect(mockClient.query).toHaveBeenCalledWith(
        'UPDATE api_keys SET permissions = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3 RETURNING id',
        [JSON.stringify(newPermissions), 'key-id-123', testTenantId]
      );
    });
  });

  describe('Statistics and Monitoring', () => {
    test('should get API key statistics', async () => {
      const mockClient = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [{ count: '5' }] }) // total keys
          .mockResolvedValueOnce({ rows: [{ count: '3' }] }) // active keys
          .mockResolvedValueOnce({ // usage details
            rows: [
              {
                id: 'key-1',
                name: 'Key 1',
                last_used_at: '2023-01-01T00:00:00Z',
                created_at: '2023-01-01T00:00:00Z'
              }
            ]
          }),
        release: jest.fn()
      };
      mockDatabase.pool.connect.mockResolvedValue(mockClient);

      const stats = await apiKeyService.getApiKeyStatistics(testTenantId);

      expect(stats.tenantId).toBe(testTenantId);
      expect(stats.totalKeys).toBe(5);
      expect(stats.activeKeys).toBe(3);
      expect(stats.keys).toHaveLength(1);
      expect(stats.keys[0].daysSinceLastUse).toBe(0);
    });

    test('should clean up expired keys', async () => {
      const mockClient = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [
            { id: 'key-1', tenant_id: testTenantId },
            { id: 'key-2', tenant_id: testTenantId }
          ]}) // UPDATE expired keys
          .mockResolvedValue({ rows: [] }), // audit logs
        release: jest.fn()
      };
      mockDatabase.pool.connect.mockResolvedValue(mockClient);

      const result = await apiKeyService.cleanupExpiredKeys();

      expect(result.deactivated).toBe(2);
      expect(result.keys).toHaveLength(2);
      expect(result.keys[0].id).toBe('key-1');
    });
  });

  describe('Audit Logging', () => {
    test('should get audit logs for tenant', async () => {
      const mockClient = {
        query: jest.fn().mockResolvedValue({
          rows: [
            {
              key_id: 'key-1',
              event: 'used',
              metadata: '{"ip": "127.0.0.1"}',
              timestamp: '2023-01-01T00:00:00Z'
            },
            {
              key_id: 'key-1',
              event: 'created',
              metadata: '{}',
              timestamp: '2023-01-01T00:00:00Z'
            }
          ]
        }),
        release: jest.fn()
      };
      mockDatabase.pool.connect.mockResolvedValue(mockClient);

      const logs = await apiKeyService.getApiKeyAuditLogs(testTenantId);

      expect(logs).toHaveLength(2);
      expect(logs[0].event).toBe('used');
      expect(logs[0].metadata).toEqual('{"ip": "127.0.0.1"}');
    });

    test('should filter audit logs by key ID', async () => {
      const mockClient = {
        query: jest.fn().mockResolvedValue({
          rows: [
            {
              key_id: 'key-1',
              event: 'used',
              metadata: '{}',
              timestamp: '2023-01-01T00:00:00Z'
            }
          ]
        }),
        release: jest.fn()
      };
      mockDatabase.pool.connect.mockResolvedValue(mockClient);

      const logs = await apiKeyService.getApiKeyAuditLogs(testTenantId, { keyId: 'key-1' });

      expect(logs).toHaveLength(1);
      expect(logs[0].keyId).toBe('key-1');
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('AND key_id = $'),
        expect.arrayContaining([testTenantId, 'key-1'])
      );
    });
  });

  describe('Error Handling', () => {
    test('should handle database errors during key generation', async () => {
      const mockClient = {
        query: jest.fn().mockRejectedValue(new Error('Database connection failed')),
        release: jest.fn()
      };
      mockDatabase.pool.connect.mockResolvedValue(mockClient);

      await expect(apiKeyService.generateApiKey(testTenantId))
        .rejects.toThrow('Failed to generate API key: Database connection failed');
    });

    test('should handle bcrypt errors during validation', async () => {
      // Mock bcrypt.compare to throw an error
      jest.spyOn(bcrypt, 'compare').mockRejectedValue(new Error('Bcrypt error'));

      const result = await apiKeyService.validateApiKey('sk_testkey');

      expect(result).toBeNull();
      expect(bcrypt.compare).toHaveBeenCalled();
    });

    test('should handle Redis cache errors gracefully', async () => {
      const rawKey = 'sk_abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
      const hashedKey = await bcrypt.hash(rawKey, 12);

      // Mock Redis get to throw error
      mockRedisClient.get.mockRejectedValue(new Error('Redis error'));

      const mockClient = {
        query: jest.fn().mockResolvedValue({
          rows: [{
            id: 'key-id-123',
            tenant_id: testTenantId,
            name: 'Test Key',
            hashed_key: hashedKey,
            permissions: ['read:subscriptions'],
            expires_at: null,
            created_at: '2023-01-01T00:00:00Z',
            last_used_at: null
          }]
        }),
        release: jest.fn()
      };
      mockDatabase.pool.connect.mockResolvedValue(mockClient);

      const result = await apiKeyService.validateApiKey(rawKey);

      expect(result).toBeDefined();
      expect(result.isValid).toBe(true);
    });
  });

  describe('Security Tests', () => {
    test('should generate cryptographically secure keys', async () => {
      const mockClient = {
        query: jest.fn().mockResolvedValue({
          rows: [{ id: 'key-id-123', created_at: '2023-01-01T00:00:00Z' }]
        }),
        release: jest.fn()
      };
      mockDatabase.pool.connect.mockResolvedValue(mockClient);

      const keys = [];
      for (let i = 0; i < 100; i++) {
        const result = await apiKeyService.generateApiKey(testTenantId);
        keys.push(result.apiKey);
      }

      // Check that all keys are unique
      const uniqueKeys = new Set(keys);
      expect(uniqueKeys.size).toBe(100);

      // Check that all keys follow the format
      keys.forEach(key => {
        expect(key).toMatch(/^sk_[a-f0-9]{64}$/);
      });
    });

    test('should use sufficient bcrypt work factor', async () => {
      const mockClient = {
        query: jest.fn().mockResolvedValue({
          rows: [{ id: 'key-id-123', created_at: '2023-01-01T00:00:00Z' }]
        }),
        release: jest.fn()
      };
      mockDatabase.pool.connect.mockResolvedValue(mockClient);

      await apiKeyService.generateApiKey(testTenantId);

      const insertCall = mockClient.query.mock.calls.find(call => 
        call[0].includes('INSERT INTO api_keys')
      );
      const hashedKey = insertCall[0].match(/\$4, '([^']+)'/)[1];
      
      // Check that bcrypt work factor is at least 12
      expect(hashedKey).toMatch(/^\$2[aby]\$1[2-9]\$/); // Work factor 12-19
    });
  });
});
