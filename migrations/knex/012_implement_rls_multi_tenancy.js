exports.up = function(knex) {
  return knex.schema
    // First, add tenant_id columns to all sensitive tables
    .raw(`
      -- Add tenant_id to subscriptions table if not exists
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'subscriptions' AND column_name = 'tenant_id'
        ) THEN
          ALTER TABLE subscriptions ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '';
        END IF;
      END $$;

      -- Add tenant_id to billing_events table if not exists
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'billing_events' AND column_name = 'tenant_id'
        ) THEN
          ALTER TABLE billing_events ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '';
        END IF;
      END $$;

      -- Add tenant_id to users table if not exists
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'users' AND column_name = 'tenant_id'
        ) THEN
          ALTER TABLE users ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '';
        END IF;
      END $$;

      -- Add tenant_id to creators table if not exists
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'creators' AND column_name = 'tenant_id'
        ) THEN
          ALTER TABLE creators ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '';
        END IF;
      END $$;

      -- Add tenant_id to creator_settings table if not exists
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'creator_settings' AND column_name = 'tenant_id'
        ) THEN
          ALTER TABLE creator_settings ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '';
        END IF;
      END $$;

      -- Add tenant_id to videos table if not exists
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'videos' AND column_name = 'tenant_id'
        ) THEN
          ALTER TABLE videos ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '';
        END IF;
      END $$;
    `)
    // Enable RLS on all tables
    .raw(`
      -- Enable Row Level Security
      ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
      ALTER TABLE billing_events ENABLE ROW LEVEL SECURITY;
      ALTER TABLE users ENABLE ROW LEVEL SECURITY;
      ALTER TABLE creators ENABLE ROW LEVEL SECURITY;
      ALTER TABLE creator_settings ENABLE ROW LEVEL SECURITY;
      ALTER TABLE videos ENABLE ROW LEVEL SECURITY;
    `)
    // Create RLS policies for each table
    .raw(`
      -- Create RLS policy for subscriptions
      CREATE POLICY subscriptions_tenant_policy ON subscriptions
        FOR ALL
        TO authenticated_user
        USING (tenant_id = current_setting('app.current_tenant_id', true));

      -- Create RLS policy for billing_events
      CREATE POLICY billing_events_tenant_policy ON billing_events
        FOR ALL
        TO authenticated_user
        USING (tenant_id = current_setting('app.current_tenant_id', true));

      -- Create RLS policy for users
      CREATE POLICY users_tenant_policy ON users
        FOR ALL
        TO authenticated_user
        USING (tenant_id = current_setting('app.current_tenant_id', true));

      -- Create RLS policy for creators
      CREATE POLICY creators_tenant_policy ON creators
        FOR ALL
        TO authenticated_user
        USING (tenant_id = current_setting('app.current_tenant_id', true));

      -- Create RLS policy for creator_settings
      CREATE POLICY creator_settings_tenant_policy ON creator_settings
        FOR ALL
        TO authenticated_user
        USING (tenant_id = current_setting('app.current_tenant_id', true));

      -- Create RLS policy for videos
      CREATE POLICY videos_tenant_policy ON videos
        FOR ALL
        TO authenticated_user
        USING (tenant_id = current_setting('app.current_tenant_id', true));
    `)
    // Create bypass_rls role for background workers
    .raw(`
      -- Create role for background workers that bypasses RLS
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bypass_rls') THEN
          CREATE ROLE bypass_rls NOINHERIT;
          GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO bypass_rls;
          ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO bypass_rls;
        END IF;
      END $$;

      -- Grant bypass_rls role to existing background worker role if it exists
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'background_worker') THEN
          GRANT bypass_rls TO background_worker;
        END IF;
      END $$;
    `)
    // Create indexes for tenant_id columns for performance
    .raw(`
      -- Create indexes for tenant_id columns
      CREATE INDEX IF NOT EXISTS idx_subscriptions_tenant_id ON subscriptions(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_billing_events_tenant_id ON billing_events(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_users_tenant_id ON users(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_creators_tenant_id ON creators(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_creator_settings_tenant_id ON creator_settings(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_videos_tenant_id ON videos(tenant_id);

      -- Composite indexes for common queries
      CREATE INDEX IF NOT EXISTS idx_subscriptions_tenant_active ON subscriptions(tenant_id, active);
      CREATE INDEX IF NOT EXISTS idx_billing_events_tenant_created ON billing_events(tenant_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_videos_tenant_creator ON videos(tenant_id, creator_id);
    `)
    // Create function to set tenant context
    .raw(`
      -- Create function to set tenant context
      CREATE OR REPLACE FUNCTION set_tenant_context(tenant_id TEXT)
      RETURNS VOID AS $$
      BEGIN
        PERFORM set_config('app.current_tenant_id', tenant_id, true);
      END;
      $$ LANGUAGE plpgsql SECURITY DEFINER;

      -- Create function to get current tenant context
      CREATE OR REPLACE FUNCTION get_current_tenant_id()
      RETURNS TEXT AS $$
      BEGIN
        RETURN current_setting('app.current_tenant_id', true);
      END;
      $$ LANGUAGE plpgsql SECURITY DEFINER;
    `)
    // Create trigger to automatically set tenant_id on insert
    .raw(`
      -- Create trigger function to set tenant_id from context
      CREATE OR REPLACE FUNCTION set_tenant_id_from_context()
      RETURNS TRIGGER AS $$
      BEGIN
        IF TG_TABLE_NAME IN ('subscriptions', 'billing_events', 'users', 'creators', 'creator_settings', 'videos') THEN
          NEW.tenant_id = COALESCE(NEW.tenant_id, current_setting('app.current_tenant_id', true));
          IF NEW.tenant_id IS NULL OR NEW.tenant_id = '' THEN
            RAISE EXCEPTION 'tenant_id cannot be null or empty';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      -- Create triggers for each table
      DROP TRIGGER IF EXISTS subscriptions_set_tenant_id ON subscriptions;
      CREATE TRIGGER subscriptions_set_tenant_id
        BEFORE INSERT OR UPDATE ON subscriptions
        FOR EACH ROW EXECUTE FUNCTION set_tenant_id_from_context();

      DROP TRIGGER IF EXISTS billing_events_set_tenant_id ON billing_events;
      CREATE TRIGGER billing_events_set_tenant_id
        BEFORE INSERT OR UPDATE ON billing_events
        FOR EACH ROW EXECUTE FUNCTION set_tenant_id_from_context();

      DROP TRIGGER IF EXISTS users_set_tenant_id ON users;
      CREATE TRIGGER users_set_tenant_id
        BEFORE INSERT OR UPDATE ON users
        FOR EACH ROW EXECUTE FUNCTION set_tenant_id_from_context();

      DROP TRIGGER IF EXISTS creators_set_tenant_id ON creators;
      CREATE TRIGGER creators_set_tenant_id
        BEFORE INSERT OR UPDATE ON creators
        FOR EACH ROW EXECUTE FUNCTION set_tenant_id_from_context();

      DROP TRIGGER IF EXISTS creator_settings_set_tenant_id ON creator_settings;
      CREATE TRIGGER creator_settings_set_tenant_id
        BEFORE INSERT OR UPDATE ON creator_settings
        FOR EACH ROW EXECUTE FUNCTION set_tenant_id_from_context();

      DROP TRIGGER IF EXISTS videos_set_tenant_id ON videos;
      CREATE TRIGGER videos_set_tenant_id
        BEFORE INSERT OR UPDATE ON videos
        FOR EACH ROW EXECUTE FUNCTION set_tenant_id_from_context();
    `);
};

exports.down = function(knex) {
  return knex.schema
    // Drop triggers
    .raw(`
      DROP TRIGGER IF EXISTS subscriptions_set_tenant_id ON subscriptions;
      DROP TRIGGER IF EXISTS billing_events_set_tenant_id ON billing_events;
      DROP TRIGGER IF EXISTS users_set_tenant_id ON users;
      DROP TRIGGER IF EXISTS creators_set_tenant_id ON creators;
      DROP TRIGGER IF EXISTS creator_settings_set_tenant_id ON creator_settings;
      DROP TRIGGER IF EXISTS videos_set_tenant_id ON videos;
    `)
    // Drop functions
    .raw(`
      DROP FUNCTION IF EXISTS set_tenant_id_from_context();
      DROP FUNCTION IF EXISTS set_tenant_context(TEXT);
      DROP FUNCTION IF EXISTS get_current_tenant_id();
    `)
    // Drop policies
    .raw(`
      DROP POLICY IF EXISTS subscriptions_tenant_policy ON subscriptions;
      DROP POLICY IF EXISTS billing_events_tenant_policy ON billing_events;
      DROP POLICY IF EXISTS users_tenant_policy ON users;
      DROP POLICY IF EXISTS creators_tenant_policy ON creators;
      DROP POLICY IF EXISTS creator_settings_tenant_policy ON creator_settings;
      DROP POLICY IF EXISTS videos_tenant_policy ON videos;
    `)
    // Disable RLS
    .raw(`
      ALTER TABLE subscriptions DISABLE ROW LEVEL SECURITY;
      ALTER TABLE billing_events DISABLE ROW LEVEL SECURITY;
      ALTER TABLE users DISABLE ROW LEVEL SECURITY;
      ALTER TABLE creators DISABLE ROW LEVEL SECURITY;
      ALTER TABLE creator_settings DISABLE ROW LEVEL SECURITY;
      ALTER TABLE videos DISABLE ROW LEVEL SECURITY;
    `)
    // Drop bypass_rls role
    .raw(`
      DROP ROLE IF EXISTS bypass_rls;
    `)
    // Note: We don't drop tenant_id columns in down migration to avoid data loss
    // They can be manually removed if needed
    .raw(`
      -- Drop indexes (optional, as they'll be dropped with columns)
      DROP INDEX IF EXISTS idx_subscriptions_tenant_id;
      DROP INDEX IF EXISTS idx_billing_events_tenant_id;
      DROP INDEX IF EXISTS idx_users_tenant_id;
      DROP INDEX IF EXISTS idx_creators_tenant_id;
      DROP INDEX IF EXISTS idx_creator_settings_tenant_id;
      DROP INDEX IF EXISTS idx_videos_tenant_id;
      DROP INDEX IF EXISTS idx_subscriptions_tenant_active;
      DROP INDEX IF EXISTS idx_billing_events_tenant_created;
      DROP INDEX IF EXISTS idx_videos_tenant_creator;
    `);
};
