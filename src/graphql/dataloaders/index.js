/**
 * DataLoaders for GraphQL resolvers
 * Solves N+1 query problem by batching database calls
 * 
 * Usage:
 *   Instead of loading one merchant at a time in a loop:
 *     for (let subscription of subscriptions) {
 *       const merchant = await loadMerchant(subscription.merchant_id); // N queries
 *     }
 *   
 *   With DataLoader:
 *     for (let subscription of subscriptions) {
 *       const merchant = await dataloaders.merchants.load(subscription.merchant_id); // 1 batched query
 *     }
 */

const DataLoader = require('dataloader');

/**
 * Create all dataloaders for GraphQL context
 * @param {import('../../db/appDatabase').AppDatabase} database
 * @returns {Object} Object containing all DataLoader instances
 */
function createDataLoaders(database) {
  // Batch load merchants by IDs
  const merchantsLoader = new DataLoader(async (merchantIds) => {
    try {
      const query = `
        SELECT * FROM creators WHERE id IN (${merchantIds.map(() => '?').join(',')})
      `;
      const merchants = database.db.prepare(query).all(...merchantIds);
      
      // Create a map for fast lookup
      const merchantMap = new Map(merchants.map(m => [m.id, m]));
      
      // Return results in the same order as the input IDs
      return merchantIds.map(id => merchantMap.get(id) || null);
    } catch (error) {
      console.error('Error loading merchants:', error);
      return merchantIds.map(() => null);
    }
  });

  // Batch load subscriptions by merchant IDs
  const subscriptionsByMerchantLoader = new DataLoader(async (merchantIds) => {
    try {
      const query = `
        SELECT * FROM subscriptions WHERE creator_id IN (${merchantIds.map(() => '?').join(',')})
      `;
      const subscriptions = database.db.prepare(query).all(...merchantIds);
      
      // Group subscriptions by merchant ID
      const subscriptionsByMerchant = new Map();
      merchantIds.forEach(id => subscriptionsByMerchant.set(id, []));
      
      subscriptions.forEach(sub => {
        if (subscriptionsByMerchant.has(sub.creator_id)) {
          subscriptionsByMerchant.get(sub.creator_id).push(sub);
        }
      });
      
      // Return subscriptions grouped by merchant ID
      return merchantIds.map(id => subscriptionsByMerchant.get(id) || []);
    } catch (error) {
      console.error('Error loading subscriptions by merchant:', error);
      return merchantIds.map(() => []);
    }
  });

  // Batch load subscription count by merchant IDs
  const subscriptionCountLoader = new DataLoader(async (merchantIds) => {
    try {
      const query = `
        SELECT creator_id, COUNT(*) as count FROM subscriptions 
        WHERE creator_id IN (${merchantIds.map(() => '?').join(',')}) AND active = 1
        GROUP BY creator_id
      `;
      const counts = database.db.prepare(query).all(...merchantIds);
      
      // Create a map for fast lookup
      const countMap = new Map(counts.map(c => [c.creator_id, c.count]));
      
      // Return counts in the same order as input IDs
      return merchantIds.map(id => countMap.get(id) || 0);
    } catch (error) {
      console.error('Error loading subscription counts:', error);
      return merchantIds.map(() => 0);
    }
  });

  // Batch load plans by merchant IDs
  const plansByMerchantLoader = new DataLoader(async (merchantIds) => {
    try {
      // Note: This assumes a 'plans' table exists
      // You may need to adjust based on your actual schema
      const query = `
        SELECT * FROM plans WHERE merchant_id IN (${merchantIds.map(() => '?').join(',')}) AND active = 1
      `;
      const plans = database.db.prepare(query).all(...merchantIds);
      
      // Group plans by merchant ID
      const plansByMerchant = new Map();
      merchantIds.forEach(id => plansByMerchant.set(id, []));
      
      plans.forEach(plan => {
        if (plansByMerchant.has(plan.merchant_id)) {
          plansByMerchant.get(plan.merchant_id).push(plan);
        }
      });
      
      // Return plans grouped by merchant ID
      return merchantIds.map(id => plansByMerchant.get(id) || []);
    } catch (error) {
      console.error('Error loading plans by merchant:', error);
      return merchantIds.map(() => []);
    }
  });

  // Batch load billing events by merchant IDs
  const billingEventsByMerchantLoader = new DataLoader(async (merchantIds) => {
    try {
      // Note: This assumes a 'billing_events' table exists
      // You may need to adjust based on your actual schema
      const query = `
        SELECT * FROM billing_events WHERE merchant_id IN (${merchantIds.map(() => '?').join(',')})
        ORDER BY created_at DESC
        LIMIT 100
      `;
      const events = database.db.prepare(query).all(...merchantIds);
      
      // Group events by merchant ID
      const eventsByMerchant = new Map();
      merchantIds.forEach(id => eventsByMerchant.set(id, []));
      
      events.forEach(event => {
        if (eventsByMerchant.has(event.merchant_id)) {
          eventsByMerchant.get(event.merchant_id).push(event);
        }
      });
      
      // Return events grouped by merchant ID
      return merchantIds.map(id => eventsByMerchant.get(id) || []);
    } catch (error) {
      console.error('Error loading billing events by merchant:', error);
      return merchantIds.map(() => []);
    }
  });

  // Batch load subscription details by IDs
  const subscriptionsLoader = new DataLoader(async (subscriptionIds) => {
    try {
      const query = `
        SELECT * FROM subscriptions WHERE id IN (${subscriptionIds.map(() => '?').join(',')})
      `;
      const subscriptions = database.db.prepare(query).all(...subscriptionIds);
      
      // Create a map for fast lookup
      const subscriptionMap = new Map(subscriptions.map(s => [s.id, s]));
      
      // Return results in the same order as input IDs
      return subscriptionIds.map(id => subscriptionMap.get(id) || null);
    } catch (error) {
      console.error('Error loading subscriptions:', error);
      return subscriptionIds.map(() => null);
    }
  });

  // Batch load plans by IDs
  const plansLoader = new DataLoader(async (planIds) => {
    try {
      const query = `
        SELECT * FROM plans WHERE id IN (${planIds.map(() => '?').join(',')})
      `;
      const plans = database.db.prepare(query).all(...planIds);
      
      // Create a map for fast lookup
      const planMap = new Map(plans.map(p => [p.id, p]));
      
      // Return results in the same order as input IDs
      return planIds.map(id => planMap.get(id) || null);
    } catch (error) {
      console.error('Error loading plans:', error);
      return planIds.map(() => null);
    }
  });

  // Batch load billing events by IDs
  const billingEventsLoader = new DataLoader(async (eventIds) => {
    try {
      const query = `
        SELECT * FROM billing_events WHERE id IN (${eventIds.map(() => '?').join(',')})
      `;
      const events = database.db.prepare(query).all(...eventIds);
      
      // Create a map for fast lookup
      const eventMap = new Map(events.map(e => [e.id, e]));
      
      // Return results in the same order as input IDs
      return eventIds.map(id => eventMap.get(id) || null);
    } catch (error) {
      console.error('Error loading billing events:', error);
      return eventIds.map(() => null);
    }
  });

  // Batch load latest billing event by subscription IDs
  const latestBillingEventsBySubscriptionLoader = new DataLoader(async (subscriptionIds) => {
    try {
      const query = `
        SELECT DISTINCT ON (subscription_id) * FROM billing_events 
        WHERE subscription_id IN (${subscriptionIds.map(() => '?').join(',')})
        ORDER BY subscription_id, created_at DESC
      `;
      const events = database.db.prepare(query).all(...subscriptionIds);
      
      // Create a map for fast lookup
      const eventMap = new Map(events.map(e => [e.subscription_id, e]));
      
      // Return events in the same order as input IDs
      return subscriptionIds.map(id => eventMap.get(id) || null);
    } catch (error) {
      console.error('Error loading latest billing events:', error);
      return subscriptionIds.map(() => null);
    }
  });

  // Batch load billing events by subscription IDs
  const billingEventsBySubscriptionLoader = new DataLoader(async (subscriptionIds) => {
    try {
      const query = `
        SELECT * FROM billing_events WHERE subscription_id IN (${subscriptionIds.map(() => '?').join(',')})
        ORDER BY created_at DESC
      `;
      const events = database.db.prepare(query).all(...subscriptionIds);
      
      // Group events by subscription ID
      const eventsBySubscription = new Map();
      subscriptionIds.forEach(id => eventsBySubscription.set(id, []));
      
      events.forEach(event => {
        if (eventsBySubscription.has(event.subscription_id)) {
          eventsBySubscription.get(event.subscription_id).push(event);
        }
      });
      
      // Return events grouped by subscription ID
      return subscriptionIds.map(id => eventsBySubscription.get(id) || []);
    } catch (error) {
      console.error('Error loading billing events by subscription:', error);
      return subscriptionIds.map(() => []);
    }
  });

  // Batch check active subscriptions for multiple (merchant_id, wallet_address) pairs
  const activeSubscriptionCheckerLoader = new DataLoader(async (pairs) => {
    try {
      // pairs is an array of {merchantId, walletAddress}
      const placeholders = pairs.map(() => '(?, ?)').join(',');
      const flatParams = pairs.flatMap(p => [p.merchantId, p.walletAddress]);
      
      const query = `
        SELECT creator_id, wallet_address, active FROM subscriptions
        WHERE (creator_id, wallet_address) IN (VALUES ${placeholders})
      `;
      const subscriptions = database.db.prepare(query).all(...flatParams);
      
      // Create a map for fast lookup
      const subMap = new Map();
      subscriptions.forEach(sub => {
        const key = `${sub.creator_id}:${sub.wallet_address}`;
        subMap.set(key, sub.active === 1);
      });
      
      // Return boolean in the same order as input pairs
      return pairs.map(pair => subMap.get(`${pair.merchantId}:${pair.walletAddress}`) || false);
    } catch (error) {
      console.error('Error checking active subscriptions:', error);
      return pairs.map(() => false);
    }
  });

  return {
    merchants: merchantsLoader,
    subscriptionsByMerchant: subscriptionsByMerchantLoader,
    subscriptionCount: subscriptionCountLoader,
    plansByMerchant: plansByMerchantLoader,
    billingEventsByMerchant: billingEventsByMerchantLoader,
    subscriptions: subscriptionsLoader,
    plans: plansLoader,
    billingEvents: billingEventsLoader,
    latestBillingEventsBySubscription: latestBillingEventsBySubscriptionLoader,
    billingEventsBySubscription: billingEventsBySubscriptionLoader,
    activeSubscriptionChecker: activeSubscriptionCheckerLoader,
    
    // Method to clear all caches (useful for mutations)
    clearAll() {
      merchantsLoader.clearAll();
      subscriptionsByMerchantLoader.clearAll();
      subscriptionCountLoader.clearAll();
      plansByMerchantLoader.clearAll();
      billingEventsByMerchantLoader.clearAll();
      subscriptionsLoader.clearAll();
      plansLoader.clearAll();
      billingEventsLoader.clearAll();
      latestBillingEventsBySubscriptionLoader.clearAll();
      billingEventsBySubscriptionLoader.clearAll();
      activeSubscriptionCheckerLoader.clearAll();
    }
  };
}

module.exports = { createDataLoaders };
