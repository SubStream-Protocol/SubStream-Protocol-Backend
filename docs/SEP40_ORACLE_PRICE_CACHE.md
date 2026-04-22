# SEP-40 Oracle Price Cache Documentation

## Overview

The SEP-40 Oracle Price Cache system bridges the gap between crypto-denominated on-chain payments and fiat-denominated SaaS accounting. It continuously fetches historical exchange rates using the SEP-40 Oracle standard and provides accurate USD equivalents for all billing events.

## Architecture

### Components

1. **Sep40OracleService** - Stellar SEP-40 oracle client
2. **PriceCacheService** - Main price cache management
3. **FallbackPriceService** - Backup pricing APIs
4. **PriceCacheWorker** - 5-minute cron job worker
5. **Database Schema** - Persistent storage with 90-day retention

### Data Flow

```
SEP-40 Oracle (5-min intervals)
        |
        v
Price Cache Service
        |
        v
Database (price_cache table)
        |
        v
SorobanEventIndexer (real-time)
        |
        v
Billing Events (with USD equivalents)
```

## Database Schema

### price_cache

Main table storing historical prices with 5-minute intervals.

```sql
CREATE TABLE price_cache (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_code VARCHAR(12) NOT NULL,
    asset_issuer VARCHAR(56),
    asset_type VARCHAR(20) NOT NULL DEFAULT 'native',
    base_asset VARCHAR(12) NOT NULL DEFAULT 'USD',
    price NUMERIC(20, 12) NOT NULL,
    price_timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
    ledger_sequence BIGINT,
    oracle_address VARCHAR(56),
    oracle_timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
    price_decimals INTEGER NOT NULL DEFAULT 7,
    fetched_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    confidence_score NUMERIC(3, 2) DEFAULT 1.0,
    is_stale BOOLEAN NOT NULL DEFAULT false,
    backfill_required BOOLEAN NOT NULL DEFAULT false,
    UNIQUE (asset_code, asset_issuer, price_timestamp)
);
```

### billing_events

Enhanced billing events with USD equivalents.

```sql
CREATE TABLE billing_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    contract_id VARCHAR(64) NOT NULL,
    transaction_hash VARCHAR(64) NOT NULL,
    event_index INTEGER NOT NULL,
    ledger_sequence BIGINT NOT NULL,
    subscriber_address VARCHAR(56) NOT NULL,
    creator_address VARCHAR(56) NOT NULL,
    subscription_id VARCHAR(100) NOT NULL,
    billing_period VARCHAR(50) NOT NULL,
    asset_code VARCHAR(12) NOT NULL,
    asset_issuer VARCHAR(56),
    amount NUMERIC(20, 7) NOT NULL,
    usd_equivalent NUMERIC(20, 8),
    usd_price_timestamp TIMESTAMP WITH TIME ZONE,
    usd_price_confidence NUMERIC(3, 2),
    event_type VARCHAR(50) NOT NULL,
    event_timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
    backfill_required BOOLEAN NOT NULL DEFAULT false,
    UNIQUE (transaction_hash, event_index)
);
```

## Configuration

### Environment Variables

```bash
# SEP-40 Oracle Configuration
ORACLE_ADDRESS=GABC123... # Stellar oracle contract address
ORACLE_HORIZON_URL=https://horizon.stellar.org
ORACLE_NETWORK=public
ORACLE_MAX_RETRIES=5
ORACLE_BASE_DELAY=1000
ORACLE_MAX_DELAY=30000
ORACLE_TIMEOUT=10000

# Price Cache Configuration
PRICE_CACHE_SYNC_INTERVAL_MS=300000 # 5 minutes
PRICE_CACHE_MAX_AGE_MINUTES=60
PRICE_CACHE_RETENTION_DAYS=90
PRICE_CACHE_ENABLE_FALLBACK=true

# Fallback APIs Configuration
FALLBACK_COINGECKO_ENABLED=true
FALLBACK_COINCAP_ENABLED=true
FALLBACK_COINMARKETCAP_ENABLED=true
FALLBACK_COINMARKETCAP_API_KEY=your_api_key

# Worker Configuration
PRICE_CACHE_WORKER_PORT=3001
PRICE_CACHE_HEALTH_PORT=3001
```

### Advanced Configuration

```javascript
const config = {
  oracle: {
    oracleAddress: 'GABC123...',
    horizonUrl: 'https://horizon.stellar.org',
    network: 'public',
    supportedAssets: [
      { code: 'XLM', issuer: null },
      { code: 'USDC', issuer: 'GA5ZSEJYB37JRC5AVCY5N7RLO4ZO7XTRHLYTGKM6EZHCKPZY5A3F6BRU' },
      { code: 'ETH', issuer: null }
    ],
    maxRetries: 5,
    baseDelay: 1000,
    maxDelay: 30000,
    timeout: 10000
  },
  fallback: {
    enableFallback: true,
    fallbackApis: [
      {
        name: 'CoinGecko',
        url: 'https://api.coingecko.com/api/v3/simple/price',
        rateLimit: 10,
        timeout: 5000
      },
      {
        name: 'CoinCap',
        url: 'https://api.coincap.io/v2/rates',
        rateLimit: 30,
        timeout: 5000
      },
      {
        name: 'CoinMarketCap',
        url: 'https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest',
        rateLimit: 33,
        timeout: 5000,
        headers: {
          'X-CMC_PRO_API_KEY': process.env.COINMARKETCAP_API_KEY
        }
      }
    ],
    circuitBreakerThreshold: 5,
    circuitBreakerTimeout: 60000,
    cacheTtl: 300000
  }
};
```

## SEP-40 Oracle Integration

### Oracle Contract Interface

The SEP-40 oracle contract provides the following interface:

```rust
// Get price for a specific asset
pub fn get_price(
    asset: Symbol,
    issuer: Option<Address>
) -> PriceData;

// Price data structure
pub struct PriceData {
    price: i128,
    timestamp: u64,
    decimals: u32,
    confidence: u32
}
```

### Supported Assets

The system supports the following assets by default:

- **XLM** (Native Stellar)
- **USDC** (Stellar USD Coin)
- **ETH** (Ethereum)
- **BTC** (Bitcoin)

Additional assets can be configured in the `supportedAssets` array.

## Price Cache Operations

### Fetching Current Prices

```javascript
const priceData = await priceCacheService.getUsdEquivalent(
  'XLM',           // asset code
  null,            // asset issuer (null for native)
  100,             // amount
  new Date()       // timestamp
);

console.log(priceData);
// {
//   usdEquivalent: 12.34,
//   priceTimestamp: '2023-01-01T12:00:00Z',
//   confidence: 1.0,
//   backfillRequired: false,
//   source: 'cache'
// }
```

### Finding Closest Price

```javascript
const priceData = await priceCacheService.findClosestPrice(
  'XLM',
  null,
  new Date('2023-01-01T12:30:00Z')
);
```

### Manual Sync

```bash
# Trigger manual sync via API
curl -X POST http://localhost:3001/sync

# Check sync status
curl http://localhost:3001/stats
```

## Fallback Pricing

When the primary SEP-40 oracle is unavailable, the system automatically falls back to external APIs:

### CoinGecko API

- **Rate Limit**: 10 requests/minute
- **Data Source**: Free tier
- **Confidence**: 0.8 (lower than oracle)

### CoinCap API

- **Rate Limit**: 30 requests/minute
- **Data Source**: Free tier
- **Confidence**: 0.8 (lower than oracle)

### CoinMarketCap API

- **Rate Limit**: 33 requests/minute
- **Data Source**: Pro tier (requires API key)
- **Confidence**: 0.8 (lower than oracle)

### Circuit Breaker Pattern

Each fallback API implements a circuit breaker pattern:

- **CLOSED**: Normal operation
- **OPEN**: All requests fail immediately
- **HALF_OPEN**: Limited requests to test recovery

## Billing Event Integration

### Automatic USD Conversion

When a `SubscriptionBilled` event is processed:

1. Extract payment information (asset, amount)
2. Query price cache for USD equivalent at event timestamp
3. Create billing event with USD data
4. Flag for backfill if price unavailable

### Example Billing Event

```json
{
  "id": "billing_1640995200_abc123",
  "contractId": "CONTRACT_123",
  "transactionHash": "tx_hash_123",
  "eventIndex": 0,
  "subscriberAddress": "GABC123...",
  "creatorAddress": "GDEF456...",
  "subscriptionId": "sub_123",
  "billingPeriod": "monthly",
  "assetCode": "XLM",
  "assetIssuer": null,
  "amount": 100,
  "usdEquivalent": 12.34,
  "usdPriceTimestamp": "2023-01-01T12:00:00Z",
  "usdPriceConfidence": 1.0,
  "eventType": "SubscriptionBilled",
  "eventTimestamp": "2023-01-01T12:05:00Z",
  "backfillRequired": false,
  "processingStatus": "completed"
}
```

## Worker Management

### Starting the Price Cache Worker

```bash
# Start the worker
npm run price-cache

# Development mode with auto-restart
npm run price-cache:dev

# Health check
npm run price-cache:health
```

### Worker Endpoints

- **GET /health** - Health status and statistics
- **GET /stats** - Detailed service statistics
- **POST /sync** - Trigger manual sync

### Health Check Response

```json
{
  "service": "price-cache-worker",
  "timestamp": "2023-01-01T12:00:00Z",
  "healthy": true,
  "stats": {
    "syncsCompleted": 1000,
    "syncsFailed": 5,
    "pricesStored": 3000,
    "averageSyncDuration": 1500,
    "uptime": 86400000,
    "successRate": 99.5
  },
  "database": {
    "summary": [
      {
        "asset_code": "XLM",
        "total_prices": 1500,
        "oldest_price": "2023-01-01T00:00:00Z",
        "newest_price": "2023-01-01T12:00:00Z",
        "average_price": 0.1234
      }
    ],
    "health": {
      "health_status": "healthy",
      "last_successful_sync_at": "2023-01-01T12:00:00Z",
      "consecutive_failures": 0
    }
  }
}
```

## Monitoring and Observability

### Database Views

#### price_cache_summary

```sql
SELECT * FROM price_cache_summary;
```

Provides aggregated statistics per asset:
- Total prices cached
- Oldest and newest prices
- Average, highest, and lowest prices
- Stale and backfill counts

#### price_cache_health

```sql
SELECT * FROM price_cache_health;
```

Overall health status and metrics:
- Sync status and consecutive failures
- Average sync duration
- Health status classification

#### billing_events_fiat_summary

```sql
SELECT * FROM billing_events_fiat_summary;
```

Monthly fiat reporting data:
- Event counts by asset
- Total crypto and USD values
- USD coverage percentages

### Metrics

The system exposes the following metrics:

- **price_cache_syncs_total** - Total sync operations
- **price_cache_sync_duration_seconds** - Sync operation duration
- **price_cache_prices_stored_total** - Total prices stored
- **price_cache_fallback_used_total** - Fallback API usage
- **price_cache_circuit_breaker_trips_total** - Circuit breaker activations
- **billing_events_usd_conversions_total** - Successful USD conversions

### Alerting

Configure alerts for:

- **Sync Failures**: More than 3 consecutive failures
- **Stale Data**: Prices older than 1 hour
- **Low Coverage**: USD conversion rate below 95%
- **Circuit Breaker**: All fallback APIs unavailable

## Troubleshooting

### Common Issues

1. **Oracle Unavailable**
   - Check oracle contract address
   - Verify network connectivity
   - Monitor fallback API usage

2. **Price Gaps**
   - Check sync logs for errors
   - Verify oracle contract health
   - Consider increasing sync frequency

3. **High Fallback Usage**
   - Check oracle connectivity
   - Monitor API rate limits
   - Review circuit breaker status

4. **USD Conversion Failures**
   - Check price cache freshness
   - Verify asset configuration
   - Review fallback API health

### Debug Mode

```bash
# Enable debug logging
LOG_LEVEL=debug npm run price-cache

# Check specific asset pricing
curl "http://localhost:3001/stats" | jq '.database.summary[] | select(.asset_code == "XLM")'
```

### Performance Tuning

```sql
-- Optimize price queries
EXPLAIN ANALYZE SELECT * FROM find_closest_price('XLM', null, NOW(), 60);

-- Check cache hit rates
SELECT 
  asset_code,
  COUNT(*) as total_requests,
  COUNT(CASE WHEN usd_equivalent IS NOT NULL THEN 1 END) as successful_conversions,
  ROUND(COUNT(CASE WHEN usd_equivalent IS NOT NULL THEN 1 END) * 100.0 / COUNT(*), 2) as success_rate
FROM billing_events
WHERE event_timestamp >= NOW() - INTERVAL '24 hours'
GROUP BY asset_code;
```

## API Reference

### PriceCacheService

```javascript
const priceCacheService = new PriceCacheService(config, {
  database,
  oracleService,
  fallbackService
});

// Initialize
await priceCacheService.initialize();

// Get USD equivalent
const usdData = await priceCacheService.getUsdEquivalent(
  'XLM', null, 100, new Date()
);

// Find closest price
const priceData = await priceCacheService.findClosestPrice(
  'XLM', null, new Date()
);

// Get statistics
const stats = await priceCacheService.getStats();
```

### Sep40OracleService

```javascript
const oracleService = new Sep40OracleService(config);

// Initialize
await oracleService.initialize();

// Fetch current prices
const prices = await oracleService.fetchCurrentPrices();

// Fetch specific asset price
const price = await oracleService.fetchAssetPrice({
  code: 'XLM',
  issuer: null
});
```

### FallbackPriceService

```javascript
const fallbackService = new FallbackPriceService(config);

// Get USD equivalent
const result = await fallbackService.getUsdEquivalent(
  'XLM', null, 100, new Date()
);

// Reset circuit breakers
fallbackService.resetCircuitBreakers();

// Clear cache
fallbackService.clearCache();
```

## Security Considerations

### API Keys

- Store API keys in environment variables
- Use separate keys for different environments
- Rotate keys regularly

### Rate Limiting

- Implement client-side rate limiting
- Monitor API usage quotas
- Handle rate limit responses gracefully

### Data Privacy

- Cache prices only, no personal data
- Implement data retention policies
- Secure database access

## Testing

### Unit Tests

```bash
# Run all price cache tests
npm run test -- --testPathPattern=priceCache

# Run with coverage
npm run test -- --testPathPattern=priceCache --coverage
```

### Integration Tests

```javascript
// Test chronological price matching
const timestamp = new Date('2023-01-01T12:30:00Z');
const usdData = await priceCacheService.getUsdEquivalent('XLM', null, 100, timestamp);

expect(usdData.usdEquivalent).toBeCloseTo(12.34, 2);
expect(usdData.source).toBe('cache');
expect(usdData.confidence).toBeGreaterThan(0.9);
```

### Load Testing

```bash
# Simulate high load
npm run test:load:price-cache

# Test fallback scenarios
npm run test:fallback:price-cache
```

## Migration Guide

### From Manual Pricing

1. **Database Migration**: Run `005_create_price_cache.sql`
2. **Configuration**: Add oracle and fallback settings
3. **Worker Deployment**: Start price cache worker
4. **Indexer Update**: Enable USD conversion in event indexer

### Configuration Migration

```javascript
// Old approach
const billingEvent = {
  amount: 100,
  assetCode: 'XLM',
  usdEquivalent: null // Manual calculation
};

// New approach
const usdData = await priceCacheService.getUsdEquivalent(
  billingEvent.assetCode,
  billingEvent.assetIssuer,
  billingEvent.amount,
  billingEvent.timestamp
);

const billingEvent = {
  amount: 100,
  assetCode: 'XLM',
  usdEquivalent: usdData.usdEquivalent,
  usdPriceTimestamp: usdData.priceTimestamp,
  usdPriceConfidence: usdData.confidence
};
```

## Best Practices

### Performance

- Use database indexes for price lookups
- Implement client-side caching
- Monitor sync performance
- Optimize batch operations

### Reliability

- Implement circuit breakers
- Use multiple fallback APIs
- Monitor health metrics
- Set up alerting

### Data Quality

- Validate price data ranges
- Monitor confidence scores
- Implement backfill processes
- Regular data audits

## Future Enhancements

- **Real-time Streaming**: WebSocket-based price updates
- **Historical Data**: Extended historical price coverage
- **Advanced Analytics**: Price volatility and trend analysis
- **Multi-currency Support**: EUR, GBP, JPY equivalents
- **Smart Contracts**: On-chain price oracle integration

## License

This SEP-40 Oracle Price Cache system is part of the SubStream Protocol backend and follows the same licensing terms as the main project.
