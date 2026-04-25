const websocketRateLimitService = require('../src/services/websocketRateLimitService');

/**
 * WebSocket Rate Limiting Middleware
 * 
 * Middleware to protect WebSocket endpoints from DoS attacks and resource starvation.
 * Implements per-IP and per-tenant connection limits and message rate limiting.
 */
class WebSocketRateLimitMiddleware {
  constructor() {
    this.rateLimitService = websocketRateLimitService;
  }

  /**
   * Middleware function to check connection limits before upgrade
   */
  async checkConnectionLimit(req, res, next) {
    try {
      const clientIP = this.getClientIP(req);
      const tenantId = this.getTenantId(req);
      const socketId = this.generateSocketId();

      // Check connection limits
      const limitCheck = await this.rateLimitService.checkConnectionLimit(
        clientIP, 
        tenantId, 
        socketId
      );

      if (!limitCheck.allowed) {
        // Log the attempted connection
        console.warn(`WebSocket connection blocked: ${limitCheck.reason} from ${clientIP}`, limitCheck.details);
        
        // Return appropriate HTTP error response
        return res.status(429).json({
          error: 'Too Many Requests',
          message: 'WebSocket connection limit exceeded',
          code: limitCheck.reason,
          details: limitCheck.details,
          retry_after: limitCheck.details.retry_after
        });
      }

      // Add connection info to request for later use
      req.wsRateLimit = {
        socketId: socketId,
        clientIP: clientIP,
        tenantId: tenantId,
        allowed: true
      };

      next();
    } catch (error) {
      console.error('Error in WebSocket rate limit middleware:', error);
      // Fail safe - allow connection but log error
      next();
    }
  }

  /**
   * Function to handle connection registration after successful upgrade
   */
  async registerConnection(socket, req) {
    try {
      const rateLimitInfo = req.wsRateLimit;
      if (!rateLimitInfo || !rateLimitInfo.allowed) {
        return;
      }

      // Register the connection
      await this.rateLimitService.registerConnection(
        rateLimitInfo.clientIP,
        rateLimitInfo.tenantId,
        rateLimitInfo.socketId,
        {
          user_agent: req.headers['user-agent'],
          origin: req.headers.origin,
          socket_id: socket.id
        }
      );

      // Store rate limit info on socket for later use
      socket.rateLimit = rateLimitInfo;

      // Set up message rate limiting
      this.setupMessageRateLimiting(socket);

      // Set up connection cleanup on disconnect
      socket.on('disconnect', () => {
        this.handleDisconnect(socket);
      });

      console.log(`WebSocket connection registered: ${rateLimitInfo.socketId}`);
    } catch (error) {
      console.error('Error registering WebSocket connection:', error);
    }
  }

  /**
   * Set up message rate limiting for a socket
   */
  setupMessageRateLimiting(socket) {
    const originalEmit = socket.emit.bind(socket);
    const originalOn = socket.on.bind(socket);

    // Intercept outgoing messages (emit)
    socket.emit = async function(event, ...args) {
      // Rate limiting is primarily for incoming messages, but we can track outgoing too
      return originalEmit(event, ...args);
    };

    // Intercept incoming messages (on)
    socket.on = function(event, handler) {
      if (event === 'message' || event === 'data') {
        return originalOn(event, async (data) => {
          try {
            // Check message rate limit
            const rateLimitCheck = await socket.rateLimitService.checkMessageRateLimit(
              socket.rateLimit.socketId
            );

            if (!rateLimitCheck.allowed) {
              // Send rate limit notification to client
              socket.emit('rate_limit', {
                type: 'message_limit',
                reason: rateLimitCheck.reason,
                details: rateLimitCheck.details,
                message: 'Message rate limit exceeded. Please slow down.'
              });

              // Close the connection after grace period
              setTimeout(() => {
                if (socket.connected) {
                  socket.emit('rate_limit', {
                    type: 'connection_terminated',
                    reason: rateLimitCheck.reason,
                    message: 'Connection terminated due to excessive message rate.'
                  });
                  socket.disconnect(true);
                }
              }, 1000);

              return;
            }

            // If rate limit allows, call the original handler
            return handler(data);
          } catch (error) {
            console.error('Error in message rate limit check:', error);
            // Fail safe - allow the message
            return handler(data);
          }
        });
      }

      return originalOn(event, handler);
    };
  }

  /**
   * Handle connection cleanup on disconnect
   */
  async handleDisconnect(socket) {
    try {
      if (socket.rateLimit) {
        await this.rateLimitService.unregisterConnection(socket.rateLimit.socketId);
        console.log(`WebSocket connection unregistered: ${socket.rateLimit.socketId}`);
      }
    } catch (error) {
      console.error('Error handling WebSocket disconnect:', error);
    }
  }

  /**
   * Extract client IP from request
   */
  getClientIP(req) {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
           req.headers['x-real-ip'] ||
           req.connection?.remoteAddress ||
           req.socket?.remoteAddress ||
           req.ip ||
           'unknown';
  }

  /**
   * Extract tenant ID from authenticated request
   */
  getTenantId(req) {
    return req.user?.tenant_id || 
           req.tenant?.id || 
           req.query?.tenant_id ||
           null;
  }

  /**
   * Generate unique socket identifier
   */
  generateSocketId() {
    return `ws_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Get current rate limit statistics
   */
  async getStats() {
    try {
      return await this.rateLimitService.getConnectionStats();
    } catch (error) {
      console.error('Error getting rate limit stats:', error);
      return null;
    }
  }

  /**
   * Middleware for Express routes to get WebSocket stats
   */
  getStatsMiddleware() {
    return async (req, res) => {
      try {
        const stats = await this.getStats();
        
        if (!stats) {
          return res.status(500).json({
            error: 'Internal Server Error',
            message: 'Unable to retrieve WebSocket statistics'
          });
        }

        res.json({
          success: true,
          data: stats
        });
      } catch (error) {
        console.error('Error in WebSocket stats middleware:', error);
        res.status(500).json({
          error: 'Internal Server Error',
          message: 'Failed to retrieve WebSocket statistics'
        });
      }
    };
  }
}

// Create singleton instance
const wsRateLimitMiddleware = new WebSocketRateLimitMiddleware();

module.exports = {
  checkConnectionLimit: wsRateLimitMiddleware.checkConnectionLimit.bind(wsRateLimitMiddleware),
  registerConnection: wsRateLimitMiddleware.registerConnection.bind(wsRateLimitMiddleware),
  getStatsMiddleware: wsRateLimitMiddleware.getStatsMiddleware.bind(wsRateLimitMiddleware),
  WebSocketRateLimitMiddleware
};
