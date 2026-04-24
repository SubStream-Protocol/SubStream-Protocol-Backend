/**
 * Billing Event Resolvers
 * Handles billing event queries and mutations
 */

const billingEventResolvers = {
  Query: {
    /**
     * Get a single billing event by ID
     */
    billingEvent: async (parent, { id }, { dataloaders }) => {
      return dataloaders.billingEvents.load(id);
    },

    /**
     * List billing events for a merchant
     */
    billingEventsByMerchant: async (
      parent,
      { merchantId, status, eventType, startDate, endDate, limit = 50, offset = 0 },
      { db }
    ) => {
      try {
        const filters = ['merchant_id = ?'];
        const params = [merchantId];

        if (status) {
          filters.push('status = ?');
          params.push(status);
        }
        if (eventType) {
          filters.push('event_type = ?');
          params.push(eventType);
        }
        if (startDate) {
          filters.push('created_at >= ?');
          params.push(startDate);
        }
        if (endDate) {
          filters.push('created_at <= ?');
          params.push(endDate);
        }

        const whereClause = filters.join(' AND ');

        const countQuery = `SELECT COUNT(*) as count FROM billing_events WHERE ${whereClause}`;
        const { count: totalCount } = db.db.prepare(countQuery).get(...params);

        const query = `
          SELECT * FROM billing_events 
          WHERE ${whereClause}
          ORDER BY created_at DESC
          LIMIT ? OFFSET ?
        `;
        const events = db.db.prepare(query).all(...params, limit, offset);

        return {
          nodes: events,
          totalCount,
          pageInfo: {
            hasNextPage: offset + limit < totalCount,
            hasPreviousPage: offset > 0,
            startCursor: Buffer.from(offset.toString()).toString('base64'),
            endCursor: Buffer.from((offset + limit).toString()).toString('base64')
          }
        };
      } catch (error) {
        console.error('Error fetching billing events by merchant:', error);
        throw new Error('Failed to fetch billing events');
      }
    },

    /**
     * List billing events for a subscription
     */
    billingEventsBySubscription: async (parent, { subscriptionId, limit = 50, offset = 0 }, { db }) => {
      try {
        const countQuery = `SELECT COUNT(*) as count FROM billing_events WHERE subscription_id = ?`;
        const { count: totalCount } = db.db.prepare(countQuery).get(subscriptionId);

        const query = `
          SELECT * FROM billing_events 
          WHERE subscription_id = ?
          ORDER BY created_at DESC
          LIMIT ? OFFSET ?
        `;
        const events = db.db.prepare(query).all(subscriptionId, limit, offset);

        return {
          nodes: events,
          totalCount,
          pageInfo: {
            hasNextPage: offset + limit < totalCount,
            hasPreviousPage: offset > 0,
            startCursor: Buffer.from(offset.toString()).toString('base64'),
            endCursor: Buffer.from((offset + limit).toString()).toString('base64')
          }
        };
      } catch (error) {
        console.error('Error fetching billing events by subscription:', error);
        throw new Error('Failed to fetch billing events');
      }
    },

    /**
     * Get billing statistics for a merchant
     */
    merchantBillingStats: async (parent, { merchantId, startDate, endDate }, { db }) => {
      try {
        const merchant = require('./merchantResolver').Query.merchant;
        const merchantData = await merchant(parent, { id: merchantId }, { db });

        if (!merchantData) {
          throw new Error('Merchant not found');
        }

        const filters = ['merchant_id = ?'];
        const params = [merchantId];

        if (startDate) {
          filters.push('created_at >= ?');
          params.push(startDate);
        }
        if (endDate) {
          filters.push('created_at <= ?');
          params.push(endDate);
        }

        const whereClause = filters.join(' AND ');

        // Get total revenue
        const revenueQuery = `
          SELECT COALESCE(SUM(amount), 0) as total FROM billing_events 
          WHERE ${whereClause} AND status = 'COMPLETED'
        `;
        const { total: totalRevenue } = db.db.prepare(revenueQuery).get(...params);

        // Get total events
        const eventCountQuery = `SELECT COUNT(*) as count FROM billing_events WHERE ${whereClause}`;
        const { count: totalEvents } = db.db.prepare(eventCountQuery).get(...params);

        // Get successful payments
        const successQuery = `
          SELECT COUNT(*) as count FROM billing_events 
          WHERE ${whereClause} AND status = 'COMPLETED'
        `;
        const { count: successfulPayments } = db.db.prepare(successQuery).get(...params);

        // Get failed payments
        const failedQuery = `
          SELECT COUNT(*) as count FROM billing_events 
          WHERE ${whereClause} AND status = 'FAILED'
        `;
        const { count: failedPayments } = db.db.prepare(failedQuery).get(...params);

        // Get refunds
        const refundsQuery = `
          SELECT COALESCE(SUM(amount), 0) as total FROM billing_events 
          WHERE ${whereClause} AND event_type = 'REFUND'
        `;
        const { total: refunds } = db.db.prepare(refundsQuery).get(...params);

        // Get event type breakdown
        const eventTypesQuery = `
          SELECT event_type, COUNT(*) as count, COALESCE(SUM(amount), 0) as amount
          FROM billing_events 
          WHERE ${whereClause}
          GROUP BY event_type
          ORDER BY count DESC
        `;
        const topEventTypes = db.db.prepare(eventTypesQuery).all(...params);

        return {
          merchant: merchantData,
          totalRevenue: parseFloat(totalRevenue) || 0,
          totalEvents,
          successfulPayments,
          failedPayments,
          refunds: parseFloat(refunds) || 0,
          averageTransactionValue: totalEvents > 0 ? (parseFloat(totalRevenue) || 0) / totalEvents : 0,
          topEventTypes: topEventTypes.map(e => ({
            eventType: e.event_type,
            count: e.count,
            amount: parseFloat(e.amount) || 0
          }))
        };
      } catch (error) {
        console.error('Error fetching billing stats:', error);
        throw new Error('Failed to fetch billing stats');
      }
    }
  },

  Mutation: {
    /**
     * Create a billing event
     */
    createBillingEvent: async (parent, { input }, { db, dataloaders }) => {
      try {
        const { merchantId, subscriptionId, planId, amount, currency = 'USD', eventType, description, metadata } = input;

        if (!merchantId || !amount || !eventType) {
          throw new Error('Merchant ID, amount, and event type are required');
        }

        const id = require('uuid').v4();
        const createdAt = new Date().toISOString();

        const query = `
          INSERT INTO billing_events 
          (id, merchant_id, subscription_id, plan_id, amount, currency, event_type, status, description, metadata, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        const metadataJson = JSON.stringify(metadata || {});
        db.db.prepare(query).run(
          id,
          merchantId,
          subscriptionId,
          planId,
          amount,
          currency,
          eventType,
          'PENDING',
          description,
          metadataJson,
          createdAt,
          createdAt
        );

        // Clear caches
        dataloaders.clearAll();

        return db.db.prepare('SELECT * FROM billing_events WHERE id = ?').get(id);
      } catch (error) {
        console.error('Error creating billing event:', error);
        throw new Error('Failed to create billing event');
      }
    },

    /**
     * Update billing event status
     */
    updateBillingEventStatus: async (parent, { id, status }, { db, dataloaders }) => {
      try {
        const updatedAt = new Date().toISOString();
        const processedAt = status === 'COMPLETED' ? updatedAt : null;

        const query = `
          UPDATE billing_events 
          SET status = ?, processed_at = ?, updated_at = ? 
          WHERE id = ?
        `;

        db.db.prepare(query).run(status, processedAt, updatedAt, id);

        // Clear caches
        dataloaders.billingEvents.clear(id);
        dataloaders.clearAll();

        return db.db.prepare('SELECT * FROM billing_events WHERE id = ?').get(id);
      } catch (error) {
        console.error('Error updating billing event status:', error);
        throw new Error('Failed to update billing event');
      }
    },

    /**
     * Record a refund for a billing event
     */
    refundBillingEvent: async (parent, { id, reason }, { db, dataloaders }) => {
      try {
        const updatedAt = new Date().toISOString();

        const query = `
          UPDATE billing_events 
          SET status = 'REFUNDED', event_type = 'REFUND', description = ?, updated_at = ? 
          WHERE id = ?
        `;

        db.db.prepare(query).run(reason || 'Refund processed', updatedAt, id);

        // Clear caches
        dataloaders.billingEvents.clear(id);
        dataloaders.clearAll();

        return db.db.prepare('SELECT * FROM billing_events WHERE id = ?').get(id);
      } catch (error) {
        console.error('Error refunding billing event:', error);
        throw new Error('Failed to refund billing event');
      }
    }
  },

  BillingEvent: {
    /**
     * Get merchant for billing event (uses dataloader)
     */
    merchant: async (event, args, { dataloaders }) => {
      return dataloaders.merchants.load(event.merchant_id);
    },

    /**
     * Get subscription for billing event (uses dataloader)
     */
    subscription: async (event, args, { dataloaders }) => {
      if (!event.subscription_id) return null;
      return dataloaders.subscriptions.load(event.subscription_id);
    },

    /**
     * Get plan for billing event (uses dataloader)
     */
    plan: async (event, args, { dataloaders }) => {
      if (!event.plan_id) return null;
      return dataloaders.plans.load(event.plan_id);
    },

    /**
     * Parse metadata JSON
     */
    metadata: async (event) => {
      try {
        return typeof event.metadata === 'string' ? JSON.parse(event.metadata) : event.metadata || {};
      } catch {
        return {};
      }
    }
  }
};

module.exports = billingEventResolvers;
