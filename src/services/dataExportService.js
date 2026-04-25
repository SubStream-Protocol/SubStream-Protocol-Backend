const AWS = require('aws-sdk');
const archiver = require('archiver');
const csv = require('csv-writer');
const { v4: uuidv4 } = require('uuid');
const { getDatabase } = require('../db/appDatabase');

/**
 * Data Export Service
 * 
 * Handles automated data export and portability for GDPR compliance.
 * Processes tenant data in background jobs and generates secure S3 URLs.
 */
class DataExportService {
  constructor() {
    this.s3 = null;
    this.exportTimeout = 30 * 60 * 1000; // 30 minutes max per export
    this.maxFileSize = 100 * 1024 * 1024; // 100MB max per file
    this.rateLimitPeriod = 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds
  }

  /**
   * Initialize AWS S3 client
   */
  initialize() {
    const config = require('../config').loadConfig();
    
    if (config.s3) {
      this.s3 = new AWS.S3({
        accessKeyId: config.s3.credentials.accessKeyId,
        secretAccessKey: config.s3.credentials.secretAccessKey,
        region: config.s3.region,
      });
    } else {
      throw new Error('S3 configuration is required for data export functionality');
    }
  }

  /**
   * Request a data export for a tenant
   * @param {string} tenantId - Tenant UUID
   * @param {string} requesterEmail - Email of the person requesting the export
   * @param {string} format - Export format (json or csv)
   * @returns {Promise<Object>} Export request details
   */
  async requestExport(tenantId, requesterEmail, format = 'json') {
    const db = getDatabase();
    
    try {
      // Check rate limits
      await this.checkRateLimit(tenantId);
      
      // Validate format
      if (!['json', 'csv'].includes(format)) {
        throw new Error('Invalid export format. Must be json or csv');
      }

      // Create export request record
      const [exportRequest] = await db('data_export_requests')
        .insert({
          tenant_id: tenantId,
          requester_email: requesterEmail,
          export_format: format,
          status: 'pending',
          export_metadata: JSON.stringify({
            requested_format: format,
            estimated_records: await this.estimateRecordCount(tenantId)
          })
        })
        .returning('*');

      // Queue background job (using Bull queue)
      const Queue = require('bull');
      const exportQueue = new Queue('data export processing');
      
      exportQueue.add('process-export', {
        exportId: exportRequest.id,
        tenantId: tenantId,
        format: format,
        requesterEmail: requesterEmail
      }, {
        attempts: 3,
        backoff: 'exponential',
        timeout: this.exportTimeout
      });

      return {
        success: true,
        export_id: exportRequest.id,
        status: 'pending',
        estimated_completion: new Date(Date.now() + this.exportTimeout).toISOString()
      };
    } catch (error) {
      console.error('Error requesting export:', error);
      throw error;
    }
  }

  /**
   * Process data export in background job
   * @param {Object} job - Bull job object
   */
  async processExport(job) {
    const { exportId, tenantId, format, requesterEmail } = job.data;
    const db = getDatabase();
    
    try {
      // Update status to processing
      await db('data_export_requests')
        .where('id', exportId)
        .update({
          status: 'processing',
          started_at: new Date()
        });

      // Generate export data
      const exportData = await this.generateExportData(tenantId, format);
      
      // Create encrypted ZIP archive
      const archiveBuffer = await this.createEncryptedArchive(exportData, tenantId);
      
      // Upload to S3 with signed URL
      const s3Url = await this.uploadToS3(archiveBuffer, exportId, tenantId);
      
      // Update request with completion details
      await db('data_export_requests')
        .where('id', exportId)
        .update({
          status: 'completed',
          s3_url: s3Url.url,
          s3_url_expires_at: s3Url.expiresAt,
          completed_at: new Date(),
          export_metadata: JSON.stringify({
            ...JSON.parse(exportData.metadata || '{}'),
            file_size_bytes: archiveBuffer.length,
            s3_key: s3Url.key,
            completed_at: new Date().toISOString()
          })
        });

      // Send notification email
      await this.sendExportNotificationEmail(requesterEmail, s3Url.url, s3Url.expiresAt);
      
      // Update rate limit
      await this.updateRateLimit(tenantId);
      
      job.progress(100);
      return { success: true, s3Url: s3Url.url };
    } catch (error) {
      console.error('Error processing export:', error);
      
      // Update request with error
      await db('data_export_requests')
        .where('id', exportId)
        .update({
          status: 'failed',
          error_message: error.message,
          completed_at: new Date()
        });
      
      throw error;
    }
  }

  /**
   * Generate all export data for a tenant
   * @param {string} tenantId - Tenant UUID
   * @param {string} format - Export format
   * @returns {Promise<Object>} Export data with metadata
   */
  async generateExportData(tenantId, format) {
    const exportData = {
      metadata: {
        tenant_id: tenantId,
        export_date: new Date().toISOString(),
        format: format,
        version: '1.0'
      },
      files: {}
    };

    // Export tenant information
    exportData.files.tenant_info = await this.exportTenantInfo(tenantId, format);
    
    // Export users
    exportData.files.users = await this.exportUsers(tenantId, format);
    
    // Export subscription plans
    exportData.files.subscription_plans = await this.exportSubscriptionPlans(tenantId, format);
    
    // Export billing history
    exportData.files.billing_history = await this.exportBillingHistory(tenantId, format);
    
    // Export webhook logs
    exportData.files.webhook_logs = await this.exportWebhookLogs(tenantId, format);
    
    // Export analytics data
    exportData.files.analytics = await this.exportAnalytics(tenantId, format);

    // Update metadata with record counts
    exportData.metadata.record_counts = {
      tenant_info: exportData.files.tenant_info.length,
      users: exportData.files.users.length,
      subscription_plans: exportData.files.subscription_plans.length,
      billing_history: exportData.files.billing_history.length,
      webhook_logs: exportData.files.webhook_logs.length,
      analytics: exportData.files.analytics.length,
      total: Object.values(exportData.files).reduce((sum, file) => sum + file.length, 0)
    };

    return exportData;
  }

  /**
   * Export tenant information
   */
  async exportTenantInfo(tenantId, format) {
    const db = getDatabase();
    
    const tenantData = await db('tenants')
      .select('id', 'name', 'email', 'created_at', 'updated_at')
      .where('id', tenantId)
      .first();

    return format === 'json' ? [tenantData] : this.convertToCSV([tenantData], 'tenant_info');
  }

  /**
   * Export users for a tenant
   */
  async exportUsers(tenantId, format) {
    const db = getDatabase();
    
    const users = await db('users')
      .select('id', 'email', 'first_name', 'last_name', 'created_at', 'updated_at')
      .where('tenant_id', tenantId);

    return format === 'json' ? users : this.convertToCSV(users, 'users');
  }

  /**
   * Export subscription plans for a tenant
   */
  async exportSubscriptionPlans(tenantId, format) {
    const db = getDatabase();
    
    const plans = await db('subscription_plans')
      .select('id', 'name', 'price', 'currency', 'interval', 'features', 'created_at', 'updated_at')
      .where('tenant_id', tenantId);

    return format === 'json' ? plans : this.convertToCSV(plans, 'subscription_plans');
  }

  /**
   * Export billing history for a tenant
   */
  async exportBillingHistory(tenantId, format) {
    const db = getDatabase();
    
    const billing = await db('billing_history')
      .select('id', 'amount', 'currency', 'status', 'payment_method', 'created_at', 'updated_at')
      .where('tenant_id', tenantId);

    return format === 'json' ? billing : this.convertToCSV(billing, 'billing_history');
  }

  /**
   * Export webhook logs for a tenant
   */
  async exportWebhookLogs(tenantId, format) {
    const db = getDatabase();
    
    const logs = await db('webhook_logs')
      .select('id', 'event_type', 'url', 'status_code', 'response_body', 'created_at')
      .where('tenant_id', tenantId)
      .orderBy('created_at', 'desc')
      .limit(10000); // Limit to prevent huge exports

    return format === 'json' ? logs : this.convertToCSV(logs, 'webhook_logs');
  }

  /**
   * Export analytics data for a tenant
   */
  async exportAnalytics(tenantId, format) {
    const db = getDatabase();
    
    const analytics = await db('analytics')
      .select('id', 'event_type', 'event_data', 'user_id', 'created_at')
      .where('tenant_id', tenantId)
      .orderBy('created_at', 'desc')
      .limit(10000); // Limit to prevent huge exports

    return format === 'json' ? analytics : this.convertToCSV(analytics, 'analytics');
  }

  /**
   * Convert data to CSV format
   */
  convertToCSV(data, filename) {
    if (data.length === 0) {
      return `# No data found for ${filename}\n`;
    }

    const headers = Object.keys(data[0]);
    const csvRows = [headers.join(',')];

    for (const row of data) {
      const values = headers.map(header => {
        const value = row[header];
        // Handle nested objects and arrays
        if (typeof value === 'object' && value !== null) {
          return `"${JSON.stringify(value).replace(/"/g, '""')}"`;
        }
        // Handle strings with commas or quotes
        if (typeof value === 'string' && (value.includes(',') || value.includes('"'))) {
          return `"${value.replace(/"/g, '""')}"`;
        }
        return value || '';
      });
      csvRows.push(values.join(','));
    }

    return csvRows.join('\n');
  }

  /**
   * Create encrypted ZIP archive
   */
  async createEncryptedArchive(exportData, tenantId) {
    return new Promise((resolve, reject) => {
      const archive = archiver('zip', {
        zlib: { level: 9 }
      });

      const buffers = [];
      
      archive.on('data', (chunk) => {
        buffers.push(chunk);
      });

      archive.on('end', () => {
        resolve(Buffer.concat(buffers));
      });

      archive.on('error', (error) => {
        reject(error);
      });

      // Add files to archive
      if (exportData.format === 'json') {
        archive.append(JSON.stringify(exportData, null, 2), { name: 'export_data.json' });
      } else {
        // Add CSV files
        Object.entries(exportData.files).forEach(([filename, content]) => {
          archive.append(content, { name: `${filename}.csv` });
        });
        
        // Add metadata
        archive.append(JSON.stringify(exportData.metadata, null, 2), { name: 'metadata.json' });
      }

      archive.finalize();
    });
  }

  /**
   * Upload archive to S3 and generate signed URL
   */
  async uploadToS3(buffer, exportId, tenantId) {
    const config = require('../config').loadConfig();
    const key = `exports/${tenantId}/${exportId}/data_export.zip`;
    
    try {
      // Upload to S3
      await this.s3.upload({
        Bucket: config.s3.bucket,
        Key: key,
        Body: buffer,
        ContentType: 'application/zip',
        ServerSideEncryption: 'AES256'
      }).promise();

      // Generate signed URL (expires in 24 hours)
      const expiresAt = new Date(Date.now() + (24 * 60 * 60 * 1000));
      const signedUrl = this.s3.getSignedUrl('getObject', {
        Bucket: config.s3.bucket,
        Key: key,
        Expires: 24 * 60 * 60 // 24 hours
      });

      return {
        url: signedUrl,
        expiresAt: expiresAt,
        key: key
      };
    } catch (error) {
      console.error('Error uploading to S3:', error);
      throw error;
    }
  }

  /**
   * Send export notification email
   */
  async sendExportNotificationEmail(email, downloadUrl, expiresAt) {
    // This would integrate with your existing email service
    console.log(`Export notification sent to ${email}:`);
    console.log(`Download URL: ${downloadUrl}`);
    console.log(`Expires at: ${expiresAt}`);
    
    // Implementation would depend on your email service setup
    // Could use the existing emailProviders service
  }

  /**
   * Check rate limits for export requests
   */
  async checkRateLimit(tenantId) {
    const db = getDatabase();
    
    const rateLimit = await db('data_export_rate_limits')
      .where('tenant_id', tenantId)
      .first();

    if (rateLimit) {
      const periodStart = new Date(rateLimit.period_start);
      const now = new Date();
      const timeSinceStart = now - periodStart;
      
      // If we're still within the 7-day period
      if (timeSinceStart < this.rateLimitPeriod) {
        if (rateLimit.export_count >= 1) {
          const nextAvailable = new Date(periodStart.getTime() + this.rateLimitPeriod);
          throw new Error(`Rate limit exceeded. Next export available on ${nextAvailable.toISOString()}`);
        }
      } else {
        // Reset the period
        await db('data_export_rate_limits')
          .where('tenant_id', tenantId)
          .update({
            export_count: 1,
            period_start: new Date(),
            last_export_at: new Date()
          });
      }
    } else {
      // Create new rate limit record
      await db('data_export_rate_limits').insert({
        tenant_id: tenantId,
        export_count: 1,
        period_start: new Date(),
        last_export_at: new Date()
      });
    }
  }

  /**
   * Update rate limit after successful export
   */
  async updateRateLimit(tenantId) {
    const db = getDatabase();
    
    await db('data_export_rate_limits')
      .where('tenant_id', tenantId)
      .increment('export_count', 1)
      .update({
        last_export_at: new Date()
      });
  }

  /**
   * Estimate total record count for export
   */
  async estimateRecordCount(tenantId) {
    const db = getDatabase();
    
    const counts = await Promise.all([
      db('users').where('tenant_id', tenantId).count('* as count').first(),
      db('subscription_plans').where('tenant_id', tenantId).count('* as count').first(),
      db('billing_history').where('tenant_id', tenantId).count('* as count').first(),
      db('webhook_logs').where('tenant_id', tenantId).count('* as count').first(),
      db('analytics').where('tenant_id', tenantId).count('* as count').first()
    ]);

    return counts.reduce((sum, result) => sum + parseInt(result.count), 0) + 1; // +1 for tenant info
  }

  /**
   * Get export status
   */
  async getExportStatus(exportId, tenantId) {
    const db = getDatabase();
    
    const exportRequest = await db('data_export_requests')
      .where({
        id: exportId,
        tenant_id: tenantId
      })
      .first();

    if (!exportRequest) {
      throw new Error('Export request not found');
    }

    // Check if URL has expired
    if (exportRequest.s3_url_expires_at && new Date() > new Date(exportRequest.s3_url_expires_at)) {
      await db('data_export_requests')
        .where('id', exportId)
        .update({ status: 'expired' });
      
      exportRequest.status = 'expired';
    }

    return exportRequest;
  }

  /**
   * Clean up expired exports
   */
  async cleanupExpiredExports() {
    const db = getDatabase();
    const config = require('../config').loadConfig();
    
    try {
      // Find expired exports
      const expiredExports = await db('data_export_requests')
        .select('id', 's3_url')
        .where('status', 'expired')
        .orWhere('s3_url_expires_at', '<', new Date());

      // Delete from S3
      for (const exportRequest of expiredExports) {
        if (exportRequest.s3_url) {
          const url = new URL(exportRequest.s3_url);
          const key = url.pathname.substring(1); // Remove leading slash
          
          try {
            await this.s3.deleteObject({
              Bucket: config.s3.bucket,
              Key: key
            }).promise();
          } catch (error) {
            console.error('Error deleting expired export from S3:', error);
          }
        }
      }

      // Update database records
      await db('data_export_requests')
        .whereIn('id', expiredExports.map(e => e.id))
        .update({ status: 'cleaned_up' });

      console.log(`Cleaned up ${expiredExports.length} expired exports`);
    } catch (error) {
      console.error('Error during cleanup:', error);
    }
  }
}

// Singleton instance
const dataExportService = new DataExportService();

module.exports = dataExportService;
