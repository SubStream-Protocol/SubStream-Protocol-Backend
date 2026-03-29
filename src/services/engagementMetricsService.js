/**
 * Engagement Metrics Collection Service
 * 
 * Collects and processes user engagement metrics for the ScaledUserProp algorithm.
 * This service tracks various engagement types and provides real-time metrics
 * for revenue division calculations.
 * 
 * Key Features:
 * - Multi-type engagement tracking
 * - Real-time metrics collection
 * - Engagement intensity calculation
 * - Performance optimization
 * - Data validation and sanitization
 */

class EngagementMetricsService {
  constructor(database, config = {}) {
    this.db = database;
    this.config = {
      // Engagement weights for different types
      engagementWeights: {
        view: config.viewWeight || 1.0,
        like: config.likeWeight || 2.0,
        comment: config.commentWeight || 5.0,
        share: config.shareWeight || 10.0,
        subscribe: config.subscribeWeight || 20.0,
        download: config.downloadWeight || 3.0,
        favorite: config.favoriteWeight || 4.0
      },
      
      // Quality thresholds
      minViewDuration: config.minViewDuration || 30000, // 30 seconds in milliseconds
      maxEngagementPerSession: config.maxEngagementPerSession || 1000,
      sessionTimeout: config.sessionTimeout || 1800000, // 30 minutes
      
      // Performance settings
      batchSize: config.batchSize || 500,
      flushInterval: config.flushInterval || 60000, // 1 minute
      maxRetries: config.maxRetries || 3,
      
      // Validation settings
      enableValidation: config.enableValidation !== false,
      enableSanitization: config.enableSanitization !== false,
      
      ...config
    };
    
    // Initialize database tables
    this.initializeDatabase();
    
    // In-memory batch buffer
    this.engagementBuffer = [];
    this.sessionBuffer = new Map();
    
    // Start background flush process
    this.startBackgroundFlush();
    
    // Metrics tracking
    this.metrics = {
      eventsCollected: 0,
      eventsProcessed: 0,
      validationFailures: 0,
      averageProcessingTime: 0
    };
  }

  /**
   * Initialize database tables for engagement metrics
   */
  initializeDatabase() {
    const tables = [
      // Raw engagement events
      `CREATE TABLE IF NOT EXISTS engagement_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        user_address TEXT NOT NULL,
        creator_address TEXT NOT NULL,
        content_id TEXT NOT NULL,
        engagement_type TEXT NOT NULL,
        engagement_weight REAL NOT NULL,
        engagement_data TEXT,
        session_id TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        ip_address TEXT,
        user_agent TEXT,
        processed BOOLEAN DEFAULT FALSE,
        quality_score REAL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      
      // User engagement sessions
      `CREATE TABLE IF NOT EXISTS engagement_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL UNIQUE,
        user_address TEXT NOT NULL,
        creator_address TEXT NOT NULL,
        start_time DATETIME NOT NULL,
        end_time DATETIME,
        total_engagement REAL DEFAULT 0,
        engagement_count INTEGER DEFAULT 0,
        quality_score REAL DEFAULT 0,
        is_active BOOLEAN DEFAULT TRUE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      
      // Aggregated engagement metrics
      `CREATE TABLE IF NOT EXISTS engagement_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_address TEXT NOT NULL,
        creator_address TEXT NOT NULL,
        metric_date DATE NOT NULL,
        total_engagement REAL DEFAULT 0,
        view_count INTEGER DEFAULT 0,
        like_count INTEGER DEFAULT 0,
        comment_count INTEGER DEFAULT 0,
        share_count INTEGER DEFAULT 0,
        subscribe_count INTEGER DEFAULT 0,
        download_count INTEGER DEFAULT 0,
        favorite_count INTEGER DEFAULT 0,
        quality_score REAL DEFAULT 0,
        intensity_score REAL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_address, creator_address, metric_date)
      )`,
      
      // Content engagement statistics
      `CREATE TABLE IF NOT EXISTS content_engagement_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_id TEXT NOT NULL,
        creator_address TEXT NOT NULL,
        total_views INTEGER DEFAULT 0,
        total_likes INTEGER DEFAULT 0,
        total_comments INTEGER DEFAULT 0,
        total_shares INTEGER DEFAULT 0,
        total_subscribes INTEGER DEFAULT 0,
        total_downloads INTEGER DEFAULT 0,
        total_favorites INTEGER DEFAULT 0,
        average_quality_score REAL DEFAULT 0,
        engagement_rate REAL DEFAULT 0,
        last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(content_id)
      )`,
      
      // Engagement quality metrics
      `CREATE TABLE IF NOT EXISTS engagement_quality (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        quality_factors TEXT NOT NULL,
        overall_score REAL NOT NULL,
        validation_flags TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (event_id) REFERENCES engagement_events(event_id)
      )`
    ];

    // Create indexes for performance
    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_engagement_events_user ON engagement_events(user_address)',
      'CREATE INDEX IF NOT EXISTS idx_engagement_events_creator ON engagement_events(creator_address)',
      'CREATE INDEX IF NOT EXISTS idx_engagement_events_content ON engagement_events(content_id)',
      'CREATE INDEX IF NOT EXISTS idx_engagement_events_timestamp ON engagement_events(timestamp)',
      'CREATE INDEX IF NOT EXISTS idx_engagement_events_type ON engagement_events(engagement_type)',
      'CREATE INDEX IF NOT EXISTS idx_engagement_events_processed ON engagement_events(processed)',
      'CREATE INDEX IF NOT EXISTS idx_engagement_sessions_user ON engagement_sessions(user_address)',
      'CREATE INDEX IF NOT EXISTS idx_engagement_sessions_active ON engagement_sessions(is_active)',
      'CREATE INDEX IF NOT EXISTS idx_engagement_metrics_date ON engagement_metrics(metric_date)',
      'CREATE INDEX IF NOT EXISTS idx_engagement_metrics_user_creator ON engagement_metrics(user_address, creator_address)',
      'CREATE INDEX IF NOT EXISTS idx_content_stats_creator ON content_engagement_stats(creator_address)',
      'CREATE INDEX IF NOT EXISTS idx_content_stats_updated ON content_engagement_stats(last_updated)'
    ];

    tables.forEach(sql => {
      try {
        this.db.run(sql);
      } catch (error) {
        console.error('Error creating engagement table:', error);
      }
    });

    indexes.forEach(sql => {
      try {
        this.db.run(sql);
      } catch (error) {
        console.error('Error creating engagement index:', error);
      }
    });
  }

  /**
   * Record an engagement event
   * @param {Object} eventData - Engagement event data
   * @returns {Object} Recording result
   */
  recordEngagement(eventData) {
    const startTime = Date.now();
    
    try {
      // Validate event data
      const validationResult = this.validateEventData(eventData);
      if (!validationResult.isValid) {
        this.metrics.validationFailures++;
        return {
          success: false,
          error: validationResult.error,
          eventId: null
        };
      }
      
      // Sanitize event data
      const sanitizedData = this.sanitizeEventData(eventData);
      
      // Calculate engagement weight
      const engagementWeight = this.calculateEngagementWeight(sanitizedData);
      
      // Generate unique event ID
      const eventId = this.generateEventId(sanitizedData);
      
      // Add to batch buffer
      const engagementRecord = {
        eventId,
        ...sanitizedData,
        engagementWeight,
        timestamp: new Date().toISOString(),
        processed: false
      };
      
      this.engagementBuffer.push(engagementRecord);
      this.metrics.eventsCollected++;
      
      // Update session tracking
      this.updateSessionTracking(engagementRecord);
      
      // Check if buffer needs flushing
      if (this.engagementBuffer.length >= this.config.batchSize) {
        this.flushEngagementBuffer();
      }
      
      // Update processing metrics
      const processingTime = Date.now() - startTime;
      this.updateProcessingMetrics(processingTime);
      
      return {
        success: true,
        eventId,
        engagementWeight,
        processingTime
      };
      
    } catch (error) {
      console.error('Error recording engagement:', error);
      return {
        success: false,
        error: error.message,
        eventId: null
      };
    }
  }

  /**
   * Validate engagement event data
   * @param {Object} eventData - Event data to validate
   * @returns {Object} Validation result
   */
  validateEventData(eventData) {
    const requiredFields = ['userAddress', 'creatorAddress', 'contentType', 'engagementType'];
    
    // Check required fields
    for (const field of requiredFields) {
      if (!eventData[field]) {
        return {
          isValid: false,
          error: `Missing required field: ${field}`
        };
      }
    }
    
    // Validate engagement type
    const validTypes = Object.keys(this.config.engagementWeights);
    if (!validTypes.includes(eventData.engagementType)) {
      return {
        isValid: false,
        error: `Invalid engagement type: ${eventData.engagementType}`
      };
    }
    
    // Validate addresses (basic Stellar address format)
    if (!this.isValidStellarAddress(eventData.userAddress)) {
      return {
        isValid: false,
        error: 'Invalid user address format'
      };
    }
    
    if (!this.isValidStellarAddress(eventData.creatorAddress)) {
      return {
        isValid: false,
        error: 'Invalid creator address format'
      };
    }
    
    // Validate engagement-specific data
    if (eventData.engagementType === 'view' && eventData.duration) {
      if (eventData.duration < this.config.minViewDuration) {
        return {
          isValid: false,
          error: `View duration too short: ${eventData.duration}ms`
        };
      }
    }
    
    return {
      isValid: true,
      error: null
    };
  }

  /**
   * Sanitize engagement event data
   * @param {Object} eventData - Event data to sanitize
   * @returns {Object} Sanitized event data
   */
  sanitizeEventData(eventData) {
    const sanitized = {
      userAddress: eventData.userAddress.trim(),
      creatorAddress: eventData.creatorAddress.trim(),
      contentId: (eventData.contentId || '').trim(),
      contentType: eventData.contentType.trim(),
      engagementType: eventData.engagementType.trim(),
      sessionId: eventData.sessionId || this.generateSessionId(eventData.userAddress),
      engagementData: {},
      metadata: {}
    };
    
    // Sanitize engagement-specific data
    if (eventData.duration) {
      sanitized.engagementData.duration = Math.max(0, parseInt(eventData.duration));
    }
    
    if (eventData.quality) {
      sanitized.engagementData.quality = Math.max(0, Math.min(1, parseFloat(eventData.quality)));
    }
    
    if (eventData.position) {
      sanitized.engagementData.position = {
        x: Math.max(0, parseInt(eventData.position.x || 0)),
        y: Math.max(0, parseInt(eventData.position.y || 0))
      };
    }
    
    // Sanitize metadata
    if (eventData.ipAddress) {
      sanitized.metadata.ipAddress = eventData.ipAddress.trim();
    }
    
    if (eventData.userAgent) {
      sanitized.metadata.userAgent = eventData.userAgent.substring(0, 500); // Limit length
    }
    
    if (eventData.referrer) {
      sanitized.metadata.referrer = eventData.referrer.substring(0, 200);
    }
    
    return sanitized;
  }

  /**
   * Calculate engagement weight based on type and data
   * @param {Object} eventData - Sanitized event data
   * @returns {number} Engagement weight
   */
  calculateEngagementWeight(eventData) {
    const baseWeight = this.config.engagementWeights[eventData.engagementType] || 1.0;
    let qualityMultiplier = 1.0;
    
    // Apply quality-based adjustments
    if (eventData.engagementData.duration) {
      // Longer views get higher weight
      const durationMultiplier = Math.min(2.0, eventData.engagementData.duration / this.config.minViewDuration);
      qualityMultiplier *= durationMultiplier;
    }
    
    if (eventData.engagementData.quality) {
      // Higher quality engagement gets higher weight
      qualityMultiplier *= (0.5 + eventData.engagementData.quality * 0.5);
    }
    
    // Apply type-specific adjustments
    switch (eventData.engagementType) {
      case 'view':
        // Views with interaction get higher weight
        if (eventData.engagementData.interactions) {
          qualityMultiplier *= 1.5;
        }
        break;
        
      case 'comment':
        // Longer comments get higher weight
        if (eventData.engagementData.commentLength) {
          const lengthMultiplier = Math.min(2.0, eventData.engagementData.commentLength / 100);
          qualityMultiplier *= lengthMultiplier;
        }
        break;
        
      case 'share':
        // Shares to more platforms get higher weight
        if (eventData.engagementData.platformCount) {
          const platformMultiplier = Math.min(3.0, eventData.engagementData.platformCount);
          qualityMultiplier *= platformMultiplier;
        }
        break;
    }
    
    return baseWeight * qualityMultiplier;
  }

  /**
   * Update session tracking for engagement
   * @param {Object} engagementRecord - Engagement record
   */
  updateSessionTracking(engagementRecord) {
    const sessionId = engagementRecord.sessionId;
    const userAddress = engagementRecord.userAddress;
    const creatorAddress = engagementRecord.creatorAddress;
    
    if (!this.sessionBuffer.has(sessionId)) {
      this.sessionBuffer.set(sessionId, {
        sessionId,
        userAddress,
        creatorAddress,
        startTime: new Date(),
        endTime: null,
        totalEngagement: 0,
        engagementCount: 0,
        lastActivity: new Date()
      });
    }
    
    const session = this.sessionBuffer.get(sessionId);
    session.totalEngagement += engagementRecord.engagementWeight;
    session.engagementCount += 1;
    session.lastActivity = new Date();
    session.endTime = new Date(); // Update end time with each activity
  }

  /**
   * Generate unique event ID
   * @param {Object} eventData - Event data
   * @returns {string} Unique event ID
   */
  generateEventId(eventData) {
    const crypto = require('crypto');
    const data = {
      userAddress: eventData.userAddress,
      creatorAddress: eventData.creatorAddress,
      contentId: eventData.contentId,
      engagementType: eventData.engagementType,
      timestamp: Date.now(),
      random: Math.random()
    };
    
    return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex').substring(0, 32);
  }

  /**
   * Generate session ID
   * @param {string} userAddress - User address
   * @returns {string} Session ID
   */
  generateSessionId(userAddress) {
    const crypto = require('crypto');
    const data = {
      userAddress,
      timestamp: Date.now(),
      random: Math.random()
    };
    
    return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex').substring(0, 24);
  }

  /**
   * Validate Stellar address format
   * @param {string} address - Address to validate
   * @returns {boolean} Whether address is valid
   */
  isValidStellarAddress(address) {
    // Basic Stellar address validation (starts with 'G' and is 56 characters)
    return typeof address === 'string' && 
           address.length === 56 && 
           address.startsWith('G') && 
           /^[A-Z0-9]+$/.test(address);
  }

  /**
   * Flush engagement buffer to database
   */
  flushEngagementBuffer() {
    if (this.engagementBuffer.length === 0) return;
    
    try {
      const transaction = this.db.transaction(() => {
        for (const record of this.engagementBuffer) {
          // Insert engagement event
          this.db.prepare(`
            INSERT INTO engagement_events 
            (event_id, user_address, creator_address, content_id, engagement_type, engagement_weight, engagement_data, session_id, timestamp, ip_address, user_agent)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            record.eventId,
            record.userAddress,
            record.creatorAddress,
            record.contentId,
            record.engagementType,
            record.engagementWeight,
            JSON.stringify(record.engagementData),
            record.sessionId,
            record.timestamp,
            record.metadata.ipAddress,
            record.metadata.userAgent
          );
          
          // Update or insert session
          const session = this.sessionBuffer.get(record.sessionId);
          if (session) {
            this.db.prepare(`
              INSERT OR REPLACE INTO engagement_sessions 
              (session_id, user_address, creator_address, start_time, end_time, total_engagement, engagement_count, is_active, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              session.sessionId,
              session.userAddress,
              session.creatorAddress,
              session.startTime.toISOString(),
              session.endTime.toISOString(),
              session.totalEngagement,
              session.engagementCount,
              true,
              new Date().toISOString()
            );
          }
        }
        
        // Clear buffer
        this.engagementBuffer = [];
        this.metrics.eventsProcessed += this.engagementBuffer.length;
      });
      
      transaction();
      console.log(`Flushed ${this.engagementBuffer.length} engagement events to database`);
      
    } catch (error) {
      console.error('Error flushing engagement buffer:', error);
    }
  }

  /**
   * Start background flush process
   */
  startBackgroundFlush() {
    setInterval(() => {
      this.flushEngagementBuffer();
      this.cleanupExpiredSessions();
    }, this.config.flushInterval);
  }

  /**
   * Clean up expired sessions
   */
  cleanupExpiredSessions() {
    try {
      const cutoffTime = new Date(Date.now() - this.config.sessionTimeout);
      
      // Mark expired sessions as inactive
      const result = this.db.prepare(`
        UPDATE engagement_sessions
        SET is_active = FALSE, updated_at = datetime('now')
        WHERE is_active = TRUE AND last_activity < ?
      `).run(cutoffTime.toISOString());
      
      if (result.changes > 0) {
        console.log(`Marked ${result.changes} expired sessions as inactive`);
      }
      
      // Clean up session buffer
      for (const [sessionId, session] of this.sessionBuffer.entries()) {
        if (session.lastActivity < cutoffTime) {
          this.sessionBuffer.delete(sessionId);
        }
      }
      
    } catch (error) {
      console.error('Error cleaning up expired sessions:', error);
    }
  }

  /**
   * Get aggregated engagement metrics for a user-creator pair
   * @param {string} userAddress - User address
   * @param {string} creatorAddress - Creator address
   * @param {Object} period - Time period
   * @returns {Object} Aggregated metrics
   */
  getUserCreatorMetrics(userAddress, creatorAddress, period) {
    try {
      const metrics = this.db.prepare(`
        SELECT 
          SUM(engagement_weight) as total_engagement,
          COUNT(*) as total_events,
          AVG(quality_score) as avg_quality_score,
          SUM(CASE WHEN engagement_type = 'view' THEN 1 ELSE 0 END) as view_count,
          SUM(CASE WHEN engagement_type = 'like' THEN 1 ELSE 0 END) as like_count,
          SUM(CASE WHEN engagement_type = 'comment' THEN 1 ELSE 0 END) as comment_count,
          SUM(CASE WHEN engagement_type = 'share' THEN 1 ELSE 0 END) as share_count,
          SUM(CASE WHEN engagement_type = 'subscribe' THEN 1 ELSE 0 END) as subscribe_count,
          SUM(CASE WHEN engagement_type = 'download' THEN 1 ELSE 0 END) as download_count,
          SUM(CASE WHEN engagement_type = 'favorite' THEN 1 ELSE 0 END) as favorite_count
        FROM engagement_events
        WHERE user_address = ? 
          AND creator_address = ?
          AND timestamp >= ? 
          AND timestamp <= ?
      `).get(
        userAddress,
        creatorAddress,
        period.start.toISOString(),
        period.end.toISOString()
      );
      
      return {
        userAddress,
        creatorAddress,
        period,
        totalEngagement: metrics.total_engagement || 0,
        totalEvents: metrics.total_events || 0,
        averageQualityScore: metrics.avg_quality_score || 0,
        engagementBreakdown: {
          views: metrics.view_count || 0,
          likes: metrics.like_count || 0,
          comments: metrics.comment_count || 0,
          shares: metrics.share_count || 0,
          subscribes: metrics.subscribe_count || 0,
          downloads: metrics.download_count || 0,
          favorites: metrics.favorite_count || 0
        }
      };
      
    } catch (error) {
      console.error('Error getting user-creator metrics:', error);
      return null;
    }
  }

  /**
   * Get creator engagement statistics
   * @param {string} creatorAddress - Creator address
   * @param {Object} period - Time period
   * @returns {Object} Creator statistics
   */
  getCreatorStatistics(creatorAddress, period) {
    try {
      const stats = this.db.prepare(`
        SELECT 
          COUNT(DISTINCT user_address) as unique_users,
          SUM(engagement_weight) as total_engagement,
          COUNT(*) as total_events,
          AVG(quality_score) as avg_quality_score,
          SUM(CASE WHEN engagement_type = 'view' THEN 1 ELSE 0 END) as view_count,
          SUM(CASE WHEN engagement_type = 'like' THEN 1 ELSE 0 END) as like_count,
          SUM(CASE WHEN engagement_type = 'comment' THEN 1 ELSE 0 END) as comment_count,
          SUM(CASE WHEN engagement_type = 'share' THEN 1 ELSE 0 END) as share_count,
          SUM(CASE WHEN engagement_type = 'subscribe' THEN 1 ELSE 0 END) as subscribe_count
        FROM engagement_events
        WHERE creator_address = ? 
          AND timestamp >= ? 
          AND timestamp <= ?
      `).get(
        creatorAddress,
        period.start.toISOString(),
        period.end.toISOString()
      );
      
      // Calculate engagement rate
      const engagementRate = stats.view_count > 0 ? 
        (stats.like_count + stats.comment_count + stats.share_count) / stats.view_count : 0;
      
      return {
        creatorAddress,
        period,
        uniqueUsers: stats.unique_users || 0,
        totalEngagement: stats.total_engagement || 0,
        totalEvents: stats.total_events || 0,
        averageQualityScore: stats.avg_quality_score || 0,
        engagementBreakdown: {
          views: stats.view_count || 0,
          likes: stats.like_count || 0,
          comments: stats.comment_count || 0,
          shares: stats.share_count || 0,
          subscribes: stats.subscribe_count || 0
        },
        engagementRate,
        averageEngagementPerUser: stats.unique_users > 0 ? (stats.total_engagement / stats.unique_users) : 0
      };
      
    } catch (error) {
      console.error('Error getting creator statistics:', error);
      return null;
    }
  }

  /**
   * Get system-wide engagement metrics
   * @param {Object} period - Time period
   * @returns {Object} System metrics
   */
  getSystemMetrics(period) {
    try {
      const metrics = this.db.prepare(`
        SELECT 
          COUNT(DISTINCT user_address) as total_users,
          COUNT(DISTINCT creator_address) as total_creators,
          COUNT(DISTINCT content_id) as total_content,
          SUM(engagement_weight) as total_engagement,
          COUNT(*) as total_events,
          AVG(quality_score) as avg_quality_score,
          SUM(CASE WHEN engagement_type = 'view' THEN 1 ELSE 0 END) as view_count,
          SUM(CASE WHEN engagement_type = 'like' THEN 1 ELSE 0 END) as like_count,
          SUM(CASE WHEN engagement_type = 'comment' THEN 1 ELSE 0 END) as comment_count,
          SUM(CASE WHEN engagement_type = 'share' THEN 1 ELSE 0 END) as share_count,
          SUM(CASE WHEN engagement_type = 'subscribe' THEN 1 ELSE 0 END) as subscribe_count
        FROM engagement_events
        WHERE timestamp >= ? AND timestamp <= ?
      `).get(
        period.start.toISOString(),
        period.end.toISOString()
      );
      
      return {
        period,
        totalUsers: metrics.total_users || 0,
        totalCreators: metrics.total_creators || 0,
        totalContent: metrics.total_content || 0,
        totalEngagement: metrics.total_engagement || 0,
        totalEvents: metrics.total_events || 0,
        averageQualityScore: metrics.avg_quality_score || 0,
        engagementBreakdown: {
          views: metrics.view_count || 0,
          likes: metrics.like_count || 0,
          comments: metrics.comment_count || 0,
          shares: metrics.share_count || 0,
          subscribes: metrics.subscribe_count || 0
        },
        averageEngagementPerUser: metrics.total_users > 0 ? (metrics.total_engagement / metrics.total_users) : 0,
        averageEngagementPerCreator: metrics.total_creators > 0 ? (metrics.total_engagement / metrics.total_creators) : 0
      };
      
    } catch (error) {
      console.error('Error getting system metrics:', error);
      return null;
    }
  }

  /**
   * Update processing metrics
   * @param {number} processingTime - Processing time in milliseconds
   */
  updateProcessingMetrics(processingTime) {
    this.metrics.eventsProcessed++;
    this.metrics.averageProcessingTime = 
      (this.metrics.averageProcessingTime * (this.metrics.eventsProcessed - 1) + processingTime) / 
      this.metrics.eventsProcessed;
  }

  /**
   * Get service metrics
   * @returns {Object} Service metrics
   */
  getServiceMetrics() {
    return {
      ...this.metrics,
      bufferSize: this.engagementBuffer.length,
      activeSessions: this.sessionBuffer.size,
      cacheHitRate: 0, // Would be calculated if we had caching
      uptime: process.uptime()
    };
  }

  /**
   * Generate engagement analytics report
   * @param {Object} period - Report period
   * @returns {Object} Analytics report
   */
  generateAnalyticsReport(period) {
    try {
      const systemMetrics = this.getSystemMetrics(period);
      const topCreators = this.getTopCreators(period, 10);
      const topContent = this.getTopContent(period, 10);
      const engagementTrends = this.getEngagementTrends(period);
      
      return {
        timestamp: new Date().toISOString(),
        period,
        systemMetrics,
        topCreators,
        topContent,
        engagementTrends,
        serviceMetrics: this.getServiceMetrics(),
        recommendations: this.generateAnalyticsRecommendations(systemMetrics)
      };
      
    } catch (error) {
      console.error('Error generating analytics report:', error);
      throw error;
    }
  }

  /**
   * Get top creators by engagement
   * @param {Object} period - Time period
   * @param {number} limit - Number of creators to return
   * @returns {Array} Top creators
   */
  getTopCreators(period, limit = 10) {
    try {
      return this.db.prepare(`
        SELECT 
          creator_address,
          SUM(engagement_weight) as total_engagement,
          COUNT(DISTINCT user_address) as unique_users,
          COUNT(*) as total_events
        FROM engagement_events
        WHERE timestamp >= ? AND timestamp <= ?
        GROUP BY creator_address
        ORDER BY total_engagement DESC
        LIMIT ?
      `).all(period.start.toISOString(), period.end.toISOString(), limit);
      
    } catch (error) {
      console.error('Error getting top creators:', error);
      return [];
    }
  }

  /**
   * Get top content by engagement
   * @param {Object} period - Time period
   * @param {number} limit - Number of content items to return
   * @returns {Array} Top content
   */
  getTopContent(period, limit = 10) {
    try {
      return this.db.prepare(`
        SELECT 
          content_id,
          creator_address,
          SUM(engagement_weight) as total_engagement,
          COUNT(DISTINCT user_address) as unique_users,
          COUNT(*) as total_events
        FROM engagement_events
        WHERE timestamp >= ? AND timestamp <= ?
        GROUP BY content_id, creator_address
        ORDER BY total_engagement DESC
        LIMIT ?
      `).all(period.start.toISOString(), period.end.toISOString(), limit);
      
    } catch (error) {
      console.error('Error getting top content:', error);
      return [];
    }
  }

  /**
   * Get engagement trends over time
   * @param {Object} period - Time period
   * @returns {Array} Engagement trends
   */
  getEngagementTrends(period) {
    try {
      return this.db.prepare(`
        SELECT 
          DATE(timestamp) as date,
          SUM(engagement_weight) as total_engagement,
          COUNT(DISTINCT user_address) as unique_users,
          COUNT(*) as total_events
        FROM engagement_events
        WHERE timestamp >= ? AND timestamp <= ?
        GROUP BY DATE(timestamp)
        ORDER BY date
      `).all(period.start.toISOString(), period.end.toISOString());
      
    } catch (error) {
      console.error('Error getting engagement trends:', error);
      return [];
    }
  }

  /**
   * Generate analytics recommendations
   * @param {Object} systemMetrics - System metrics
   * @returns {Array} Recommendations
   */
  generateAnalyticsRecommendations(systemMetrics) {
    const recommendations = [];
    
    if (!systemMetrics) return recommendations;
    
    // Check engagement quality
    if (systemMetrics.averageQualityScore < 0.5) {
      recommendations.push({
        type: 'quality',
        priority: 'medium',
        action: 'improve_content_quality',
        message: 'Low average engagement quality detected'
      });
    }
    
    // Check user engagement
    if (systemMetrics.averageEngagementPerUser < 5) {
      recommendations.push({
        type: 'engagement',
        priority: 'low',
        action: 'increase_user_engagement',
        message: 'Low average engagement per user'
      });
    }
    
    return recommendations;
  }
}

module.exports = {
  EngagementMetricsService
};
