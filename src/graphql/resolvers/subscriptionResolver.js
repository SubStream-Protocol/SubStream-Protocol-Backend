/**
 * Subscription Resolvers
 * Handles subscription queries and mutations
 */

const subscriptionResolvers = {
  Query: {
    /**
     * Get a single subscription by ID
     */
    subscription: async (parent, { id }, { dataloaders }) => {
      return dataloaders.subscriptions.load(id);
    },

    /**
     * List subscriptions for a merchant
     */
    subscriptions: async (parent, { merchantId, status, limit = 50, offset = 0 }, { db, dataloaders }) => {
      try {
        let statusFilter = '';
        if (status) {
          const statusMap = {
            ACTIVE: 'active = 1',
            INACTIVE: 'active = 0',
            EXPIRED: "unsubscribed_at IS NOT NULL",
            CANCELLED: "cancelled_at IS NOT NULL"
          };
          statusFilter = statusMap[status] || '';
        }

        const countQuery = `
          SELECT COUNT(*) as count FROM subscriptions 
          WHERE creator_id = ? ${statusFilter ? 'AND ' + statusFilter : ''}
        `;
        const { count: totalCount } = db.db.prepare(countQuery).get(merchantId);

        const query = `
          SELECT * FROM subscriptions 
          WHERE creator_id = ? ${statusFilter ? 'AND ' + statusFilter : ''}
          ORDER BY subscribed_at DESC
          LIMIT ? OFFSET ?
        `;
        const subscriptions = db.db.prepare(query).all(merchantId, limit, offset);

        return {
          nodes: subscriptions,
          totalCount,
          pageInfo: {
            hasNextPage: offset + limit < totalCount,
            hasPreviousPage: offset > 0,
            startCursor: Buffer.from(offset.toString()).toString('base64'),
            endCursor: Buffer.from((offset + limit).toString()).toString('base64')
          }
        };
      } catch (error) {
        console.error('Error fetching subscriptions:', error);
        throw new Error('Failed to fetch subscriptions');
      }
    },

    /**
     * Get subscriptions for a subscriber wallet
     */
    mySubscriptions: async (parent, { subscriberWallet, limit = 50, offset = 0 }, { db }) => {
      try {
        const countQuery = `
          SELECT COUNT(*) as count FROM subscriptions 
          WHERE wallet_address = ?
        `;
        const { count: totalCount } = db.db.prepare(countQuery).get(subscriberWallet);

        const query = `
          SELECT * FROM subscriptions 
          WHERE wallet_address = ?
          ORDER BY subscribed_at DESC
          LIMIT ? OFFSET ?
        `;
        const subscriptions = db.db.prepare(query).all(subscriberWallet, limit, offset);

        return {
          nodes: subscriptions,
          totalCount,
          pageInfo: {
            hasNextPage: offset + limit < totalCount,
            hasPreviousPage: offset > 0,
            startCursor: Buffer.from(offset.toString()).toString('base64'),
            endCursor: Buffer.from((offset + limit).toString()).toString('base64')
          }
        };
      } catch (error) {
        console.error('Error fetching subscriber subscriptions:', error);
        throw new Error('Failed to fetch subscriptions');
      }
    },

    /**
     * Check if a subscriber has an active subscription to a merchant
     */
    hasActiveSubscription: async (parent, { merchantId, subscriberWallet }, { dataloaders }) => {
      try {
        return dataloaders.activeSubscriptionChecker.load({ merchantId, walletAddress: subscriberWallet });
      } catch (error) {
        console.error('Error checking active subscription:', error);
        return false;
      }
    }
  },

  Mutation: {
    /**
     * Create a new subscription
     */
    createSubscription: async (parent, { input }, { db, dataloaders }) => {
      try {
        const { merchantId, subscriberWallet, planId, deviceId, deviceFingerprint } = input;

        if (!merchantId || !subscriberWallet) {
          throw new Error('Merchant ID and subscriber wallet are required');
        }

        const id = require('uuid').v4();
        const subscribedAt = new Date().toISOString();

        const query = `
          INSERT INTO subscriptions 
          (id, creator_id, wallet_address, plan_id, subscribed_at, active, device_id, device_fingerprint)
          VALUES (?, ?, ?, ?, ?, 1, ?, ?)
        `;

        db.db.prepare(query).run(id, merchantId, subscriberWallet, planId, subscribedAt, deviceId, deviceFingerprint);

        // Clear relevant caches
        dataloaders.clearAll();

        return db.db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id);
      } catch (error) {
        console.error('Error creating subscription:', error);
        throw new Error('Failed to create subscription');
      }
    },

    /**
     * Update subscription
     */
    updateSubscription: async (parent, { id, input }, { db, dataloaders }) => {
      try {
        const { planId, active, daysToExpire } = input;
        const updates = [];
        const values = [];

        if (planId !== undefined) {
          updates.push('plan_id = ?');
          values.push(planId);
        }
        if (active !== undefined) {
          updates.push('active = ?');
          values.push(active ? 1 : 0);
        }
        if (daysToExpire !== undefined) {
          const expiryDate = new Date();
          expiryDate.setDate(expiryDate.getDate() + daysToExpire);
          updates.push('expires_at = ?');
          values.push(expiryDate.toISOString());
        }

        if (updates.length === 0) {
          return db.db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id);
        }

        values.push(id);
        const query = `UPDATE subscriptions SET ${updates.join(', ')} WHERE id = ?`;
        db.db.prepare(query).run(...values);

        // Clear caches
        dataloaders.subscriptions.clear(id);
        dataloaders.clearAll();

        return db.db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id);
      } catch (error) {
        console.error('Error updating subscription:', error);
        throw new Error('Failed to update subscription');
      }
    },

    /**
     * Cancel a subscription
     */
    cancelSubscription: async (parent, { id }, { db, dataloaders }) => {
      try {
        const unsubscribedAt = new Date().toISOString();

        const query = `
          UPDATE subscriptions 
          SET active = 0, unsubscribed_at = ? 
          WHERE id = ?
        `;

        db.db.prepare(query).run(unsubscribedAt, id);

        // Clear caches
        dataloaders.subscriptions.clear(id);
        dataloaders.clearAll();

        return db.db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id);
      } catch (error) {
        console.error('Error cancelling subscription:', error);
        throw new Error('Failed to cancel subscription');
      }
    }
  },

  Subscription: {
    /**
     * Get merchant for subscription (uses dataloader)
     */
    merchant: async (subscription, args, { dataloaders }) => {
      return dataloaders.merchants.load(subscription.creator_id);
    },

    /**
     * Get plan for subscription (uses dataloader)
     */
    plan: async (subscription, args, { dataloaders }) => {
      if (!subscription.plan_id) return null;
      return dataloaders.plans.load(subscription.plan_id);
    },

    /**
     * Get latest billing event for subscription (uses dataloader)
     */
    latestBillingEvent: async (subscription, args, { dataloaders }) => {
      return dataloaders.latestBillingEventsBySubscription.load(subscription.id);
    },

    /**
     * Get all billing events for subscription (uses dataloader)
     */
    billingEvents: async (subscription, args, { dataloaders }) => {
      return dataloaders.billingEventsBySubscription.load(subscription.id);
    },

    /**
     * Get subscription status
     */
    status: async (subscription) => {
      if (!subscription.active) return 'INACTIVE';
      if (subscription.unsubscribed_at) return 'CANCELLED';
      if (subscription.expires_at && new Date(subscription.expires_at) < new Date()) return 'EXPIRED';
      return 'ACTIVE';
    },

    /**
     * Calculate days remaining
     */
    daysRemaining: async (subscription) => {
      if (!subscription.expires_at) return null;
      const expiryDate = new Date(subscription.expires_at);
      const today = new Date();
      const diffTime = expiryDate - today;
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      return diffDays > 0 ? diffDays : 0;
    },

    subscriberWallet: async (subscription) => {
      return subscription.wallet_address;
    }
  }
};

module.exports = subscriptionResolvers;
