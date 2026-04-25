/**
 * Add Data Export Tracking Tables
 * 
 * This migration creates:
 * - data_export_requests: Tracks export requests and their status
 * - data_export_rate_limits: Prevents abuse of export functionality
 */

exports.up = async function(knex) {
  // Create data_export_requests table
  await knex.schema.createTable('data_export_requests', function(table) {
    table.uuid('id').primary().defaultTo(knex.raw('(gen_random_uuid())'));
    table.uuid('tenant_id').notNullable();
    table.string('status', 50).defaultTo('pending'); // pending, processing, completed, failed, expired
    table.string('requester_email', 255).notNullable();
    table.string('export_format', 20).defaultTo('json'); // json, csv
    table.string('s3_url').nullable(); // Signed URL when ready
    table.timestamp('s3_url_expires_at').nullable();
    table.jsonb('export_metadata').defaultTo('{}'); // File sizes, record counts, etc.
    table.text('error_message').nullable();
    table.timestamp('requested_at').defaultTo(knex.fn.now());
    table.timestamp('started_at').nullable();
    table.timestamp('completed_at').nullable();
    
    // Indexes
    table.index(['tenant_id'], 'idx_export_tenant');
    table.index(['status'], 'idx_export_status');
    table.index(['requested_at'], 'idx_export_requested');
    table.index(['s3_url_expires_at'], 'idx_export_expires');
    
    // Foreign key constraint
    table.foreign('tenant_id').references('id').inTable('tenants').onDelete('CASCADE');
  });

  // Create data_export_rate_limits table
  await knex.schema.createTable('data_export_rate_limits', function(table) {
    table.uuid('id').primary().defaultTo(knex.raw('(gen_random_uuid())'));
    table.uuid('tenant_id').notNullable();
    table.timestamp('last_export_at').defaultTo(knex.fn.now());
    table.integer('export_count').defaultTo(1); // Number of exports in current period
    table.timestamp('period_start').defaultTo(knex.fn.now()); // Start of current 7-day period
    table.jsonb('metadata').defaultTo('{}');
    
    // Indexes
    table.index(['tenant_id'], 'idx_rate_limit_tenant');
    table.unique(['tenant_id'], 'uk_rate_limit_tenant');
    
    // Foreign key constraint
    table.foreign('tenant_id').references('id').inTable('tenants').onDelete('CASCADE');
  });
};

exports.down = async function(knex) {
  await knex.schema.dropTableIfExists('data_export_rate_limits');
  await knex.schema.dropTableIfExists('data_export_requests');
};
