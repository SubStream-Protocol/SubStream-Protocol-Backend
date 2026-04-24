/**
 * Plan Resolvers
 * Handles plan queries and mutations
 */

const planResolvers = {
  Query: {
    /**
     * Get a single plan by ID
     */
    plan: async (parent, { id }, { dataloaders }) => {
      return dataloaders.plans.load(id);
    },

    /**
     * List plans for a merchant
     */
    plansByMerchant: async (parent, { merchantId, active = true, limit = 50, offset = 0 }, { db }) => {
      try {
        let query = `SELECT COUNT(*) as count FROM plans WHERE merchant_id = ?`;
        const params = [merchantId];

        if (active !== null) {
          query += ' AND active = ?';
          params.push(active ? 1 : 0);
        }

        const { count: totalCount } = db.db.prepare(query).get(...params);

        const listQuery = `
          SELECT * FROM plans 
          WHERE merchant_id = ? ${active !== null ? 'AND active = ?' : ''}
          ORDER BY created_at DESC
          LIMIT ? OFFSET ?
        `;
        const listParams = [merchantId];
        if (active !== null) listParams.push(active ? 1 : 0);
        listParams.push(limit, offset);

        const plans = db.db.prepare(listQuery).all(...listParams);

        return {
          nodes: plans,
          totalCount,
          pageInfo: {
            hasNextPage: offset + limit < totalCount,
            hasPreviousPage: offset > 0,
            startCursor: Buffer.from(offset.toString()).toString('base64'),
            endCursor: Buffer.from((offset + limit).toString()).toString('base64')
          }
        };
      } catch (error) {
        console.error('Error fetching plans by merchant:', error);
        throw new Error('Failed to fetch plans');
      }
    },

    /**
     * List all plans
     */
    plans: async (parent, { limit = 50, offset = 0, sortBy = 'createdAt', sortOrder = 'DESC' }, { db }) => {
      try {
        const countQuery = `SELECT COUNT(*) as count FROM plans`;
        const { count: totalCount } = db.db.prepare(countQuery).get();

        const query = `
          SELECT * FROM plans 
          ORDER BY ${sortBy} ${sortOrder}
          LIMIT ? OFFSET ?
        `;
        const plans = db.db.prepare(query).all(limit, offset);

        return {
          nodes: plans,
          totalCount,
          pageInfo: {
            hasNextPage: offset + limit < totalCount,
            hasPreviousPage: offset > 0,
            startCursor: Buffer.from(offset.toString()).toString('base64'),
            endCursor: Buffer.from((offset + limit).toString()).toString('base64')
          }
        };
      } catch (error) {
        console.error('Error fetching plans:', error);
        throw new Error('Failed to fetch plans');
      }
    }
  },

  Mutation: {
    /**
     * Create a new plan
     */
    createPlan: async (parent, { input }, { db, dataloaders }) => {
      try {
        const { merchantId, name, description, price, currency = 'USD', billingCycle, features, maxSubscribers } = input;

        if (!merchantId || !name || price === undefined || !billingCycle) {
          throw new Error('Merchant ID, name, price, and billing cycle are required');
        }

        const id = require('uuid').v4();
        const createdAt = new Date().toISOString();

        const query = `
          INSERT INTO plans 
          (id, merchant_id, name, description, price, currency, billing_cycle, features, max_subscribers, active, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        `;

        const featureJson = JSON.stringify(features || []);
        db.db.prepare(query).run(
          id,
          merchantId,
          name,
          description,
          price,
          currency,
          billingCycle,
          featureJson,
          maxSubscribers,
          createdAt,
          createdAt
        );

        // Clear caches
        dataloaders.clearAll();

        return db.db.prepare('SELECT * FROM plans WHERE id = ?').get(id);
      } catch (error) {
        console.error('Error creating plan:', error);
        throw new Error('Failed to create plan');
      }
    },

    /**
     * Update a plan
     */
    updatePlan: async (parent, { id, input }, { db, dataloaders }) => {
      try {
        const { name, description, price, features, maxSubscribers, active } = input;
        const updates = [];
        const values = [];

        if (name !== undefined) {
          updates.push('name = ?');
          values.push(name);
        }
        if (description !== undefined) {
          updates.push('description = ?');
          values.push(description);
        }
        if (price !== undefined) {
          updates.push('price = ?');
          values.push(price);
        }
        if (features !== undefined) {
          updates.push('features = ?');
          values.push(JSON.stringify(features));
        }
        if (maxSubscribers !== undefined) {
          updates.push('max_subscribers = ?');
          values.push(maxSubscribers);
        }
        if (active !== undefined) {
          updates.push('active = ?');
          values.push(active ? 1 : 0);
        }

        if (updates.length === 0) {
          return db.db.prepare('SELECT * FROM plans WHERE id = ?').get(id);
        }

        updates.push('updated_at = ?');
        values.push(new Date().toISOString());
        values.push(id);

        const query = `UPDATE plans SET ${updates.join(', ')} WHERE id = ?`;
        db.db.prepare(query).run(...values);

        // Clear caches
        dataloaders.plans.clear(id);
        dataloaders.clearAll();

        return db.db.prepare('SELECT * FROM plans WHERE id = ?').get(id);
      } catch (error) {
        console.error('Error updating plan:', error);
        throw new Error('Failed to update plan');
      }
    },

    /**
     * Deactivate a plan
     */
    deactivatePlan: async (parent, { id }, { db, dataloaders }) => {
      try {
        const query = `UPDATE plans SET active = 0, updated_at = ? WHERE id = ?`;
        db.db.prepare(query).run(new Date().toISOString(), id);

        // Clear caches
        dataloaders.plans.clear(id);
        dataloaders.clearAll();

        return db.db.prepare('SELECT * FROM plans WHERE id = ?').get(id);
      } catch (error) {
        console.error('Error deactivating plan:', error);
        throw new Error('Failed to deactivate plan');
      }
    },

    /**
     * Activate a plan
     */
    activatePlan: async (parent, { id }, { db, dataloaders }) => {
      try {
        const query = `UPDATE plans SET active = 1, updated_at = ? WHERE id = ?`;
        db.db.prepare(query).run(new Date().toISOString(), id);

        // Clear caches
        dataloaders.plans.clear(id);
        dataloaders.clearAll();

        return db.db.prepare('SELECT * FROM plans WHERE id = ?').get(id);
      } catch (error) {
        console.error('Error activating plan:', error);
        throw new Error('Failed to activate plan');
      }
    }
  },

  Plan: {
    /**
     * Get merchant for plan (uses dataloader)
     */
    merchant: async (plan, args, { dataloaders }) => {
      return dataloaders.merchants.load(plan.merchant_id);
    },

    /**
     * Parse features JSON
     */
    features: async (plan) => {
      try {
        return typeof plan.features === 'string' ? JSON.parse(plan.features) : plan.features || [];
      } catch {
        return [];
      }
    },

    /**
     * Get subscription count for plan
     */
    subscriptionCount: async (plan, args, { db }) => {
      try {
        const query = `SELECT COUNT(*) as count FROM subscriptions WHERE plan_id = ? AND active = 1`;
        const { count } = db.db.prepare(query).get(plan.id);
        return count;
      } catch (error) {
        console.error('Error counting plan subscriptions:', error);
        return 0;
      }
    }
  }
};

module.exports = planResolvers;
