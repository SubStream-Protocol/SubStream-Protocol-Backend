const crypto = require('crypto');
const { logger } = require('../utils/logger');

/**
 * Behavioral Biometric Data Collection and Analysis Service
 * Tracks user interaction patterns to detect automated/bot behavior
 */
class BehavioralBiometricService {
  constructor(database, config = {}) {
    this.database = database;
    this.config = {
      // Data collection settings
      collection: {
        enabled: config.collection?.enabled !== false,
        sampleRate: config.collection?.sampleRate || 1.0, // 100% sampling
        maxEventsPerSession: config.collection?.maxEventsPerSession || 1000,
        sessionTimeout: config.collection?.sessionTimeout || 30 * 60 * 1000, // 30 minutes
        anonymizeIP: config.collection?.anonymizeIP !== false,
        hashSalt: config.collection?.hashSalt || crypto.randomBytes(32).toString('hex')
      },
      // ML model settings
      classifier: {
        enabled: config.classifier?.enabled !== false,
        modelType: config.classifier?.modelType || 'random_forest',
        trainingThreshold: config.classifier?.trainingThreshold || 100,
        confidenceThreshold: config.classifier?.confidenceThreshold || 0.7,
        retrainInterval: config.classifier?.retrainInterval || 7 * 24 * 60 * 60 * 1000 // 7 days
      },
      // Detection thresholds
      thresholds: {
        botScoreThreshold: config.thresholds?.botScoreThreshold || 0.8,
        throttlingThreshold: config.thresholds?.throttlingThreshold || 0.6,
        watchListThreshold: config.thresholds?.watchListThreshold || 0.9,
        anomalyThreshold: config.thresholds?.anomalyThreshold || 0.75
      },
      // Privacy settings
      privacy: {
        dataRetentionDays: config.privacy?.dataRetentionDays || 30,
        hashPersonalData: config.privacy?.hashPersonalData !== false,
        excludePII: config.privacy?.excludePII !== false,
        gdprCompliant: config.privacy?.gdprCompliant !== false
      },
      ...config
    };

    // Initialize behavioral tracking
    this.initializeBehavioralTracking();
    
    // ML model state
    this.mlModel = null;
    this.modelStats = {
      totalPredictions: 0,
      correctPredictions: 0,
      falsePositives: 0,
      falseNegatives: 0,
      lastTrained: null
    };

    // Session tracking
    this.activeSessions = new Map();
    this.sessionCleanupInterval = setInterval(() => {
      this.cleanupExpiredSessions();
    }, 5 * 60 * 1000); // Every 5 minutes
  }

  /**
   * Initialize behavioral tracking database tables
   */
  initializeBehavioralTracking() {
    try {
      this.database.db.exec(`
        CREATE TABLE IF NOT EXISTS behavioral_sessions (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          user_fingerprint TEXT,
          start_time TEXT NOT NULL,
          end_time TEXT,
          total_events INTEGER DEFAULT 0,
          bot_score REAL DEFAULT 0,
          is_flagged INTEGER DEFAULT 0,
          is_throttled INTEGER DEFAULT 0,
          risk_level TEXT DEFAULT 'unknown',
          behavioral_hash TEXT,
          metadata_json TEXT,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS behavioral_events (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          coordinates_x REAL,
          coordinates_y REAL,
          target_element TEXT,
          viewport_width INTEGER,
          viewport_height INTEGER,
          user_agent TEXT,
          movement_speed REAL,
          click_pattern TEXT,
          keystroke_timing TEXT,
          scroll_pattern TEXT,
          metadata_json TEXT,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS behavioral_patterns (
          id TEXT PRIMARY KEY,
          pattern_hash TEXT NOT NULL,
          pattern_type TEXT NOT NULL,
          confidence REAL DEFAULT 0,
          frequency INTEGER DEFAULT 1,
          last_seen TEXT NOT NULL,
          is_bot_pattern INTEGER DEFAULT 0,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS high_risk_watch_list (
          id TEXT PRIMARY KEY,
          stellar_address TEXT NOT NULL,
          reason TEXT NOT NULL,
          risk_score REAL DEFAULT 0,
          session_id TEXT,
          added_at TEXT NOT NULL,
          expires_at TEXT,
          is_active INTEGER DEFAULT 1,
          metadata_json TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_behavioral_sessions_session_id ON behavioral_sessions(session_id);
        CREATE INDEX IF NOT EXISTS idx_behavioral_sessions_start_time ON behavioral_sessions(start_time);
        CREATE INDEX IF NOT EXISTS idx_behavioral_sessions_bot_score ON behavioral_sessions(bot_score);
        CREATE INDEX IF NOT EXISTS idx_behavioral_events_session_id ON behavioral_events(session_id);
        CREATE INDEX IF NOT EXISTS idx_behavioral_events_timestamp ON behavioral_events(timestamp);
        CREATE INDEX IF NOT EXISTS idx_behavioral_patterns_hash ON behavioral_patterns(pattern_hash);
        CREATE INDEX IF NOT EXISTS idx_high_risk_watch_list_address ON high_risk_watch_list(stellar_address);
        CREATE INDEX IF NOT EXISTS idx_high_risk_watch_list_active ON high_risk_watch_list(is_active);
      `);

      logger.info('Behavioral biometric database tables initialized');
    } catch (error) {
      logger.error('Failed to initialize behavioral tracking tables', {
        error: error.message
      });
    }
  }

  /**
   * Start tracking a new session
   * @param {string} sessionId - Unique session identifier
   * @param {object} sessionData - Initial session data
   * @returns {object} Session tracking result
   */
  startSession(sessionId, sessionData = {}) {
    try {
      if (!this.config.collection.enabled) {
        return { tracking: false, reason: 'Behavioral tracking disabled' };
      }

      const sessionRecord = {
        id: `session_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`,
        sessionId,
        userFingerprint: this.generateUserFingerprint(sessionData),
        startTime: new Date().toISOString(),
        endTime: null,
        totalEvents: 0,
        botScore: 0,
        isFlagged: false,
        isThrottled: false,
        riskLevel: 'unknown',
        behavioralHash: null,
        metadata: {
          userAgent: sessionData.userAgent,
          viewport: sessionData.viewport,
          platform: sessionData.platform,
          language: sessionData.language
        },
        events: [],
        createdAt: new Date().toISOString()
      };

      // Store in active sessions
      this.activeSessions.set(sessionId, sessionRecord);

      // Store in database
      this.database.db.prepare(`
        INSERT INTO behavioral_sessions (
          id, session_id, user_fingerprint, start_time, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        sessionRecord.id,
        sessionId,
        sessionRecord.userFingerprint,
        sessionRecord.startTime,
        JSON.stringify(sessionRecord.metadata),
        sessionRecord.createdAt
      );

      logger.debug('Started behavioral tracking session', {
        sessionId,
        fingerprint: sessionRecord.userFingerprint
      });

      return {
        tracking: true,
        sessionId,
        fingerprint: sessionRecord.userFingerprint
      };

    } catch (error) {
      logger.error('Failed to start behavioral session', {
        sessionId,
        error: error.message
      });

      return {
        tracking: false,
        error: error.message
      };
    }
  }

  /**
   * Record a behavioral event
   * @param {string} sessionId - Session identifier
   * @param {object} eventData - Event data
   * @returns {object} Recording result
   */
  recordEvent(sessionId, eventData) {
    try {
      if (!this.config.collection.enabled) {
        return { recorded: false, reason: 'Behavioral tracking disabled' };
      }

      const session = this.activeSessions.get(sessionId);
      if (!session) {
        return { recorded: false, reason: 'Session not found' };
      }

      // Check event limit
      if (session.totalEvents >= this.config.collection.maxEventsPerSession) {
        return { recorded: false, reason: 'Event limit reached' };
      }

      // Process event data
      const processedEvent = this.processEvent(eventData, session);
      
      // Store event
      const eventId = `event_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
      
      this.database.db.prepare(`
        INSERT INTO behavioral_events (
          id, session_id, event_type, timestamp, coordinates_x, coordinates_y,
          target_element, viewport_width, viewport_height, user_agent,
          movement_speed, click_pattern, keystroke_timing, scroll_pattern,
          metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        eventId,
        sessionId,
        processedEvent.eventType,
        processedEvent.timestamp,
        processedEvent.coordinates?.x || null,
        processedEvent.coordinates?.y || null,
        processedEvent.targetElement || null,
        processedEvent.viewport?.width || null,
        processedEvent.viewport?.height || null,
        processedEvent.userAgent || null,
        processedEvent.movementSpeed || null,
        processedEvent.clickPattern || null,
        processedEvent.keystrokeTiming || null,
        processedEvent.scrollPattern || null,
        JSON.stringify(processedEvent.metadata || {}),
        processedEvent.timestamp
      );

      // Update session
      session.totalEvents++;
      session.events.push(processedEvent);

      // Analyze session periodically
      if (session.totalEvents % 10 === 0) {
        this.analyzeSession(sessionId);
      }

      return {
        recorded: true,
        eventId,
        eventCount: session.totalEvents
      };

    } catch (error) {
      logger.error('Failed to record behavioral event', {
        sessionId,
        error: error.message
      });

      return {
        recorded: false,
        error: error.message
      };
    }
  }

  /**
   * Process and normalize event data
   * @param {object} eventData - Raw event data
   * @param {object} session - Session context
   * @returns {object} Processed event data
   */
  processEvent(eventData, session) {
    const processedEvent = {
      eventType: eventData.type || 'unknown',
      timestamp: eventData.timestamp || new Date().toISOString(),
      coordinates: eventData.coordinates || null,
      targetElement: eventData.targetElement || null,
      viewport: eventData.viewport || session.metadata?.viewport || null,
      userAgent: eventData.userAgent || session.metadata?.userAgent || null,
      metadata: {}
    };

    // Calculate movement speed for mouse events
    if (processedEvent.eventType === 'mousemove' && session.events.length > 0) {
      const lastEvent = session.events[session.events.length - 1];
      if (lastEvent.coordinates && processedEvent.coordinates) {
        const distance = Math.sqrt(
          Math.pow(processedEvent.coordinates.x - lastEvent.coordinates.x, 2) +
          Math.pow(processedEvent.coordinates.y - lastEvent.coordinates.y, 2)
        );
        const timeDiff = new Date(processedEvent.timestamp) - new Date(lastEvent.timestamp);
        processedEvent.movementSpeed = timeDiff > 0 ? distance / timeDiff : 0;
      }
    }

    // Analyze click patterns
    if (processedEvent.eventType === 'click') {
      processedEvent.clickPattern = this.analyzeClickPattern(session.events, processedEvent);
    }

    // Analyze keystroke timing
    if (processedEvent.eventType === 'keydown') {
      processedEvent.keystrokeTiming = this.analyzeKeystrokeTiming(session.events, processedEvent);
    }

    // Analyze scroll patterns
    if (processedEvent.eventType === 'scroll') {
      processedEvent.scrollPattern = this.analyzeScrollPattern(session.events, processedEvent);
    }

    // Anonymize sensitive data if enabled
    if (this.config.collection.anonymizeIP && processedEvent.metadata?.ip) {
      processedEvent.metadata.ip = this.hashData(processedEvent.metadata.ip);
    }

    return processedEvent;
  }

  /**
   * Analyze click patterns
   * @param {array} previousEvents - Previous session events
   * @param {object} currentEvent - Current click event
   * @returns {string} Click pattern description
   */
  analyzeClickPattern(previousEvents, currentEvent) {
    const clickEvents = previousEvents.filter(e => e.eventType === 'click');
    
    if (clickEvents.length === 0) {
      return 'first_click';
    }

    const lastClick = clickEvents[clickEvents.length - 1];
    const timeDiff = new Date(currentEvent.timestamp) - new Date(lastClick.timestamp);
    
    // Analyze timing patterns
    if (timeDiff < 50) {
      return 'rapid_click';
    } else if (timeDiff > 5000) {
      return 'delayed_click';
    } else {
      return 'normal_click';
    }
  }

  /**
   * Analyze keystroke timing patterns
   * @param {array} previousEvents - Previous session events
   * @param {object} currentEvent - Current keystroke event
   * @returns {object} Keystroke timing analysis
   */
  analyzeKeystrokeTiming(previousEvents, currentEvent) {
    const keyEvents = previousEvents.filter(e => e.eventType === 'keydown');
    
    if (keyEvents.length === 0) {
      return { pattern: 'first_keystroke', interval: null };
    }

    const lastKey = keyEvents[keyEvents.length - 1];
    const interval = new Date(currentEvent.timestamp) - new Date(lastKey.timestamp);
    
    return {
      pattern: interval < 50 ? 'rapid_typing' : interval > 1000 ? 'slow_typing' : 'normal_typing',
      interval,
      consistency: this.calculateTypingConsistency(keyEvents)
    };
  }

  /**
   * Analyze scroll patterns
   * @param {array} previousEvents - Previous session events
   * @param {object} currentEvent - Current scroll event
   * @returns {object} Scroll pattern analysis
   */
  analyzeScrollPattern(previousEvents, currentEvent) {
    const scrollEvents = previousEvents.filter(e => e.eventType === 'scroll');
    
    if (scrollEvents.length === 0) {
      return { pattern: 'first_scroll', velocity: null };
    }

    const lastScroll = scrollEvents[scrollEvents.length - 1];
    const timeDiff = new Date(currentEvent.timestamp) - new Date(lastScroll.timestamp);
    const velocity = timeDiff > 0 ? Math.abs(currentEvent.metadata?.scrollDelta || 0) / timeDiff : 0;
    
    return {
      pattern: velocity > 10 ? 'fast_scroll' : velocity < 1 ? 'slow_scroll' : 'normal_scroll',
      velocity,
      smoothness: this.calculateScrollSmoothness(scrollEvents)
    };
  }

  /**
   * Calculate typing consistency
   * @param {array} keyEvents - Keyboard events
   * @returns {number} Consistency score (0-1)
   */
  calculateTypingConsistency(keyEvents) {
    if (keyEvents.length < 3) return 0.5;
    
    const intervals = [];
    for (let i = 1; i < keyEvents.length; i++) {
      const interval = new Date(keyEvents[i].timestamp) - new Date(keyEvents[i-1].timestamp);
      intervals.push(interval);
    }
    
    const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const variance = intervals.reduce((sum, interval) => sum + Math.pow(interval - mean, 2), 0) / intervals.length;
    const stdDev = Math.sqrt(variance);
    
    // Consistency is inverse of standard deviation (normalized)
    return Math.max(0, 1 - (stdDev / mean));
  }

  /**
   * Calculate scroll smoothness
   * @param {array} scrollEvents - Scroll events
   * @returns {number} Smoothness score (0-1)
   */
  calculateScrollSmoothness(scrollEvents) {
    if (scrollEvents.length < 3) return 0.5;
    
    const velocities = [];
    for (let i = 1; i < scrollEvents.length; i++) {
      const timeDiff = new Date(scrollEvents[i].timestamp) - new Date(scrollEvents[i-1].timestamp);
      if (timeDiff > 0) {
        const velocity = Math.abs(scrollEvents[i].metadata?.scrollDelta || 0) / timeDiff;
        velocities.push(velocity);
      }
    }
    
    if (velocities.length === 0) return 0.5;
    
    const mean = velocities.reduce((a, b) => a + b, 0) / velocities.length;
    const variance = velocities.reduce((sum, velocity) => sum + Math.pow(velocity - mean, 2), 0) / velocities.length;
    
    // Smoothness is inverse of velocity variance
    return Math.max(0, 1 - (variance / (mean * mean)));
  }

  /**
   * Analyze session for bot-like behavior
   * @param {string} sessionId - Session identifier
   * @returns {object} Analysis results
   */
  analyzeSession(sessionId) {
    try {
      const session = this.activeSessions.get(sessionId);
      if (!session) {
        return { error: 'Session not found' };
      }

      // Calculate behavioral features
      const features = this.extractBehavioralFeatures(session);
      
      // Generate behavioral hash
      const behavioralHash = this.generateBehavioralHash(features);
      session.behavioralHash = behavioralHash;

      // Run ML classifier if available
      let botScore = 0.5; // Default neutral score
      let confidence = 0;
      
      if (this.mlModel && this.config.classifier.enabled) {
        const prediction = this.mlModel.predict(features);
        botScore = prediction.score;
        confidence = prediction.confidence;
      } else {
        // Fallback to rule-based analysis
        botScore = this.ruleBasedBotDetection(features);
      }

      // Update session
      session.botScore = botScore;
      session.riskLevel = this.calculateRiskLevel(botScore);

      // Apply thresholds
      const flagged = botScore >= this.config.thresholds.botScoreThreshold;
      const throttled = botScore >= this.config.thresholds.throttlingThreshold;
      
      session.isFlagged = flagged;
      session.isThrottled = throttled;

      // Update database
      this.database.db.prepare(`
        UPDATE behavioral_sessions 
        SET bot_score = ?, risk_level = ?, is_flagged = ?, is_throttled = ?, 
            behavioral_hash = ?, total_events = ?
        WHERE session_id = ?
      `).run(
        botScore,
        session.riskLevel,
        flagged ? 1 : 0,
        throttled ? 1 : 0,
        behavioralHash,
        session.totalEvents,
        sessionId
      );

      // Apply throttling if needed
      if (throttled) {
        this.applySessionThrottling(sessionId);
      }

      // Add to watch list if high risk
      if (botScore >= this.config.thresholds.watchListThreshold) {
        this.addToWatchList(sessionId, botScore, 'High bot score detected');
      }

      logger.info('Session analysis completed', {
        sessionId,
        botScore,
        riskLevel: session.riskLevel,
        flagged,
        throttled,
        eventCount: session.totalEvents
      });

      return {
        sessionId,
        botScore,
        riskLevel: session.riskLevel,
        flagged,
        throttled,
        confidence,
        features,
        behavioralHash
      };

    } catch (error) {
      logger.error('Failed to analyze session', {
        sessionId,
        error: error.message
      });

      return {
        error: error.message
      };
    }
  }

  /**
   * Extract behavioral features from session data
   * @param {object} session - Session data
   * @returns {object} Behavioral features
   */
  extractBehavioralFeatures(session) {
    const events = session.events || [];
    
    // Basic session metrics
    const sessionDuration = new Date() - new Date(session.startTime);
    const eventsPerMinute = events.length / (sessionDuration / 60000);
    
    // Mouse movement features
    const mouseEvents = events.filter(e => e.eventType === 'mousemove');
    const mouseSpeeds = mouseEvents.map(e => e.movementSpeed).filter(s => s !== null);
    const avgMouseSpeed = mouseSpeeds.length > 0 ? mouseSpeeds.reduce((a, b) => a + b, 0) / mouseSpeeds.length : 0;
    const mouseSpeedVariance = this.calculateVariance(mouseSpeeds);
    
    // Click features
    const clickEvents = events.filter(e => e.eventType === 'click');
    const clickIntervals = this.calculateClickIntervals(clickEvents);
    const avgClickInterval = clickIntervals.length > 0 ? clickIntervals.reduce((a, b) => a + b, 0) / clickIntervals.length : 0;
    
    // Typing features
    const keyEvents = events.filter(e => e.eventType === 'keydown');
    const typingConsistency = this.calculateTypingConsistency(keyEvents);
    
    // Scroll features
    const scrollEvents = events.filter(e => e.eventType === 'scroll');
    const scrollSmoothness = this.calculateScrollSmoothness(scrollEvents);
    
    // Pattern features
    const clickPatterns = clickEvents.map(e => e.clickPattern);
    const rapidClicks = clickPatterns.filter(p => p === 'rapid_click').length;
    const delayedClicks = clickPatterns.filter(p => p === 'delayed_click').length;
    
    return {
      sessionDuration,
      eventsPerMinute,
      avgMouseSpeed,
      mouseSpeedVariance,
      avgClickInterval,
      typingConsistency,
      scrollSmoothness,
      rapidClicks,
      delayedClicks,
      totalEvents: events.length,
      mouseEvents: mouseEvents.length,
      clickEvents: clickEvents.length,
      keyEvents: keyEvents.length,
      scrollEvents: scrollEvents.length
    };
  }

  /**
   * Rule-based bot detection fallback
   * @param {object} features - Behavioral features
   * @returns {number} Bot score (0-1)
   */
  ruleBasedBotDetection(features) {
    let score = 0;
    let factors = 0;

    // High events per minute
    if (features.eventsPerMinute > 100) {
      score += 0.3;
      factors++;
    }

    // Low mouse speed variance (robotic movement)
    if (features.mouseSpeedVariance < 0.1 && features.avgMouseSpeed > 0) {
      score += 0.2;
      factors++;
    }

    // Very consistent typing (robotic)
    if (features.typingConsistency > 0.95 && features.keyEvents > 10) {
      score += 0.2;
      factors++;
    }

    // Rapid clicking patterns
    if (features.rapidClicks > features.clickEvents * 0.5) {
      score += 0.2;
      factors++;
    }

    // No natural delays
    if (features.delayedClicks === 0 && features.clickEvents > 5) {
      score += 0.1;
      factors++;
    }

    // Normalize score
    return factors > 0 ? score / factors : 0.5;
  }

  /**
   * Calculate variance of an array
   * @param {array} values - Array of numbers
   * @returns {number} Variance
   */
  calculateVariance(values) {
    if (values.length === 0) return 0;
    
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    return values.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / values.length;
  }

  /**
   * Calculate click intervals
   * @param {array} clickEvents - Click events
   * @returns {array} Click intervals in milliseconds
   */
  calculateClickIntervals(clickEvents) {
    const intervals = [];
    for (let i = 1; i < clickEvents.length; i++) {
      const interval = new Date(clickEvents[i].timestamp) - new Date(clickEvents[i-1].timestamp);
      intervals.push(interval);
    }
    return intervals;
  }

  /**
   * Calculate risk level from bot score
   * @param {number} botScore - Bot score (0-1)
   * @returns {string} Risk level
   */
  calculateRiskLevel(botScore) {
    if (botScore >= 0.9) return 'critical';
    if (botScore >= 0.75) return 'high';
    if (botScore >= 0.5) return 'medium';
    if (botScore >= 0.25) return 'low';
    return 'minimal';
  }

  /**
   * Generate behavioral hash
   * @param {object} features - Behavioral features
   * @returns {string} Behavioral hash
   */
  generateBehavioralHash(features) {
    const hashData = {
      eventsPerMinute: Math.round(features.eventsPerMinute),
      avgMouseSpeed: Math.round(features.avgMouseSpeed * 100) / 100,
      typingConsistency: Math.round(features.typingConsistency * 100) / 100,
      scrollSmoothness: Math.round(features.scrollSmoothness * 100) / 100,
      rapidClicks: features.rapidClicks,
      totalEvents: features.totalEvents
    };
    
    return this.hashData(JSON.stringify(hashData));
  }

  /**
   * Generate user fingerprint
   * @param {object} sessionData - Session data
   * @returns {string} User fingerprint
   */
  generateUserFingerprint(sessionData) {
    const fingerprintData = {
      userAgent: sessionData.userAgent || '',
      viewport: sessionData.viewport || '',
      platform: sessionData.platform || '',
      language: sessionData.language || '',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
    };
    
    return this.hashData(JSON.stringify(fingerprintData));
  }

  /**
   * Hash data with salt
   * @param {string} data - Data to hash
   * @returns {string} Hashed data
   */
  hashData(data) {
    return crypto
      .createHash('sha256')
      .update(data + this.config.collection.hashSalt)
      .digest('hex');
  }

  /**
   * Apply session throttling
   * @param {string} sessionId - Session identifier
   */
  applySessionThrottling(sessionId) {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    // Add throttling metadata
    session.throttledAt = new Date().toISOString();
    session.throttlingLevel = this.calculateThrottlingLevel(session.botScore);

    logger.warn('Session throttling applied', {
      sessionId,
      botScore: session.botScore,
      throttlingLevel: session.throttlingLevel
    });

    // Update database
    this.database.db.prepare(`
      UPDATE behavioral_sessions 
      SET is_throttled = 1, metadata_json = json_patch(metadata_json, ?)
      WHERE session_id = ?
    `).run(
      JSON.stringify({ throttledAt: session.throttledAt, throttlingLevel: session.throttlingLevel }),
      sessionId
    );
  }

  /**
   * Calculate throttling level
   * @param {number} botScore - Bot score
   * @returns {number} Throttling level (0.1-1.0)
   */
  calculateThrottlingLevel(botScore) {
    if (botScore >= 0.9) return 0.1; // 90% throttling
    if (botScore >= 0.8) return 0.3; // 70% throttling
    if (botScore >= 0.7) return 0.5; // 50% throttling
    if (botScore >= 0.6) return 0.7; // 30% throttling
    return 1.0; // No throttling
  }

  /**
   * Add session to high-risk watch list
   * @param {string} sessionId - Session identifier
   * @param {number} riskScore - Risk score
   * @param {string} reason - Reason for addition
   */
  addToWatchList(sessionId, riskScore, reason) {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    // Get stellar address from session metadata
    const stellarAddress = session.metadata?.stellarAddress;
    if (!stellarAddress) {
      logger.warn('No stellar address found for watch list addition', {
        sessionId,
        riskScore,
        reason
      });
      return;
    }

    const watchListId = `watch_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
    const expiresAt = new Date(Date.now() + (30 * 24 * 60 * 60 * 1000)).toISOString(); // 30 days

    this.database.db.prepare(`
      INSERT INTO high_risk_watch_list (
        id, stellar_address, reason, risk_score, session_id, added_at, expires_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      watchListId,
      stellarAddress,
      reason,
      riskScore,
      sessionId,
      new Date().toISOString(),
      expiresAt,
      JSON.stringify({
        sessionId,
        botScore: session.botScore,
        riskLevel: session.riskLevel,
        fingerprint: session.userFingerprint
      })
    );

    logger.warn('Added to high-risk watch list', {
      watchListId,
      stellarAddress: this.hashData(stellarAddress), // Hash for privacy
      riskScore,
      reason,
      sessionId
    });
  }

  /**
   * Check if address is on watch list
   * @param {string} stellarAddress - Stellar address to check
   * @returns {object} Watch list status
   */
  checkWatchList(stellarAddress) {
    const record = this.database.db.prepare(`
      SELECT * FROM high_risk_watch_list 
      WHERE stellar_address = ? AND is_active = 1 AND (expires_at IS NULL OR expires_at > ?)
    `).get(stellarAddress, new Date().toISOString());

    if (!record) {
      return { onWatchList: false };
    }

    return {
      onWatchList: true,
      watchListId: record.id,
      riskScore: record.risk_score,
      reason: record.reason,
      addedAt: record.added_at,
      expiresAt: record.expires_at,
      metadata: JSON.parse(record.metadata_json || '{}')
    };
  }

  /**
   * End session tracking
   * @param {string} sessionId - Session identifier
   * @returns {object} Session summary
   */
  endSession(sessionId) {
    try {
      const session = this.activeSessions.get(sessionId);
      if (!session) {
        return { error: 'Session not found' };
      }

      // Final analysis
      const analysis = this.analyzeSession(sessionId);

      // Update session end time
      session.endTime = new Date().toISOString();
      
      // Update database
      this.database.db.prepare(`
        UPDATE behavioral_sessions 
        SET end_time = ?, bot_score = ?, risk_level = ?, is_flagged = ?, is_throttled = ?
        WHERE session_id = ?
      `).run(
        session.endTime,
        session.botScore,
        session.riskLevel,
        session.isFlagged ? 1 : 0,
        session.isThrottled ? 1 : 0,
        sessionId
      );

      // Remove from active sessions
      this.activeSessions.delete(sessionId);

      logger.info('Session ended', {
        sessionId,
        duration: new Date(session.endTime) - new Date(session.startTime),
        botScore: session.botScore,
        riskLevel: session.riskLevel,
        totalEvents: session.totalEvents
      });

      return {
        sessionId,
        duration: new Date(session.endTime) - new Date(session.startTime),
        botScore: session.botScore,
        riskLevel: session.riskLevel,
        totalEvents: session.totalEvents,
        flagged: session.isFlagged,
        throttled: session.isThrottled,
        analysis
      };

    } catch (error) {
      logger.error('Failed to end session', {
        sessionId,
        error: error.message
      });

      return {
        error: error.message
      };
    }
  }

  /**
   * Clean up expired sessions
   */
  cleanupExpiredSessions() {
    const now = Date.now();
    const expiredSessions = [];

    for (const [sessionId, session] of this.activeSessions.entries()) {
      const sessionAge = now - new Date(session.startTime).getTime();
      if (sessionAge > this.config.collection.sessionTimeout) {
        expiredSessions.push(sessionId);
      }
    }

    expiredSessions.forEach(sessionId => {
      this.endSession(sessionId);
    });

    if (expiredSessions.length > 0) {
      logger.debug('Cleaned up expired sessions', {
        count: expiredSessions.length
      });
    }
  }

  /**
   * Get behavioral analytics
   * @param {object} options - Analytics options
   * @returns {object} Analytics data
   */
  getBehavioralAnalytics(options = {}) {
    const {
      period = '24h',
      includeDetails = false
    } = options;

    const startDate = this.getStartDate(period);

    // Session analytics
    const sessionStats = this.database.db.prepare(`
      SELECT 
        COUNT(*) as total_sessions,
        AVG(bot_score) as avg_bot_score,
        MAX(bot_score) as max_bot_score,
        COUNT(CASE WHEN is_flagged = 1 THEN 1 END) as flagged_sessions,
        COUNT(CASE WHEN is_throttled = 1 THEN 1 END) as throttled_sessions,
        risk_level,
        COUNT(*) as count
      FROM behavioral_sessions 
      WHERE start_time > ?
      GROUP BY risk_level
    `).all(startDate.toISOString());

    // Risk distribution
    const riskDistribution = sessionStats.reduce((acc, row) => {
      acc[row.risk_level] = row.count;
      return acc;
    }, {});

    // Top flagged sessions
    const topFlaggedSessions = this.database.db.prepare(`
      SELECT session_id, bot_score, risk_level, total_events, start_time
      FROM behavioral_sessions 
      WHERE start_time > ? AND is_flagged = 1
      ORDER BY bot_score DESC
      LIMIT 10
    `).all(startDate.toISOString());

    // Watch list analytics
    const watchListStats = this.database.db.prepare(`
      SELECT 
        COUNT(*) as total_entries,
        AVG(risk_score) as avg_risk_score,
        COUNT(CASE WHERE expires_at > ? THEN 1 END) as active_entries
      FROM high_risk_watch_list
    `).get(startDate.toISOString(), new Date().toISOString());

    return {
      period,
      timestamp: new Date().toISOString(),
      sessionStats: {
        totalSessions: sessionStats.reduce((sum, row) => sum + row.count, 0),
        avgBotScore: sessionStats.reduce((sum, row) => sum + (row.avg_bot_score * row.count), 0) / sessionStats.reduce((sum, row) => sum + row.count, 0) || 0,
        maxBotScore: Math.max(...sessionStats.map(row => row.max_bot_score)),
        flaggedSessions: sessionStats.reduce((sum, row) => sum + row.flagged_sessions, 0),
        throttledSessions: sessionStats.reduce((sum, row) => sum + row.throttled_sessions, 0)
      },
      riskDistribution,
      topFlaggedSessions,
      watchList: watchListStats,
      activeSessions: this.activeSessions.size
    };
  }

  /**
   * Get start date for period
   * @param {string} period - Period string
   * @returns {Date} Start date
   */
  getStartDate(period) {
    const now = new Date();
    switch (period) {
      case '1h':
        return new Date(now.getTime() - 60 * 60 * 1000);
      case '24h':
        return new Date(now.getTime() - 24 * 60 * 60 * 1000);
      case '7d':
        return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      case '30d':
        return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      default:
        return new Date(now.getTime() - 24 * 60 * 60 * 1000);
    }
  }

  /**
   * Get service statistics
   * @returns {object} Service statistics
   */
  getServiceStats() {
    return {
      config: this.config,
      activeSessions: this.activeSessions.size,
      modelStats: this.mlModel ? this.modelStats : null,
      databaseStats: {
        totalSessions: this.database.db.prepare('SELECT COUNT(*) FROM behavioral_sessions').get()['COUNT(*)'],
        totalEvents: this.database.db.prepare('SELECT COUNT(*) FROM behavioral_events').get()['COUNT(*)'],
        watchListEntries: this.database.db.prepare('SELECT COUNT(*) FROM high_risk_watch_list WHERE is_active = 1').get()['COUNT(*)']
      }
    };
  }

  /**
   * Clean up old data for privacy compliance
   */
  cleanupOldData() {
    try {
      const cutoffDate = new Date(Date.now() - (this.config.privacy.dataRetentionDays * 24 * 60 * 60 * 1000));
      
      // Clean up old sessions
      const deletedSessions = this.database.db.prepare(`
        DELETE FROM behavioral_sessions WHERE start_time < ?
      `).run(cutoffDate.toISOString());

      // Clean up old events
      const deletedEvents = this.database.db.prepare(`
        DELETE FROM behavioral_events WHERE created_at < ?
      `).run(cutoffDate.toISOString());

      // Clean up expired watch list entries
      const deletedWatchList = this.database.db.prepare(`
        DELETE FROM high_risk_watch_list WHERE expires_at < ?
      `).run(cutoffDate.toISOString());

      logger.info('Cleaned up old behavioral data', {
        deletedSessions: deletedSessions.changes,
        deletedEvents: deletedEvents.changes,
        deletedWatchList: deletedWatchList.changes,
        cutoffDate: cutoffDate.toISOString()
      });

    } catch (error) {
      logger.error('Failed to cleanup old behavioral data', {
        error: error.message
      });
    }
  }

  /**
   * Stop the service
   */
  stop() {
    if (this.sessionCleanupInterval) {
      clearInterval(this.sessionCleanupInterval);
    }

    // End all active sessions
    for (const sessionId of this.activeSessions.keys()) {
      this.endSession(sessionId);
    }

    logger.info('Behavioral biometric service stopped');
  }
}

module.exports = { BehavioralBiometricService };
