# GraphQL Quick Start Guide

## 🚀 Quick Start for Frontend Developers

### Accessing the GraphQL Endpoint

```
POST http://localhost:3000/graphql
Content-Type: application/json

{
  "query": "{ merchant(id: \"123\") { id walletAddress } }"
}
```

### Using Apollo Client (React)

```javascript
import { ApolloClient, InMemoryCache, HttpLink, gql } from '@apollo/client';

const client = new ApolloClient({
  link: new HttpLink({ uri: 'http://localhost:3000/graphql' }),
  cache: new InMemoryCache()
});

const MERCHANT_QUERY = gql`
  query GetMerchant($id: ID!) {
    merchant(id: $id) {
      id
      walletAddress
      displayName
      subscriptionCount
      totalRevenue
    }
  }
`;

client.query({ query: MERCHANT_QUERY, variables: { id: 'merchant-123' } })
  .then(result => console.log(result.data))
  .catch(error => console.error(error));
```

### Common Queries

#### Get Merchant Dashboard (Replaces 5 REST calls!)

```graphql
query GetMerchantDashboard($id: ID!) {
  merchantDashboard(id: $id) {
    merchant {
      id
      walletAddress
      displayName
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
      status
    }
    recentBillingEvents {
      id
      amount
      eventType
    }
  }
}
```

#### List Merchants with Pagination

```graphql
query GetMerchants($limit: Int!, $offset: Int!) {
  merchants(limit: $limit, offset: $offset) {
    nodes {
      id
      displayName
      subscriptionCount
      totalRevenue
    }
    totalCount
    pageInfo {
      hasNextPage
      hasPreviousPage
    }
  }
}
```

#### Get Subscriber's Subscriptions

```graphql
query GetMySubscriptions($wallet: String!) {
  mySubscriptions(subscriberWallet: $wallet) {
    nodes {
      id
      merchant {
        displayName
      }
      plan {
        name
        price
      }
      status
      daysRemaining
    }
  }
}
```

#### Check Active Subscription

```graphql
query CheckSubscription($merchantId: ID!, $wallet: String!) {
  hasActiveSubscription(merchantId: $merchantId, subscriberWallet: $wallet)
}
```

### Common Mutations

#### Create Merchant

```graphql
mutation CreateMerchant($input: CreateMerchantInput!) {
  createMerchant(input: $input) {
    id
    walletAddress
    displayName
  }
}

# Variables:
{
  "input": {
    "walletAddress": "GBHXT...",
    "displayName": "Creator Name",
    "email": "creator@example.com"
  }
}
```

#### Create Subscription

```graphql
mutation Subscribe($input: CreateSubscriptionInput!) {
  createSubscription(input: $input) {
    id
    merchant { displayName }
    plan { name }
    status
    active
  }
}

# Variables:
{
  "input": {
    "merchantId": "merchant-123",
    "subscriberWallet": "GUSER...",
    "planId": "plan-456"
  }
}
```

#### Cancel Subscription

```graphql
mutation CancelSubscription($id: ID!) {
  cancelSubscription(id: $id) {
    id
    status
    unsubscribedAt
  }
}

# Variables:
{
  "id": "subscription-789"
}
```

#### Create Billing Event

```graphql
mutation RecordPayment($input: CreateBillingEventInput!) {
  createBillingEvent(input: $input) {
    id
    amount
    status
    eventType
  }
}

# Variables:
{
  "input": {
    "merchantId": "merchant-123",
    "subscriptionId": "sub-456",
    "amount": 9.99,
    "currency": "USD",
    "eventType": "SUBSCRIPTION_RENEWAL"
  }
}
```

### Filtering & Pagination

```graphql
query GetBillingEvents(
  $merchantId: ID!
  $status: BillingEventStatus
  $startDate: String
  $limit: Int!
  $offset: Int!
) {
  billingEventsByMerchant(
    merchantId: $merchantId
    status: $status
    startDate: $startDate
    limit: $limit
    offset: $offset
  ) {
    nodes {
      id
      amount
      eventType
      status
      createdAt
    }
    totalCount
    pageInfo {
      hasNextPage
    }
  }
}
```

### Using GraphQL Playground

Visit `http://localhost:3000/graphql` in your browser to access Apollo GraphQL Playground:

1. Write queries in the left panel
2. Click the play button to execute
3. View results in the middle panel
4. See documentation in the right panel
5. Use CTRL+Space for autocomplete

### Error Handling

```javascript
const { errors, data } = await client.query({ query });

if (errors) {
  errors.forEach(error => {
    console.error(`GraphQL Error: ${error.message}`);
    if (error.extensions?.code) {
      console.error(`Error Code: ${error.extensions.code}`);
    }
  });
}

if (data) {
  // Process data
}
```

### Common Field Names

| Field | Type | Description |
|-------|------|-------------|
| `id` | ID | Unique identifier |
| `walletAddress` | String | Blockchain wallet address |
| `displayName` | String | User-friendly name |
| `createdAt` | String | ISO 8601 creation timestamp |
| `active` | Boolean | Current status |
| `price` | Float | Monetary amount |
| `currency` | String | Currency code (USD, EUR) |
| `status` | Enum | Current state |
| `eventType` | Enum | Type of event |

### Performance Tips

1. **Use specific fields** - Only request fields you need
   ```graphql
   ✅ Good: { id, displayName }
   ❌ Bad: { id, displayName, email, phone, address, ... }
   ```

2. **Batch related data** - Request nested relationships in one query
   ```graphql
   ✅ Good: merchant { subscriptions { id } plans { id } }
   ❌ Bad: Make 3 separate queries
   ```

3. **Use pagination** - For large result sets
   ```graphql
   ✅ Good: merchants(limit: 20, offset: 0)
   ❌ Bad: merchants (returns all)
   ```

4. **Cache results** - Apollo Client caches automatically
   ```javascript
   cache: new InMemoryCache()
   ```

### Testing with cURL

```bash
curl -X POST http://localhost:3000/graphql \
  -H "Content-Type: application/json" \
  -d '{
    "query": "{ merchant(id: \"123\") { id displayName } }"
  }'
```

### Benefits vs REST

| Aspect | REST | GraphQL |
|--------|------|---------|
| Over-fetching | ❌ Lots of unused data | ✅ Exact fields |
| Under-fetching | ❌ Multiple calls needed | ✅ Single query |
| API Versioning | ❌ v1, v2, v3 needed | ✅ Additive only |
| Type Safety | ❌ Manual | ✅ Built-in schema |
| Learning Curve | ✅ Simple | ❌ Moderate |
| Real-time | ❌ Polling | ✅ Subscriptions |

### Next Steps

1. Check [GraphQL Endpoint Guide](./GRAPHQL_ENDPOINT_GUIDE.md) for full documentation
2. Review schema definitions in `src/graphql/schemas/`
3. Explore examples in `src/graphql/graphql.test.js`
4. Run tests: `npm test -- src/graphql/graphql.test.js`

### Support

For issues or questions:
1. Check the main [GraphQL Endpoint Guide](./GRAPHQL_ENDPOINT_GUIDE.md)
2. Review resolver implementations in `src/graphql/resolvers/`
3. Check test cases for usage examples
4. Consult [Apollo Server Documentation](https://www.apollographql.com/docs/)

---

**Version:** 1.0.0  
**Last Updated:** 2026-04-24  
**Status:** ✅ Production Ready
