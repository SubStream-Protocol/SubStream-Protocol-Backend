const EventEmitter = require('events');
const { getRedisClient } = require('../config/redis');

/**
 * MRR Analytics Service for Live Substream Analytics Feed
 * Handles real-time MRR calculations with throttling and WebSocket broadcasting
 */
class MRRAnalyticsService extends EventEmitter {
  constructor(database, redisService) {
    super();
    this.database = database;
    this.redisService = redisService;
    this.redisClient = getRedisClient();
    
    // Throttling configuration
    this.THROTTLE_WINDOW_MS = 5000; // 5 seconds
    this.pendingCalculations = new Map(); // creatorId -> timeout
    this.lastMRRValues = new Map(); // creatorId -> { mrr, timestamp }
    
    // Setup Redis subscriptions for payment events
    this.setupRedisSubscriptions();
  }

  /**
   * Setup Redis subscriptions for payment events
   */
  setupRedisSubscriptions() {
    // Subscribe to payment success events
    this.redisService.subscribe('payment_success', async (payload) => {
      await this.handlePaymentEvent(payload.stellarPublicKey, 'payment_success', payload);
    });

    // Subscribe to payment failure events  
    this.redisService.subscribe('payment_failed', async (payload) => {
      await this.handlePaymentEvent(payload.stellarPublicKey, 'payment_failed', payload);
    });

    // Subscribe to subscription cancellation events
    this.redisService.subscribe('subscription_cancelled', async (payload) => {
      await this.handlePaymentEvent(payload.stellarPublicKey, 'subscription_cancelled', payload);
    });

    // Subscribe to new subscription events
    this.redisService.subscribe('subscription_created', async (payload) => {
      await this.handlePaymentEvent(payload.stellarPublicKey, 'subscription_created', payload);
    });
  }

  /**
   * Handle payment events with throttling
   */
  async handlePaymentEvent(creatorId, eventType, payload) {
    // Clear existing timeout for this creator
    if (this.pendingCalculations.has(creatorId)) {
      clearTimeout(this.pendingCalculations.get(creatorId));
    }

    // Set new throttled calculation
    const timeout = setTimeout(async () => {
      await this.calculateAndBroadcastMRR(creatorId, eventType, payload);
      this.pendingCalculations.delete(creatorId);
    }, this.THROTTLE_WINDOW_MS);

    this.pendingCalculations.set(creatorId, timeout);
  }

  /**
   * Calculate MRR and broadcast via WebSocket
   */
  async calculateAndBroadcastMRR(creatorId, triggerEvent, payload) {
    try {
      const startTime = Date.now();
      
      // Get current MRR calculation
      const currentMRRData = await this.calculateMRR(creatorId);
      const previousMRRData = this.lastMRRValues.get(creatorId) || { 
        total_mrr: 0, 
        active_subscribers: 0,
        mrr_gained_today: 0,
        mrr_lost_to_churn: 0
      };

      // Calculate deltas
      const mrrDelta = {
        previous: previousMRRData.total_mrr,
        current: currentMRRData.total_mrr,
        change: currentMRRData.total_mrr - previousMRRData.total_mrr,
        change_percent: previousMRRData.total_mrr > 0 
          ? ((currentMRRData.total_mrr - previousMRRData.total_mrr) / previousMRRData.total_mrr) * 100 
          : 0
      };

      const subscribersDelta = {
        previous: previousMRRData.active_subscribers,
        current: currentMRRData.active_subscribers,
        change: currentMRRData.active_subscribers - previousMRRData.active_subscribers
      };

      // Create metric payload
      const metricPayload = {
        type: 'mrr_update',
        creator_id: creatorId,
        timestamp: new Date().toISOString(),
        trigger_event: triggerEvent,
        trigger_payload: payload,
        calculation_time_ms: Date.now() - startTime,
        
        // Current metrics
        metrics: {
          total_mrr: currentMRRData.total_mrr,
          active_subscribers: currentMRRData.active_subscribers,
          currency: currentMRRData.currency || 'XLM',
          mrr_gained_today: currentMRRData.mrr_gained_today,
          mrr_lost_to_churn: currentMRRData.mrr_lost_to_churn,
          churn_rate: currentMRRData.churn_rate,
          average_revenue_per_user: currentMRRData.average_revenue_per_user
        },
        
        // Deltas for animation
        deltas: {
          mrr: mrrDelta,
          subscribers: subscribersDelta
        },
        
        // Granular breakdowns
        breakdowns: {
          by_plan: currentMRRData.by_plan || [],
          by_cohort: currentMRRData.by_cohort || [],
          recent_activity: currentMRRData.recent_activity || []
        }
      };

      // Cache current values for next calculation
      this.lastMRRValues.set(creatorId, currentMRRData);

      // Broadcast to WebSocket clients
      await this.broadcastToMerchant(creatorId, metricPayload);

      // Emit for internal listeners
      this.emit('mrr_calculated', metricPayload);

      // Cache in Redis for REST API consistency
      await this.cacheMRRData(creatorId, currentMRRData);

      console.log(`MRR calculated for ${creatorId}: ${currentMRRData.total_mrr} (${mrrDelta.change > 0 ? '+' : ''}${mrrDelta.change})`);

    } catch (error) {
      console.error(`Error calculating MRR for ${creatorId}:`, error);
      this.emit('mrr_error', { creatorId, error: error.message });
    }
  }

  /**
   * Calculate comprehensive MRR data
   */
  async calculateMRR(creatorId) {
    const client = await this.database.pool.connect();
    try {
      // Get current MRR from active subscriptions
      const mrrResult = await client.query(`
        SELECT 
          SUM(CAST(cs.flow_rate AS DECIMAL)) as total_mrr,
          COUNT(s.wallet_address) as active_subscribers,
          cs.currency,
          AVG(CAST(cs.flow_rate AS DECIMAL)) as avg_revenue_per_user
        FROM subscriptions s
        JOIN creator_settings cs ON s.creator_id = cs.creator_id
        WHERE s.creator_id = $1 AND s.active = 1
        GROUP BY cs.currency
      `, [creatorId]);

      const baseData = mrrResult.rows[0] || { 
        total_mrr: 0, 
        active_subscribers: 0, 
        currency: 'XLM',
        avg_revenue_per_user: 0
      };

      // Get MRR gained today
      const gainedTodayResult = await client.query(`
        SELECT COALESCE(SUM(CAST(flow_rate AS DECIMAL)), 0) as mrr_gained_today
        FROM subscriptions s
        JOIN creator_settings cs ON s.creator_id = cs.creator_id
        WHERE s.creator_id = $1 
          AND s.active = 1 
          AND DATE(s.subscribed_at) = CURRENT_DATE
      `, [creatorId]);

      // Get MRR lost to churn today
      const lostToChurnResult = await client.query(`
        SELECT COALESCE(SUM(CAST(cs.flow_rate AS DECIMAL)), 0) as mrr_lost_to_churn
        FROM subscriptions s
        JOIN creator_settings cs ON s.creator_id = cs.creator_id
        WHERE s.creator_id = $1 
          AND s.active = 0 
          AND DATE(s.unsubscribed_at) = CURRENT_DATE
      `, [creatorId]);

      // Calculate churn rate (last 30 days)
      const churnRateResult = await client.query(`
        SELECT 
          COUNT(*) as total_lost,
          (SELECT COUNT(*) FROM subscriptions WHERE creator_id = $1 AND active = 1) as current_active
        FROM subscriptions 
        WHERE creator_id = $1 
          AND active = 0 
          AND unsubscribed_at >= NOW() - INTERVAL '30 days'
      `, [creatorId]);

      const churnData = churnRateResult.rows[0];
      const churnRate = churnData.current_active > 0 
        ? (churnData.total_lost / (churnData.current_active + churnData.total_lost)) * 100 
        : 0;

      // Get breakdown by plan
      const planBreakdownResult = await client.query(`
        SELECT 
          cs.flow_rate,
          COUNT(*) as subscriber_count,
          SUM(CAST(cs.flow_rate AS DECIMAL)) as plan_mrr
        FROM subscriptions s
        JOIN creator_settings cs ON s.creator_id = cs.creator_id
        WHERE s.creator_id = $1 AND s.active = 1
        GROUP BY cs.flow_rate
        ORDER BY plan_mrr DESC
      `, [creatorId]);

      // Get recent activity (last hour)
      const recentActivityResult = await client.query(`
        SELECT 
          'payment' as type,
          wallet_address,
          created_at as timestamp,
          amount
        FROM billing_events 
        WHERE creator_id = $1 AND created_at >= NOW() - INTERVAL '1 hour'
        UNION ALL
        SELECT 
          CASE WHEN active = 1 THEN 'new_subscription' ELSE 'cancellation' END as type,
          wallet_address,
          CASE WHEN active = 1 THEN subscribed_at ELSE unsubscribed_at END as timestamp,
          CAST(flow_rate AS DECIMAL) as amount
        FROM subscriptions s
        JOIN creator_settings cs ON s.creator_id = cs.creator_id
        WHERE s.creator_id = $1 
          AND (
            (active = 1 AND subscribed_at >= NOW() - INTERVAL '1 hour') OR
            (active = 0 AND unsubscribed_at >= NOW() - INTERVAL '1 hour')
          )
        ORDER BY timestamp DESC
        LIMIT 10
      `, [creatorId]);

      return {
        total_mrr: parseFloat(baseData.total_mrr) || 0,
        active_subscribers: parseInt(baseData.active_subscribers) || 0,
        currency: baseData.currency,
        average_revenue_per_user: parseFloat(baseData.avg_revenue_per_user) || 0,
        mrr_gained_today: parseFloat(gainedTodayResult.rows[0].mrr_gained_today) || 0,
        mrr_lost_to_churn: parseFloat(lostToChurnResult.rows[0].mrr_lost_to_churn) || 0,
        churn_rate: parseFloat(churnRate) || 0,
        by_plan: planBreakdownResult.rows,
        recent_activity: recentActivityResult.rows
      };

    } finally {
      client.release();
    }
  }

  /**
   * Broadcast MRR update to merchant WebSocket clients
   */
  async broadcastToMerchant(creatorId, payload) {
    try {
      // Use WebSocket gateway to emit to merchant room
      if (this.redisService) {
        await this.redisService.publish('mrr_update', {
          creator_id: creatorId,
          payload
        });
      }
    } catch (error) {
      console.error('Error broadcasting to merchant:', error);
    }
  }

  /**
   * Cache MRR data in Redis for REST API consistency
   */
  async cacheMRRData(creatorId, mrrData) {
    try {
      const cacheKey = `mrr_cache:${creatorId}`;
      await this.redisClient.setex(cacheKey, 300, JSON.stringify(mrrData)); // 5 minutes TTL
    } catch (error) {
      console.error('Error caching MRR data:', error);
    }
  }

  /**
   * Get cached MRR data for REST API
   */
  async getCachedMRRData(creatorId) {
    try {
      const cacheKey = `mrr_cache:${creatorId}`;
      const cached = await this.redisClient.get(cacheKey);
      return cached ? JSON.parse(cached) : null;
    } catch (error) {
      console.error('Error getting cached MRR data:', error);
      return null;
    }
  }

  /**
   * Force immediate MRR recalculation (for testing or manual triggers)
   */
  async forceRecalculate(creatorId) {
    // Clear any pending throttled calculation
    if (this.pendingCalculations.has(creatorId)) {
      clearTimeout(this.pendingCalculations.get(creatorId));
      this.pendingCalculations.delete(creatorId);
    }

    // Calculate immediately
    await this.calculateAndBroadcastMRR(creatorId, 'manual_trigger', {});
  }
}

module.exports = MRRAnalyticsService;
