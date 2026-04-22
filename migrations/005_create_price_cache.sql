-- SEP-40 Oracle Price Cache Database Schema
-- This migration creates tables for storing historical cryptocurrency prices
-- with 5-minute intervals and USD conversion rates for fiat accounting

-- Drop existing tables if they exist (for clean migration)
DROP TABLE IF EXISTS price_cache CASCADE;
DROP TABLE IF EXISTS price_cache_metadata CASCADE;

-- Main price cache table
-- Stores historical exchange rates from SEP-40 Oracle with 5-minute intervals
CREATE TABLE price_cache (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Asset identification
    asset_code VARCHAR(12) NOT NULL, -- e.g., 'XLM', 'USDC', 'ETH'
    asset_issuer VARCHAR(56), -- Stellar asset issuer (null for native XLM)
    asset_type VARCHAR(20) NOT NULL DEFAULT 'native', -- 'native', 'credit_alphanum4', 'credit_alphanum12'
    
    -- Price information
    base_asset VARCHAR(12) NOT NULL DEFAULT 'USD', -- Base currency (USD)
    price NUMERIC(20, 12) NOT NULL, -- Exchange rate (asset_to_usd)
    price_timestamp TIMESTAMP WITH TIME ZONE NOT NULL, -- Oracle price timestamp
    ledger_sequence BIGINT, -- Ledger sequence when price was recorded
    
    -- Oracle metadata
    oracle_address VARCHAR(56), -- SEP-40 oracle contract address
    oracle_timestamp TIMESTAMP WITH TIME ZONE NOT NULL, -- When oracle provided this price
    price_decimals INTEGER NOT NULL DEFAULT 7, -- Number of decimal places in price
    
    -- System metadata
    fetched_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(), -- When we fetched this price
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    
    -- Data quality indicators
    confidence_score NUMERIC(3, 2) DEFAULT 1.0, -- Price confidence (0.0-1.0)
    is_stale BOOLEAN NOT NULL DEFAULT false, -- Marked as stale if too old
    backfill_required BOOLEAN NOT NULL DEFAULT false, -- Flag for manual backfill
    
    -- Constraints
    UNIQUE (asset_code, asset_issuer, price_timestamp),
    CHECK (price > 0),
    CHECK (price_timestamp <= NOW()),
    CHECK (confidence_score >= 0.0 AND confidence_score <= 1.0)
);

-- Price cache metadata table
-- Tracks cache health, last sync status, and configuration
CREATE TABLE price_cache_metadata (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Sync status
    last_sync_at TIMESTAMP WITH TIME ZONE,
    last_successful_sync_at TIMESTAMP WITH TIME ZONE,
    sync_status VARCHAR(20) NOT NULL DEFAULT 'idle', -- 'idle', 'syncing', 'error', 'success'
    last_error_message TEXT,
    
    -- Oracle configuration
    oracle_address VARCHAR(56) NOT NULL,
    supported_assets JSONB NOT NULL DEFAULT '[]', -- Array of supported asset configs
    sync_interval_seconds INTEGER NOT NULL DEFAULT 300, -- 5 minutes
    
    -- Statistics
    total_prices_cached INTEGER NOT NULL DEFAULT 0,
    oldest_price_timestamp TIMESTAMP WITH TIME ZONE,
    newest_price_timestamp TIMESTAMP WITH TIME ZONE,
    
    -- Health metrics
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    average_sync_duration_ms INTEGER,
    last_sync_duration_ms INTEGER,
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    
    -- Constraints
    CHECK (sync_interval_seconds > 0),
    CHECK (consecutive_failures >= 0),
    CHECK (average_sync_duration_ms >= 0)
);

-- Billing events table (updated to include USD equivalents)
CREATE TABLE billing_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Event identification
    contract_id VARCHAR(64) NOT NULL,
    transaction_hash VARCHAR(64) NOT NULL,
    event_index INTEGER NOT NULL,
    ledger_sequence BIGINT NOT NULL,
    
    -- Billing information
    subscriber_address VARCHAR(56) NOT NULL,
    creator_address VARCHAR(56) NOT NULL,
    subscription_id VARCHAR(100) NOT NULL,
    billing_period VARCHAR(50) NOT NULL, -- 'monthly', 'yearly', 'custom'
    
    -- Payment details
    asset_code VARCHAR(12) NOT NULL,
    asset_issuer VARCHAR(56),
    amount NUMERIC(20, 7) NOT NULL, -- Original crypto amount
    
    -- USD equivalent (new fields)
    usd_equivalent NUMERIC(20, 8), -- USD value at time of billing
    usd_price_timestamp TIMESTAMP WITH TIME ZONE, -- When the USD price was captured
    usd_price_confidence NUMERIC(3, 2), -- Confidence in USD conversion
    
    -- Event metadata
    event_type VARCHAR(50) NOT NULL, -- 'SubscriptionBilled', 'PaymentFailed', etc.
    event_timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
    raw_event_data JSONB,
    
    -- Processing status
    processed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    backfill_required BOOLEAN NOT NULL DEFAULT false, -- Flag if USD price needs backfill
    processing_status VARCHAR(20) NOT NULL DEFAULT 'completed', -- 'completed', 'pending', 'error'
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    
    -- Constraints
    UNIQUE (transaction_hash, event_index),
    CHECK (amount > 0),
    CHECK (usd_equivalent IS NULL OR usd_equivalent >= 0),
    CHECK (usd_price_confidence IS NULL OR (usd_price_confidence >= 0.0 AND usd_price_confidence <= 1.0))
);

-- Create indexes for efficient querying
CREATE INDEX idx_price_cache_asset_timestamp 
ON price_cache (asset_code, price_timestamp DESC);

CREATE INDEX idx_price_cache_asset_issuer_timestamp 
ON price_cache (asset_code, asset_issuer, price_timestamp DESC);

CREATE INDEX idx_price_cache_oracle_timestamp 
ON price_cache (oracle_address, price_timestamp DESC);

CREATE INDEX idx_price_cache_fetched_at 
ON price_cache (fetched_at DESC);

CREATE INDEX idx_price_cache_stale 
ON price_cache (is_stale, price_timestamp DESC) 
WHERE is_stale = true;

-- Composite index for finding closest price to a timestamp
CREATE INDEX idx_price_cache_closest_match 
ON price_cache (asset_code, asset_issuer, price_timestamp) 
WHERE is_stale = false;

-- Indexes for billing events
CREATE INDEX idx_billing_events_subscription 
ON billing_events (subscription_id, event_timestamp DESC);

CREATE INDEX idx_billing_events_subscriber 
ON billing_events (subscriber_address, event_timestamp DESC);

CREATE INDEX idx_billing_events_ledger 
ON billing_events (ledger_sequence);

CREATE INDEX idx_billing_events_backfill 
ON billing_events (backfill_required, event_timestamp DESC) 
WHERE backfill_required = true;

-- Create views for monitoring and reporting
CREATE OR REPLACE VIEW price_cache_summary AS
SELECT 
    asset_code,
    asset_issuer,
    COUNT(*) as total_prices,
    MIN(price_timestamp) as oldest_price,
    MAX(price_timestamp) as newest_price,
    AVG(price) as average_price,
    MAX(price) as highest_price,
    MIN(price) as lowest_price,
    COUNT(CASE WHEN is_stale = true THEN 1 END) as stale_prices,
    COUNT(CASE WHEN backfill_required = true THEN 1 END) as backfill_needed,
    MAX(fetched_at) as last_fetched
FROM price_cache
GROUP BY asset_code, asset_issuer
ORDER BY asset_code, asset_issuer;

CREATE OR REPLACE VIEW price_cache_health AS
SELECT 
    total_prices_cached,
    last_successful_sync_at,
    sync_status,
    consecutive_failures,
    average_sync_duration_ms,
    last_sync_duration_ms,
    CASE 
        WHEN consecutive_failures >= 5 THEN 'critical'
        WHEN consecutive_failures >= 3 THEN 'warning'
        WHEN last_successful_sync_at >= NOW() - INTERVAL '1 hour' THEN 'healthy'
        ELSE 'degraded'
    END as health_status,
    EXTRACT(EPOCH FROM (NOW() - COALESCE(last_successful_sync_at, '1970-01-01')))::INTEGER as seconds_since_last_sync
FROM price_cache_metadata;

CREATE OR REPLACE VIEW billing_events_fiat_summary AS
SELECT 
    DATE_TRUNC('month', event_timestamp) as month,
    asset_code,
    COUNT(*) as event_count,
    SUM(amount) as total_crypto_amount,
    SUM(COALESCE(usd_equivalent, 0)) as total_usd_value,
    COUNT(CASE WHEN usd_equivalent IS NOT NULL THEN 1 END) as events_with_usd,
    COUNT(CASE WHEN backfill_required = true THEN 1 END) as backfill_needed,
    ROUND(COUNT(CASE WHEN usd_equivalent IS NOT NULL THEN 1 END) * 100.0 / COUNT(*), 2) as usd_coverage_percentage
FROM billing_events
GROUP BY DATE_TRUNC('month', event_timestamp), asset_code
ORDER BY month DESC, asset_code;

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_price_cache_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE OR REPLACE FUNCTION update_billing_events_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE OR REPLACE FUNCTION update_price_cache_metadata_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers to automatically update updated_at
CREATE TRIGGER trigger_price_cache_updated_at
    BEFORE UPDATE ON price_cache
    FOR EACH ROW
    EXECUTE FUNCTION update_price_cache_updated_at();

CREATE TRIGGER trigger_billing_events_updated_at
    BEFORE UPDATE ON billing_events
    FOR EACH ROW
    EXECUTE FUNCTION update_billing_events_updated_at();

CREATE TRIGGER trigger_price_cache_metadata_updated_at
    BEFORE UPDATE ON price_cache_metadata
    FOR EACH ROW
    EXECUTE FUNCTION update_price_cache_metadata_updated_at();

-- Function to find closest price to a given timestamp
CREATE OR REPLACE FUNCTION find_closest_price(
    p_asset_code VARCHAR(12),
    p_asset_issuer VARCHAR(56),
    p_target_timestamp TIMESTAMP WITH TIME ZONE,
    p_max_age_minutes INTEGER DEFAULT 60
) RETURNS TABLE (
    price NUMERIC(20, 12),
    price_timestamp TIMESTAMP WITH TIME ZONE,
    confidence_score NUMERIC(3, 2),
    time_diff_minutes INTEGER
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        pc.price,
        pc.price_timestamp,
        pc.confidence_score,
        EXTRACT(EPOCH FROM (pc.price_timestamp - p_target_timestamp)) / 60 as time_diff_minutes
    FROM price_cache pc
    WHERE pc.asset_code = p_asset_code
      AND (pc.asset_issuer = p_asset_issuer OR (pc.asset_issuer IS NULL AND p_asset_issuer IS NULL))
      AND pc.is_stale = false
      AND pc.price_timestamp <= p_target_timestamp
      AND pc.price_timestamp >= p_target_timestamp - INTERVAL '1 minute' * p_max_age_minutes
    ORDER BY ABS(EXTRACT(EPOCH FROM (pc.price_timestamp - p_target_timestamp)))
    LIMIT 1;
END;
$$ LANGUAGE plpgsql;

-- Function to mark stale prices
CREATE OR REPLACE FUNCTION mark_stale_prices()
RETURNS INTEGER AS $$
DECLARE
    stale_count INTEGER;
    stale_threshold_minutes INTEGER := 360; -- 6 hours
BEGIN
    UPDATE price_cache 
    SET is_stale = true,
        updated_at = NOW()
    WHERE is_stale = false
      AND fetched_at <= NOW() - INTERVAL '1 minute' * stale_threshold_minutes;
    
    GET DIAGNOSTICS stale_count = ROW_COUNT;
    
    RETURN stale_count;
END;
$$ LANGUAGE plpgsql;

-- Function to clean up old price data (keep 90 days)
CREATE OR REPLACE FUNCTION cleanup_old_price_data()
RETURNS INTEGER AS $$
DECLARE
    cleanup_count INTEGER;
    retention_days INTEGER := 90;
BEGIN
    DELETE FROM price_cache 
    WHERE price_timestamp < NOW() - INTERVAL '1 day' * retention_days;
    
    GET DIAGNOSTICS cleanup_count = ROW_COUNT;
    
    RETURN cleanup_count;
END;
$$ LANGUAGE plpgsql;

-- Function to initialize price cache metadata
CREATE OR REPLACE FUNCTION initialize_price_cache_metadata(
    p_oracle_address VARCHAR(56),
    p_supported_assets JSONB DEFAULT '[]',
    p_sync_interval_seconds INTEGER DEFAULT 300
) RETURNS UUID AS $$
DECLARE
    metadata_id UUID;
BEGIN
    INSERT INTO price_cache_metadata (
        oracle_address,
        supported_assets,
        sync_interval_seconds,
        created_at
    ) VALUES (
        p_oracle_address,
        p_supported_assets,
        p_sync_interval_seconds,
        NOW()
    ) RETURNING id INTO metadata_id;
    
    RETURN metadata_id;
END;
$$ LANGUAGE plpgsql;

-- Grant necessary permissions (adjust as needed)
-- GRANT SELECT, INSERT, UPDATE ON price_cache TO price_cache_user;
-- GRANT SELECT, INSERT, UPDATE ON billing_events TO billing_user;
-- GRANT SELECT ON price_cache_summary TO readonly_user;
-- GRANT SELECT ON price_cache_health TO readonly_user;
-- GRANT EXECUTE ON FUNCTION find_closest_price TO app_user;

-- Add table comments for documentation
COMMENT ON TABLE price_cache IS 'SEP-40 Oracle price cache with 5-minute intervals for USD conversion';
COMMENT ON TABLE billing_events IS 'Billing events with USD equivalent values for fiat accounting';
COMMENT ON TABLE price_cache_metadata IS 'Metadata and health status for price cache synchronization';
COMMENT ON COLUMN price_cache.price IS 'Exchange rate from asset to USD (asset_to_usd)';
COMMENT ON COLUMN price_cache.price_timestamp IS 'Oracle-provided timestamp for the price';
COMMENT ON COLUMN billing_events.usd_equivalent IS 'USD value of the crypto amount at billing time';
COMMENT ON COLUMN billing_events.backfill_required IS 'Flag indicating USD price needs manual backfill';

-- Update table statistics for optimal query planning
ANALYZE price_cache;
ANALYZE billing_events;
ANALYZE price_cache_metadata;
