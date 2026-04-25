exports.up = function(knex) {
  return knex.schema
    // Create API keys table
    .createTable('api_keys', (table) => {
      table.string('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      table.string('tenant_id').notNullable().references('id').inTable('creators');
      table.string('name').notNullable();
      table.text('hashed_key').notNullable(); // bcrypt hash of the API key
      table.jsonb('permissions').notNullable(); // Array of permissions
      table.timestamp('expires_at').nullable();
      table.jsonb('metadata').defaultTo('{}'); // Additional metadata
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());
      table.timestamp('last_used_at').nullable();
      table.boolean('is_active').defaultTo(true);
      
      // Indexes for performance
      table.index(['tenant_id', 'is_active']);
      table.index(['expires_at']);
      table.index(['last_used_at']);
      table.index(['created_at']);
    })
    // Create API key audit logs table
    .createTable('api_key_audit_logs', (table) => {
      table.string('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      table.string('tenant_id').notNullable().references('id').inTable('creators');
      table.string('key_id').notNullable().references('id').inTable('api_keys');
      table.string('event').notNullable(); // created, revoked, used, expired, permissions_updated, etc.
      table.jsonb('metadata').defaultTo('{}'); // Event-specific metadata
      table.timestamp('timestamp').defaultTo(knex.fn.now());
      table.string('ip_address').nullable();
      table.text('user_agent').nullable();
      
      // Indexes for audit queries
      table.index(['tenant_id', 'timestamp']);
      table.index(['key_id', 'timestamp']);
      table.index(['event', 'timestamp']);
    })
    // Create function to validate API key permissions
    .raw(`
      -- Function to check if API key has specific permission
      CREATE OR REPLACE FUNCTION check_api_key_permission(
        key_id_param TEXT,
        permission_param TEXT
      )
      RETURNS BOOLEAN AS $$
      DECLARE
        key_permissions JSONB;
      BEGIN
        SELECT permissions INTO key_permissions 
        FROM api_keys 
        WHERE id = key_id_param AND is_active = true AND (expires_at IS NULL OR expires_at > NOW());
        
        IF NOT FOUND THEN
          RETURN FALSE;
        END IF;
        
        -- Check for admin access
        IF key_permissions ? 'admin:all' THEN
          RETURN TRUE;
        END IF;
        
        -- Check for specific permission
        RETURN key_permissions ? permission_param;
      END;
      $$ LANGUAGE plpgsql SECURITY DEFINER;
    `)
    // Create function to log API key usage
    .raw(`
      -- Function to log API key usage
      CREATE OR REPLACE FUNCTION log_api_key_usage(
        key_id_param TEXT,
        event_param TEXT,
        metadata_param JSONB DEFAULT '{}',
        ip_param TEXT DEFAULT NULL,
        user_agent_param TEXT DEFAULT NULL
      )
      RETURNS VOID AS $$
      DECLARE
        tenant_id_var TEXT;
      BEGIN
        -- Get tenant_id from API key
        SELECT tenant_id INTO tenant_id_var
        FROM api_keys 
        WHERE id = key_id_param;
        
        IF tenant_id_var IS NOT NULL THEN
          INSERT INTO api_key_audit_logs (tenant_id, key_id, event, metadata, ip_address, user_agent)
          VALUES (tenant_id_var, key_id_param, event_param, metadata_param, ip_param, user_agent_param);
        END IF;
      END;
      $$ LANGUAGE plpgsql SECURITY DEFINER;
    `)
    // Create trigger to update last_used_at
    .raw(`
      -- Function to update last_used_at timestamp
      CREATE OR REPLACE FUNCTION update_api_key_last_used()
      RETURNS TRIGGER AS $$
      BEGIN
        UPDATE api_keys 
        SET last_used_at = NOW() 
        WHERE id = NEW.key_id;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      
      -- Trigger to automatically update last_used_at when audit log is created
      CREATE TRIGGER update_api_key_last_used_trigger
        AFTER INSERT ON api_key_audit_logs
        FOR EACH ROW
        WHEN (NEW.event = 'used')
        EXECUTE FUNCTION update_api_key_last_used();
    `)
    // Create view for API key statistics
    .raw(`
      -- Create view for API key statistics
      CREATE OR REPLACE VIEW api_key_stats AS
      SELECT 
        ak.tenant_id,
        ak.id as key_id,
        ak.name,
        ak.permissions,
        ak.expires_at,
        ak.created_at,
        ak.last_used_at,
        ak.is_active,
        COUNT(aal.id) as usage_count,
        MAX(aal.timestamp) as last_activity,
        COUNT(CASE WHEN aal.event = 'used' THEN 1 END) as request_count,
        COUNT(CASE WHEN aal.event = 'revoked' THEN 1 END) as revocation_count
      FROM api_keys ak
      LEFT JOIN api_key_audit_logs aal ON ak.id = aal.key_id
      GROUP BY ak.tenant_id, ak.id, ak.name, ak.permissions, ak.expires_at, ak.created_at, ak.last_used_at, ak.is_active;
    `)
    // Create function to clean up expired API keys
    .raw(`
      -- Function to deactivate expired API keys
      CREATE OR REPLACE FUNCTION deactivate_expired_api_keys()
      RETURNS TABLE (
        deactivated_keys BIGINT,
        key_ids TEXT[]
      ) AS $$
      DECLARE
        expired_keys RECORD;
        key_id_array TEXT[] := '{}';
        deactivated_count BIGINT := 0;
      BEGIN
        -- Deactivate expired keys
        UPDATE api_keys 
        SET is_active = false, updated_at = NOW()
        WHERE is_active = true AND expires_at IS NOT NULL AND expires_at <= NOW()
        RETURNING id INTO expired_keys;
        
        -- Collect deactivated key IDs
        FOR expired_keys IN 
          SELECT id FROM api_keys 
          WHERE is_active = false AND expires_at IS NOT NULL AND expires_at <= NOW()
          AND updated_at >= NOW() - INTERVAL '1 minute'
        LOOP
          key_id_array := array_append(key_id_array, expired_keys.id);
          deactivated_count := deactivated_count + 1;
          
          -- Log deactivation
          INSERT INTO api_key_audit_logs (tenant_id, key_id, event, metadata)
          SELECT tenant_id, id, 'expired', '{"automatic": true}'
          FROM api_keys 
          WHERE id = expired_keys.id;
        END LOOP;
        
        RETURN QUERY SELECT deactivated_count, key_id_array;
      END;
      $$ LANGUAGE plpgsql;
    `)
    // Add RLS policies for API keys table
    .raw(`
      -- Enable RLS on API keys table
      ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
      
      -- Create RLS policy for API keys
      CREATE POLICY api_keys_tenant_policy ON api_keys
        FOR ALL
        TO authenticated_user
        USING (tenant_id = current_setting('app.current_tenant_id', true));
      
      -- Enable RLS on audit logs table
      ALTER TABLE api_key_audit_logs ENABLE ROW LEVEL SECURITY;
      
      -- Create RLS policy for audit logs
      CREATE POLICY api_key_audit_logs_tenant_policy ON api_key_audit_logs
        FOR ALL
        TO authenticated_user
        USING (tenant_id = current_setting('app.current_tenant_id', true));
    `)
    // Create indexes for RLS performance
    .raw(`
      -- Create indexes for RLS-optimized queries
      CREATE INDEX IF NOT EXISTS idx_api_keys_tenant_active ON api_keys(tenant_id, is_active);
      CREATE INDEX IF NOT EXISTS idx_api_keys_tenant_created ON api_keys(tenant_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_api_audit_logs_tenant_timestamp ON api_key_audit_logs(tenant_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_api_audit_logs_key_timestamp ON api_key_audit_logs(key_id, timestamp);
    `)
    // Create helper functions for API key management
    .raw(`
      -- Function to get API key usage summary
      CREATE OR REPLACE FUNCTION get_api_key_usage_summary(
        tenant_id_param TEXT,
        start_date TIMESTAMP DEFAULT NOW() - INTERVAL '30 days',
        end_date TIMESTAMP DEFAULT NOW()
      )
      RETURNS TABLE (
        key_id TEXT,
        key_name TEXT,
        total_requests BIGINT,
        unique_ips BIGINT,
        last_request TIMESTAMP,
        is_active BOOLEAN
      ) AS $$
      BEGIN
        RETURN QUERY
        SELECT 
          ak.id,
          ak.name,
          COUNT(aal.id) FILTER (WHERE aal.event = 'used') as total_requests,
          COUNT(DISTINCT aal.ip_address) as unique_ips,
          MAX(aal.timestamp) FILTER (WHERE aal.event = 'used') as last_request,
          ak.is_active
        FROM api_keys ak
        LEFT JOIN api_key_audit_logs aal ON ak.id = aal.key_id 
          AND aal.timestamp BETWEEN start_date AND end_date
        WHERE ak.tenant_id = tenant_id_param
        GROUP BY ak.id, ak.name, ak.is_active
        ORDER BY total_requests DESC;
      END;
      $$ LANGUAGE plpgsql SECURITY DEFINER;
      
      -- Function to validate API key format
      CREATE OR REPLACE FUNCTION validate_api_key_format(key_text TEXT)
      RETURNS BOOLEAN AS $$
      BEGIN
        -- API keys should start with 'sk_' and be at least 35 characters total
        RETURN key_text ~ '^sk_[a-f0-9]{64,}$';
      END;
      $$ LANGUAGE plpgsql IMMUTABLE;
      
      -- Function to check API key rate limit
      CREATE OR REPLACE FUNCTION check_api_key_rate_limit(
        key_id_param TEXT,
        window_minutes INTEGER DEFAULT 1,
        max_requests INTEGER DEFAULT 1000
      )
      RETURNS TABLE (
        allowed BOOLEAN,
        current_count BIGINT,
        remaining BIGINT,
        reset_time TIMESTAMP
      ) AS $$
      DECLARE
        current_count BIGINT;
        remaining_requests BIGINT;
        reset_timestamp TIMESTAMP;
      BEGIN
        -- Count requests in the time window
        SELECT COUNT(*) INTO current_count
        FROM api_key_audit_logs
        WHERE key_id = key_id_param 
          AND event = 'used'
          AND timestamp >= NOW() - (window_minutes || ' minutes')::INTERVAL;
        
        remaining_requests := GREATEST(0, max_requests - current_count);
        reset_timestamp := NOW() + (window_minutes || ' minutes')::INTERVAL;
        
        RETURN QUERY SELECT 
          (current_count < max_requests) as allowed,
          current_count,
          remaining_requests,
          reset_timestamp;
      END;
      $$ LANGUAGE plpgsql SECURITY DEFINER;
    `);
};

exports.down = function(knex) {
  return knex.schema
    // Drop views and functions
    .raw(`
      DROP VIEW IF EXISTS api_key_stats;
      DROP FUNCTION IF EXISTS get_api_key_usage_summary(TEXT, TIMESTAMP, TIMESTAMP);
      DROP FUNCTION IF EXISTS check_api_key_rate_limit(TEXT, INTEGER, INTEGER);
      DROP FUNCTION IF EXISTS validate_api_key_format(TEXT);
      DROP FUNCTION IF EXISTS deactivate_expired_api_keys();
      DROP FUNCTION IF EXISTS log_api_key_usage(TEXT, TEXT, JSONB, TEXT, TEXT);
      DROP FUNCTION IF EXISTS check_api_key_permission(TEXT, TEXT);
      DROP FUNCTION IF EXISTS update_api_key_last_used();
    `)
    // Drop triggers
    .raw(`
      DROP TRIGGER IF EXISTS update_api_key_last_used_trigger ON api_key_audit_logs;
    `)
    // Drop RLS policies
    .raw(`
      DROP POLICY IF EXISTS api_keys_tenant_policy ON api_keys;
      DROP POLICY IF EXISTS api_key_audit_logs_tenant_policy ON api_key_audit_logs;
      ALTER TABLE api_keys DISABLE ROW LEVEL SECURITY;
      ALTER TABLE api_key_audit_logs DISABLE ROW LEVEL SECURITY;
    `)
    // Drop tables
    .dropTableIfExists('api_key_audit_logs')
    .dropTableIfExists('api_keys')
    // Drop indexes
    .raw(`
      DROP INDEX IF EXISTS idx_api_keys_tenant_active;
      DROP INDEX IF EXISTS idx_api_keys_tenant_created;
      DROP INDEX IF EXISTS idx_api_audit_logs_tenant_timestamp;
      DROP INDEX IF EXISTS idx_api_audit_logs_key_timestamp;
    `);
};
