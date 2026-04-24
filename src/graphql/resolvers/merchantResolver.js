/**
 * Merchant Resolvers
 * Handles merchant queries and mutations
 */

const merchantResolvers = {
  Query: {
    /**
     * Get a single merchant by ID
     */
    merchant: async (parent, { id }, { db, dataloaders }) => {
      return dataloaders.merchants.load(id);
    },

    /**
     * Get a merchant by wallet address
     */
    merchantByWallet: async (parent, { walletAddress }, { db }) => {
      try {
        const query = `SELECT * FROM creators WHERE wallet_address = ?`;
        return db.db.prepare(query).get(walletAddress);
      } catch (error) {
        console.error('Error fetching merchant by wallet:', error);
        throw new Error('Failed to fetch merchant');
      }
    },

    /**
     * List merchants with pagination
     */
    merchants: async (parent, { limit = 50, offset = 0, sortBy = 'createdAt', sortOrder = 'DESC' }, { db }) => {
      try {
        const totalCountQuery = `SELECT COUNT(*) as count FROM creators`;
        const { count: totalCount } = db.db.prepare(totalCountQuery).get();

        const query = `
          SELECT * FROM creators 
          ORDER BY ${sortBy} ${sortOrder}
          LIMIT ? OFFSET ?
        `;
        const merchants = db.db.prepare(query).all(limit, offset);

        return {
          nodes: merchants,
          totalCount,
          pageInfo: {
            hasNextPage: offset + limit < totalCount,
            hasPreviousPage: offset > 0,
            startCursor: Buffer.from(offset.toString()).toString('base64'),
            endCursor: Buffer.from((offset + limit).toString()).toString('base64')
          }
        };
      } catch (error) {
        console.error('Error fetching merchants:', error);
        throw new Error('Failed to fetch merchants');
      }
    },

    /**
     * Get merchant dashboard with all related data
     * This replaces the 5 separate REST API calls
     */
    merchantDashboard: async (parent, { id }, { db, dataloaders }) => {
      try {
        const merchant = await dataloaders.merchants.load(id);
        if (!merchant) {
          throw new Error(`Merchant not found: ${id}`);
        }

        // Get all required data with single batched queries through dataloaders
        const subscriptions = await dataloaders.subscriptionsByMerchant.load(id);
        const activeCount = await dataloaders.subscriptionCount.load(id);
        const plans = await dataloaders.plansByMerchant.load(id);
        const billingEvents = await dataloaders.billingEventsByMerchant.load(id);

        // Calculate stats
        const totalRevenue = billingEvents
          .filter(e => e.status === 'COMPLETED')
          .reduce((sum, e) => sum + (e.amount || 0), 0);

        const monthlyRevenue = billingEvents
          .filter(e => {
            const eventDate = new Date(e.created_at);
            const now = new Date();
            return e.status === 'COMPLETED' && 
                   eventDate.getMonth() === now.getMonth() &&
                   eventDate.getFullYear() === now.getFullYear();
          })
          .reduce((sum, e) => sum + (e.amount || 0), 0);

        return {
          merchant,
          stats: {
            totalSubscribers: subscriptions.length,
            activeSubscribers: activeCount,
            totalRevenue,
            monthlyRevenue,
            averageSubscriptionValue: subscriptions.length > 0 ? totalRevenue / subscriptions.length : 0,
            churnRate: subscriptions.length > 0 
              ? (subscriptions.filter(s => !s.active).length / subscriptions.length) * 100 
              : 0
          },
          recentSubscriptions: subscriptions.slice(0, 10),
          recentBillingEvents: billingEvents.slice(0, 10)
        };
      } catch (error) {
        console.error('Error fetching merchant dashboard:', error);
        throw new Error('Failed to fetch merchant dashboard');
      }
    }
  },

  Mutation: {
    /**
     * Create a new merchant
     */
    createMerchant: async (parent, { input }, { db, dataloaders }) => {
      try {
        const { walletAddress, displayName, email } = input;
        
        if (!walletAddress) {
          throw new Error('Wallet address is required');
        }

        const id = require('uuid').v4();
        const createdAt = new Date().toISOString();

        const query = `
          INSERT INTO creators (id, wallet_address, display_name, email, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `;
        
        db.db.prepare(query).run(id, walletAddress, displayName, email, createdAt, createdAt);
        
        // Clear cache so fresh data is fetched
        dataloaders.merchants.clear(id);
        
        return db.db.prepare('SELECT * FROM creators WHERE id = ?').get(id);
      } catch (error) {
        console.error('Error creating merchant:', error);
        throw new Error('Failed to create merchant');
      }
    },

    /**
     * Update merchant details
     */
    updateMerchant: async (parent, { id, input }, { db, dataloaders }) => {
      try {
        const { displayName, email } = input;
        const updatedAt = new Date().toISOString();

        const updates = [];
        const values = [];

        if (displayName !== undefined) {
          updates.push('display_name = ?');
          values.push(displayName);
        }
        if (email !== undefined) {
          updates.push('email = ?');
          values.push(email);
        }

        updates.push('updated_at = ?');
        values.push(updatedAt);
        values.push(id);

        const query = `UPDATE creators SET ${updates.join(', ')} WHERE id = ?`;
        db.db.prepare(query).run(...values);

        // Clear cache
        dataloaders.merchants.clear(id);
        dataloaders.clearAll();

        return db.db.prepare('SELECT * FROM creators WHERE id = ?').get(id);
      } catch (error) {
        console.error('Error updating merchant:', error);
        throw new Error('Failed to update merchant');
      }
    }
  },

  Merchant: {
    /**
     * Get subscriptions for merchant (uses dataloader)
     */
    subscriptions: async (merchant, args, { dataloaders }) => {
      return dataloaders.subscriptionsByMerchant.load(merchant.id);
    },

    /**
     * Get plans for merchant (uses dataloader)
     */
    plans: async (merchant, args, { dataloaders }) => {
      return dataloaders.plansByMerchant.load(merchant.id);
    },

    /**
     * Get billing events for merchant (uses dataloader)
     */
    billingEvents: async (merchant, args, { dataloaders }) => {
      return dataloaders.billingEventsByMerchant.load(merchant.id);
    },

    /**
     * Get active subscription count (uses dataloader)
     */
    subscriptionCount: async (merchant, args, { dataloaders }) => {
      return dataloaders.subscriptionCount.load(merchant.id);
    },

    /**
     * Calculate subscription count with filtering
     */
    activeSubscriptionCount: async (merchant, args, { db }) => {
      try {
        const query = `SELECT COUNT(*) as count FROM subscriptions WHERE creator_id = ? AND active = 1`;
        const { count } = db.db.prepare(query).get(merchant.id);
        return count;
      } catch (error) {
        console.error('Error counting active subscriptions:', error);
        return 0;
      }
    },

    /**
     * Calculate total revenue for merchant
     */
    totalRevenue: async (merchant, args, { db }) => {
      try {
        const query = `
          SELECT COALESCE(SUM(amount), 0) as total FROM billing_events 
          WHERE merchant_id = ? AND status = 'COMPLETED'
        `;
        const { total } = db.db.prepare(query).get(merchant.id);
        return parseFloat(total) || 0;
      } catch (error) {
        console.error('Error calculating total revenue:', error);
        return 0;
      }
    }
  }
};

module.exports = merchantResolvers;
