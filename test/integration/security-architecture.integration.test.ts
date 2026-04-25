import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../../src/app.module';
import { Redis } from 'ioredis';
import { Server } from 'socket.io';
import { io, Socket } from 'socket.io-client';

describe('Security Architecture Integration Tests', () => {
  let app: INestApplication;
  let redisClient: Redis;
  let httpServer: any;
  let wsClient: Socket;

  beforeAll(async () => {
    // Mock Redis for testing
    const mockRedis = {
      hset: jest.fn(),
      hgetall: jest.fn(),
      hincrby: jest.fn(),
      expire: jest.fn(),
      keys: jest.fn(),
      lpush: jest.fn(),
      ltrim: jest.fn(),
      subscribe: jest.fn(),
      publish: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
    .overrideProvider('REDIS_CLIENT')
    .useValue(mockRedis)
    .compile();

    app = module.createNestApplication();
    await app.init();
    
    httpServer = app.getHttpServer();
    redisClient = mockRedis as any;
  });

  afterAll(async () => {
    if (wsClient) {
      wsClient.disconnect();
    }
    await app.close();
  });

  describe('Cross-Tenant Data Leakage Prevention', () => {
    let validToken: string;

    beforeAll(() => {
      // Mock a valid JWT token for testing
      validToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0LXB1YmxpYy1rZXkiLCJ0ZW5hbnRfaWQiOiJ0ZW5hbnQtMTIzIiwiaWF0IjoxNjE2MjM5MDIyfQ.test';
    });

    it('should allow responses with matching tenant_id', async () => {
      // Mock Redis to return tenant configuration
      redisClient.hgetall.mockResolvedValue({
        tier: 'standard',
        connectionString: 'postgres://test-db:5432/substream',
      });

      const response = await request(httpServer)
        .get('/test/tenant-data')
        .set('Authorization', `Bearer ${validToken}`)
        .expect(200);

      expect(response.body).toMatchObject({
        tenant_id: 'tenant-123', // Should match the authenticated tenant
        data: 'some data',
      });
    });

    it('should block responses with mismatched tenant_id', async () => {
      // Mock Redis to return tenant configuration
      redisClient.hgetall.mockResolvedValue({
        tier: 'standard',
        connectionString: 'postgres://test-db:5432/substream',
      });

      // This should be intercepted and return 500 instead of the actual data
      const response = await request(httpServer)
        .get('/test/cross-tenant-data')
        .set('Authorization', `Bearer ${validToken}`)
        .expect(500);

      expect(response.body).toMatchObject({
        message: 'Internal server error',
      });
    });

    it('should handle nested objects with tenant validation', async () => {
      redisClient.hgetall.mockResolvedValue({
        tier: 'standard',
        connectionString: 'postgres://test-db:5432/substream',
      });

      const response = await request(httpServer)
        .get('/test/nested-tenant-data')
        .set('Authorization', `Bearer ${validToken}`)
        .expect(200);

      expect(response.body).toMatchObject({
        user: {
          tenant_id: 'tenant-123',
          name: 'Test User',
        },
        subscription: {
          tenant_id: 'tenant-123',
          plan: 'premium',
        },
      });
    });

    it('should bypass tenant check for admin endpoints', async () => {
      redisClient.hgetall.mockResolvedValue({
        tier: 'standard',
        connectionString: 'postgres://test-db:5432/substream',
      });

      // Admin endpoint should bypass tenant validation
      const response = await request(httpServer)
        .get('/admin/global-stats')
        .set('Authorization', `Bearer ${validToken}`)
        .expect(200);

      expect(response.body).toMatchObject({
        totalUsers: expect.any(Number),
        totalRevenue: expect.any(Number),
        // Should not contain tenant_id validation
      });
    });
  });

  describe('Dynamic Database Routing', () => {
    it('should route standard tenants to shared database', async () => {
      const tenantId = 'standard-tenant-456';
      
      // Mock tenant configuration
      redisClient.hgetall.mockResolvedValue({
        tier: 'standard',
        connectionString: 'postgres://shared-db:5432/substream',
      });

      // Mock shared database configuration
      redisClient.hgetall
        .mockResolvedValueOnce({
          tier: 'standard',
          connectionString: 'postgres://shared-db:5432/substream',
        })
        .mockResolvedValueOnce({
          connectionString: 'postgres://shared-db:5432/substream',
        });

      const response = await request(httpServer)
        .get(`/test/database-routing/${tenantId}`)
        .expect(200);

      expect(response.body).toMatchObject({
        tenantId,
        databaseType: 'shared',
        connectionString: 'postgres://shared-db:5432/substream',
      });
    });

    it('should route enterprise tenants to dedicated database', async () => {
      const tenantId = 'enterprise-tenant-789';
      const enterpriseDb = 'postgres://enterprise-db:5432/substream';
      
      // Mock enterprise tenant configuration
      redisClient.hgetall.mockResolvedValue({
        tier: 'enterprise',
        connectionString: enterpriseDb,
      });

      const response = await request(httpServer)
        .get(`/test/database-routing/${tenantId}`)
        .expect(200);

      expect(response.body).toMatchObject({
        tenantId,
        databaseType: 'enterprise',
        connectionString: enterpriseDb,
      });
    });

    it('should handle tenant migration to enterprise', async () => {
      const tenantId = 'migrating-tenant-123';
      const enterpriseDb = 'postgres://new-enterprise-db:5432/substream';
      const sharedDb = 'postgres://shared-db:5432/substream';

      // Mock current tenant config
      redisClient.hgetall.mockResolvedValue({
        tier: 'standard',
        connectionString: sharedDb,
      });

      // Mock migration operations
      redisClient.hset.mockResolvedValue(1);
      redisClient.hincrby.mockResolvedValue(1);
      redisClient.expire.mockResolvedValue(1);

      const response = await request(httpServer)
        .post(`/test/migrate-tenant/${tenantId}`)
        .send({
          enterpriseConnectionString: enterpriseDb,
        })
        .expect(200);

      expect(response.body).toMatchObject({
        success: true,
        message: 'Migration completed successfully',
      });

      expect(redisClient.hset).toHaveBeenCalledWith(
        expect.stringContaining(`migration:${tenantId}:`),
        expect.objectContaining({
          status: 'in_progress',
          fromDb: sharedDb,
          toDb: enterpriseDb,
        })
      );
    });

    it('should reject migration for already enterprise tenants', async () => {
      const tenantId = 'already-enterprise-456';
      const enterpriseDb = 'postgres://enterprise-db:5432/substream';

      // Mock enterprise tenant configuration
      redisClient.hgetall.mockResolvedValue({
        tier: 'enterprise',
        connectionString: enterpriseDb,
      });

      const response = await request(httpServer)
        .post(`/test/migrate-tenant/${tenantId}`)
        .send({
          enterpriseConnectionString: enterpriseDb,
        })
        .expect(400);

      expect(response.body).toMatchObject({
        success: false,
        error: expect.stringContaining('already on enterprise tier'),
      });
    });
  });

  describe('WebSocket Connection Recovery', () => {
    let wsServer: Server;

    beforeAll(() => {
      wsServer = app.get('WebSocketRecoveryGateway')?.server;
    });

    it('should establish WebSocket connection with authentication', (done) => {
      wsClient = io('http://localhost:3001/merchant', {
        auth: {
          token: 'valid-websocket-token',
        },
      });

      wsClient.on('connect', () => {
        expect(wsClient.connected).toBe(true);
        done();
      });

      wsClient.on('error', (error) => {
        done(error);
      });
    });

    it('should handle heartbeat ping/pong', (done) => {
      wsClient.on('ping', (data) => {
        expect(data).toMatchObject({
          timestamp: expect.any(String),
        });
        
        // Respond with pong
        wsClient.emit('pong', { timestamp: new Date().toISOString() });
        done();
      });

      // Trigger ping by waiting for heartbeat interval
      setTimeout(() => {
        wsClient.emit('ping');
      }, 100);
    });

    it('should buffer and replay events on reconnection', (done) => {
      let messageIdCounter = 0;
      const events: any[] = [];

      // Listen for events
      wsClient.on('payment_success', (data) => {
        events.push(data);
        
        // Acknowledge the message
        wsClient.emit('ack', { messageId: data.messageId });
        
        if (events.length >= 2) {
          expect(events).toHaveLength(2);
          expect(events[0].messageId).toBe(1);
          expect(events[1].messageId).toBe(2);
          done();
        }
      });

      // Simulate server sending events
      setTimeout(() => {
        wsClient.emit('payment_success', {
          messageId: ++messageIdCounter,
          data: { amount: 100, merchantId: 'test-merchant' },
        });
        
        wsClient.emit('payment_success', {
          messageId: ++messageIdCounter,
          data: { amount: 200, merchantId: 'test-merchant' },
        });
      }, 50);
    });

    it('should handle reconnection with message replay', (done) => {
      const originalClient = wsClient;
      let replayedEvents = 0;

      // Disconnect original client
      originalClient.disconnect();

      // Reconnect with last known message ID
      wsClient = io('http://localhost:3001/merchant', {
        auth: {
          token: 'valid-websocket-token',
          lastMessageId: 5,
          reconnectAttempt: 1,
        },
      });

      wsClient.on('reconnection_complete', (data) => {
        expect(data.messagesReplayed).toBeGreaterThan(0);
        expect(data.lastMessageId).toBeGreaterThan(5);
        done();
      });

      wsClient.on('payment_success', (data) => {
        if (data.replayed) {
          replayedEvents++;
        }
      });

      // Give time for reconnection
      setTimeout(() => {
        if (replayedEvents === 0) {
          done(new Error('No events were replayed'));
        }
      }, 1000);
    });

    it('should handle state_stale when buffer is empty', (done) => {
      const staleClient = io('http://localhost:3001/merchant', {
        auth: {
          token: 'valid-websocket-token',
          lastMessageId: 999, // Very old message ID
          reconnectAttempt: 1,
        },
      });

      staleClient.on('state_stale', (data) => {
        expect(data.message).toContain('Too much time has passed');
        expect(data.recommendation).toContain('refresh your data');
        staleClient.disconnect();
        done();
      });

      staleClient.on('connect', () => {
        done(new Error('Expected state_stale event, but connection succeeded'));
      });
    });
  });

  describe('End-to-End Security Flow', () => {
    it('should prevent cross-tenant data access through complete flow', async () => {
      const attackerToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhdHRhY2tlci1rZXkiLCJ0ZW5hbnRfaWQiOiJhdHRhY2tlci10ZW5hbnQiLCJpYXQiOjE2MTYyMzkwMjJ9.attack';
      
      // Mock attacker tenant configuration
      redisClient.hgetall.mockResolvedValue({
        tier: 'standard',
        connectionString: 'postgres://shared-db:5432/substream',
      });

      // Try to access victim's data
      const response = await request(httpServer)
        .get('/api/subscriptions/victim-tenant-123')
        .set('Authorization', `Bearer ${attackerToken}`)
        .expect(500); // Should be blocked by tenant leakage prevention

      expect(response.body.message).toBe('Internal server error');
    });

    it('should allow legitimate tenant access through complete flow', async () => {
      const legitimateToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJsZWdpdC1rZXkiLCJ0ZW5hbnRfaWQiOiJsZWdpdC10ZW5hbnQiLCJpYXQiOjE2MTYyMzkwMjJ9.legit';
      
      // Mock legitimate tenant configuration
      redisClient.hgetall.mockResolvedValue({
        tier: 'standard',
        connectionString: 'postgres://shared-db:5432/substream',
      });

      const response = await request(httpServer)
        .get('/api/subscriptions/legitimate-tenant-456')
        .set('Authorization', `Bearer ${legitimateToken}`)
        .expect(200);

      expect(response.body).toMatchObject({
        tenant_id: 'legitimate-tenant-456',
        subscriptions: expect.any(Array),
      });
    });
  });

  describe('Performance and Load Testing', () => {
    it('should handle large response payloads efficiently', async () => {
      const validToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0LXB1YmxpYy1rZXkiLCJ0ZW5hbnRfaWQiOiJ0ZW5hbnQtMTIzIiwiaWF0IjoxNjE2MjM5MDIyfQ.test';
      
      redisClient.hgetall.mockResolvedValue({
        tier: 'standard',
        connectionString: 'postgres://test-db:5432/substream',
      });

      const startTime = Date.now();
      
      const response = await request(httpServer)
        .get('/test/large-payload')
        .set('Authorization', `Bearer ${validToken}`)
        .expect(200);

      const endTime = Date.now();
      const responseTime = endTime - startTime;

      // Should handle large payloads efficiently (< 100ms)
      expect(responseTime).toBeLessThan(100);
      expect(response.body).toMatchObject({
        data: expect.any(Array),
        totalCount: expect.any(Number),
      });
    });

    it('should handle concurrent WebSocket connections', async () => {
      const connections: Socket[] = [];
      const connectionPromises: Promise<void>[] = [];

      // Create 10 concurrent connections
      for (let i = 0; i < 10; i++) {
        const promise = new Promise<void>((resolve, reject) => {
          const client = io('http://localhost:3001/merchant', {
            auth: {
              token: `valid-token-${i}`,
            },
          });

          client.on('connect', () => {
            connections.push(client);
            resolve();
          });

          client.on('error', reject);
        });

        connectionPromises.push(promise);
      }

      // Wait for all connections to establish
      await Promise.all(connectionPromises);

      expect(connections).toHaveLength(10);
      connections.forEach(client => {
        expect(client.connected).toBe(true);
      });

      // Clean up connections
      connections.forEach(client => client.disconnect());
    });
  });
});
