# GraphQL Endpoint Implementation Guide

## Overview

This document describes the GraphQL endpoint implementation that solves the "over-fetching" problem in the SubStream backend. The endpoint allows frontend clients to request exactly the data they need, eliminating the need for multiple REST API calls.

## Problem Statement

**Before (REST API):**
Loading the merchant dashboard required **5 separate API calls:**
1. `GET /api/v1/merchants/:id` - Get merchant details
2. `GET /api/v1/merchants/:id/subscriptions` - Get all subscriptions
3. `GET /api/v1/merchants/:id/plans` - Get merchant plans
4. `GET /api/v1/merchants/:id/billing-events` - Get billing events
5. `GET /api/v1/merchants/:id/stats` - Get statistics

Each call returned redundant data, and clients had to stitch multiple responses together.

**After (GraphQL):**
One GraphQL query fetches exactly the needed data:
```graphql
query {
  merchantDashboard(id: "merchant-1") {
    merchant { id, walletAddress }
    stats { totalSubscribers, activeSubscribers, totalRevenue }
    recentSubscriptions { id, subscriberWallet, active }
    recentBillingEvents { id, amount, eventType }
  }
}
```

## Architecture

### Directory Structure

```
src/graphql/
├── index.js                 # Apollo Server setup
├── schemas/                 # GraphQL type definitions
│   ├── merchant.graphql
│   ├── subscription.graphql
│   ├── plan.graphql
│   ├── billingEvent.graphql
│   └── root.graphql
├── resolvers/               # Query/Mutation implementations
│   ├── merchantResolver.js
│   ├── subscriptionResolver.js
│   ├── planResolver.js
│   ├── billingEventResolver.js
│   └── index.js
├── dataloaders/             # Batch loaders for N+1 prevention
│   └── index.js
└── graphql.test.js          # Comprehensive test suite
```

### DataLoaders: Solving the N+1 Problem

**What is the N+1 Problem?**
When resolving nested relationships, naive implementations execute one query per relationship, resulting in N+1 total queries (1 parent + N children queries).

**Example:**
```javascript
// BAD: N+1 queries (1 + 100 subscriptions = 101 queries)
const merchants = await getMerchants();
for (let merchant of merchants) {
  merchant.subscriptions = await getSubscriptions(merchant.id); // Loop = 100 queries
}

// GOOD: 2 queries total with DataLoader
const merchants = await getMerchants();  // 1 query
const subscriptions = await dataloaders.subscriptionsByMerchant.loadMany(merchantIds);  // 1 batched query
```

**How DataLoaders Work:**
1. Request collects keys to load
2. Within same event loop tick, keys are batched
3. Single database query fetches all keys at once
4. Results are cached for subsequent accesses

**Implemented DataLoaders:**

| DataLoader | Purpose | Use Case |
|-----------|---------|----------|
| `merchants` | Load merchants by ID | Resolving `subscription.merchant` |
| `subscriptionsByMerchant` | Load subscriptions for merchants | Resolving `merchant.subscriptions` |
| `subscriptionCount` | Count active subscriptions | Resolving `merchant.subscriptionCount` |
| `plansByMerchant` | Load plans for merchants | Resolving `merchant.plans` |
| `billingEventsByMerchant` | Load billing events | Resolving `merchant.billingEvents` |
| `subscriptions` | Load subscriptions by ID | Resolving by ID |
| `plans` | Load plans by ID | Resolving by ID |
| `billingEvents` | Load billing events by ID | Resolving by ID |
| `latestBillingEventsBySubscription` | Get latest billing event | Resolving `subscription.latestBillingEvent` |
| `billingEventsBySubscription` | Load all billing events | Resolving `subscription.billingEvents` |
| `activeSubscriptionChecker` | Check active subscriptions | Resolving `hasActiveSubscription` |

## Getting Started

### 1. Query the GraphQL Endpoint

**URL:** `http://localhost:3000/graphql`

**Example Query:**
```graphql
query {
  merchant(id: "merchant-123") {
    id
    walletAddress
    displayName
    subscriptionCount
    activeSubscriptionCount
    totalRevenue
    subscriptions {
      id
      subscriberWallet
      active
      status
      plan {
        name
        price
      }
    }
    plans {
      id
      name
      price
      billingCycle
      features
    }
  }
}
```

**Response:**
```json
{
  "data": {
    "merchant": {
      "id": "merchant-123",
      "walletAddress": "GBHXT...",
      "displayName": "Top Creator",
      "subscriptionCount": 150,
      "activeSubscriptionCount": 142,
      "totalRevenue": 4250.50,
      "subscriptions": [...],
      "plans": [...]
    }
  }
}
```

### 2. Use Pagination

All list queries support cursor-based pagination:

```graphql
query {
  merchants(limit: 20, offset: 0) {
    nodes {
      id
      displayName
    }
    totalCount
    pageInfo {
      hasNextPage
      hasPreviousPage
      startCursor
      endCursor
    }
  }
}
```

### 3. Complex Queries with Nested Data

**Merchant Dashboard Query** (replaces 5 REST calls):
```graphql
query GetMerchantDashboard($merchantId: ID!) {
  merchantDashboard(id: $merchantId) {
    merchant {
      id
      walletAddress
      displayName
      email
    }
    stats {
      totalSubscribers
      activeSubscribers
      totalRevenue
      monthlyRevenue
      averageSubscriptionValue
      churnRate
    }
    recentSubscriptions(limit: 10) {
      id
      subscriberWallet
      active
      status
      plan {
        name
        price
      }
    }
    recentBillingEvents(limit: 10) {
      id
      amount
      currency
      eventType
      status
    }
  }
}
```

### 4. Check Subscriber Status

```graphql
query {
  hasActiveSubscription(
    merchantId: "merchant-123"
    subscriberWallet: "GBHXT..."
  )
}
```

## Mutations

### Create Merchant

```graphql
mutation {
  createMerchant(input: {
    walletAddress: "GBHXT..."
    displayName: "My Creator Name"
    email: "creator@example.com"
  }) {
    id
    walletAddress
    displayName
  }
}
```

### Create Subscription

```graphql
mutation {
  createSubscription(input: {
    merchantId: "merchant-123"
    subscriberWallet: "GUSER..."
    planId: "plan-456"
    deviceId: "device-789"
  }) {
    id
    merchant { id, displayName }
    subscriberWallet
    plan { name, price }
    status
    active
  }
}
```

### Create Plan

```graphql
mutation {
  createPlan(input: {
    merchantId: "merchant-123"
    name: "Premium"
    price: 9.99
    currency: "USD"
    billingCycle: MONTHLY
    features: ["4K Video", "Early Access", "Discord"]
  }) {
    id
    name
    price
    features
  }
}
```

### Create Billing Event

```graphql
mutation {
  createBillingEvent(input: {
    merchantId: "merchant-123"
    subscriptionId: "sub-456"
    amount: 9.99
    currency: "USD"
    eventType: SUBSCRIPTION_RENEWAL
    metadata: { transactionId: "txn-789" }
  }) {
    id
    amount
    eventType
    status
  }
}
```

## Schema Definitions

### Merchant Type

```graphql
type Merchant {
  id: ID!                              # Unique identifier
  walletAddress: String!               # Creator's blockchain wallet
  displayName: String                  # Display name
  email: String                        # Creator's email
  createdAt: String!                   # ISO 8601 timestamp
  updatedAt: String!                   # ISO 8601 timestamp
  
  # Relationships
  subscriptions: [Subscription!]!      # All subscriptions
  plans: [Plan!]!                      # Creator's plans
  billingEvents: [BillingEvent!]!      # All billing events
  subscriptionCount: Int!              # Total subscribers
  activeSubscriptionCount: Int!        # Active subscribers only
  totalRevenue: Float!                 # Sum of completed events
}
```

### Subscription Type

```graphql
type Subscription {
  id: ID!                              # Unique identifier
  merchant: Merchant!                  # Associated merchant
  subscriberWallet: String!            # Subscriber's blockchain wallet
  plan: Plan                           # Associated plan (optional)
  active: Boolean!                     # Subscription status
  subscribedAt: String!                # ISO 8601 timestamp
  unsubscribedAt: String               # ISO 8601 timestamp
  expiresAt: String                    # Expiration date
  
  # Device & Fraud Detection
  deviceId: String                     # Device fingerprint ID
  deviceFingerprint: String            # Device fingerprint hash
  sybilRiskScore: Int                  # Risk score 0-100
  sybilFlagged: Boolean!               # Sybil attack flag
  
  # Related Data
  latestBillingEvent: BillingEvent     # Most recent event
  billingEvents: [BillingEvent!]!      # All events
  
  # Computed Fields
  status: SubscriptionStatus!          # ACTIVE, INACTIVE, EXPIRED, etc.
  daysRemaining: Int                   # Days until expiration
}

enum SubscriptionStatus {
  ACTIVE
  INACTIVE
  EXPIRED
  PENDING
  CANCELLED
}
```

### Plan Type

```graphql
type Plan {
  id: ID!                              # Unique identifier
  merchant: Merchant!                  # Plan owner
  name: String!                        # Plan name
  description: String                 # Plan description
  price: Float!                        # Plan price
  currency: String!                    # Currency code (USD, EUR, etc.)
  billingCycle: BillingCycle!          # MONTHLY, YEARLY, ONE_TIME, etc.
  features: [String!]!                 # List of features
  maxSubscribers: Int                  # Subscription limit
  active: Boolean!                     # Availability status
  createdAt: String!                   # ISO 8601 timestamp
  updatedAt: String!                   # ISO 8601 timestamp
  
  # Relationships
  subscriptions: [Subscription!]!      # Subscribers
  billingEvents: [BillingEvent!]!      # Billing history
  subscriptionCount: Int!              # Number of active subscribers
}

enum BillingCycle {
  MONTHLY
  YEARLY
  ONE_TIME
  DAILY
  WEEKLY
}
```

### BillingEvent Type

```graphql
type BillingEvent {
  id: ID!                              # Unique identifier
  merchant: Merchant!                  # Associated merchant
  subscription: Subscription           # Associated subscription
  plan: Plan                           # Associated plan
  amount: Float!                       # Event amount
  currency: String!                    # Currency code
  eventType: BillingEventType!         # Event classification
  status: BillingEventStatus!          # Processing status
  description: String                 # Event description
  metadata: JSON!                      # Additional data
  createdAt: String!                   # ISO 8601 timestamp
  updatedAt: String!                   # ISO 8601 timestamp
  processedAt: String                  # Processing completion time
}

enum BillingEventType {
  SUBSCRIPTION_CREATED
  SUBSCRIPTION_RENEWAL
  SUBSCRIPTION_UPGRADED
  SUBSCRIPTION_DOWNGRADED
  SUBSCRIPTION_CANCELLED
  REFUND
  PAYMENT_RECEIVED
  PAYMENT_FAILED
  CHARGEBACK
  ADJUSTMENT
}

enum BillingEventStatus {
  PENDING
  PROCESSING
  COMPLETED
  FAILED
  CANCELLED
  REFUNDED
}
```

## Performance Optimization

### Query Optimization Example

**Inefficient (5+ database queries):**
```graphql
query {
  merchants {
    nodes {
      subscriptions { merchant { subscriptions { id } } }  # N+1 problem
    }
  }
}
```

**Efficient (2 database queries with DataLoaders):**
```graphql
query {
  merchants(limit: 20) {
    nodes {
      id
      subscriptions {
        id
        merchant { id }  # Batched via DataLoader
      }
    }
  }
}
```

### Cache Management

DataLoaders cache results within a single GraphQL request. Caches are automatically cleared:
- After each GraphQL request completes
- After mutations complete (via `dataloaders.clearAll()`)
- Manually with `dataloaders.clearCache(key)`

## Testing

Run GraphQL tests:

```bash
npm test -- src/graphql/graphql.test.js
```

### Test Coverage

- ✅ Merchant queries and mutations
- ✅ Subscription queries and mutations
- ✅ Plan queries and mutations
- ✅ Billing event queries and mutations
- ✅ Nested relationships
- ✅ DataLoader efficiency (N+1 prevention)
- ✅ Error handling
- ✅ Pagination
- ✅ Filtering and sorting

## Deployment Checklist

- [ ] Install dependencies: `npm install`
- [ ] Test GraphQL endpoint: `npm test`
- [ ] Verify database schema includes required tables
- [ ] Set `NODE_ENV=production` in production
- [ ] Disable introspection in production (if needed)
- [ ] Configure CORS for frontend origin
- [ ] Set up monitoring/logging for GraphQL errors
- [ ] Test with production-like data volumes

## Troubleshooting

### Common Issues

**Error: "Cannot find module '@apollo/server'"**
- Solution: Run `npm install` to install GraphQL dependencies

**GraphQL endpoint not responding**
- Solution: Verify Apollo Server started successfully in console logs
- Check that port 3000 is accessible

**Performance degradation**
- Solution: Check DataLoader batching is working
- Enable query logging to verify batch sizes
- Consider query complexity limits

**Nested queries return null**
- Solution: Verify database schema tables exist
- Check resolver implementations for null checks
- Enable debug logging to trace resolver execution

## Future Enhancements

1. **Subscriptions (Real-time Updates)**
   ```graphql
   subscription {
     subscriptionCreated {
       id
       merchant { id }
     }
   }
   ```

2. **Query Complexity Analysis**
   - Prevent deeply nested queries that could harm performance
   - Set max depth limits

3. **Caching Strategy**
   - Implement Redis-backed DataLoaders for multi-request caching
   - Cache expensive computations (stats, aggregations)

4. **Monitoring & Analytics**
   - Track query performance
   - Monitor most-used fields
   - Track error rates per query type

5. **Federation**
   - Support Apollo Federation for microservices
   - Share types across multiple GraphQL endpoints

## Resources

- [Apollo Server Documentation](https://www.apollographql.com/docs/apollo-server/)
- [DataLoader GitHub](https://github.com/graphql/dataloader)
- [GraphQL Best Practices](https://graphql.org/learn/best-practices/)
- [GraphQL Performance Guide](https://www.apollographql.com/docs/apollo-server/performance/)

## Contributing

When adding new resolvers or fields:

1. Add GraphQL schema definition
2. Implement resolver function
3. Add DataLoader if fetching related data
4. Add unit tests
5. Update this documentation
6. Test with nested queries to verify no N+1 issues

## Questions?

For questions about the GraphQL implementation, refer to:
- Schema files in `src/graphql/schemas/`
- Resolver implementations in `src/graphql/resolvers/`
- DataLoader implementations in `src/graphql/dataloaders/`
- Test examples in `src/graphql/graphql.test.js`
