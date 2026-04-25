/**
 * Add WebSocket Rate Limit Log Table
 * 
 * This migration creates:
 * - websocket_rate_limit_log: Audit trail for all rate limit events
 * - tenant_rate_limits: Custom rate limit configurations per tenant
 */

exports.up = async function(knex) {
  // Create websocket_rate_limit_log table
  await knex.schema.createTable('websocket_rate_limit_log', function(table) {
    table.uuid('id').primary().defaultTo(knex.raw('(gen_random_uuid())'));
    table.string('event_type', 50).notNullable(); // IP_CONNECTION_LIMIT, TENANT_CONNECTION_LIMIT, MESSAGE_RATE_LIMIT
    table.string('client_ip', 45).notNullable(); // IPv6 compatible
    table.uuid('tenant_id').nullable();
    table.jsonb('details').defaultTo('{}');
    table.timestamp('created_at').defaultTo(knex.fn.now());
    
    // Indexes for audit queries
    table.index(['event_type'], 'idx_ws_log_event');
    table.index(['client_ip'], 'idx_ws_log_ip');
    table.index(['tenant_id'], 'idx_ws_log_tenant');
    table.index(['created_at'], 'idx_ws_log_timestamp');
    
    // Foreign key constraint (nullable for anonymous connections)
    table.foreign('tenant_id').references('id').inTable('tenants').onDelete('SET NULL');
  });

  // Create tenant_rate_limits table for custom configurations
  await knex.schema.createTable('tenant_rate_limits', function(table) {
    table.uuid('id').primary().defaultTo(knex.raw('(gen_random_uuid())'));
    table.uuid('tenant_id').notNullable().unique();
    table.integer('max_connections_per_ip').defaultTo(null);
    table.integer('max_connections_per_tenant').defaultTo(null);
    table.integer('max_messages_per_second').defaultTo(null);
    table.jsonb('metadata').defaultTo('{}');
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
    
    // Indexes
    table.index(['tenant_id'], 'idx_tenant_rate_limits_tenant');
    
    // Foreign key constraint
    table.foreign('tenant_id').references('id').inTable('tenants').onDelete('CASCADE');
  });
};

exports.down = async function(knex) {
  await knex.schema.dropTableIfExists('tenant_rate_limits');
  await knex.schema.dropTableIfExists('websocket_rate_limit_log');
};
