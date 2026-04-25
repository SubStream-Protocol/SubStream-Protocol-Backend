const websocketRateLimitService = require('../src/services/websocketRateLimitService');
const { WebSocketRateLimitMiddleware } = require('../middleware/websocketRateLimit');
const { getDatabase } = require('../src/db/appDatabase');

describe('WebSocket Rate Limit Service', () => {
  let db;
  let testTenantId;
  let testIP = '192.168.1.100';
  
  beforeAll(async () => {
    db = getDatabase();
    
    // Create test tenant
    const [tenant] = await db('tenants').insert({
      name: 'WS Rate Limit Test Tenant',
      email: 'ws-test@example.com',
      created_at: new Date(),
      updated_at: new Date()
    }).returning('*');
    
    testTenantId = tenant.id;
    
    // Initialize service
    await websocketRateLimitService.initialize();
  });

  afterAll(async () => {
    await websocketRateLimitService.shutdown();
    
    // Clean up test data
    await db('websocket_rate_limit_log').where('tenant_id', testTenantId).del();
    await db('tenants').where('id', testTenantId).del();
  });

  beforeEach(async () => {
    // Clear Redis data
    await websocketRateLimitService.redis.flushAll();
    
    // Clear test data
    await db('websocket_rate_limit_log').where('tenant_id', testTenantId).del();
  });

  describe('Connection Limits', () => {
    test('should allow connections within IP limit', async () => {
      const socketId1 = 'socket1';
      const socketId2 = 'socket2';
      
      // First connection should be allowed
      const result1 = await websocketRateLimitService.checkConnectionLimit(testIP, null, socketId1);
      expect(result1.allowed).toBe(true);
      
      // Register first connection
      await websocketRateLimitService.registerConnection(testIP, null, socketId1);
      
      // Second connection should still be allowed (within limit of 5)
      const result2 = await websocketRateLimitService.checkConnectionLimit(testIP, null, socketId2);
      expect(result2.allowed).toBe(true);
    });

    test('should block connections exceeding IP limit', async () => {
      const maxConnections = websocketRateLimitService.config.maxConnectionsPerIP;
      
      // Register connections up to the limit
      for (let i = 0; i < maxConnections; i++) {
        await websocketRateLimitService.registerConnection(testIP, null, `socket${i}`);
      }
      
      // Next connection should be blocked
      const result = await websocketRateLimitService.checkConnectionLimit(testIP, null, 'socket_exceed');
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('IP_CONNECTION_LIMIT_EXCEEDED');
    });

    test('should allow connections within tenant limit', async () => {
      const socketId1 = 'socket1';
      const socketId2 = 'socket2';
      
      // First connection should be allowed
      const result1 = await websocketRateLimitService.checkConnectionLimit(testIP, testTenantId, socketId1);
      expect(result1.allowed).toBe(true);
      
      // Register first connection
      await websocketRateLimitService.registerConnection(testIP, testTenantId, socketId1);
      
      // Second connection should still be allowed (within limit of 10)
      const result2 = await websocketRateLimitService.checkConnectionLimit(testIP, testTenantId, socketId2);
      expect(result2.allowed).toBe(true);
    });

    test('should block connections exceeding tenant limit', async () => {
      const maxConnections = websocketRateLimitService.config.maxConnectionsPerTenant;
      
      // Register connections up to the limit
      for (let i = 0; i < maxConnections; i++) {
        await websocketRateLimitService.registerConnection(testIP, testTenantId, `socket${i}`);
      }
      
      // Next connection should be blocked
      const result = await websocketRateLimitService.checkConnectionLimit(testIP, testTenantId, 'socket_exceed');
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('TENANT_CONNECTION_LIMIT_EXCEEDED');
    });

    test('should log rate limit events', async () => {
      const maxConnections = websocketRateLimitService.config.maxConnectionsPerIP;
      
      // Register connections up to the limit
      for (let i = 0; i < maxConnections; i++) {
        await websocketRateLimitService.registerConnection(testIP, null, `socket${i}`);
      }
      
      // Try to exceed limit
      await websocketRateLimitService.checkConnectionLimit(testIP, null, 'socket_exceed');
      
      // Check if event was logged
      const logEntry = await db('websocket_rate_limit_log')
        .where('event_type', 'IP_CONNECTION_LIMIT')
        .where('client_ip', testIP)
        .first();
      
      expect(logEntry).toBeDefined();
      expect(logEntry.event_type).toBe('IP_CONNECTION_LIMIT');
      expect(logEntry.client_ip).toBe(testIP);
    });
  });

  describe('Connection Management', () => {
    test('should register connection correctly', async () => {
      const socketId = 'test_socket';
      
      await websocketRateLimitService.registerConnection(testIP, testTenantId, socketId, {
        user_agent: 'test-agent',
        origin: 'test-origin'
      });
      
      // Check if connection is registered in Redis
      const connectionKey = `ws:connection:${socketId}`;
      const connectionData = await websocketRateLimitService.redis.hGetAll(connectionKey);
      
      expect(connectionData.ip).toBe(testIP);
      expect(connectionData.tenant_id).toBe(testTenantId);
      expect(connectionData.connected_at).toBeDefined();
    });

    test('should unregister connection correctly', async () => {
      const socketId = 'test_socket';
      
      // Register connection
      await websocketRateLimitService.registerConnection(testIP, testTenantId, socketId);
      
      // Verify it's registered
      const connectionKey = `ws:connection:${socketId}`;
      const exists = await websocketRateLimitService.redis.exists(connectionKey);
      expect(exists).toBe(true);
      
      // Unregister connection
      await websocketRateLimitService.unregisterConnection(socketId);
      
      // Verify it's unregistered
      const existsAfter = await websocketRateLimitService.redis.exists(connectionKey);
      expect(existsAfter).toBe(false);
    });
  });

  describe('Message Rate Limiting', () => {
    test('should allow messages within rate limit', async () => {
      const socketId = 'test_socket';
      
      // Register connection
      await websocketRateLimitService.registerConnection(testIP, testTenantId, socketId);
      
      // Send messages within limit
      for (let i = 0; i < 5; i++) {
        const result = await websocketRateLimitService.checkMessageRateLimit(socketId);
        expect(result.allowed).toBe(true);
      }
    });

    test('should block messages exceeding rate limit', async () => {
      const socketId = 'test_socket';
      
      // Register connection with minimal tokens
      await websocketRateLimitService.registerConnection(testIP, testTenantId, socketId);
      
      // Manually set token count to 0 to test limit
      const rateLimitKey = `ws:messages:${socketId}`;
      const bucketKey = `${rateLimitKey}:bucket`;
      await websocketRateLimitService.redis.set(bucketKey, 0);
      
      // Next message should be blocked
      const result = await websocketRateLimitService.checkMessageRateLimit(socketId);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('MESSAGE_RATE_LIMIT_EXCEEDED');
    });

    test('should refill tokens over time', async () => {
      const socketId = 'test_socket';
      
      // Register connection
      await websocketRateLimitService.registerConnection(testIP, testTenantId, socketId);
      
      // Use all tokens
      const maxMessages = websocketRateLimitService.config.tokenBucketCapacity;
      for (let i = 0; i < maxMessages; i++) {
        await websocketRateLimitService.checkMessageRateLimit(socketId);
      }
      
      // Next message should be blocked
      const result1 = await websocketRateLimitService.checkMessageRateLimit(socketId);
      expect(result1.allowed).toBe(false);
      
      // Wait for token refill
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Message should be allowed again
      const result2 = await websocketRateLimitService.checkMessageRateLimit(socketId);
      expect(result2.allowed).toBe(true);
    });
  });

  describe('Statistics', () => {
    test('should return connection statistics', async () => {
      // Register some connections
      await websocketRateLimitService.registerConnection(testIP, testTenantId, 'socket1');
      await websocketRateLimitService.registerConnection(testIP, testTenantId, 'socket2');
      
      const stats = await websocketRateLimitService.getConnectionStats();
      
      expect(stats).toBeDefined();
      expect(stats.total_connections).toBe(2);
      expect(stats.unique_ips).toBe(1);
      expect(stats.unique_tenants).toBe(1);
      expect(stats.config).toBeDefined();
    });
  });
});

describe('WebSocket Rate Limit Middleware', () => {
  let middleware;
  
  beforeAll(() => {
    middleware = new WebSocketRateLimitMiddleware();
  });

  describe('Connection Limit Middleware', () => {
    test('should extract client IP correctly', () => {
      const req = {
        headers: {
          'x-forwarded-for': '192.168.1.100, 192.168.1.101',
          'x-real-ip': '192.168.1.100'
        },
        ip: '192.168.1.102'
      };
      
      const ip = middleware.getClientIP(req);
      expect(ip).toBe('192.168.1.100');
    });

    test('should extract tenant ID correctly', () => {
      const req1 = {
        user: { tenant_id: 'tenant-123' }
      };
      
      const req2 = {
        tenant: { id: 'tenant-456' }
      };
      
      const req3 = {
        query: { tenant_id: 'tenant-789' }
      };
      
      expect(middleware.getTenantId(req1)).toBe('tenant-123');
      expect(middleware.getTenantId(req2)).toBe('tenant-456');
      expect(middleware.getTenantId(req3)).toBe('tenant-789');
    });

    test('should generate unique socket IDs', () => {
      const id1 = middleware.generateSocketId();
      const id2 = middleware.generateSocketId();
      
      expect(id1).toMatch(/^ws_\d+_[a-z0-9]+$/);
      expect(id2).toMatch(/^ws_\d+_[a-z0-9]+$/);
      expect(id1).not.toBe(id2);
    });
  });

  describe('Rate Limit Check', () => {
    test('should allow connection within limits', async () => {
      const req = {
        headers: { 'x-forwarded-for': '192.168.1.100' },
        user: { tenant_id: 'test-tenant' }
      };
      
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };
      
      const next = jest.fn();
      
      // Mock the service to return allowed
      jest.spyOn(websocketRateLimitService, 'checkConnectionLimit')
        .mockResolvedValue({ allowed: true, reason: 'CONNECTION_ALLOWED' });
      
      await middleware.checkConnectionLimit(req, res, next);
      
      expect(next).toHaveBeenCalled();
      expect(req.wsRateLimit).toBeDefined();
      expect(req.wsRateLimit.allowed).toBe(true);
    });

    test('should block connection exceeding limits', async () => {
      const req = {
        headers: { 'x-forwarded-for': '192.168.1.100' },
        user: { tenant_id: 'test-tenant' }
      };
      
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };
      
      const next = jest.fn();
      
      // Mock the service to return blocked
      jest.spyOn(websocketRateLimitService, 'checkConnectionLimit')
        .mockResolvedValue({ 
          allowed: false, 
          reason: 'IP_CONNECTION_LIMIT_EXCEEDED',
          details: { current: 5, limit: 5, retry_after: 60 }
        });
      
      await middleware.checkConnectionLimit(req, res, next);
      
      expect(res.status).toHaveBeenCalledWith(429);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Too Many Requests',
        message: 'WebSocket connection limit exceeded',
        code: 'IP_CONNECTION_LIMIT_EXCEEDED',
        details: { current: 5, limit: 5, retry_after: 60 },
        retry_after: 60
      });
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('Connection Registration', () => {
    test('should register connection successfully', async () => {
      const socket = {
        id: 'test_socket',
        rateLimit: null,
        on: jest.fn(),
        emit: jest.fn()
      };
      
      const req = {
        wsRateLimit: {
          socketId: 'test_socket',
          clientIP: '192.168.1.100',
          tenantId: 'test-tenant',
          allowed: true
        }
      };
      
      // Mock the service
      jest.spyOn(websocketRateLimitService, 'registerConnection')
        .mockResolvedValue();
      
      await middleware.registerConnection(socket, req);
      
      expect(websocketRateLimitService.registerConnection).toHaveBeenCalledWith(
        '192.168.1.100',
        'test-tenant',
        'test_socket',
        expect.any(Object)
      );
      expect(socket.rateLimit).toBeDefined();
      expect(socket.on).toHaveBeenCalledWith('disconnect', expect.any(Function));
    });
  });

  describe('Stats Middleware', () => {
    test('should return statistics', async () => {
      const req = {};
      const res = {
        json: jest.fn()
      };
      
      // Mock the service
      jest.spyOn(websocketRateLimitService, 'getConnectionStats')
        .mockResolvedValue({
          total_connections: 10,
          unique_ips: 5,
          unique_tenants: 3
        });
      
      const statsMiddleware = middleware.getStatsMiddleware();
      await statsMiddleware(req, res);
      
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: {
          total_connections: 10,
          unique_ips: 5,
          unique_tenants: 3
        }
      });
    });
  });
});
