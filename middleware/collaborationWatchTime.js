const { logger } = require('../utils/logger');

/**
 * Collaboration Watch Time Tracking Middleware
 * Tracks watch time for collaborative content and triggers revenue attribution
 */
class CollaborationWatchTimeMiddleware {
  constructor(collaborationService, database) {
    this.collaborationService = collaborationService;
    this.database = database;
    
    // Configuration
    this.minWatchTimeSeconds = 30; // Minimum 30 seconds to count
    this.sessionTimeout = 300000; // 5 minutes session timeout
    this.activeSessions = new Map(); // In-memory session tracking
  }

  /**
   * Express middleware for tracking watch time
   * @param {object} options Middleware options
   * @returns {Function} Express middleware function
   */
  trackWatchTime(options = {}) {
    return async (req, res, next) => {
      try {
        // Check if content is collaborative
        const collaboration = await this.collaborationService.getCollaborationForContent(req.body?.contentId || req.query?.contentId);
        
        if (!collaboration) {
          // Not collaborative content, proceed normally
          return next();
        }

        // Generate session ID
        const sessionId = this.generateSessionId();
        const startTime = Date.now();

        // Store session in memory
        this.activeSessions.set(sessionId, {
          collaborationId: collaboration.id,
          contentId: collaboration.content_id,
          userAddress: req.user.address,
          startTime,
          lastActivity: startTime,
          totalWatchTime: 0,
          isActive: true
        });

        // Add session info to request
        req.collaborationSession = {
          sessionId,
          collaborationId: collaboration.id,
          isCollaborative: true,
          participants: collaboration.participants,
          startTime
        };

        // Set up cleanup on response finish
        const originalSend = res.send;
        res.send = function(data) {
          // End session when response is sent
          endSession(sessionId);
          originalSend.call(res, data);
        };

        // Set up cleanup on connection close
        req.on('close', () => {
          endSession(sessionId);
        });

        // Set up session timeout
        const timeoutId = setTimeout(() => {
          endSession(sessionId);
        }, this.sessionTimeout);

        // Store timeout ID for cleanup
        this.activeSessions.get(sessionId).timeoutId = timeoutId;

        logger.debug('Collaboration watch time session started', {
          sessionId,
          collaborationId: collaboration.id,
          contentId: collaboration.content_id,
          userAddress: req.user.address
        });

        next();
      } catch (error) {
        logger.error('Collaboration watch time middleware error', {
          error: error.message,
          contentId: req.body?.contentId || req.query?.contentId,
          userAddress: req.user?.address
        });
        next();
      }
    };
  }

  /**
   * Record watch time increment
   * @param {string} sessionId Session ID
   * @param {number} seconds Number of seconds to add
   * @returns {Promise<object>} Updated session info
   */
  async recordWatchTimeIncrement(sessionId, seconds) {
    try {
      const session = this.activeSessions.get(sessionId);
      
      if (!session || !session.isActive) {
        return { recorded: false, reason: 'Session not found or inactive' };
      }

      // Update session
      session.totalWatchTime += seconds;
      session.lastActivity = Date.now();

      // Reset timeout
      if (session.timeoutId) {
        clearTimeout(session.timeoutId);
      }
      session.timeoutId = setTimeout(() => {
        endSession(sessionId);
      }, this.sessionTimeout);

      logger.debug('Watch time increment recorded', {
        sessionId,
        seconds,
        totalWatchTime: session.totalWatchTime
      });

      return {
        recorded: true,
        sessionId,
        seconds,
        totalWatchTime: session.totalWatchTime
      };
    } catch (error) {
      logger.error('Failed to record watch time increment', {
        error: error.message,
        sessionId,
        seconds
      });
      return { recorded: false, error: error.message };
    }
  }

  /**
   * End watch time session and record to database
   * @param {string} sessionId Session ID
   * @returns {Promise<boolean>} Whether session was ended successfully
   */
  async endSession(sessionId) {
    try {
      const session = this.activeSessions.get(sessionId);
      
      if (!session) {
        return false;
      }

      // Mark as inactive to prevent duplicate processing
      session.isActive = false;

      // Clear timeout
      if (session.timeoutId) {
        clearTimeout(sessionId);
      }

      // Remove from memory
      this.activeSessions.delete(sessionId);

      // Record watch time if above minimum threshold
      if (session.totalWatchTime >= this.minWatchTimeSeconds) {
        await this.collaborationService.recordWatchTime(
          session.contentId,
          session.userAddress,
          session.totalWatchTime
        );

        logger.info('Collaboration watch time session recorded', {
          sessionId,
          collaborationId: session.collaborationId,
          contentId: session.contentId,
          userAddress: session.userAddress,
          watchSeconds: session.totalWatchTime,
          sessionDuration: Date.now() - session.startTime
        });
      } else {
        logger.debug('Watch time below minimum threshold, not recorded', {
          sessionId,
          collaborationId: session.collaborationId,
          contentId: session.contentId,
          userAddress: session.userAddress,
          watchSeconds: session.totalWatchTime,
          minimumThreshold: this.minWatchTimeSeconds
        });
      }

      return true;
    } catch (error) {
      logger.error('Failed to end collaboration session', {
        error: error.message,
        sessionId
      });
      return false;
    }
  }

  /**
   * Get active session count
   * @returns {number} Number of active sessions
   */
  getActiveSessionCount() {
    return this.activeSessions.size;
  }

  /**
   * Get session information
   * @param {string} sessionId Session ID
   * @returns {object|null} Session information
   */
  getSessionInfo(sessionId) {
    const session = this.activeSessions.get(sessionId);
    
    if (!session) {
      return null;
    }

    return {
      sessionId,
      collaborationId: session.collaborationId,
      contentId: session.contentId,
      userAddress: session.userAddress,
      startTime: session.startTime,
      lastActivity: session.lastActivity,
      totalWatchTime: session.totalWatchTime,
      sessionDuration: Date.now() - session.startTime,
      isActive: session.isActive
    };
  }

  /**
   * Clean up expired sessions
   * @returns {number} Number of sessions cleaned up
   */
  cleanupExpiredSessions() {
    try {
      const now = Date.now();
      const expiredSessions = [];

      for (const [sessionId, session] of this.activeSessions.entries()) {
        const age = now - session.lastActivity;
        
        if (age > this.sessionTimeout || !session.isActive) {
          expiredSessions.push(sessionId);
          
          // Clear timeout
          if (session.timeoutId) {
            clearTimeout(session.timeoutId);
          }
          
          // Remove from memory
          this.activeSessions.delete(sessionId);
          
          // Record watch time if above minimum threshold
          if (session.totalWatchTime >= this.minWatchTimeSeconds) {
            this.collaborationService.recordWatchTime(
              session.contentId,
              session.userAddress,
              session.totalWatchTime
            ).catch(error => {
              logger.error('Failed to record watch time during cleanup', {
                error: error.message,
                sessionId
              });
            });
          }
        }
      }

      if (expiredSessions.length > 0) {
        logger.info('Expired collaboration sessions cleaned up', {
          cleanedCount: expiredSessions.length,
          totalActive: this.activeSessions.size
        });
      }

      return expiredSessions.length;
    } catch (error) {
      logger.error('Failed to cleanup expired sessions', {
        error: error.message
      });
      return 0;
    }
  }

  /**
   * Get collaboration statistics
   * @returns {object} Statistics
   */
  getStatistics() {
    try {
      const activeSessions = this.activeSessions.size;
      const totalWatchTime = Array.from(this.activeSessions.values())
        .reduce((sum, session) => sum + session.totalWatchTime, 0);

      const sessionsByCollaboration = {};
      for (const session of this.activeSessions.values()) {
        const collabId = session.collaborationId;
        if (!sessionsByCollaboration[collabId]) {
          sessionsByCollaboration[collabId] = {
            collaborationId: collabId,
            contentId: session.contentId,
            activeSessions: 0,
            totalWatchTime: 0
          };
        }
        sessionsByCollaboration[collabId].activeSessions++;
        sessionsByCollaboration[collabId].totalWatchTime += session.totalWatchTime;
      }

      return {
        activeSessions,
        totalWatchTime,
        averageWatchTime: activeSessions > 0 ? totalWatchTime / activeSessions : 0,
        sessionsByCollaboration: Object.values(sessionsByCollaboration),
        generatedAt: new Date().toISOString()
      };
    } catch (error) {
      logger.error('Failed to get collaboration statistics', {
        error: error.message
      });
      return null;
    }
  }

  /**
   * Generate unique session ID
   * @returns {string} Session ID
   */
  generateSessionId() {
    return `watch_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
  }

  /**
   * Start automatic cleanup interval
   */
  startCleanupInterval() {
    // Clean up expired sessions every 5 minutes
    setInterval(() => {
      this.cleanupExpiredSessions();
    }, 300000);
  }

  /**
   * Create watch time tracking endpoint for WebSocket or real-time updates
   * @param {object} socket WebSocket connection
   * @param {object} data Connection data
   */
  handleWebSocketConnection(socket, data) {
    const { sessionId, contentId, userAddress } = data;

    if (!sessionId || !contentId || !userAddress) {
      socket.emit('error', { message: 'Invalid connection data' });
      return;
    }

    // Verify session exists and is collaborative
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      socket.emit('error', { message: 'Session not found' });
      return;
    }

    // Verify user matches session
    if (session.userAddress !== userAddress) {
      socket.emit('error', { message: 'User address mismatch' });
      return;
    }

    // Store socket reference
    session.socket = socket;

    // Set up message handlers
    socket.on('watch_time_increment', async (data) => {
      try {
        const { seconds } = data;
        
        if (typeof seconds !== 'number' || seconds <= 0) {
          socket.emit('error', { message: 'Invalid watch time increment' });
          return;
        }

        const result = await this.recordWatchTimeIncrement(sessionId, seconds);
        
        socket.emit('watch_time_recorded', {
          sessionId,
          seconds,
          totalWatchTime: result.totalWatchTime,
          recorded: result.recorded
        });
      } catch (error) {
        logger.error('WebSocket watch time increment error', {
          error: error.message,
          sessionId
        });
        socket.emit('error', { message: 'Failed to record watch time' });
      }
    });

    socket.on('get_session_info', () => {
      const sessionInfo = this.getSessionInfo(sessionId);
      socket.emit('session_info', sessionInfo);
    });

    socket.on('disconnect', () => {
      // Remove socket reference
      if (session.socket === socket) {
        session.socket = null;
      }
    });

    logger.info('Collaboration WebSocket connected', {
      sessionId,
      contentId,
      userAddress
    });
  }
}

module.exports = CollaborationWatchTimeMiddleware;
