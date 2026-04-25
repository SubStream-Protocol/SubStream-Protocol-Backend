const Redis = require('redis');
const { getDatabase } = require('../db/appDatabase');

/**
 * WebSocket Rate Limiting Service
 * 
 * Implements Redis-backed token bucket rate limiting for WebSocket connections.
 * Protects against DoS attacks and resource starvation with per-IP and per-tenant limits.
 */
class WebSocketRateLimitService {
  constructor() {
    this.redis = null;
    this.config = {
      maxConnectionsPerIP: 5,
      maxConnectionsPerTenant: 10,
      maxMessagesPerSecond: 10,
      tokenBucketCapacity: 20,
      tokenBucketRefillRate: 10,
      auditLogRetention: 7 * 24 * 60 * 60, // 7 days in seconds
      cleanupInterval: 60 * 1000 // 1 minute
    };
    this.cleanupTimer = null;
  }

  /**
   * Initialize Redis connection and start cleanup timer
   */
  async initialize() {
    const appConfig = require('../config').loadConfig();
    
    this.redis = Redis.createClient({
      host: appConfig.redis.host,
      port: appConfig.redis.port,
      password: appConfig.redis.password || undefined,
      db: appConfig.redis.db,
    });

    await this.redis.connect();
    
    // Override config with environment variables if provided
    this.config.maxConnectionsPerIP = parseInt(process.env.WS_MAX_CONNECTIONS_PER_IP) || this.config.maxConnectionsPerIP;
    this.config.maxConnectionsPerTenant = parseInt(process.env.WS_MAX_CONNECTIONS_PER_TENANT) || this.config.maxConnectionsPerTenant;
    this.config.maxMessagesPerSecond = parseInt(process.env.WS_MAX_MESSAGES_PER_SECOND) || this.config.maxMessagesPerSecond;
    
    // Start cleanup timer
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredEntries();
    }, this.config.cleanupInterval);
    
    console.log('WebSocket rate limiting service initialized with config:', this.config);
  }

  /**
   * Check if a new WebSocket connection is allowed
   * @param {string} clientIP - Client IP address
   * @param {string} tenantId - Tenant UUID (if authenticated)
   * @param {string} socketId - Socket identifier
   * @returns {Promise<Object>} Connection decision with reason
   */
  async checkConnectionLimit(clientIP, tenantId = null, socketId) {
    try {
      // Check IP-based connection limit
      const ipKey = `ws:connections:ip:${clientIP}`;
      const ipConnectionCount = await this.redis.sCard(ipKey);
      
      if (ipConnectionCount >= this.config.maxConnectionsPerIP) {
        await this.logRateLimitEvent('IP_CONNECTION_LIMIT', clientIP, tenantId, {
          current_connections: ipConnectionCount,
          limit: this.config.maxConnectionsPerIP,
          socket_id: socketId
        });
        
        return {
          allowed: false,
          reason: 'IP_CONNECTION_LIMIT_EXCEEDED',
          details: {
            current: ipConnectionCount,
            limit: this.config.maxConnectionsPerIP,
            retry_after: this.calculateRetryAfter(ipKey)
          }
        };
      }

      // Check tenant-based connection limit (if authenticated)
      if (tenantId) {
        const tenantKey = `ws:connections:tenant:${tenantId}`;
        const tenantConnectionCount = await this.redis.sCard(tenantKey);
        
        if (tenantConnectionCount >= this.config.maxConnectionsPerTenant) {
          await this.logRateLimitEvent('TENANT_CONNECTION_LIMIT', clientIP, tenantId, {
            current_connections: tenantConnectionCount,
            limit: this.config.maxConnectionsPerTenant,
            socket_id: socketId
          });
          
          return {
            allowed: false,
            reason: 'TENANT_CONNECTION_LIMIT_EXCEEDED',
            details: {
              current: tenantConnectionCount,
              limit: this.config.maxConnectionsPerTenant,
              retry_after: this.calculateRetryAfter(tenantKey)
            }
          };
        }
      }

      return {
        allowed: true,
        reason: 'CONNECTION_ALLOWED'
      };
    } catch (error) {
      console.error('Error checking connection limit:', error);
      // Fail safe - allow connection but log error
      return {
        allowed: true,
        reason: 'ERROR_FALLBACK_ALLOWED'
      };
    }
  }

  /**
   * Register a new WebSocket connection
   * @param {string} clientIP - Client IP address
   * @param {string} tenantId - Tenant UUID (if authenticated)
   * @param {string} socketId - Socket identifier
   * @param {Object} metadata - Additional connection metadata
   */
  async registerConnection(clientIP, tenantId = null, socketId, metadata = {}) {
    try {
      const now = Date.now();
      const connectionData = JSON.stringify({
        socket_id: socketId,
        client_ip: clientIP,
        tenant_id: tenantId,
        connected_at: now,
        metadata: metadata
      });

      // Add to IP connection set
      const ipKey = `ws:connections:ip:${clientIP}`;
      await this.redis.sAdd(ipKey, socketId);
      await this.redis.expire(ipKey, 24 * 60 * 60); // 24 hour TTL

      // Add to tenant connection set (if authenticated)
      if (tenantId) {
        const tenantKey = `ws:connections:tenant:${tenantId}`;
        await this.redis.sAdd(tenantKey, socketId);
        await this.redis.expire(tenantKey, 24 * 60 * 60); // 24 hour TTL
      }

      // Store connection details
      const connectionKey = `ws:connection:${socketId}`;
      await this.redis.hSet(connectionKey, {
        ip: clientIP,
        tenant_id: tenantId || '',
        connected_at: now.toString(),
        metadata: JSON.stringify(metadata)
      });
      await this.redis.expire(connectionKey, 24 * 60 * 60); // 24 hour TTL

      // Initialize message rate limiter for this connection
      await this.initializeMessageRateLimiter(socketId);

      console.log(`WebSocket connection registered: ${socketId} from ${clientIP}${tenantId ? ` (tenant: ${tenantId})` : ''}`);
    } catch (error) {
      console.error('Error registering WebSocket connection:', error);
    }
  }

  /**
   * Unregister a WebSocket connection
   * @param {string} socketId - Socket identifier
   */
  async unregisterConnection(socketId) {
    try {
      // Get connection details
      const connectionKey = `ws:connection:${socketId}`;
      const connectionData = await this.redis.hGetAll(connectionKey);
      
      if (connectionData.ip) {
        // Remove from IP connection set
        const ipKey = `ws:connections:ip:${connectionData.ip}`;
        await this.redis.sRem(ipKey, socketId);
      }

      if (connectionData.tenant_id) {
        // Remove from tenant connection set
        const tenantKey = `ws:connections:tenant:${connectionData.tenant_id}`;
        await this.redis.sRem(tenantKey, socketId);
      }

      // Remove connection details
      await this.redis.del(connectionKey);

      // Remove message rate limiter
      const rateLimitKey = `ws:messages:${socketId}`;
      await this.redis.del(rateLimitKey);

      console.log(`WebSocket connection unregistered: ${socketId}`);
    } catch (error) {
      console.error('Error unregistering WebSocket connection:', error);
    }
  }

  /**
   * Check if a message is allowed based on rate limiting
   * @param {string} socketId - Socket identifier
   * @returns {Promise<Object>} Message decision with reason
   */
  async checkMessageRateLimit(socketId) {
    try {
      const rateLimitKey = `ws:messages:${socketId}`;
      const now = Date.now();
      const bucketKey = `${rateLimitKey}:bucket`;
      const lastRefillKey = `${rateLimitKey}:last_refill`;

      // Get current token count and last refill time
      const [tokens, lastRefill] = await Promise.all([
        this.redis.get(bucketKey),
        this.redis.get(lastRefillKey)
      ]);

      const currentTokens = parseInt(tokens) || this.config.tokenBucketCapacity;
      const lastRefillTime = parseInt(lastRefill) || now;

      // Calculate tokens to add based on elapsed time
      const timeDiff = now - lastRefillTime;
      const tokensToAdd = Math.floor((timeDiff / 1000) * this.config.tokenBucketRefillRate);
      const newTokens = Math.min(
        this.config.tokenBucketCapacity,
        currentTokens + tokensToAdd
      );

      // Check if we have tokens available
      if (newTokens < 1) {
        // Get connection details for logging
        const connectionKey = `ws:connection:${socketId}`;
        const connectionData = await this.redis.hGetAll(connectionKey);
        
        await this.logRateLimitEvent('MESSAGE_RATE_LIMIT', connectionData.ip, connectionData.tenant_id, {
          socket_id: socketId,
          current_tokens: newTokens,
          limit: this.config.maxMessagesPerSecond,
          retry_after: Math.ceil((1 - newTokens) / this.config.tokenBucketRefillRate)
        });

        return {
          allowed: false,
          reason: 'MESSAGE_RATE_LIMIT_EXCEEDED',
          details: {
            current_tokens: newTokens,
            limit: this.config.maxMessagesPerSecond,
            retry_after: Math.ceil((1 - newTokens) / this.config.tokenBucketRefillRate)
          }
        };
      }

      // Consume one token and update bucket
      const updatedTokens = newTokens - 1;
      await Promise.all([
        this.redis.set(bucketKey, updatedTokens),
        this.redis.set(lastRefillKey, now),
        this.redis.expire(bucketKey, 60), // 1 minute TTL
        this.redis.expire(lastRefillKey, 60)
      ]);

      return {
        allowed: true,
        reason: 'MESSAGE_ALLOWED',
        details: {
          remaining_tokens: updatedTokens
        }
      };
    } catch (error) {
      console.error('Error checking message rate limit:', error);
      // Fail safe - allow message but log error
      return {
        allowed: true,
        reason: 'ERROR_FALLBACK_ALLOWED'
      };
    }
  }

  /**
   * Initialize message rate limiter for a new connection
   * @param {string} socketId - Socket identifier
   */
  async initializeMessageRateLimiter(socketId) {
    try {
      const rateLimitKey = `ws:messages:${socketId}`;
      const bucketKey = `${rateLimitKey}:bucket`;
      const lastRefillKey = `${rateLimitKey}:last_refill`;
      const now = Date.now();

      await Promise.all([
        this.redis.set(bucketKey, this.config.tokenBucketCapacity),
        this.redis.set(lastRefillKey, now),
        this.redis.expire(bucketKey, 60), // 1 minute TTL
        this.redis.expire(lastRefillKey, 60)
      ]);
    } catch (error) {
      console.error('Error initializing message rate limiter:', error);
    }
  }

  /**
   * Get current connection statistics
   * @returns {Promise<Object>} Connection statistics
   */
  async getConnectionStats() {
    try {
      const db = getDatabase();
      
      // Get total active connections from Redis
      const connectionPattern = 'ws:connection:*';
      const connectionKeys = await this.redis.keys(connectionPattern);
      const totalConnections = connectionKeys.length;

      // Get unique IPs
      const ipPattern = 'ws:connections:ip:*';
      const ipKeys = await this.redis.keys(ipPattern);
      const uniqueIPs = ipKeys.length;

      // Get unique tenants
      const tenantPattern = 'ws:connections:tenant:*';
      const tenantKeys = await this.redis.keys(tenantPattern);
      const uniqueTenants = tenantKeys.length;

      // Get recent rate limit events from database
      const recentEvents = await db('websocket_rate_limit_log')
        .count('* as count')
        .where('created_at', '>', new Date(Date.now() - 60 * 60 * 1000)) // Last hour
        .first();

      return {
        total_connections: totalConnections,
        unique_ips: uniqueIPs,
        unique_tenants: uniqueTenants,
        recent_rate_limit_events: parseInt(recentEvents.count),
        config: this.config,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('Error getting connection stats:', error);
      return null;
    }
  }

  /**
   * Log rate limit events to database for security auditing
   * @param {string} eventType - Type of rate limit event
   * @param {string} clientIP - Client IP address
   * @param {string} tenantId - Tenant UUID
   * @param {Object} details - Event details
   */
  async logRateLimitEvent(eventType, clientIP, tenantId, details) {
    try {
      const db = getDatabase();
      
      await db('websocket_rate_limit_log').insert({
        event_type: eventType,
        client_ip: clientIP,
        tenant_id: tenantId,
        details: JSON.stringify(details),
        created_at: new Date()
      });

      // Also log to console for immediate visibility
      console.warn(`WebSocket rate limit: ${eventType} from ${clientIP}${tenantId ? ` (tenant: ${tenantId})` : ''}`, details);
    } catch (error) {
      console.error('Error logging rate limit event:', error);
    }
  }

  /**
   * Calculate retry after time for rate-limited requests
   * @param {string} key - Redis key for the rate limit
   * @returns {number} Retry after time in seconds
   */
  calculateRetryAfter(key) {
    // For connection limits, we'll use a fixed retry time
    // In a more sophisticated implementation, this could be based on TTL
    return 60; // 1 minute
  }

  /**
   * Clean up expired entries
   */
  async cleanupExpiredEntries() {
    try {
      // Redis TTL handles most cleanup automatically
      // This method can be used for additional cleanup if needed
      const now = Date.now();
      const cutoffTime = now - (24 * 60 * 60 * 1000); // 24 hours ago

      // Clean up old audit logs from database
      const db = getDatabase();
      await db('websocket_rate_limit_log')
        .where('created_at', '<', new Date(cutoffTime))
        .del();
    } catch (error) {
      console.error('Error during cleanup:', error);
    }
  }

  /**
   * Get rate limit configuration for a specific tenant (for custom limits)
   * @param {string} tenantId - Tenant UUID
   * @returns {Promise<Object>} Tenant-specific rate limit config
   */
  async getTenantRateLimitConfig(tenantId) {
    try {
      const db = getDatabase();
      
      const config = await db('tenant_rate_limits')
        .where('tenant_id', tenantId)
        .first();

      if (config) {
        return {
          maxConnectionsPerIP: config.max_connections_per_ip || this.config.maxConnectionsPerIP,
          maxConnectionsPerTenant: config.max_connections_per_tenant || this.config.maxConnectionsPerTenant,
          maxMessagesPerSecond: config.max_messages_per_second || this.config.maxMessagesPerSecond,
          custom: true
        };
      }

      return this.config;
    } catch (error) {
      console.error('Error getting tenant rate limit config:', error);
      return this.config;
    }
  }

  /**
   * Graceful shutdown
   */
  async shutdown() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    
    if (this.redis) {
      await this.redis.quit();
    }
    
    console.log('WebSocket rate limiting service shutdown completed');
  }
}

// Singleton instance
const websocketRateLimitService = new WebSocketRateLimitService();

module.exports = websocketRateLimitService;
