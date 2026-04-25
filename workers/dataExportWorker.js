const Queue = require('bull');
const dataExportService = require('../src/services/dataExportService');

/**
 * Data Export Worker
 * 
 * Background worker that processes data export requests using BullMQ.
 * Handles large dataset exports with proper streaming and error handling.
 */
class DataExportWorker {
  constructor() {
    this.exportQueue = new Queue('data export processing', {
      redis: {
        host: process.env.REDIS_HOST || 'localhost',
        port: process.env.REDIS_PORT || 6379,
        password: process.env.REDIS_PASSWORD || undefined,
        db: process.env.REDIS_DB || 0,
      }
    });

    this.isProcessing = false;
    this.concurrency = 2; // Process 2 exports concurrently
  }

  /**
   * Start the worker
   */
  async start() {
    try {
      // Initialize the data export service
      dataExportService.initialize();
      
      // Start processing jobs
      this.exportQueue.process(this.concurrency, async (job) => {
        return await this.processExportJob(job);
      });

      // Handle job events
      this.exportQueue.on('completed', (job, result) => {
        console.log(`Export job ${job.id} completed successfully:`, result);
      });

      this.exportQueue.on('failed', (job, err) => {
        console.error(`Export job ${job.id} failed:`, err);
      });

      this.exportQueue.on('stalled', (job) => {
        console.warn(`Export job ${job.id} stalled, will be retried`);
      });

      // Set up cleanup interval
      setInterval(() => {
        this.cleanupExpiredExports();
      }, 60 * 60 * 1000); // Run cleanup every hour

      this.isProcessing = true;
      console.log('Data export worker started successfully');
    } catch (error) {
      console.error('Error starting data export worker:', error);
      throw error;
    }
  }

  /**
   * Process a single export job
   */
  async processExportJob(job) {
    const { exportId, tenantId, format, requesterEmail } = job.data;
    
    try {
      console.log(`Processing export job ${job.id} for tenant ${tenantId}`);
      
      // Update job progress
      job.progress(10);
      
      // Process the export
      const result = await dataExportService.processExport(job);
      
      // Update job progress
      job.progress(100);
      
      return result;
    } catch (error) {
      console.error(`Error processing export job ${job.id}:`, error);
      
      // Log detailed error information
      const errorDetails = {
        exportId,
        tenantId,
        error: error.message,
        stack: error.stack,
        timestamp: new Date().toISOString()
      };
      
      console.error('Export job error details:', errorDetails);
      
      throw error;
    }
  }

  /**
   * Add a new export job to the queue
   */
  async addExportJob(exportData) {
    try {
      const job = await this.exportQueue.add('process-export', exportData, {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000
        },
        removeOnComplete: 50, // Keep last 50 completed jobs
        removeOnFail: 10,    // Keep last 10 failed jobs
        delay: 0,            // Start immediately
        priority: exportData.priority || 0
      });

      console.log(`Export job added to queue: ${job.id}`);
      return job;
    } catch (error) {
      console.error('Error adding export job to queue:', error);
      throw error;
    }
  }

  /**
   * Get queue statistics
   */
  async getQueueStats() {
    try {
      const waiting = await this.exportQueue.getWaiting();
      const active = await this.exportQueue.getActive();
      const completed = await this.exportQueue.getCompleted();
      const failed = await this.exportQueue.getFailed();
      const delayed = await this.exportQueue.getDelayed();

      return {
        waiting: waiting.length,
        active: active.length,
        completed: completed.length,
        failed: failed.length,
        delayed: delayed.length,
        total: waiting.length + active.length + completed.length + failed.length + delayed.length
      };
    } catch (error) {
      console.error('Error getting queue stats:', error);
      return null;
    }
  }

  /**
   * Pause the queue
   */
  async pause() {
    try {
      await this.exportQueue.pause();
      this.isProcessing = false;
      console.log('Data export queue paused');
    } catch (error) {
      console.error('Error pausing export queue:', error);
      throw error;
    }
  }

  /**
   * Resume the queue
   */
  async resume() {
    try {
      await this.exportQueue.resume();
      this.isProcessing = true;
      console.log('Data export queue resumed');
    } catch (error) {
      console.error('Error resuming export queue:', error);
      throw error;
    }
  }

  /**
   * Clean up expired exports
   */
  async cleanupExpiredExports() {
    try {
      console.log('Starting cleanup of expired exports...');
      await dataExportService.cleanupExpiredExports();
      console.log('Expired exports cleanup completed');
    } catch (error) {
      console.error('Error during expired exports cleanup:', error);
    }
  }

  /**
   * Graceful shutdown
   */
  async shutdown() {
    try {
      console.log('Shutting down data export worker...');
      
      // Pause the queue first
      await this.pause();
      
      // Wait for active jobs to complete (with timeout)
      const activeJobs = await this.exportQueue.getActive();
      if (activeJobs.length > 0) {
        console.log(`Waiting for ${activeJobs.length} active jobs to complete...`);
        
        // Wait up to 5 minutes for jobs to complete
        const timeout = 5 * 60 * 1000;
        const startTime = Date.now();
        
        while (activeJobs.length > 0 && (Date.now() - startTime) < timeout) {
          await new Promise(resolve => setTimeout(resolve, 5000));
          const currentActive = await this.exportQueue.getActive();
          if (currentActive.length !== activeJobs.length) {
            console.log(`${activeJobs.length - currentActive.length} jobs completed, ${currentActive.length} remaining`);
            activeJobs.length = 0;
            activeJobs.push(...currentActive);
          }
        }
        
        if (activeJobs.length > 0) {
          console.warn(`Timeout reached, ${activeJobs.length} jobs may not have completed`);
        }
      }
      
      // Close the queue
      await this.exportQueue.close();
      
      console.log('Data export worker shutdown completed');
    } catch (error) {
      console.error('Error during worker shutdown:', error);
      throw error;
    }
  }

  /**
   * Health check
   */
  async healthCheck() {
    try {
      const stats = await this.getQueueStats();
      const redisConnected = this.exportQueue.client.status === 'ready';
      
      return {
        status: this.isProcessing ? 'healthy' : 'paused',
        queue_stats: stats,
        redis_connected: redisConnected,
        worker_pid: process.pid,
        uptime: process.uptime(),
        memory_usage: process.memoryUsage(),
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('Error during health check:', error);
      return {
        status: 'unhealthy',
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }
}

// Create and export singleton instance
const dataExportWorker = new DataExportWorker();

// Handle process signals for graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, shutting down data export worker...');
  try {
    await dataExportWorker.shutdown();
    process.exit(0);
  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
});

process.on('SIGINT', async () => {
  console.log('Received SIGINT, shutting down data export worker...');
  try {
    await dataExportWorker.shutdown();
    process.exit(0);
  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception in data export worker:', error);
  dataExportWorker.shutdown().then(() => {
    process.exit(1);
  });
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection in data export worker:', reason);
});

module.exports = dataExportWorker;
