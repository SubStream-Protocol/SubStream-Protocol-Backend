const { PriceCacheService } = require('./priceCacheService');
const winston = require('winston');

/**
 * Price Cache Worker
 * Dedicated worker for running the price cache cron job with 5-minute intervals
 */
class PriceCacheWorker {
  constructor(config, dependencies = {}) {
    this.config = config;
    this.logger = dependencies.logger || winston.createLogger({
      level: config.logLevel || 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      ),
      transports: [new winston.transports.Console()]
    });
    
    // Initialize price cache service
    this.priceCacheService = new PriceCacheService(config, {
      logger: this.logger,
      database: dependencies.database
    });
    
    // Worker state
    this.isRunning = false;
    this.shutdownGracefully = false;
    
    // Health check endpoint
    this.healthCheckPort = config.healthCheckPort || 3001;
    this.healthServer = null;
    
    this.logger.info('Price Cache Worker initialized', {
      syncInterval: config.syncIntervalMs || 300000, // 5 minutes
      oracleAddress: config.oracle?.oracleAddress
    });
  }

  /**
   * Start the price cache worker
   */
  async start() {
    try {
      this.logger.info('Starting Price Cache Worker...');
      
      // Initialize price cache service
      await this.priceCacheService.initialize();
      
      // Start health check server
      await this.startHealthServer();
      
      // Set up graceful shutdown handlers
      this.setupGracefulShutdown();
      
      this.isRunning = true;
      this.logger.info('Price Cache Worker started successfully');
      
      // Keep the process alive
      await this.keepAlive();
      
    } catch (error) {
      this.logger.error('Failed to start Price Cache Worker', {
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Stop the price cache worker
   */
  async stop() {
    this.logger.info('Stopping Price Cache Worker...');
    
    this.isRunning = false;
    this.shutdownGracefully = true;
    
    try {
      // Close price cache service
      await this.priceCacheService.close();
      
      // Close health server
      if (this.healthServer) {
        await this.closeHealthServer();
      }
      
      this.logger.info('Price Cache Worker stopped successfully');
    } catch (error) {
      this.logger.error('Error stopping Price Cache Worker', {
        error: error.message
      });
    }
  }

  /**
   * Start health check server
   */
  async startHealthServer() {
    const express = require('express');
    const app = express();
    
    // Health check endpoint
    app.get('/health', async (req, res) => {
      try {
        const health = await this.priceCacheService.getHealthStatus();
        const statusCode = health.healthy ? 200 : 503;
        
        res.status(statusCode).json({
          service: 'price-cache-worker',
          timestamp: new Date().toISOString(),
          ...health
        });
      } catch (error) {
        res.status(503).json({
          service: 'price-cache-worker',
          healthy: false,
          error: error.message,
          timestamp: new Date().toISOString()
        });
      }
    });
    
    // Stats endpoint
    app.get('/stats', async (req, res) => {
      try {
        const stats = await this.priceCacheService.getStats();
        res.json({
          service: 'price-cache-worker',
          timestamp: new Date().toISOString(),
          stats
        });
      } catch (error) {
        res.status(500).json({
          service: 'price-cache-worker',
          error: error.message,
          timestamp: new Date().toISOString()
        });
      }
    });
    
    // Manual sync endpoint (for admin use)
    app.post('/sync', async (req, res) => {
      try {
        this.logger.info('Manual sync triggered via API');
        const result = await this.priceCacheService.performSync();
        
        res.json({
          success: true,
          result,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error.message,
          timestamp: new Date().toISOString()
        });
      }
    });
    
    return new Promise((resolve, reject) => {
      this.healthServer = app.listen(this.healthCheckPort, (err) => {
        if (err) {
          reject(err);
        } else {
          this.logger.info(`Health server started on port ${this.healthCheckPort}`);
          resolve();
        }
      });
    });
  }

  /**
   * Close health server
   */
  async closeHealthServer() {
    return new Promise((resolve) => {
      if (this.healthServer) {
        this.healthServer.close(() => {
          this.logger.info('Health server closed');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Set up graceful shutdown handlers
   */
  setupGracefulShutdown() {
    const shutdown = async (signal) => {
      this.logger.info(`Received ${signal}, shutting down gracefully...`);
      await this.stop();
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGUSR2', () => shutdown('SIGUSR2')); // nodemon restart
  }

  /**
   * Keep the process alive
   */
  async keepAlive() {
    return new Promise((resolve) => {
      // The process stays alive as long as the price cache service is running
      // The service handles the 5-minute sync intervals internally
      const checkInterval = setInterval(() => {
        if (!this.isRunning) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 1000);
    });
  }

  /**
   * Get worker statistics
   */
  async getStats() {
    return await this.priceCacheService.getStats();
  }

  /**
   * Get health status
   */
  async getHealthStatus() {
    return await this.priceCacheService.getHealthStatus();
  }
}

// CLI entry point
if (require.main === module) {
  const { loadConfig } = require('../config');
  
  async function main() {
    const config = loadConfig();
    
    // Override config for price cache worker
    const workerConfig = {
      ...config,
      syncIntervalMs: config.priceCache?.syncIntervalMs || 5 * 60 * 1000,
      healthCheckPort: config.priceCache?.healthCheckPort || 3001,
      logLevel: process.env.LOG_LEVEL || 'info'
    };
    
    const worker = new PriceCacheWorker(workerConfig);
    
    try {
      await worker.start();
    } catch (error) {
      console.error('Price Cache Worker failed to start:', error.message);
      process.exit(1);
    }
  }
  
  main().catch(console.error);
}

module.exports = { PriceCacheWorker };
