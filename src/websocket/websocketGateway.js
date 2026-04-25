const { Server } = require('socket.io');
const { checkConnectionLimit, registerConnection } = require('../../middleware/websocketRateLimit');
const jwt = require('jsonwebtoken');
const { getDatabase } = require('../db/appDatabase');

/**
 * WebSocket Gateway with Rate Limiting
 * 
 * Enhanced WebSocket gateway that integrates rate limiting to protect against DoS attacks.
 * Handles authentication, connection management, and real-time communication.
 */
class WebSocketGateway {
  constructor(httpServer) {
    this.io = new Server(httpServer, {
      cors: {
        origin: process.env.CORS_ORIGINS?.split(',') || ["http://localhost:3000"],
        methods: ["GET", "POST"],
        credentials: true
      },
      transports: ['websocket', 'polling'],
      pingTimeout: 60000,
      pingInterval: 25000
    });

    this.connectedClients = new Map();
    this.tenantClients = new Map();
    this.initialize();
  }

  /**
   * Initialize the WebSocket gateway
   */
  initialize() {
    // Apply rate limiting middleware before connection upgrade
    this.engine = this.io.engine;
    this.originalEngineHandleRequest = this.engine.handleRequest.bind(this.engine);
    
    this.engine.handleRequest = async (req, res) => {
      // Apply rate limiting check
      await checkConnectionLimit(req, res, (err) => {
        if (err) {
          return res.status(500).json({ error: 'Internal Server Error' });
        }
        // Continue with original request handling
        return this.originalEngineHandleRequest(req, res);
      });
    };

    // Handle new connections
    this.io.on('connection', (socket) => {
      this.handleConnection(socket);
    });

    // Set up authentication middleware
    this.io.use(async (socket, next) => {
      try {
        await this.authenticateSocket(socket, next);
      } catch (error) {
        console.error('Socket authentication error:', error);
        next(new Error('Authentication failed'));
      }
    });

    console.log('WebSocket gateway initialized with rate limiting');
  }

  /**
   * Handle new WebSocket connection
   */
  async handleConnection(socket) {
    try {
      // Register connection with rate limiting service
      const req = socket.request;
      await registerConnection(socket, req);

      // Add to connected clients tracking
      this.connectedClients.set(socket.id, {
        socket: socket,
        connectedAt: new Date(),
        tenantId: socket.tenantId,
        userId: socket.userId,
        clientIP: socket.clientIP
      });

      // Add to tenant client tracking
      if (socket.tenantId) {
        if (!this.tenantClients.has(socket.tenantId)) {
          this.tenantClients.set(socket.tenantId, new Set());
        }
        this.tenantClients.get(socket.tenantId).add(socket.id);
      }

      // Set up event handlers
      this.setupEventHandlers(socket);

      // Send welcome message
      socket.emit('connected', {
        message: 'Connected to SubStream WebSocket gateway',
        socketId: socket.id,
        timestamp: new Date().toISOString(),
        rateLimitInfo: {
          maxMessagesPerSecond: parseInt(process.env.WS_MAX_MESSAGES_PER_SECOND) || 10
        }
      });

      console.log(`WebSocket client connected: ${socket.id} from ${socket.clientIP}${socket.tenantId ? ` (tenant: ${socket.tenantId})` : ''}`);
    } catch (error) {
      console.error('Error handling WebSocket connection:', error);
      socket.disconnect(true);
    }
  }

  /**
   * Authenticate WebSocket connection
   */
  async authenticateSocket(socket, next) {
    try {
      const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.replace('Bearer ', '');
      
      if (!token) {
        socket.tenantId = null;
        socket.userId = null;
        socket.authenticated = false;
        return next();
      }

      // Verify JWT token
      const config = require('../config').loadConfig();
      const decoded = jwt.verify(token, config.auth.creatorJwtSecret);
      
      // Get tenant information
      const db = getDatabase();
      const tenant = await db('tenants').where('id', decoded.tenant_id).first();
      
      if (!tenant) {
        return next(new Error('Invalid tenant'));
      }

      socket.tenantId = decoded.tenant_id;
      socket.userId = decoded.user_id;
      socket.authenticated = true;
      socket.user = decoded;

      next();
    } catch (error) {
      // Allow anonymous connections but mark as unauthenticated
      socket.tenantId = null;
      socket.userId = null;
      socket.authenticated = false;
      next();
    }
  }

  /**
   * Set up event handlers for a socket
   */
  setupEventHandlers(socket) {
    // Handle subscription to tenant-specific events
    socket.on('subscribe', async (data) => {
      try {
        await this.handleSubscription(socket, data);
      } catch (error) {
        console.error('Error handling subscription:', error);
        socket.emit('error', { message: 'Subscription failed', error: error.message });
      }
    });

    // Handle unsubscription
    socket.on('unsubscribe', (data) => {
      try {
        this.handleUnsubscription(socket, data);
      } catch (error) {
        console.error('Error handling unsubscription:', error);
        socket.emit('error', { message: 'Unsubscription failed', error: error.message });
      }
    });

    // Handle custom events
    socket.on('custom_event', async (data) => {
      try {
        await this.handleCustomEvent(socket, data);
      } catch (error) {
        console.error('Error handling custom event:', error);
        socket.emit('error', { message: 'Event handling failed', error: error.message });
      }
    });

    // Handle ping for connection health
    socket.on('ping', () => {
      socket.emit('pong', { timestamp: new Date().toISOString() });
    });

    // Handle disconnect
    socket.on('disconnect', (reason) => {
      this.handleDisconnect(socket, reason);
    });

    // Handle connection errors
    socket.on('error', (error) => {
      console.error(`WebSocket error for socket ${socket.id}:`, error);
    });
  }

  /**
   * Handle subscription to events
   */
  async handleSubscription(socket, data) {
    const { events, tenantId } = data;
    
    // Validate subscription request
    if (!Array.isArray(events) || events.length === 0) {
      throw new Error('Invalid subscription request');
    }

    // Only allow authenticated users to subscribe to tenant-specific events
    if (tenantId && (!socket.authenticated || socket.tenantId !== tenantId)) {
      throw new Error('Unauthorized to subscribe to tenant events');
    }

    // Join appropriate rooms
    events.forEach(event => {
      const roomName = tenantId ? `${tenantId}:${event}` : `global:${event}`;
      socket.join(roomName);
    });

    socket.emit('subscribed', {
      events: events,
      tenantId: tenantId,
      timestamp: new Date().toISOString()
    });

    console.log(`Socket ${socket.id} subscribed to events: ${events.join(', ')}${tenantId ? ` for tenant ${tenantId}` : ''}`);
  }

  /**
   * Handle unsubscription from events
   */
  handleUnsubscription(socket, data) {
    const { events, tenantId } = data;
    
    if (!Array.isArray(events)) {
      throw new Error('Invalid unsubscription request');
    }

    events.forEach(event => {
      const roomName = tenantId ? `${tenantId}:${event}` : `global:${event}`;
      socket.leave(roomName);
    });

    socket.emit('unsubscribed', {
      events: events,
      tenantId: tenantId,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Handle custom events
   */
  async handleCustomEvent(socket, data) {
    const { type, payload } = data;
    
    // Validate event
    if (!type || typeof payload === 'undefined') {
      throw new Error('Invalid custom event format');
    }

    // Only authenticated users can send custom events
    if (!socket.authenticated) {
      throw new Error('Authentication required for custom events');
    }

    // Process the custom event based on type
    switch (type) {
      case 'analytics_event':
        await this.handleAnalyticsEvent(socket, payload);
        break;
      case 'notification':
        await this.handleNotification(socket, payload);
        break;
      case 'status_update':
        await this.handleStatusUpdate(socket, payload);
        break;
      default:
        console.warn(`Unknown custom event type: ${type}`);
    }

    socket.emit('event_processed', {
      type: type,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Handle analytics events
   */
  async handleAnalyticsEvent(socket, payload) {
    // Store analytics event in database
    const db = getDatabase();
    await db('analytics').insert({
      tenant_id: socket.tenantId,
      user_id: socket.userId,
      event_type: payload.event_type,
      event_data: JSON.stringify(payload.data),
      created_at: new Date()
    });
  }

  /**
   * Handle notification events
   */
  async handleNotification(socket, payload) {
    // Broadcast notification to tenant's other clients
    if (socket.tenantId && payload.broadcast) {
      this.io.to(`${socket.tenantId}:notifications`).emit('notification', {
        ...payload,
        sender: socket.userId,
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * Handle status update events
   */
  async handleStatusUpdate(socket, payload) {
    // Update user status and broadcast to tenant
    if (socket.tenantId) {
      this.io.to(`${socket.tenantId}:status`).emit('status_update', {
        user_id: socket.userId,
        status: payload.status,
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * Handle socket disconnection
   */
  handleDisconnect(socket, reason) {
    try {
      // Remove from connected clients tracking
      this.connectedClients.delete(socket.id);

      // Remove from tenant client tracking
      if (socket.tenantId && this.tenantClients.has(socket.tenantId)) {
        this.tenantClients.get(socket.tenantId).delete(socket.id);
        if (this.tenantClients.get(socket.tenantId).size === 0) {
          this.tenantClients.delete(socket.tenantId);
        }
      }

      // Broadcast disconnection to tenant (if authenticated)
      if (socket.authenticated && socket.tenantId) {
        this.io.to(`${socket.tenantId}:presence`).emit('user_disconnected', {
          user_id: socket.userId,
          timestamp: new Date().toISOString()
        });
      }

      console.log(`WebSocket client disconnected: ${socket.id} (${reason})${socket.tenantId ? ` (tenant: ${socket.tenantId})` : ''}`);
    } catch (error) {
      console.error('Error handling WebSocket disconnection:', error);
    }
  }

  /**
   * Broadcast event to specific tenant
   */
  broadcastToTenant(tenantId, event, data) {
    this.io.to(`${tenantId}:${event}`).emit(event, {
      ...data,
      tenant_id: tenantId,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Broadcast event globally
   */
  broadcastGlobal(event, data) {
    this.io.emit(event, {
      ...data,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Get connection statistics
   */
  getConnectionStats() {
    const stats = {
      total_connections: this.connectedClients.size,
      authenticated_connections: 0,
      anonymous_connections: 0,
      tenants_connected: this.tenantClients.size,
      connections_by_tenant: {},
      timestamp: new Date().toISOString()
    };

    // Count authenticated vs anonymous connections
    this.connectedClients.forEach((client) => {
      if (client.authenticated) {
        stats.authenticated_connections++;
      } else {
        stats.anonymous_connections++;
      }

      // Count connections per tenant
      if (client.tenantId) {
        stats.connections_by_tenant[client.tenantId] = 
          (stats.connections_by_tenant[client.tenantId] || 0) + 1;
      }
    });

    return stats;
  }

  /**
   * Graceful shutdown
   */
  async shutdown() {
    console.log('Shutting down WebSocket gateway...');
    
    // Disconnect all clients
    this.io.emit('server_shutdown', {
      message: 'Server is shutting down',
      timestamp: new Date().toISOString()
    });

    // Close all connections
    this.io.close(() => {
      console.log('WebSocket gateway shutdown completed');
    });
  }
}

module.exports = WebSocketGateway;
