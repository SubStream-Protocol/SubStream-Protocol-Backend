const TenantFeatureFlagService = require('../src/services/tenantFeatureFlagService');
const Redis = require('ioredis');

// Mock dependencies
jest.mock('ioredis');
jest.mock('../config/redis', () => ({
  getRedisClient: jest.fn(() => mockRedis)
}));

const mockRedis = {
  get: jest.fn(),
  setex: jest.fn(),
  del: jest.fn(),
  info: jest.fn()
};

const mockDatabase = {
  pool: {
    query: jest.fn(),
    connect: jest.fn()
  }
};

describe('TenantFeatureFlagService', () => {
  let service;
  let mockClient;

  beforeEach(() => {
    jest.clearAllMocks();
    
    service = new TenantFeatureFlagService(mockDatabase, null);
    
    mockClient = {
      query: jest.fn(),
      release: jest.fn()
    };
    
    mockDatabase.pool.connect.mockResolvedValue(mockClient);
    mockDatabase.pool.query.mockResolvedValue({ rows: [] });
  });

  describe('evaluateFlag', () => {
    it('should return cached value when available', async () => {
      const tenantId = 'tenant-123';
      const flagName = 'enable_crypto_checkout';
      
      mockRedis.get.mockResolvedValue('true');
      
      const result = await service.evaluateFlag(tenantId, flagName);
      
      expect(result).toEqual({
        flagName,
        value: true,
        cached: true,
        evaluationTimeMs: expect.any(Number)
      });
      
      expect(mockRedis.get).toHaveBeenCalledWith(`feature_flag:${tenantId}:${flagName}`);
      expect(mockDatabase.pool.query).not.toHaveBeenCalled();
    });

    it('should query database when cache miss', async () => {
      const tenantId = 'tenant-123';
      const flagName = 'enable_crypto_checkout';
      
      mockRedis.get.mockResolvedValue(null);
      mockDatabase.pool.query.mockResolvedValue({
        rows: [{ flag_value: true, metadata: {} }]
      });
      
      const result = await service.evaluateFlag(tenantId, flagName);
      
      expect(result).toEqual({
        flagName,
        value: true,
        cached: false,
        evaluationTimeMs: expect.any(Number)
      });
      
      expect(mockDatabase.pool.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT flag_value, metadata'),
        [tenantId, flagName]
      );
      expect(mockRedis.setex).toHaveBeenCalledWith(
        `feature_flag:${tenantId}:${flagName}`,
        300,
        'true'
      );
    });

    it('should return default value when flag not found', async () => {
      const tenantId = 'tenant-123';
      const flagName = 'nonexistent_flag';
      
      mockRedis.get.mockResolvedValue(null);
      mockDatabase.pool.query.mockResolvedValue({ rows: [] });
      
      const result = await service.evaluateFlag(tenantId, flagName);
      
      expect(result).toEqual({
        flagName,
        value: false,
        cached: false,
        evaluationTimeMs: expect.any(Number)
      });
    });

    it('should handle database errors gracefully', async () => {
      const tenantId = 'tenant-123';
      const flagName = 'enable_crypto_checkout';
      
      mockRedis.get.mockResolvedValue(null);
      mockDatabase.pool.query.mockRejectedValue(new Error('Database error'));
      
      const result = await service.evaluateFlag(tenantId, flagName);
      
      expect(result).toEqual({
        flagName,
        value: false,
        cached: false,
        evaluationTimeMs: expect.any(Number),
        error: 'Database error'
      });
    });

    it('should evaluate in under 1ms for cached values', async () => {
      const tenantId = 'tenant-123';
      const flagName = 'enable_crypto_checkout';
      
      mockRedis.get.mockResolvedValue('true');
      
      const startTime = Date.now();
      const result = await service.evaluateFlag(tenantId, flagName);
      const endTime = Date.now();
      
      expect(result.evaluationTimeMs).toBeLessThan(1);
      expect(result.cached).toBe(true);
    });
  });

  describe('getAllFlags', () => {
    it('should return all cached flags when available', async () => {
      const tenantId = 'tenant-123';
      const cachedFlags = {
        enable_crypto_checkout: true,
        enable_b2b_invoicing: false
      };
      
      mockRedis.get.mockResolvedValue(JSON.stringify(cachedFlags));
      
      const result = await service.getAllFlags(tenantId);
      
      expect(result).toEqual({
        tenantId,
        flags: cachedFlags,
        cached: true,
        evaluationTimeMs: expect.any(Number)
      });
    });

    it('should query database and cache results', async () => {
      const tenantId = 'tenant-123';
      
      mockRedis.get.mockResolvedValue(null);
      mockDatabase.pool.query.mockResolvedValue({
        rows: [
          { flag_name: 'enable_crypto_checkout', flag_value: true },
          { flag_name: 'enable_b2b_invoicing', flag_value: false }
        ]
      });
      
      const result = await service.getAllFlags(tenantId);
      
      expect(result.flags).toEqual({
        enable_crypto_checkout: true,
        enable_b2b_invoicing: false,
        require_kyc_for_subs: false,
        enable_advanced_analytics: false,
        enable_api_webhooks: false,
        enable_custom_branding: false,
        enable_priority_support: false,
        enable_bulk_operations: false
      });
      
      expect(mockRedis.setex).toHaveBeenCalledWith(
        `feature_flag:${tenantId}:all`,
        300,
        expect.stringContaining('enable_crypto_checkout')
      );
    });
  });

  describe('updateFlag', () => {
    it('should update flag and log audit trail', async () => {
      const tenantId = 'tenant-123';
      const flagName = 'enable_crypto_checkout';
      const newValue = true;
      const changedBy = 'admin@example.com';
      const changeReason = 'Enable for beta testing';
      
      mockDatabase.pool.query
        .mockResolvedValueOnce({ rows: [{ flag_value: false }] }) // Current value
        .mockResolvedValueOnce({ rows: [] }) // Upsert
        .mockResolvedValueOnce({ rows: [] }); // Audit log
      
      mockRedis.del.mockResolvedValue(1);
      
      const result = await service.updateFlag(tenantId, flagName, newValue, changedBy, changeReason);
      
      expect(result).toEqual({
        success: true,
        flagName,
        oldValue: false,
        newValue: true,
        changedBy,
        changeReason
      });
      
      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
      expect(mockRedis.del).toHaveBeenCalledTimes(2); // Specific flag + all flags cache
    });

    it('should handle transaction rollback on error', async () => {
      const tenantId = 'tenant-123';
      const flagName = 'enable_crypto_checkout';
      const newValue = true;
      const changedBy = 'admin@example.com';
      
      mockDatabase.pool.query.mockRejectedValue(new Error('Database error'));
      
      await expect(service.updateFlag(tenantId, flagName, newValue, changedBy))
        .rejects.toThrow('Database error');
      
      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    });
  });

  describe('getAuditLog', () => {
    it('should return audit log entries', async () => {
      const tenantId = 'tenant-123';
      const flagName = 'enable_crypto_checkout';
      
      mockDatabase.pool.query.mockResolvedValue({
        rows: [
          {
            id: 'audit-1',
            tenant_id: tenantId,
            flag_name: flagName,
            old_value: false,
            new_value: true,
            changed_by: 'admin@example.com',
            change_reason: 'Enable for beta',
            created_at: new Date().toISOString()
          }
        ]
      });
      
      const result = await service.getAuditLog(tenantId, flagName);
      
      expect(result).toEqual({
        tenantId,
        flagName,
        entries: expect.arrayContaining([
          expect.objectContaining({
            tenant_id: tenantId,
            flag_name: flagName,
            old_value: false,
            new_value: true
          })
        ]),
        total: 1
      });
    });
  });

  describe('initializeTenantFlags', () => {
    it('should initialize default flags for new tenant', async () => {
      const tenantId = 'tenant-new';
      
      mockDatabase.pool.query.mockResolvedValue({ rows: [] });
      
      const result = await service.initializeTenantFlags(tenantId);
      
      expect(result).toEqual({
        success: true,
        tenantId,
        initializedFlags: Object.keys(service.DEFAULT_FLAGS)
      });
      
      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
      
      // Should insert all default flags
      expect(mockClient.query).toHaveBeenCalledTimes(
        Object.keys(service.DEFAULT_FLAGS).length + 2 // BEGIN + COMMIT
      );
    });
  });

  describe('bulkUpdateFlags', () => {
    it('should update multiple flags in single transaction', async () => {
      const tenantId = 'tenant-123';
      const flagUpdates = [
        { flagName: 'enable_crypto_checkout', value: true },
        { flagName: 'enable_b2b_invoicing', value: false }
      ];
      const changedBy = 'admin@example.com';
      
      mockDatabase.pool.query.mockResolvedValue({ rows: [] });
      mockRedis.del.mockResolvedValue(1);
      
      const result = await service.bulkUpdateFlags(tenantId, flagUpdates, changedBy);
      
      expect(result).toEqual({
        success: true,
        tenantId,
        changes: expect.arrayContaining([
          { flagName: 'enable_crypto_checkout', oldValue: false, newValue: true },
          { flagName: 'enable_b2b_invoicing', oldValue: false, newValue: false }
        ]),
        changedBy
      });
      
      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    });
  });

  describe('invalidateCache', () => {
    it('should invalidate specific flag cache', async () => {
      const tenantId = 'tenant-123';
      const flagName = 'enable_crypto_checkout';
      
      mockRedis.del.mockResolvedValue(1);
      
      await service.invalidateCache(tenantId, flagName);
      
      expect(mockRedis.del).toHaveBeenCalledWith(`feature_flag:${tenantId}:${flagName}`);
      expect(mockRedis.del).toHaveBeenCalledWith(`feature_flag:${tenantId}:all`);
    });

    it('should invalidate all flags cache only', async () => {
      const tenantId = 'tenant-123';
      
      mockRedis.del.mockResolvedValue(1);
      
      await service.invalidateCache(tenantId);
      
      expect(mockRedis.del).toHaveBeenCalledTimes(1);
      expect(mockRedis.del).toHaveBeenCalledWith(`feature_flag:${tenantId}:all`);
    });
  });

  describe('getPerformanceMetrics', () => {
    it('should return performance metrics', async () => {
      mockRedis.info.mockResolvedValue('stats:...');
      
      const result = await service.getPerformanceMetrics();
      
      expect(result).toEqual({
        cacheHitRatio: 'N/A',
        averageEvaluationTime: '< 1ms',
        cacheTTL: 300,
        totalFlags: 8
      });
    });
  });

  describe('Performance Tests', () => {
    it('should handle 1000 concurrent flag evaluations', async () => {
      const tenantId = 'tenant-123';
      const flagName = 'enable_crypto_checkout';
      
      mockRedis.get.mockResolvedValue('true');
      
      const promises = Array.from({ length: 1000 }, () => 
        service.evaluateFlag(tenantId, flagName)
      );
      
      const startTime = Date.now();
      const results = await Promise.all(promises);
      const endTime = Date.now();
      
      expect(results).toHaveLength(1000);
      expect(results.every(r => r.value === true && r.cached === true)).toBe(true);
      expect(endTime - startTime).toBeLessThan(100); // Should complete in under 100ms
    });

    it('should maintain sub-1ms evaluation time for cached flags', async () => {
      const tenantId = 'tenant-123';
      const flagName = 'enable_crypto_checkout';
      
      mockRedis.get.mockResolvedValue('true');
      
      const evaluationTimes = [];
      
      for (let i = 0; i < 100; i++) {
        const result = await service.evaluateFlag(tenantId, flagName);
        evaluationTimes.push(result.evaluationTimeMs);
      }
      
      const averageTime = evaluationTimes.reduce((a, b) => a + b, 0) / evaluationTimes.length;
      const maxTime = Math.max(...evaluationTimes);
      
      expect(averageTime).toBeLessThan(1);
      expect(maxTime).toBeLessThan(5); // Allow some variance
    });
  });
});
