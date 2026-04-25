import { Test, TestingModule } from '@nestjs/testing';
import { WebSocketRecoveryGateway } from './websocket-recovery.gateway';
import { AuthService } from '../auth/auth.service';
import { RedisService } from '../redis/redis.service';
import { DunningService } from './dunning.service';
import { Server, Socket } from 'socket.io';

// Extend the Socket interface for testing
interface TestSocket extends Socket {
  stellarPublicKey?: string;
  token?: string;
  lastMessageId?: number;
  reconnectAttempts?: number;
}

describe('WebSocketRecoveryGateway', () => {
  let gateway: WebSocketRecoveryGateway;
  let authServiceMock: jest.Mocked<AuthService>;
  let redisServiceMock: jest.Mocked<RedisService>;
  let dunningServiceMock: jest.Mocked<DunningService>;
  let serverMock: jest.Mocked<Server>;
  let clientMock: jest.Mocked<TestSocket>;

  beforeEach(async () => {
    authServiceMock = {
      extractPublicKeyFromToken: jest.fn(),
      isTokenExpired: jest.fn(),
    } as any;

    redisServiceMock = {
      subscribe: jest.fn(),
      publish: jest.fn(),
      lpush: jest.fn(),
      ltrim: jest.fn(),
      expire: jest.fn(),
    } as any;

    dunningServiceMock = {
      processPaymentFailure: jest.fn(),
    } as any;

    serverMock = {
      to: jest.fn().mockReturnValue({
        emit: jest.fn(),
      }),
    } as any;

    clientMock = {
      id: 'test-client-id',
      handshake: {
        auth: {},
      },
      join: jest.fn(),
      emit: jest.fn(),
      disconnect: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebSocketRecoveryGateway,
        {
          provide: AuthService,
          useValue: authServiceMock,
        },
        {
          provide: RedisService,
          useValue: redisServiceMock,
        },
        {
          provide: DunningService,
          useValue: dunningServiceMock,
        },
      ],
    }).compile();

    gateway = module.get<WebSocketRecoveryGateway>(WebSocketRecoveryGateway);
    gateway['server'] = serverMock;
  });

  it('should be defined', () => {
    expect(gateway).toBeDefined();
  });

  describe('handleConnection', () => {
    const stellarPublicKey = 'test-public-key';

    beforeEach(() => {
      authServiceMock.extractPublicKeyFromToken.mockResolvedValue(stellarPublicKey);
      authServiceMock.isTokenExpired.mockReturnValue(false);
    });

    it('should handle new connection successfully', async () => {
      clientMock.handshake.auth = {
        token: 'valid-token',
      };

      await gateway.handleConnection(clientMock);

      expect(authServiceMock.extractPublicKeyFromToken).toHaveBeenCalledWith('valid-token');
      expect(clientMock.stellarPublicKey).toBe(stellarPublicKey);
      expect(clientMock.join).toHaveBeenCalledWith(stellarPublicKey);
      expect(clientMock.emit).toHaveBeenCalledWith('connected', expect.objectContaining({
        merchantId: stellarPublicKey,
        currentMessageId: 0,
      }));
    });

    it('should handle reconnection with message replay', async () => {
      clientMock.handshake.auth = {
        token: 'valid-token',
        lastMessageId: 5,
        reconnectAttempt: 2,
      };

      // Mock existing messages in buffer
      const mockMessages = [
        { messageId: 3, event: 'test_event', data: {}, timestamp: Date.now() },
        { messageId: 6, event: 'test_event2', data: {}, timestamp: Date.now() },
        { messageId: 7, event: 'test_event3', data: {}, timestamp: Date.now() },
      ];

      gateway['messageBuffers'].set(stellarPublicKey, mockMessages);
      gateway['messageIdCounter'].set(stellarPublicKey, 7);

      await gateway.handleConnection(clientMock);

      expect(clientMock.emit).toHaveBeenCalledWith('reconnection_complete', expect.objectContaining({
        messagesReplayed: 2, // Messages 6 and 7
        lastMessageId: 7,
      }));

      // Should replay messages 6 and 7
      expect(clientMock.emit).toHaveBeenCalledWith('test_event2', expect.objectContaining({
        messageId: 6,
        replayed: true,
      }));
      expect(clientMock.emit).toHaveBeenCalledWith('test_event3', expect.objectContaining({
        messageId: 7,
        replayed: true,
      }));
    });

    it('should send state_stale if buffer is empty during reconnection', async () => {
      clientMock.handshake.auth = {
        token: 'valid-token',
        lastMessageId: 100,
      };

      // Empty buffer
      gateway['messageBuffers'].set(stellarPublicKey, []);
      gateway['messageIdCounter'].set(stellarPublicKey, 150);

      await gateway.handleConnection(clientMock);

      expect(clientMock.emit).toHaveBeenCalledWith('state_stale', expect.objectContaining({
        message: 'Too much time has passed since last connection',
        recommendation: 'Please refresh your data via REST API',
      }));
    });

    it('should reject connection without token', async () => {
      clientMock.handshake.auth = {};

      await gateway.handleConnection(clientMock);

      expect(clientMock.emit).toHaveBeenCalledWith('error', { message: 'Authentication failed' });
      expect(clientMock.disconnect).toHaveBeenCalledWith(true);
    });

    it('should reject connection with invalid token', async () => {
      clientMock.handshake.auth = {
        token: 'invalid-token',
      };

      authServiceMock.extractPublicKeyFromToken.mockRejectedValue(new Error('Invalid token'));

      await gateway.handleConnection(clientMock);

      expect(clientMock.emit).toHaveBeenCalledWith('error', { message: 'Authentication failed' });
      expect(clientMock.disconnect).toHaveBeenCalledWith(true);
    });
  });

  describe('handleDisconnect', () => {
    it('should clean up intervals and timeouts', async () => {
      const stellarPublicKey = 'test-public-key';
      clientMock.stellarPublicKey = stellarPublicKey;

      // Mock intervals and timeouts
      const mockInterval = setInterval(() => {}, 1000);
      const mockTimeout = setTimeout(() => {}, 1000);
      
      gateway['heartbeatIntervals'].set(clientMock.id, mockInterval);
      gateway['connectionTimeouts'].set(clientMock.id, mockTimeout);

      const clearIntervalSpy = jest.spyOn(global, 'clearInterval');
      const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');

      await gateway.handleDisconnect(clientMock);

      expect(clearIntervalSpy).toHaveBeenCalledWith(mockInterval);
      expect(clearTimeoutSpy).toHaveBeenCalledWith(mockTimeout);
      expect(gateway['heartbeatIntervals'].has(clientMock.id)).toBe(false);
      expect(gateway['connectionTimeouts'].has(clientMock.id)).toBe(false);

      clearIntervalSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    });
  });

  describe('handlePing', () => {
    it('should respond with pong and reset timeout', async () => {
      const stellarPublicKey = 'test-public-key';
      clientMock.stellarPublicKey = stellarPublicKey;

      // Mock connection timeout
      const mockTimeout = setTimeout(() => {}, 1000);
      gateway['connectionTimeouts'].set(clientMock.id, mockTimeout);
      const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');
      const setTimeoutSpy = jest.spyOn(global, 'setTimeout');

      gateway.handlePing(clientMock);

      expect(clientMock.emit).toHaveBeenCalledWith('pong', expect.objectContaining({
        timestamp: expect.any(String),
      }));
      expect(clearTimeoutSpy).toHaveBeenCalledWith(mockTimeout);
      expect(setTimeoutSpy).toHaveBeenCalled();

      clearTimeoutSpy.mockRestore();
      setTimeoutSpy.mockRestore();
    });
  });

  describe('handleAck', () => {
    it('should update last acknowledged message ID and clean up buffer', async () => {
      const stellarPublicKey = 'test-public-key';
      clientMock.stellarPublicKey = stellarPublicKey;

      // Mock buffer with messages
      const mockMessages = [
        { messageId: 1, event: 'event1', data: {}, timestamp: Date.now() },
        { messageId: 2, event: 'event2', data: {}, timestamp: Date.now() },
        { messageId: 3, event: 'event3', data: {}, timestamp: Date.now() },
        { messageId: 4, event: 'event4', data: {}, timestamp: Date.now() },
      ];
      gateway['messageBuffers'].set(stellarPublicKey, mockMessages);

      gateway.handleAck(clientMock, { messageId: 2 });

      expect(gateway['lastAckedMessageId'].get(stellarPublicKey)).toBe(2);
      
      // Buffer should only contain messages with ID > 2
      const remainingMessages = gateway['messageBuffers'].get(stellarPublicKey);
      expect(remainingMessages).toHaveLength(2);
      expect(remainingMessages![0].messageId).toBe(3);
      expect(remainingMessages![1].messageId).toBe(4);
    });
  });

  describe('emitToMerchant', () => {
    it('should emit event with message ID and add to buffer', async () => {
      const merchantId = 'test-merchant';
      const event = 'test_event';
      const data = { test: 'data' };

      // Initialize merchant data
      gateway['messageIdCounter'].set(merchantId, 0);
      gateway['messageBuffers'].set(merchantId, []);

      await gateway.emitToMerchant(merchantId, event, data);

      expect(serverMock.to).toHaveBeenCalledWith(merchantId);
      expect(gateway['messageIdCounter'].get(merchantId)).toBe(1);
      
      const buffer = gateway['messageBuffers'].get(merchantId);
      expect(buffer).toHaveLength(1);
      expect(buffer![0]).toMatchObject({
        messageId: 1,
        event,
        data,
      });

      expect(redisServiceMock.publish).toHaveBeenCalledWith('websocket_event', expect.objectContaining({
        merchantId,
        event,
        messageId: 1,
        data,
      }));
    });

    it('should maintain buffer size limit', async () => {
      const merchantId = 'test-merchant';
      const event = 'test_event';
      const data = { test: 'data' };

      // Initialize with full buffer
      const fullBuffer = Array.from({ length: 500 }, (_, i) => ({
        messageId: i + 1,
        event,
        data,
        timestamp: Date.now(),
      }));
      
      gateway['messageIdCounter'].set(merchantId, 500);
      gateway['messageBuffers'].set(merchantId, fullBuffer);

      await gateway.emitToMerchant(merchantId, event, data);

      const buffer = gateway['messageBuffers'].get(merchantId);
      expect(buffer).toHaveLength(500); // Should still be 500, not 501
      expect(buffer![buffer!.length - 1].messageId).toBe(501); // Latest message
    });
  });

  describe('event handlers', () => {
    const merchantId = 'test-merchant';
    const payload = {
      stellarPublicKey: merchantId,
      planId: 'plan-123',
      userId: 'user-456',
      failureReason: 'insufficient_funds',
      timestamp: new Date().toISOString(),
      deepLinkRef: 'ref-789',
    };

    beforeEach(() => {
      gateway['messageIdCounter'].set(merchantId, 0);
      gateway['messageBuffers'].set(merchantId, []);
    });

    it('should handle payment success events', async () => {
      await gateway.handlePaymentSuccess(payload);

      expect(redisServiceMock.publish).toHaveBeenCalledWith('payment_success', payload);
      expect(serverMock.to).toHaveBeenCalledWith(merchantId);
    });

    it('should handle payment failure events with dunning processing', async () => {
      const processedPayload = {
        stellarPublicKey: merchantId,
        failures: [payload],
        batchId: 'batch-123',
        timestamp: new Date().toISOString(),
        totalCount: 1,
      };
      dunningServiceMock.processPaymentFailure.mockResolvedValue(processedPayload);

      await gateway.handlePaymentFailure(payload);

      expect(dunningServiceMock.processPaymentFailure).toHaveBeenCalledWith(payload);
      expect(redisServiceMock.publish).toHaveBeenCalledWith('payment_failed', processedPayload);
      expect(serverMock.to).toHaveBeenCalledWith(merchantId);
    });

    it('should skip payment failure if dunning returns null', async () => {
      dunningServiceMock.processPaymentFailure.mockResolvedValue(null);

      await gateway.handlePaymentFailure(payload);

      expect(dunningServiceMock.processPaymentFailure).toHaveBeenCalledWith(payload);
      expect(redisServiceMock.publish).not.toHaveBeenCalledWith('payment_failed', expect.anything());
    });

    it('should handle trial conversion events', async () => {
      await gateway.handleTrialConverted(payload);

      expect(redisServiceMock.publish).toHaveBeenCalledWith('trial_converted', payload);
      expect(serverMock.to).toHaveBeenCalledWith(merchantId);
    });

    it('should handle MRR update events', async () => {
      const mrrPayload = { creator_id: merchantId, payload: { mrr: 100 } };

      await gateway.handleMRRUpdate(mrrPayload);

      expect(serverMock.to).toHaveBeenCalledWith(merchantId);
    });
  });

  describe('getBufferStats', () => {
    it('should return buffer statistics', () => {
      const merchantId1 = 'merchant1';
      const merchantId2 = 'merchant2';

      gateway['messageBuffers'].set(merchantId1, [
        { messageId: 1, event: 'event1', data: {}, timestamp: Date.now() },
        { messageId: 3, event: 'event2', data: {}, timestamp: Date.now() },
      ]);

      gateway['messageBuffers'].set(merchantId2, [
        { messageId: 10, event: 'event3', data: {}, timestamp: Date.now() },
      ]);

      const stats = gateway.getBufferStats();

      expect(stats[merchantId1]).toMatchObject({
        size: 2,
        oldestMessage: 1,
        newestMessage: 3,
      });

      expect(stats[merchantId2]).toMatchObject({
        size: 1,
        oldestMessage: 10,
        newestMessage: 10,
      });
    });

    it('should return empty stats for empty buffers', () => {
      gateway['messageBuffers'].set('merchant1', []);

      const stats = gateway.getBufferStats();

      expect(stats).toEqual({});
    });
  });

  describe('buffer cleanup', () => {
    it('should remove old messages during cleanup', async () => {
      const merchantId = 'test-merchant';
      const now = Date.now();
      const oneHour = 60 * 60 * 1000;

      // Create buffer with old and new messages
      const messages = [
        { messageId: 1, event: 'old_event', data: {}, timestamp: now - oneHour - 1000 },
        { messageId: 2, event: 'new_event', data: {}, timestamp: now - 1000 },
        { messageId: 3, event: 'newer_event', data: {}, timestamp: now },
      ];

      gateway['messageBuffers'].set(merchantId, messages);

      // Trigger cleanup (this runs on interval, but we can test the logic)
      gateway['startBufferCleanup']();

      // Wait a bit for the interval to potentially run
      await new Promise(resolve => setTimeout(resolve, 100));

      const buffer = gateway['messageBuffers'].get(merchantId);
      
      // Should only contain the newer messages
      expect(buffer).toHaveLength(2);
      expect(buffer![0].messageId).toBe(2);
      expect(buffer![1].messageId).toBe(3);
    });
  });
});
