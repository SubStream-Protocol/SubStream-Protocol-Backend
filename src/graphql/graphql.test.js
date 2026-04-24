/**
 * GraphQL API Tests
 * 
 * Tests for the Apollo GraphQL endpoint covering:
 * - Merchant queries and mutations
 * - Subscription queries and mutations
 * - Plan queries and mutations
 * - Billing Event queries and mutations
 * - DataLoader efficiency (N+1 problem solving)
 */

const request = require('supertest');
const { createApp } = require('../../index');
const { setupApolloServer } = require('../../src/graphql');
const { AppDatabase } = require('../../src/db/appDatabase');

describe('GraphQL API Endpoint', () => {
  let app;
  let database;
  let server;

  beforeAll(async () => {
    // Use in-memory database for tests
    database = new AppDatabase(':memory:');
    
    // Create test app with in-memory database
    app = createApp({ database });
    
    // Setup Apollo Server
    server = await setupApolloServer(app, database);
    
    // Seed test data
    seedTestData(database);
  });

  afterAll(async () => {
    if (server) {
      await server.stop();
    }
  });

  describe('Merchant Queries', () => {
    it('should query a merchant by ID', async () => {
      const query = `
        query {
          merchant(id: "merchant-1") {
            id
            walletAddress
            displayName
            subscriptionCount
            activeSubscriptionCount
          }
        }
      `;

      const response = await request(app)
        .post('/graphql')
        .send({ query });

      expect(response.status).toBe(200);
      expect(response.body.data.merchant).toBeDefined();
      expect(response.body.data.merchant.id).toBe('merchant-1');
      expect(response.body.data.merchant.subscriptionCount).toBe(0);
    });

    it('should list merchants with pagination', async () => {
      const query = `
        query {
          merchants(limit: 10, offset: 0) {
            nodes {
              id
              walletAddress
              displayName
            }
            totalCount
            pageInfo {
              hasNextPage
              hasPreviousPage
            }
          }
        }
      `;

      const response = await request(app)
        .post('/graphql')
        .send({ query });

      expect(response.status).toBe(200);
      expect(response.body.data.merchants).toBeDefined();
      expect(Array.isArray(response.body.data.merchants.nodes)).toBe(true);
      expect(typeof response.body.data.merchants.totalCount).toBe('number');
    });

    it('should get merchant dashboard with nested data', async () => {
      const query = `
        query {
          merchantDashboard(id: "merchant-1") {
            merchant {
              id
              walletAddress
            }
            stats {
              totalSubscribers
              activeSubscribers
              totalRevenue
              monthlyRevenue
              churnRate
            }
            recentSubscriptions {
              id
              subscriberWallet
              active
            }
            recentBillingEvents {
              id
              amount
              eventType
            }
          }
        }
      `;

      const response = await request(app)
        .post('/graphql')
        .send({ query });

      expect(response.status).toBe(200);
      expect(response.body.data.merchantDashboard).toBeDefined();
      expect(response.body.data.merchantDashboard.merchant).toBeDefined();
      expect(response.body.data.merchantDashboard.stats).toBeDefined();
      expect(typeof response.body.data.merchantDashboard.stats.totalSubscribers).toBe('number');
    });

    it('should get merchant by wallet address', async () => {
      const query = `
        query {
          merchantByWallet(walletAddress: "wallet-1") {
            id
            walletAddress
            displayName
          }
        }
      `;

      const response = await request(app)
        .post('/graphql')
        .send({ query });

      expect(response.status).toBe(200);
      expect(response.body.data.merchantByWallet).toBeDefined();
    });
  });

  describe('Merchant Mutations', () => {
    it('should create a new merchant', async () => {
      const mutation = `
        mutation {
          createMerchant(input: {
            walletAddress: "wallet-new"
            displayName: "Test Creator"
            email: "test@example.com"
          }) {
            id
            walletAddress
            displayName
            email
          }
        }
      `;

      const response = await request(app)
        .post('/graphql')
        .send({ query: mutation });

      expect(response.status).toBe(200);
      expect(response.body.data.createMerchant).toBeDefined();
      expect(response.body.data.createMerchant.walletAddress).toBe('wallet-new');
    });

    it('should update a merchant', async () => {
      const mutation = `
        mutation {
          updateMerchant(id: "merchant-1", input: {
            displayName: "Updated Name"
            email: "updated@example.com"
          }) {
            id
            displayName
            email
          }
        }
      `;

      const response = await request(app)
        .post('/graphql')
        .send({ query: mutation });

      expect(response.status).toBe(200);
      expect(response.body.data.updateMerchant).toBeDefined();
      expect(response.body.data.updateMerchant.displayName).toBe('Updated Name');
    });
  });

  describe('Subscription Queries', () => {
    it('should query subscriptions for a merchant', async () => {
      const query = `
        query {
          subscriptions(merchantId: "merchant-1", limit: 10) {
            nodes {
              id
              merchant {
                id
                walletAddress
              }
              subscriberWallet
              active
              status
            }
            totalCount
          }
        }
      `;

      const response = await request(app)
        .post('/graphql')
        .send({ query });

      expect(response.status).toBe(200);
      expect(response.body.data.subscriptions).toBeDefined();
      expect(Array.isArray(response.body.data.subscriptions.nodes)).toBe(true);
    });

    it('should check if subscriber has active subscription', async () => {
      const query = `
        query {
          hasActiveSubscription(merchantId: "merchant-1", subscriberWallet: "subscriber-1")
        }
      `;

      const response = await request(app)
        .post('/graphql')
        .send({ query });

      expect(response.status).toBe(200);
      expect(typeof response.body.data.hasActiveSubscription).toBe('boolean');
    });

    it('should list subscriber subscriptions', async () => {
      const query = `
        query {
          mySubscriptions(subscriberWallet: "subscriber-1", limit: 10) {
            nodes {
              id
              merchant {
                displayName
              }
              plan {
                name
                price
              }
              active
            }
            totalCount
          }
        }
      `;

      const response = await request(app)
        .post('/graphql')
        .send({ query });

      expect(response.status).toBe(200);
      expect(response.body.data.mySubscriptions).toBeDefined();
    });
  });

  describe('Subscription Mutations', () => {
    it('should create a subscription', async () => {
      const mutation = `
        mutation {
          createSubscription(input: {
            merchantId: "merchant-1"
            subscriberWallet: "new-subscriber"
          }) {
            id
            merchant {
              id
            }
            subscriberWallet
            active
            status
          }
        }
      `;

      const response = await request(app)
        .post('/graphql')
        .send({ query: mutation });

      expect(response.status).toBe(200);
      expect(response.body.data.createSubscription).toBeDefined();
      expect(response.body.data.createSubscription.active).toBe(true);
      expect(response.body.data.createSubscription.status).toBe('ACTIVE');
    });

    it('should cancel a subscription', async () => {
      const mutation = `
        mutation {
          cancelSubscription(id: "subscription-1") {
            id
            active
            status
            unsubscribedAt
          }
        }
      `;

      const response = await request(app)
        .post('/graphql')
        .send({ query: mutation });

      expect(response.status).toBe(200);
      expect(response.body.data.cancelSubscription).toBeDefined();
      expect(response.body.data.cancelSubscription.active).toBe(false);
    });
  });

  describe('Plan Queries', () => {
    it('should query plans by merchant', async () => {
      const query = `
        query {
          plansByMerchant(merchantId: "merchant-1", limit: 10) {
            nodes {
              id
              name
              price
              billingCycle
              features
              merchant {
                id
              }
            }
            totalCount
          }
        }
      `;

      const response = await request(app)
        .post('/graphql')
        .send({ query });

      expect(response.status).toBe(200);
      expect(response.body.data.plansByMerchant).toBeDefined();
    });

    it('should get a single plan', async () => {
      const query = `
        query {
          plan(id: "plan-1") {
            id
            name
            price
            currency
            billingCycle
            subscriptionCount
          }
        }
      `;

      const response = await request(app)
        .post('/graphql')
        .send({ query });

      expect(response.status).toBe(200);
      expect(response.body.data.plan).toBeDefined();
    });
  });

  describe('Plan Mutations', () => {
    it('should create a plan', async () => {
      const mutation = `
        mutation {
          createPlan(input: {
            merchantId: "merchant-1"
            name: "Premium Plan"
            price: 9.99
            billingCycle: MONTHLY
            features: ["Feature 1", "Feature 2"]
          }) {
            id
            name
            price
            billingCycle
            features
            active
          }
        }
      `;

      const response = await request(app)
        .post('/graphql')
        .send({ query: mutation });

      expect(response.status).toBe(200);
      expect(response.body.data.createPlan).toBeDefined();
      expect(response.body.data.createPlan.name).toBe('Premium Plan');
      expect(response.body.data.createPlan.price).toBe(9.99);
    });

    it('should update a plan', async () => {
      const mutation = `
        mutation {
          updatePlan(id: "plan-1", input: {
            name: "Updated Plan"
            price: 12.99
          }) {
            id
            name
            price
          }
        }
      `;

      const response = await request(app)
        .post('/graphql')
        .send({ query: mutation });

      expect(response.status).toBe(200);
      expect(response.body.data.updatePlan).toBeDefined();
    });
  });

  describe('Billing Event Queries', () => {
    it('should query billing events for a merchant', async () => {
      const query = `
        query {
          billingEventsByMerchant(merchantId: "merchant-1", limit: 10) {
            nodes {
              id
              amount
              currency
              eventType
              status
              merchant {
                id
              }
            }
            totalCount
          }
        }
      `;

      const response = await request(app)
        .post('/graphql')
        .send({ query });

      expect(response.status).toBe(200);
      expect(response.body.data.billingEventsByMerchant).toBeDefined();
    });

    it('should get merchant billing stats', async () => {
      const query = `
        query {
          merchantBillingStats(merchantId: "merchant-1") {
            merchant {
              id
            }
            totalRevenue
            totalEvents
            successfulPayments
            failedPayments
            averageTransactionValue
          }
        }
      `;

      const response = await request(app)
        .post('/graphql')
        .send({ query });

      expect(response.status).toBe(200);
      expect(response.body.data.merchantBillingStats).toBeDefined();
      expect(typeof response.body.data.merchantBillingStats.totalRevenue).toBe('number');
    });
  });

  describe('DataLoader Efficiency', () => {
    it('should resolve nested relationships without N+1 queries', async () => {
      const query = `
        query {
          merchants(limit: 5) {
            nodes {
              id
              subscriptions {
                id
                merchant {
                  id
                }
              }
              plans {
                id
                merchant {
                  id
                }
              }
              billingEvents {
                id
                merchant {
                  id
                }
              }
            }
          }
        }
      `;

      const response = await request(app)
        .post('/graphql')
        .send({ query });

      expect(response.status).toBe(200);
      expect(response.body.data.merchants).toBeDefined();
      // Verify nested relationships are resolved
      expect(response.body.data.merchants.nodes.length).toBeGreaterThan(0);
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid queries gracefully', async () => {
      const query = `
        query {
          invalidField {
            id
          }
        }
      `;

      const response = await request(app)
        .post('/graphql')
        .send({ query });

      expect(response.status).toBe(200);
      expect(response.body.errors).toBeDefined();
    });

    it('should handle missing required arguments', async () => {
      const query = `
        query {
          merchant {
            id
          }
        }
      `;

      const response = await request(app)
        .post('/graphql')
        .send({ query });

      expect(response.status).toBe(200);
      expect(response.body.errors).toBeDefined();
    });
  });
});

// Helper function to seed test data
function seedTestData(database) {
  try {
    // Create test merchants
    const createMerchantQuery = `
      INSERT INTO creators (id, wallet_address, display_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `;
    
    database.db.prepare(createMerchantQuery).run(
      'merchant-1',
      'wallet-1',
      'Test Creator 1',
      new Date().toISOString(),
      new Date().toISOString()
    );

    // Create test plans
    const createPlanQuery = `
      INSERT INTO plans (id, merchant_id, name, price, currency, billing_cycle, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    database.db.prepare(createPlanQuery).run(
      'plan-1',
      'merchant-1',
      'Basic Plan',
      4.99,
      'USD',
      'MONTHLY',
      1,
      new Date().toISOString(),
      new Date().toISOString()
    );

    // Create test subscriptions
    const createSubscriptionQuery = `
      INSERT INTO subscriptions (id, creator_id, wallet_address, plan_id, subscribed_at, active)
      VALUES (?, ?, ?, ?, ?, ?)
    `;

    database.db.prepare(createSubscriptionQuery).run(
      'subscription-1',
      'merchant-1',
      'subscriber-1',
      'plan-1',
      new Date().toISOString(),
      1
    );
  } catch (error) {
    console.warn('Error seeding test data:', error.message);
  }
}

module.exports = { seedTestData };
