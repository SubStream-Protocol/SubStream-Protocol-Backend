exports.up = function(knex) {
  return knex.schema
    // Create tenant quotas table
    .createTable('tenant_quotas', (table) => {
      table.string('tenant_id').primary().references('id').inTable('creators');
      table.jsonb('quota_config').notNullable(); // Custom quota configuration
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());
      
      table.index(['tenant_id']);
    })
    // Create tenant retention policies table
    .createTable('tenant_retention_policies', (table) => {
      table.string('tenant_id').primary().references('id').inTable('creators');
      table.jsonb('retention_config').notNullable(); // Custom retention policies
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());
      
      table.index(['tenant_id']);
    })
    // Create archive logs table
    .createTable('archive_logs', (table) => {
      table.string('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      table.string('tenant_id').notNullable().references('id').inTable('creators');
      table.string('archive_id').notNullable();
      table.string('table_name').notNullable();
      table.integer('record_count').notNullable();
      table.string('storage_class').notNullable(); // GLACIER, DEEP_ARCHIVE, etc.
      table.string('s3_key').notNullable();
      table.string('upload_id').nullable();
      table.timestamp('created_at').defaultTo(knex.fn.now());
      
      table.index(['tenant_id', 'created_at']);
      table.index(['archive_id']);
      table.index(['table_name']);
    })
    // Create archive retrieval requests table
    .createTable('archive_retrieval_requests', (table) => {
      table.string('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      table.string('tenant_id').notNullable().references('id').inTable('creators');
      table.string('archive_id').notNullable();
      table.string('status').notNullable().defaultTo('initiated'); // initiated, in_progress, completed, failed
      table.timestamp('requested_at').defaultTo(knex.fn.now());
      table.timestamp('completed_at').nullable();
      table.text('error_message').nullable();
      
      table.index(['tenant_id', 'requested_at']);
      table.index(['archive_id']);
      table.index(['status']);
    })
    // Add tenant_id to existing tables if not exists (for archival purposes)
    .raw(`
      -- Ensure tenant_id exists in tables for archival
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'billing_events' AND column_name = 'tenant_id'
        ) THEN
          ALTER TABLE billing_events ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '';
        END IF;
      END $$;

      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'subscriptions' AND column_name = 'tenant_id'
        ) THEN
          ALTER TABLE subscriptions ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '';
        END IF;
      END $$;
    `)
    // Create indexes for archival queries
    .raw(`
      -- Indexes for efficient archival queries
      CREATE INDEX IF NOT EXISTS idx_billing_events_tenant_created ON billing_events(tenant_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_subscriptions_tenant_unsubscribed ON subscriptions(tenant_id, unsubscribed_at) WHERE unsubscribed_at IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_subscriptions_tenant_inactive ON subscriptions(tenant_id, active) WHERE active = false;
      
      -- Composite indexes for quota monitoring
      CREATE INDEX IF NOT EXISTS idx_billing_events_tenant_count ON billing_events(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_subscriptions_tenant_count ON subscriptions(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_users_tenant_count ON users(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_videos_tenant_count ON videos(tenant_id);
    `)
    // Create function to get tenant storage usage
    .raw(`
      -- Function to get tenant storage usage
      CREATE OR REPLACE FUNCTION get_tenant_storage_usage(tenant_id_param TEXT)
      RETURNS TABLE (
        table_name TEXT,
        record_count BIGINT,
        storage_bytes BIGINT
      ) AS $$
      BEGIN
        RETURN QUERY
        SELECT 'users' as table_name,
               COUNT(*) as record_count,
               COALESCE(pg_total_relation_size('users'), 0) as storage_bytes
        FROM users WHERE tenant_id = tenant_id_param
        
        UNION ALL
        
        SELECT 'subscriptions' as table_name,
               COUNT(*) as record_count,
               COALESCE(pg_total_relation_size('subscriptions'), 0) as storage_bytes
        FROM subscriptions WHERE tenant_id = tenant_id_param
        
        UNION ALL
        
        SELECT 'billing_events' as table_name,
               COUNT(*) as record_count,
               COALESCE(pg_total_relation_size('billing_events'), 0) as storage_bytes
        FROM billing_events WHERE tenant_id = tenant_id_param
        
        UNION ALL
        
        SELECT 'videos' as table_name,
               COUNT(*) as record_count,
               COALESCE(SUM(file_size), 0) as storage_bytes
        FROM videos WHERE tenant_id = tenant_id_param;
      END;
      $$ LANGUAGE plpgsql SECURITY DEFINER;
    `)
    // Create function to check tenant quota
    .raw(`
      -- Function to check if tenant exceeds quota
      CREATE OR REPLACE FUNCTION check_tenant_quota(
        tenant_id_param TEXT,
        resource_type TEXT,
        additional_count INTEGER DEFAULT 1
      )
      RETURNS TABLE (
        allowed BOOLEAN,
        current_count BIGINT,
        quota_limit BIGINT,
        remaining BIGINT,
        percentage NUMERIC
      ) AS $$
      DECLARE
        current_usage BIGINT;
        quota_limit BIGINT;
        remaining_count BIGINT;
        usage_percentage NUMERIC;
      BEGIN
        -- Get current usage
        CASE resource_type
          WHEN 'users' THEN
            SELECT COUNT(*) INTO current_usage FROM users WHERE tenant_id = tenant_id_param;
          WHEN 'subscriptions' THEN
            SELECT COUNT(*) INTO current_usage FROM subscriptions WHERE tenant_id = tenant_id_param;
          WHEN 'billing_events' THEN
            SELECT COUNT(*) INTO current_usage FROM billing_events WHERE tenant_id = tenant_id_param;
          WHEN 'videos' THEN
            SELECT COUNT(*) INTO current_usage FROM videos WHERE tenant_id = tenant_id_param;
          ELSE
            RAISE EXCEPTION 'Invalid resource type: %', resource_type;
        END CASE;
        
        -- Get quota limit
        SELECT COALESCE(
          (quota_config->'max' || resource_type)::BIGINT,
          CASE 
            WHEN tier = 'enterprise' THEN -1
            WHEN tier = 'pro' THEN 
              CASE resource_type
                WHEN 'users' THEN 100000
                WHEN 'subscriptions' THEN 100000
                WHEN 'billing_events' THEN 500000
                WHEN 'videos' THEN 1000
                ELSE 1000
              END
            ELSE -- free tier
              CASE resource_type
                WHEN 'users' THEN 10000
                WHEN 'subscriptions' THEN 10000
                WHEN 'billing_events' THEN 50000
                WHEN 'videos' THEN 100
                ELSE 100
              END
            END
        ) INTO quota_limit
        FROM creators c
        LEFT JOIN tenant_quotas tq ON c.id = tq.tenant_id
        WHERE c.id = tenant_id_param;
        
        -- Calculate remaining and percentage
        IF quota_limit = -1 THEN
          remaining_count := -1;
          usage_percentage := 0;
        ELSE
          remaining_count := quota_limit - current_usage;
          usage_percentage := (current_usage::NUMERIC / quota_limit::NUMERIC) * 100;
        END IF;
        
        RETURN QUERY SELECT 
          (remaining_count >= additional_count) as allowed,
          current_usage,
          quota_limit,
          remaining_count,
          usage_percentage;
      END;
      $$ LANGUAGE plpgsql SECURITY DEFINER;
    `)
    // Create trigger to enforce quota on inserts
    .raw(`
      -- Trigger function to enforce quota
      CREATE OR REPLACE FUNCTION enforce_quota_on_insert()
      RETURNS TRIGGER AS $$
      DECLARE
        quota_check RECORD;
        resource_type TEXT;
      BEGIN
        -- Determine resource type from table
        CASE TG_TABLE_NAME
          WHEN 'users' THEN resource_type := 'users';
          WHEN 'subscriptions' THEN resource_type := 'subscriptions';
          WHEN 'billing_events' THEN resource_type := 'billing_events';
          WHEN 'videos' THEN resource_type := 'videos';
          ELSE RETURN NEW;
        END CASE;
        
        -- Check quota
        SELECT * INTO quota_check FROM check_tenant_quota(NEW.tenant_id, resource_type, 1);
        
        IF NOT quota_check.allowed THEN
          RAISE EXCEPTION 'Storage quota exceeded for %: current=%, limit=%', 
                         resource_type, quota_check.current_count, quota_check.quota_limit;
        END IF;
        
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      
      -- Create triggers for quota enforcement
      DROP TRIGGER IF EXISTS enforce_users_quota ON users;
      CREATE TRIGGER enforce_users_quota
        BEFORE INSERT ON users
        FOR EACH ROW EXECUTE FUNCTION enforce_quota_on_insert();
        
      DROP TRIGGER IF EXISTS enforce_subscriptions_quota ON subscriptions;
      CREATE TRIGGER enforce_subscriptions_quota
        BEFORE INSERT ON subscriptions
        FOR EACH ROW EXECUTE FUNCTION enforce_quota_on_insert();
        
      DROP TRIGGER IF EXISTS enforce_billing_events_quota ON billing_events;
      CREATE TRIGGER enforce_billing_events_quota
        BEFORE INSERT ON billing_events
        FOR EACH ROW EXECUTE FUNCTION enforce_quota_on_insert();
        
      DROP TRIGGER IF EXISTS enforce_videos_quota ON videos;
      CREATE TRIGGER enforce_videos_quota
        BEFORE INSERT ON videos
        FOR EACH ROW EXECUTE FUNCTION enforce_quota_on_insert();
    `);
};

exports.down = function(knex) {
  return knex.schema
    // Drop triggers
    .raw(`
      DROP TRIGGER IF EXISTS enforce_users_quota ON users;
      DROP TRIGGER IF EXISTS enforce_subscriptions_quota ON subscriptions;
      DROP TRIGGER IF EXISTS enforce_billing_events_quota ON billing_events;
      DROP TRIGGER IF EXISTS enforce_videos_quota ON videos;
    `)
    // Drop functions
    .raw(`
      DROP FUNCTION IF EXISTS enforce_quota_on_insert();
      DROP FUNCTION IF EXISTS check_tenant_quota(TEXT, TEXT, INTEGER);
      DROP FUNCTION IF EXISTS get_tenant_storage_usage(TEXT);
    `)
    // Drop tables
    .dropTableIfExists('archive_retrieval_requests')
    .dropTableIfExists('archive_logs')
    .dropTableIfExists('tenant_retention_policies')
    .dropTableIfExists('tenant_quotas')
    // Drop indexes
    .raw(`
      DROP INDEX IF EXISTS idx_billing_events_tenant_created;
      DROP INDEX IF EXISTS idx_subscriptions_tenant_unsubscribed;
      DROP INDEX IF EXISTS idx_subscriptions_tenant_inactive;
      DROP INDEX IF EXISTS idx_billing_events_tenant_count;
      DROP INDEX IF EXISTS idx_subscriptions_tenant_count;
      DROP INDEX IF EXISTS idx_users_tenant_count;
      DROP INDEX IF EXISTS idx_videos_tenant_count;
    `);
};
