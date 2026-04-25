const MRRAnalyticsService = require('../src/services/mrrAnalyticsService');
const { Pool } = require('pg');

describe('MRR Analytics Service Integration Tests', () => {
  let mrrService;
  let mockDatabase;
  let mockRedisService;
  let mockRedisClient;

  beforeEach(() => {
    // Mock database
    mockDatabase = {
      pool: {
        connect: jest.fn(() => ({
          query: jest.fn(),
          release: jest.fn()
        }))
      }
    };

    // Mock Redis service
    mockRedisService = {
      subscribe: jest.fn(),
      publish: jest.fn()
    };

    // Mock Redis client
    mockRedisClient = {
      setex: jest.fn(),
      get: jest.fn()
    };

    // Mock getRedisClient function
    jest.doMock('../src/config/redis', () => ({
      getRedisClient: () => mockRedisClient
    }));

    mrrService = new MRRAnalyticsService(mockDatabase, mockRedisService);
  });

  afterEach(() => {
    jest.resetAllMocks();
    jest.restoreAllMocks();
  });

  describe('MRR Calculation', () => {
    test('should calculate MRR correctly for active subscriptions', async () => {
      const mockClient = {
        query: jest.fn()
          .mockResolvedValueOnce({
            rows: [{
              total_mrr: '1000.50',
              active_subscribers: '25',
              currency: 'XLM',
              avg_revenue_per_user: '40.02'
            }]
          })
          .mockResolvedValueOnce({ rows: [{ mrr_gained_today: '200.00' }] })
          .mockResolvedValueOnce({ rows: [{ mrr_lost_to_churn: '50.00' }] })
          .mockResolvedValueOnce({ rows: [{ total_lost: '5', current_active: '20' }] })
          .mockResolvedValueOnce({ rows: [
            { flow_rate: '50.00', subscriber_count: 10, plan_mrr: '500.00' },
            { flow_rate: '25.00', subscriber_count: 15, plan_mrr: '375.00' }
          ] })
          .mockResolvedValueOnce({ rows: [] }),
        release: jest.fn()
      };

      mockDatabase.pool.connect.mockResolvedValue(mockClient);

      const result = await mrrService.calculateMRR('test-creator');

      expect(result).toEqual({
        total_mrr: 1000.50,
        active_subscribers: 25,
        currency: 'XLM',
        average_revenue_per_user: 40.02,
        mrr_gained_today: 200.00,
        mrr_lost_to_churn: 50.00,
        churn_rate: 20, // 5/(20+5) * 100
        by_plan: [
          { flow_rate: '50.00', subscriber_count: 10, plan_mrr: '500.00' },
          { flow_rate: '25.00', subscriber_count: 15, plan_mrr: '375.00' }
        ],
        recent_activity: []
      });
    });

    test('should handle zero MRR correctly', async () => {
      const mockClient = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [] }) // No active subscriptions
          .mockResolvedValueOnce({ rows: [{ mrr_gained_today: '0' }] })
          .mockResolvedValueOnce({ rows: [{ mrr_lost_to_churn: '0' }] })
          .mockResolvedValueOnce({ rows: [{ total_lost: '0', current_active: '0' }] })
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({ rows: [] }),
        release: jest.fn()
      };

      mockDatabase.pool.connect.mockResolvedValue(mockClient);

      const result = await mrrService.calculateMRR('test-creator');

      expect(result.total_mrr).toBe(0);
      expect(result.active_subscribers).toBe(0);
      expect(result.currency).toBe('XLM');
    });
  });

  describe('Event Handling and Throttling', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    test('should throttle MRR calculations within 5-second window', async () => {
      const mockClient = {
        query: jest.fn().mockResolvedValue({ rows: [] }),
        release: jest.fn()
      };
      mockDatabase.pool.connect.mockResolvedValue(mockClient);

      // Emit multiple payment events rapidly
      await mrrService.handlePaymentEvent('test-creator', 'payment_success', { amount: 100 });
      await mrrService.handlePaymentEvent('test-creator', 'payment_success', { amount: 200 });
      await mrrService.handlePaymentEvent('test-creator', 'payment_success', { amount: 300 });

      // Should not have calculated yet due to throttling
      expect(mockDatabase.pool.connect).not.toHaveBeenCalled();

      // Fast-forward 5 seconds
      jest.advanceTimersByTime(5000);

      // Should have calculated exactly once
      expect(mockDatabase.pool.connect).toHaveBeenCalledTimes(1);
    });

    test('should handle rapid burst of transactions correctly', async () => {
      const mockClient = {
        query: jest.fn().mockResolvedValue({ rows: [] }),
        release: jest.fn()
      };
      mockDatabase.pool.connect.mockResolvedValue(mockClient);

      const events = [];
      for (let i = 0; i < 20; i++) {
        events.push(mrrService.handlePaymentEvent('test-creator', 'payment_success', { amount: i * 10 }));
      }

      await Promise.all(events);

      // Fast-forward 5 seconds
      jest.advanceTimersByTime(5000);

      // Should have calculated exactly once despite 20 events
      expect(mockDatabase.pool.connect).toHaveBeenCalledTimes(1);
      expect(mockRedisService.publish).toHaveBeenCalledWith('mrr_update', expect.any(Object));
    });
  });

  describe('WebSocket Broadcasting', () => {
    test('should broadcast MRR updates to merchant room', async () => {
      const mockClient = {
        query: jest.fn().mockResolvedValue({ rows: [] }),
        release: jest.fn()
      };
      mockDatabase.pool.connect.mockResolvedValue(mockClient);

      await mrrService.calculateAndBroadcastMRR('test-creator', 'payment_success', { amount: 100 });

      expect(mockRedisService.publish).toHaveBeenCalledWith('mrr_update', {
        creator_id: 'test-creator',
        payload: expect.objectContaining({
          type: 'mrr_update',
          creator_id: 'test-creator',
          trigger_event: 'payment_success',
          metrics: expect.any(Object),
          deltas: expect.any(Object)
        })
      });
    });

    test('should include proper delta calculations', async () => {
      const mockClient = {
        query: jest.fn()
          .mockResolvedValueOnce({
            rows: [{ total_mrr: '1500', active_subscribers: '30', currency: 'XLM', avg_revenue_per_user: '50' }]
          })
          .mockResolvedValue({ rows: [] }),
        release: jest.fn()
      };
      mockDatabase.pool.connect.mockResolvedValue(mockClient);

      // Set previous MRR value
      mrrService.lastMRRValues.set('test-creator', {
        total_mrr: 1000,
        active_subscribers: 25
      });

      await mrrService.calculateAndBroadcastMRR('test-creator', 'payment_success', { amount: 100 });

      const publishCall = mockRedisService.publish.mock.calls[0][1];
      const payload = publishCall.payload;

      expect(payload.deltas.mrr).toEqual({
        previous: 1000,
        current: 1500,
        change: 500,
        change_percent: 50
      });

      expect(payload.deltas.subscribers).toEqual({
        previous: 25,
        current: 30,
        change: 5
      });
    });
  });

  describe('Caching', () => {
    test('should cache MRR data in Redis', async () => {
      const mockClient = {
        query: jest.fn().mockResolvedValue({ rows: [] }),
        release: jest.fn()
      };
      mockDatabase.pool.connect.mockResolvedValue(mockClient);

      const mrrData = { total_mrr: 1000, active_subscribers: 25 };
      await mrrService.cacheMRRData('test-creator', mrrData);

      expect(mockRedisClient.setex).toHaveBeenCalledWith(
        'mrr_cache:test-creator',
        300,
        JSON.stringify(mrrData)
      );
    });

    test('should retrieve cached MRR data', async () => {
      const cachedData = { total_mrr: 1000, active_subscribers: 25 };
      mockRedisClient.get.mockResolvedValue(JSON.stringify(cachedData));

      const result = await mrrService.getCachedMRRData('test-creator');

      expect(result).toEqual(cachedData);
      expect(mockRedisClient.get).toHaveBeenCalledWith('mrr_cache:test-creator');
    });

    test('should return null for expired cache', async () => {
      mockRedisClient.get.mockResolvedValue(null);

      const result = await mrrService.getCachedMRRData('test-creator');

      expect(result).toBeNull();
    });
  });

  describe('REST API Consistency', () => {
    test('should ensure socket payload matches database after rapid transactions', async () => {
      const mockClient = {
        query: jest.fn()
          .mockResolvedValueOnce({
            rows: [{ total_mrr: '2000', active_subscribers: '40', currency: 'XLM', avg_revenue_per_user: '50' }]
          })
          .mockResolvedValue({ rows: [] }),
        release: jest.fn()
      };
      mockDatabase.pool.connect.mockResolvedValue(mockClient);

      // Simulate rapid transactions
      const events = [];
      for (let i = 0; i < 10; i++) {
        events.push(mrrService.handlePaymentEvent('test-creator', 'payment_success', { amount: 100 }));
      }
      await Promise.all(events);

      // Fast-forward throttling window
      jest.advanceTimersByTime(5000);

      // Get cached data (what REST API would return)
      const cachedData = await mrrService.getCachedMRRData('test-creator');

      // Verify socket payload matches cached data
      expect(cachedData).toBeDefined();
      expect(cachedData.total_mrr).toBe(2000);
      expect(cachedData.active_subscribers).toBe(40);

      // Verify the socket payload was sent with same data
      expect(mockRedisService.publish).toHaveBeenCalledWith('mrr_update', expect.objectContaining({
        creator_id: 'test-creator',
        payload: expect.objectContaining({
          metrics: expect.objectContaining({
            total_mrr: 2000,
            active_subscribers: 40
          })
        })
      }));
    });
  });

  describe('Error Handling', () => {
    test('should handle database errors gracefully', async () => {
      const mockClient = {
        query: jest.fn().mockRejectedValue(new Error('Database connection failed')),
        release: jest.fn()
      };
      mockDatabase.pool.connect.mockResolvedValue(mockClient);

      // Should not throw error
      await expect(mrrService.calculateAndBroadcastMRR('test-creator', 'payment_success', {}))
        .resolves.not.toThrow();

      // Should emit error event
      expect(mrrService.emit).toHaveBeenCalledWith('mrr_error', {
        creator_id: 'test-creator',
        error: 'Database connection failed'
      });
    });

    test('should handle Redis errors gracefully', async () => {
      mockRedisService.publish.mockRejectedValue(new Error('Redis connection failed'));

      const mockClient = {
        query: jest.fn().mockResolvedValue({ rows: [] }),
        release: jest.fn()
      };
      mockDatabase.pool.connect.mockResolvedValue(mockClient);

      // Should not throw error
      await expect(mrrService.calculateAndBroadcastMRR('test-creator', 'payment_success', {}))
        .resolves.not.toThrow();
    });
  });

  describe('Force Recalculation', () => {
    test('should force immediate recalculation bypassing throttling', async () => {
      const mockClient = {
        query: jest.fn().mockResolvedValue({ rows: [] }),
        release: jest.fn()
      };
      mockDatabase.pool.connect.mockResolvedValue(mockClient);

      // Set up pending calculation
      await mrrService.handlePaymentEvent('test-creator', 'payment_success', { amount: 100 });
      expect(mrrService.pendingCalculations.has('test-creator')).toBe(true);

      // Force recalculation
      await mrrService.forceRecalculate('test-creator');

      // Should have cleared pending calculation and calculated immediately
      expect(mrrService.pendingCalculations.has('test-creator')).toBe(false);
      expect(mockDatabase.pool.connect).toHaveBeenCalledTimes(1);
    });
  });
});
