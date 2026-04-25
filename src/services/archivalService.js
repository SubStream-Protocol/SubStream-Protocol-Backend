const AWS = require('aws-sdk');
const { getRedisClient } = require('../config/redis');

/**
 * Archival Service
 * Handles automated data archival to cold storage and retention policies
 */

class ArchivalService {
  constructor(database, redisService) {
    this.database = database;
    this.redisService = redisService;
    this.redisClient = getRedisClient();
    
    // Initialize S3 client for Glacier
    this.s3 = new AWS.S3({
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      region: process.env.AWS_REGION || 'us-east-1'
    });

    // Configuration
    this.batchSize = 1000;
    this.maxRetries = 3;
    this.archiveBucket = process.env.ARCHIVE_BUCKET || 'substream-archives';
  }

  /**
   * Run archival process for all tenants
   * @returns {Promise<object>} Archival results
   */
  async runArchivalProcess() {
    const results = {
      startTime: new Date().toISOString(),
      tenants: [],
      totalRecordsProcessed: 0,
      totalRecordsArchived: 0,
      totalErrors: 0,
      endTime: null
    };

    try {
      // Get all active tenants
      const tenants = await this.getActiveTenants();
      
      for (const tenant of tenants) {
        console.log(`Processing archival for tenant: ${tenant.id}`);
        
        try {
          const tenantResult = await this.processTenantArchival(tenant.id);
          results.tenants.push(tenantResult);
          results.totalRecordsProcessed += tenantResult.recordsProcessed;
          results.totalRecordsArchived += tenantResult.recordsArchived;
          results.totalErrors += tenantResult.errors;
        } catch (error) {
          console.error(`Error processing tenant ${tenant.id}:`, error);
          results.tenants.push({
            tenantId: tenant.id,
            success: false,
            error: error.message,
            recordsProcessed: 0,
            recordsArchived: 0,
            errors: 1
          });
          results.totalErrors++;
        }
      }

      results.endTime = new Date().toISOString();
      results.success = results.totalErrors === 0;
      
      // Log archival results
      await this.logArchivalResults(results);
      
      return results;
    } catch (error) {
      console.error('Archival process failed:', error);
      results.endTime = new Date().toISOString();
      results.success = false;
      results.error = error.message;
      return results;
    }
  }

  /**
   * Process archival for a specific tenant
   * @param {string} tenantId - Tenant ID
   * @returns {Promise<object>} Tenant archival results
   */
  async processTenantArchival(tenantId) {
    const result = {
      tenantId,
      startTime: new Date().toISOString(),
      recordsProcessed: 0,
      recordsArchived: 0,
      errors: 0,
      archives: [],
      endTime: null
    };

    try {
      // Get tenant retention policy
      const retentionPolicy = await this.getTenantRetentionPolicy(tenantId);
      
      // Process each table for archival
      const tables = ['billing_events', 'subscriptions'];
      
      for (const table of tables) {
        const tableResult = await this.archiveTable(tenantId, table, retentionPolicy);
        result.recordsProcessed += tableResult.recordsProcessed;
        result.recordsArchived += tableResult.recordsArchived;
        result.errors += tableResult.errors;
        result.archives.push(...tableResult.archives);
      }

      result.endTime = new Date().toISOString();
      result.success = result.errors === 0;
      
      return result;
    } catch (error) {
      console.error(`Error processing archival for tenant ${tenantId}:`, error);
      result.endTime = new Date().toISOString();
      result.success = false;
      result.error = error.message;
      return result;
    }
  }

  /**
   * Archive data from a specific table
   * @param {string} tenantId - Tenant ID
   * @param {string} table - Table name
   * @param {object} retentionPolicy - Retention policy
   * @returns {Promise<object>} Table archival results
   */
  async archiveTable(tenantId, table, retentionPolicy) {
    const result = {
      table,
      recordsProcessed: 0,
      recordsArchived: 0,
      errors: 0,
      archives: []
    };

    try {
      const cutoffDate = this.calculateCutoffDate(retentionPolicy[table] || retentionPolicy.default);
      
      // Get records to archive
      const recordsToArchive = await this.getRecordsForArchival(tenantId, table, cutoffDate);
      result.recordsProcessed = recordsToArchive.length;

      if (recordsToArchive.length === 0) {
        return result;
      }

      // Process in batches
      for (let i = 0; i < recordsToArchive.length; i += this.batchSize) {
        const batch = recordsToArchive.slice(i, i + this.batchSize);
        
        try {
          const archiveResult = await this.archiveBatch(tenantId, table, batch, cutoffDate);
          result.recordsArchived += archiveResult.recordsArchived;
          result.archives.push(archiveResult.archiveInfo);
        } catch (error) {
          console.error(`Error archiving batch for ${table}:`, error);
          result.errors++;
        }
      }

      return result;
    } catch (error) {
      console.error(`Error archiving table ${table}:`, error);
      result.errors++;
      return result;
    }
  }

  /**
   * Get records that need to be archived
   * @param {string} tenantId - Tenant ID
   * @param {string} table - Table name
   * @param {Date} cutoffDate - Cutoff date for archival
   * @returns {Promise<Array>} Records to archive
   */
  async getRecordsForArchival(tenantId, table, cutoffDate) {
    const client = await this.database.pool.connect();
    
    try {
      let query = '';
      let params = [tenantId, cutoffDate];

      switch (table) {
        case 'billing_events':
          query = `
            SELECT id, subscription_id, amount, event_type, status, metadata_json, created_at, updated_at
            FROM billing_events 
            WHERE tenant_id = $1 AND created_at < $2
            ORDER BY created_at ASC
            LIMIT 10000
          `;
          break;
          
        case 'subscriptions':
          query = `
            SELECT id, wallet_address, creator_id, subscribed_at, unsubscribed_at, active, 
                   metadata_json, created_at, updated_at
            FROM subscriptions 
            WHERE tenant_id = $1 AND active = 0 AND unsubscribed_at < $2
            ORDER BY unsubscribed_at ASC
            LIMIT 10000
          `;
          break;
          
        default:
          throw new Error(`Unsupported table for archival: ${table}`);
      }

      const result = await client.query(query, params);
      return result.rows;
    } finally {
      client.release();
    }
  }

  /**
   * Archive a batch of records to S3 Glacier
   * @param {string} tenantId - Tenant ID
   * @param {string} table - Table name
   * @param {Array} records - Records to archive
   * @param {Date} cutoffDate - Cutoff date
   * @returns {Promise<object>} Archive result
   */
  async archiveBatch(tenantId, table, records, cutoffDate) {
    const archiveId = `${tenantId}/${table}/${cutoffDate.toISOString().split('T')[0]}/${Date.now()}`;
    const archiveKey = `archives/${archiveId}.json`;

    try {
      // Prepare archive data
      const archiveData = {
        metadata: {
          tenantId,
          table,
          cutoffDate: cutoffDate.toISOString(),
          archiveDate: new Date().toISOString(),
          recordCount: records.length,
          archiveId
        },
        records
      };

      // Upload to S3 Glacier
      const uploadResult = await this.uploadToGlacier(archiveKey, archiveData);

      // Delete archived records from database
      await this.deleteArchivedRecords(tenantId, table, records);

      // Log archival for billing
      await this.logArchiveForBilling(tenantId, {
        archiveId,
        table,
        recordCount: records.length,
        storageClass: 'GLACIER',
        s3Key: archiveKey,
        uploadId: uploadResult.UploadId
      });

      return {
        recordsArchived: records.length,
        archiveInfo: {
          archiveId,
          table,
          recordCount: records.length,
          s3Key: archiveKey,
          uploadId: uploadResult.UploadId
        }
      };
    } catch (error) {
      console.error(`Error archiving batch ${archiveId}:`, error);
      throw error;
    }
  }

  /**
   * Upload data to S3 Glacier
   * @param {string} key - S3 key
   * @param {object} data - Data to upload
   * @returns {Promise<object>} Upload result
   */
  async uploadToGlacier(key, data) {
    const params = {
      Bucket: this.archiveBucket,
      Key: key,
      Body: JSON.stringify(data, null, 2),
      StorageClass: 'GLACIER',
      Metadata: {
        'tenant-id': data.metadata.tenantId,
        'table': data.metadata.table,
        'record-count': data.metadata.recordCount.toString(),
        'archive-date': data.metadata.archiveDate
      }
    };

    return await this.s3.upload(params).promise();
  }

  /**
   * Delete archived records from database
   * @param {string} tenantId - Tenant ID
   * @param {string} table - Table name
   * @param {Array} records - Records to delete
   * @returns {Promise<void>}
   */
  async deleteArchivedRecords(tenantId, table, records) {
    const client = await this.database.pool.connect();
    
    try {
      await client.query('BEGIN');

      const recordIds = records.map(r => r.id);
      
      let query = '';
      switch (table) {
        case 'billing_events':
          query = 'DELETE FROM billing_events WHERE id = ANY($1) AND tenant_id = $2';
          break;
        case 'subscriptions':
          query = 'DELETE FROM subscriptions WHERE id = ANY($1) AND tenant_id = $2';
          break;
        default:
          throw new Error(`Unsupported table for deletion: ${table}`);
      }

      await client.query(query, [recordIds, tenantId]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get tenant retention policy
   * @param {string} tenantId - Tenant ID
   * @returns {Promise<object>} Retention policy
   */
  async getTenantRetentionPolicy(tenantId) {
    try {
      // Get tenant tier and default retention
      const client = await this.database.pool.connect();
      
      try {
        const result = await client.query(
          'SELECT tier FROM creators WHERE id = $1',
          [tenantId]
        );
        
        const tier = result.rows[0]?.tier || 'free';
        
        // Default retention policies by tier (in days)
        const defaultPolicies = {
          free: {
            billing_events: 730, // 2 years
            subscriptions: 730,
            default: 730
          },
          pro: {
            billing_events: 1825, // 5 years
            subscriptions: 1825,
            default: 1825
          },
          enterprise: {
            billing_events: -1, // Unlimited
            subscriptions: -1,
            default: -1
          }
        };

        // Check for custom retention policies
        const customPolicyResult = await client.query(
          'SELECT retention_config FROM tenant_retention_policies WHERE tenant_id = $1',
          [tenantId]
        );

        if (customPolicyResult.rows.length > 0) {
          const customPolicy = JSON.parse(customPolicyResult.rows[0].retention_config);
          return { ...defaultPolicies[tier], ...customPolicy };
        }

        return defaultPolicies[tier];
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Error getting retention policy:', error);
      // Return conservative default
      return { billing_events: 730, subscriptions: 730, default: 730 };
    }
  }

  /**
   * Calculate cutoff date for archival
   * @param {number} retentionDays - Retention period in days
   * @returns {Date} Cutoff date
   */
  calculateCutoffDate(retentionDays) {
    if (retentionDays === -1) {
      // Unlimited retention - use a very old date
      return new Date('1970-01-01');
    }
    
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
    return cutoffDate;
  }

  /**
   * Get active tenants for archival processing
   * @returns {Promise<Array>} Active tenants
   */
  async getActiveTenants() {
    const client = await this.database.pool.connect();
    
    try {
      const result = await client.query(
        'SELECT id, tier FROM creators WHERE tier IS NOT NULL ORDER BY id'
      );
      
      return result.rows;
    } finally {
      client.release();
    }
  }

  /**
   * Log archival results for monitoring
   * @param {object} results - Archival results
   * @returns {Promise<void>}
   */
  async logArchivalResults(results) {
    try {
      const logEntry = {
        type: 'archival_results',
        timestamp: new Date().toISOString(),
        ...results
      };

      // Store in Redis for monitoring
      await this.redisClient.lpush('archival_logs', JSON.stringify(logEntry));
      await this.redisClient.ltrim('archival_logs', 0, 999); // Keep last 1000 logs

      console.log(`Archival process completed: ${results.totalRecordsArchived} records archived, ${results.totalErrors} errors`);
    } catch (error) {
      console.error('Error logging archival results:', error);
    }
  }

  /**
   * Log archive for billing purposes
   * @param {string} tenantId - Tenant ID
   * @param {object} archiveInfo - Archive information
   * @returns {Promise<void>}
   */
  async logArchiveForBilling(tenantId, archiveInfo) {
    const client = await this.database.pool.connect();
    
    try {
      await client.query(`
        INSERT INTO archive_logs (tenant_id, archive_id, table_name, record_count, 
                                storage_class, s3_key, upload_id, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      `, [
        tenantId,
        archiveInfo.archiveId,
        archiveInfo.table,
        archiveInfo.recordCount,
        archiveInfo.storageClass,
        archiveInfo.s3Key,
        archiveInfo.uploadId
      ]);
    } catch (error) {
      console.error('Error logging archive for billing:', error);
    } finally {
      client.release();
    }
  }

  /**
   * Retrieve archived data for tenant
   * @param {string} tenantId - Tenant ID
   * @param {string} archiveId - Archive ID
   * @returns {Promise<object>} Retrieved archive data
   */
  async retrieveArchive(tenantId, archiveId) {
    try {
      const archiveKey = `archives/${archiveId}.json`;
      
      const params = {
        Bucket: this.archiveBucket,
        Key: archiveKey
      };

      // Initiate restore from Glacier (this is async)
      await this.s3.restoreObject({
        ...params,
        RestoreRequest: {
          Days: 1, // Restore for 1 day
          GlacierJobParameters: {
            Tier: 'Expedited' // Fast restore
          }
        }
      }).promise();

      // Log retrieval request
      await this.logRetrievalRequest(tenantId, archiveId);

      return {
        status: 'initiated',
        message: 'Archive retrieval initiated. Data will be available shortly.',
        archiveId,
        tenantId
      };
    } catch (error) {
      console.error('Error retrieving archive:', error);
      throw error;
    }
  }

  /**
   * Log retrieval request for audit
   * @param {string} tenantId - Tenant ID
   * @param {string} archiveId - Archive ID
   * @returns {Promise<void>}
   */
  async logRetrievalRequest(tenantId, archiveId) {
    const client = await this.database.pool.connect();
    
    try {
      await client.query(`
        INSERT INTO archive_retrieval_requests (tenant_id, archive_id, requested_at, status)
        VALUES ($1, $2, NOW(), 'initiated')
      `, [tenantId, archiveId]);
    } catch (error) {
      console.error('Error logging retrieval request:', error);
    } finally {
      client.release();
    }
  }

  /**
   * Get archival statistics for tenant
   * @param {string} tenantId - Tenant ID
   * @returns {Promise<object>} Archival statistics
   */
  async getArchivalStatistics(tenantId) {
    const client = await this.database.pool.connect();
    
    try {
      const [archiveLogsResult, retrievalResult] = await Promise.all([
        client.query(`
          SELECT table_name, COUNT(*) as archive_count, SUM(record_count) as total_records
          FROM archive_logs 
          WHERE tenant_id = $1 
          GROUP BY table_name
        `, [tenantId]),
        
        client.query(`
          SELECT COUNT(*) as retrieval_count,
                 SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_count
          FROM archive_retrieval_requests 
          WHERE tenant_id = $1 AND requested_at >= NOW() - INTERVAL '30 days'
        `, [tenantId])
      ]);

      return {
        tenantId,
        archives: archiveLogsResult.rows,
        retrievals: {
          total: parseInt(retrievalResult.rows[0].retrieval_count),
          completed: parseInt(retrievalResult.rows[0].completed_count)
        }
      };
    } finally {
      client.release();
    }
  }
}

module.exports = ArchivalService;
