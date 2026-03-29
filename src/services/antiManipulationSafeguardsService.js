/**
 * Anti-Manipulation Safeguards Service
 * 
 * Implements comprehensive safeguards against manipulation of the ScaledUserProp
 * revenue division system. This service provides multiple layers of protection
 * to ensure the integrity and fairness of the payout system.
 * 
 * Key Features:
 * - Multi-layer manipulation detection
 * - Real-time safeguard monitoring
 * - Adaptive threshold adjustment
 * - Economic incentive analysis
 * - Automated response mechanisms
 */

class AntiManipulationSafeguardsService {
  constructor(database, config = {}) {
    this.db = database;
    this.config = {
      // Detection thresholds
      suspiciousEngagementThreshold: config.suspiciousEngagementThreshold || 10,
      maxEngagementPerHour: config.maxEngagementPerHour || 100,
      maxAccountsPerIP: config.maxAccountsPerIP || 5,
      payoutVarianceThreshold: config.payoutVarianceThreshold || 0.5,
      
      // Response parameters
      autoBlockThreshold: config.autoBlockThreshold || 0.9,
      manualReviewThreshold: config.manualReviewThreshold || 0.7,
      cooldownPeriod: config.cooldownPeriod || 24 * 60 * 60 * 1000, // 24 hours
      
      // Adaptive parameters
      enableAdaptiveThresholds: config.enableAdaptiveThresholds !== false,
      thresholdAdjustmentRate: config.thresholdAdjustmentRate || 0.1,
      learningPeriod: config.learningPeriod || 7 * 24 * 60 * 60 * 1000, // 7 days
      
      // Economic safeguards
      maxPayoutConcentration: config.maxPayoutConcentration || 0.3, // 30% of total revenue
      minDistributedCreators: config.minDistributedCreators || 10,
      
      ...config
    };
    
    // Initialize database tables
    this.initializeDatabase();
    
    // Safeguard state
    this.safeguardState = {
      activeThreats: new Map(),
      blockedEntities: new Set(),
      adaptiveThresholds: new Map(),
      lastAdjustment: Date.now()
    };
    
    // Metrics tracking
    this.metrics = {
      threatsDetected: 0,
      threatsBlocked: 0,
      manualReviewsTriggered: 0,
      adaptiveAdjustments: 0,
      averageResponseTime: 0
    };
  }

  /**
   * Initialize database tables for anti-manipulation safeguards
   */
  initializeDatabase() {
    const tables = [
      // Manipulation detection records
      `CREATE TABLE IF NOT EXISTS manipulation_detections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        detection_id TEXT NOT NULL UNIQUE,
        threat_type TEXT NOT NULL,
        entity_address TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        confidence_score REAL NOT NULL,
        risk_level TEXT NOT NULL,
        detection_data TEXT NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        status TEXT DEFAULT 'active',
        response_action TEXT,
        response_timestamp DATETIME,
        reviewed_by TEXT,
        review_notes TEXT
      )`,
      
      // Safeguard actions taken
      `CREATE TABLE IF NOT EXISTS safeguard_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action_id TEXT NOT NULL UNIQUE,
        detection_id TEXT NOT NULL,
        action_type TEXT NOT NULL,
        entity_address TEXT NOT NULL,
        action_data TEXT NOT NULL,
        automated BOOLEAN DEFAULT TRUE,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        effectiveness_score REAL,
        duration_ms INTEGER,
        FOREIGN KEY (detection_id) REFERENCES manipulation_detections(detection_id)
      )`,
      
      // Adaptive threshold records
      `CREATE TABLE IF NOT EXISTS adaptive_thresholds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        threshold_name TEXT NOT NULL UNIQUE,
        current_value REAL NOT NULL,
        initial_value REAL NOT NULL,
        adjustment_count INTEGER DEFAULT 0,
        last_adjustment DATETIME DEFAULT CURRENT_TIMESTAMP,
        adjustment_reason TEXT,
        performance_impact REAL
      )`,
      
      // Economic safeguard records
      `CREATE TABLE IF NOT EXISTS economic_safeguards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        safeguard_id TEXT NOT NULL UNIQUE,
        safeguard_type TEXT NOT NULL,
        period_start DATETIME NOT NULL,
        period_end DATETIME NOT NULL,
        total_revenue REAL NOT NULL,
        payout_distribution TEXT NOT NULL,
        concentration_score REAL NOT NULL,
        fairness_score REAL NOT NULL,
        triggered BOOLEAN DEFAULT FALSE,
        action_taken TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      
      // Cooldown periods for entities
      `CREATE TABLE IF NOT EXISTS entity_cooldowns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_address TEXT NOT NULL UNIQUE,
        entity_type TEXT NOT NULL,
        cooldown_start DATETIME NOT NULL,
        cooldown_end DATETIME NOT NULL,
        reason TEXT NOT NULL,
        severity TEXT NOT NULL,
        is_active BOOLEAN DEFAULT TRUE
      )`,
      
      // Safeguard performance metrics
      `CREATE TABLE IF NOT EXISTS safeguard_performance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        metric_date DATE NOT NULL UNIQUE,
        threats_detected INTEGER DEFAULT 0,
        threats_blocked INTEGER DEFAULT 0,
        false_positives INTEGER DEFAULT 0,
        average_response_time REAL DEFAULT 0,
        adaptive_adjustments INTEGER DEFAULT 0,
        system_health_score REAL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    ];

    // Create indexes for performance
    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_manipulation_detections_entity ON manipulation_detections(entity_address, entity_type)',
      'CREATE INDEX IF NOT EXISTS idx_manipulation_detections_status ON manipulation_detections(status)',
      'CREATE INDEX IF NOT EXISTS idx_manipulation_detections_timestamp ON manipulation_detections(timestamp)',
      'CREATE INDEX IF NOT EXISTS idx_safeguard_actions_detection ON safeguard_actions(detection_id)',
      'CREATE INDEX IF NOT EXISTS idx_safeguard_actions_entity ON safeguard_actions(entity_address)',
      'CREATE INDEX IF NOT EXISTS idx_adaptive_thresholds_name ON adaptive_thresholds(threshold_name)',
      'CREATE INDEX IF NOT EXISTS idx_economic_safeguards_period ON economic_safeguards(period_start, period_end)',
      'CREATE INDEX IF NOT EXISTS idx_entity_cooldowns_active ON entity_cooldowns(is_active, cooldown_end)',
      'CREATE INDEX IF NOT EXISTS idx_safeguard_performance_date ON safeguard_performance(metric_date)'
    ];

    tables.forEach(sql => {
      try {
        this.db.run(sql);
      } catch (error) {
        console.error('Error creating safeguard table:', error);
      }
    });

    indexes.forEach(sql => {
      try {
        this.db.run(sql);
      } catch (error) {
        console.error('Error creating safeguard index:', error);
      }
    });

    // Initialize default adaptive thresholds
    this.initializeAdaptiveThresholds();
  }

  /**
   * Initialize default adaptive thresholds
   */
  initializeAdaptiveThresholds() {
    const defaultThresholds = [
      { name: 'suspicious_engagement_threshold', value: this.config.suspiciousEngagementThreshold },
      { name: 'max_engagement_per_hour', value: this.config.maxEngagementPerHour },
      { name: 'payout_variance_threshold', value: this.config.payoutVarianceThreshold },
      { name: 'auto_block_threshold', value: this.config.autoBlockThreshold },
      { name: 'manual_review_threshold', value: this.config.manualReviewThreshold }
    ];

    defaultThresholds.forEach(threshold => {
      try {
        this.db.prepare(`
          INSERT OR IGNORE INTO adaptive_thresholds 
          (threshold_name, current_value, initial_value)
          VALUES (?, ?, ?)
        `).run(threshold.name, threshold.value, threshold.value);
        
        this.safeguardState.adaptiveThresholds.set(threshold.name, threshold.value);
      } catch (error) {
        console.error('Error initializing threshold:', error);
      }
    });
  }

  /**
   * Run comprehensive anti-manipulation checks
   * @param {Object} context - Analysis context (user, creator, engagement, etc.)
   * @returns {Object} Safeguard analysis results
   */
  runSafeguardChecks(context) {
    const startTime = Date.now();
    
    try {
      const analysis = {
        context,
        timestamp: new Date().toISOString(),
        threats: [],
        overallRisk: 0,
        recommendations: [],
        actions: []
      };

      // Check if entity is in cooldown
      const cooldownStatus = this.checkCooldownStatus(context.entityAddress, context.entityType);
      if (cooldownStatus.isActive) {
        analysis.threats.push({
          type: 'cooldown_violation',
          severity: 'high',
          confidence: 1.0,
          description: 'Entity is currently in cooldown period',
          cooldownEnd: cooldownStatus.cooldownEnd
        });
        analysis.overallRisk = 1.0;
      } else {
        // Run various safeguard checks
        this.checkEngagementManipulation(context, analysis);
        this.checkPayoutManipulation(context, analysis);
        this.checkNetworkManipulation(context, analysis);
        this.checkTemporalManipulation(context, analysis);
        this.checkEconomicManipulation(context, analysis);
      }

      // Calculate overall risk
      analysis.overallRisk = this.calculateOverallRisk(analysis.threats);

      // Generate recommendations and actions
      analysis.recommendations = this.generateRecommendations(analysis);
      analysis.actions = this.determineActions(analysis);

      // Store detection record if threats found
      if (analysis.threats.length > 0) {
        this.storeManipulationDetection(analysis);
        this.metrics.threatsDetected++;
      }

      // Update performance metrics
      const responseTime = Date.now() - startTime;
      this.updatePerformanceMetrics(responseTime);

      return analysis;

    } catch (error) {
      console.error('Error running safeguard checks:', error);
      throw new Error(`Safeguard check failed: ${error.message}`);
    }
  }

  /**
   * Check for engagement manipulation
   * @param {Object} context - Analysis context
   * @param {Object} analysis - Analysis object to update
   */
  checkEngagementManipulation(context, analysis) {
    try {
      const { engagementData, userAddress } = context;
      
      if (!engagementData) return;

      // Check for unusually high engagement
      const totalEngagement = Object.values(engagementData).reduce((sum, weight) => sum + weight, 0);
      const threshold = this.getAdaptiveThreshold('suspicious_engagement_threshold');
      
      if (totalEngagement > threshold) {
        analysis.threats.push({
          type: 'high_engagement',
          severity: 'medium',
          confidence: Math.min(1.0, totalEngagement / (threshold * 2)),
          description: `Unusually high engagement: ${totalEngagement}`,
          engagementLevel: totalEngagement,
          threshold
        });
      }

      // Check for engagement concentration (single creator focus)
      const creatorCount = Object.keys(engagementData).length;
      if (creatorCount === 1 && totalEngagement > threshold / 2) {
        analysis.threats.push({
          type: 'engagement_concentration',
          severity: 'medium',
          confidence: 0.7,
          description: 'Engagement concentrated on single creator',
          creatorCount,
          totalEngagement
        });
      }

      // Check for robotic engagement patterns
      const engagementValues = Object.values(engagementData);
      const variance = this.calculateVariance(engagementValues);
      if (variance < 0.1 && engagementValues.length > 2) {
        analysis.threats.push({
          type: 'robotic_engagement',
          severity: 'high',
          confidence: 0.8,
          description: 'Robotic engagement pattern detected',
          variance,
          pattern: 'consistent'
        });
      }

    } catch (error) {
      console.error('Error checking engagement manipulation:', error);
    }
  }

  /**
   * Check for payout manipulation
   * @param {Object} context - Analysis context
   * @param {Object} analysis - Analysis object to update
   */
  checkPayoutManipulation(context, analysis) {
    try {
      const { creatorAddress, payoutData } = context;
      
      if (!payoutData) return;

      // Check for payout concentration
      const totalPayout = payoutData.totalRevenue || 0;
      const creatorPayout = payoutData.creatorPayouts?.[creatorAddress] || 0;
      const concentration = creatorPayout / totalPayout;
      
      if (concentration > this.config.maxPayoutConcentration) {
        analysis.threats.push({
          type: 'payout_concentration',
          severity: 'high',
          confidence: 0.9,
          description: `High payout concentration: ${(concentration * 100).toFixed(1)}%`,
          concentration,
          threshold: this.config.maxPayoutConcentration
        });
      }

      // Check for payout variance anomalies
      const payouts = Object.values(payoutData.creatorPayouts || {});
      const variance = this.calculateVariance(payouts);
      const threshold = this.getAdaptiveThreshold('payout_variance_threshold');
      
      if (variance > threshold) {
        analysis.threats.push({
          type: 'payout_variance_anomaly',
          severity: 'medium',
          confidence: 0.6,
          description: 'Unusual payout variance detected',
          variance,
          threshold
        });
      }

    } catch (error) {
      console.error('Error checking payout manipulation:', error);
    }
  }

  /**
   * Check for network manipulation
   @param {Object} context - Analysis context
   * @param {Object} analysis - Analysis object to update
   */
  checkNetworkManipulation(context, analysis) {
    try {
      const { userAddress, networkData } = context;
      
      if (!networkData) return;

      // Check for IP clustering
      const ipCount = networkData.ipClusterCount || 0;
      if (ipCount > this.config.maxAccountsPerIP) {
        analysis.threats.push({
          type: 'ip_clustering',
          severity: 'medium',
          confidence: 0.7,
          description: `Multiple accounts from same IP: ${ipCount}`,
          ipCount,
          threshold: this.config.maxAccountsPerIP
        });
      }

      // Check for device clustering
      const deviceCount = networkData.deviceClusterCount || 0;
      if (deviceCount > this.config.maxAccountsPerDevice) {
        analysis.threats.push({
          type: 'device_clustering',
          severity: 'medium',
          confidence: 0.6,
          description: `Multiple accounts from same device: ${deviceCount}`,
          deviceCount
        });
      }

      // Check for coordinated activity
      const coordinatedScore = networkData.coordinatedActivityScore || 0;
      if (coordinatedScore > 0.7) {
        analysis.threats.push({
          type: 'coordinated_activity',
          severity: 'high',
          confidence: coordinatedScore,
          description: 'Coordinated activity pattern detected',
          coordinatedScore
        });
      }

    } catch (error) {
      console.error('Error checking network manipulation:', error);
    }
  }

  /**
   * Check for temporal manipulation
   * @param {Object} context - Analysis context
   * @param {Object} analysis - Analysis object to update
   */
  checkTemporalManipulation(context, analysis) {
    try {
      const { userAddress, temporalData } = context;
      
      if (!temporalData) return;

      // Check for burst activity
      const hourlyEngagement = temporalData.hourlyEngagement || [];
      const maxHourly = Math.max(...hourlyEngagement);
      const threshold = this.getAdaptiveThreshold('max_engagement_per_hour');
      
      if (maxHourly > threshold) {
        analysis.threats.push({
          type: 'burst_activity',
          severity: 'medium',
          confidence: Math.min(1.0, maxHourly / (threshold * 2)),
          description: `Burst activity detected: ${maxHourly} engagements/hour`,
          maxHourly,
          threshold
        });
      }

      // Check for 24/7 activity pattern
      const activeHours = hourlyEngagement.filter(count => count > 0).length;
      if (activeHours > 20) {
        analysis.threats.push({
          type: 'continuous_activity',
          severity: 'medium',
          confidence: 0.6,
          description: `Continuous activity pattern: ${activeHours} active hours`,
          activeHours
        });
      }

      // Check for synchronized timing
      const synchronizationScore = temporalData.synchronizationScore || 0;
      if (synchronizationScore > 0.8) {
        analysis.threats.push({
          type: 'synchronized_timing',
          severity: 'high',
          confidence: synchronizationScore,
          description: 'Synchronized activity timing detected',
          synchronizationScore
        });
      }

    } catch (error) {
      console.error('Error checking temporal manipulation:', error);
    }
  }

  /**
   * Check for economic manipulation
   * @param {Object} context - Analysis context
   * @param {Object} analysis - Analysis object to update
   */
  checkEconomicManipulation(context, analysis) {
    try {
      const { userAddress, economicData } = context;
      
      if (!economicData) return;

      // Check for uneconomic behavior
      const subscriptionCost = economicData.subscriptionCost || 1;
      const estimatedRevenue = economicData.estimatedRevenue || 0;
      const profitMargin = estimatedRevenue - subscriptionCost;
      
      if (profitMargin < -10 && economicData.totalEngagement > 50) {
        analysis.threats.push({
          type: 'uneconomic_behavior',
          severity: 'medium',
          confidence: 0.5,
          description: 'Loss-making behavior with high engagement',
          profitMargin,
          totalEngagement: economicData.totalEngagement
        });
      }

      // Check for profit-seeking patterns
      if (profitMargin > 50) {
        analysis.threats.push({
          type: 'profit_seeking',
          severity: 'high',
          confidence: Math.min(1.0, profitMargin / 100),
          description: `High profit margin detected: ${profitMargin}`,
          profitMargin
        });
      }

    } catch (error) {
      console.error('Error checking economic manipulation:', error);
    }
  }

  /**
   * Calculate overall risk score from threats
   * @param {Array} threats - Array of detected threats
   * @returns {number} Overall risk score (0-1)
   */
  calculateOverallRisk(threats) {
    if (threats.length === 0) return 0;

    const severityWeights = {
      low: 0.2,
      medium: 0.5,
      high: 0.8,
      critical: 1.0
    };

    let weightedSum = 0;
    let totalWeight = 0;

    for (const threat of threats) {
      const weight = severityWeights[threat.severity] || 0.5;
      weightedSum += threat.confidence * weight;
      totalWeight += weight;
    }

    return totalWeight > 0 ? weightedSum / totalWeight : 0;
  }

  /**
   * Generate recommendations based on analysis
   * @param {Object} analysis - Safeguard analysis
   * @returns {Array} Recommendations
   */
  generateRecommendations(analysis) {
    const recommendations = [];

    for (const threat of analysis.threats) {
      switch (threat.type) {
        case 'high_engagement':
          recommendations.push({
            type: 'monitoring',
            priority: 'medium',
            action: 'enhanced_monitoring',
            message: 'Implement enhanced monitoring for high-engagement user'
          });
          break;

        case 'engagement_concentration':
          recommendations.push({
            type: 'investigation',
            priority: 'high',
            action: 'investigate_concentration',
            message: 'Investigate single-creator engagement concentration'
          });
          break;

        case 'robotic_engagement':
          recommendations.push({
            type: 'blocking',
            priority: 'high',
            action: 'temporary_block',
            message: 'Consider temporary block for robotic behavior'
          });
          break;

        case 'payout_concentration':
          recommendations.push({
            type: 'economic',
            priority: 'critical',
            action: 'payout_adjustment',
            message: 'Adjust payout to prevent concentration'
          });
          break;

        case 'coordinated_activity':
          recommendations.push({
            type: 'security',
            priority: 'critical',
            action: 'network_analysis',
            message: 'Conduct network analysis for coordinated activity'
          });
          break;
      }
    }

    return recommendations;
  }

  /**
   * Determine actions to take based on analysis
   * @param {Object} analysis - Safeguard analysis
   * @returns {Array} Actions to take
   */
  determineActions(analysis) {
    const actions = [];
    const autoBlockThreshold = this.getAdaptiveThreshold('auto_block_threshold');
    const manualReviewThreshold = this.getAdaptiveThreshold('manual_review_threshold');

    if (analysis.overallRisk >= autoBlockThreshold) {
      actions.push({
        type: 'auto_block',
        priority: 'critical',
        automated: true,
        description: 'Automatic block due to high risk score',
        duration: this.config.cooldownPeriod
      });
    } else if (analysis.overallRisk >= manualReviewThreshold) {
      actions.push({
        type: 'manual_review',
        priority: 'high',
        automated: false,
        description: 'Manual review required',
        reason: `Risk score: ${analysis.overallRisk.toFixed(2)}`
      });
    }

    // Add specific actions based on threat types
    for (const threat of analysis.threats) {
      if (threat.severity === 'critical') {
        actions.push({
          type: 'immediate_action',
          priority: 'critical',
          automated: true,
          description: `Immediate action for ${threat.type}`,
          threatData: threat
        });
      }
    }

    return actions;
  }

  /**
   * Store manipulation detection record
   * @param {Object} analysis - Safeguard analysis
   */
  storeManipulationDetection(analysis) {
    try {
      const detectionId = this.generateDetectionId(analysis);
      
      this.db.prepare(`
        INSERT INTO manipulation_detections 
        (detection_id, threat_type, entity_address, entity_type, confidence_score, risk_level, detection_data, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        detectionId,
        analysis.threats[0]?.type || 'unknown',
        analysis.context.entityAddress || 'unknown',
        analysis.context.entityType || 'unknown',
        analysis.overallRisk,
        this.getRiskLevel(analysis.overallRisk),
        JSON.stringify(analysis),
        'active'
      );

      // Store actions
      for (const action of analysis.actions) {
        this.storeSafeguardAction(detectionId, action);
      }

    } catch (error) {
      console.error('Error storing manipulation detection:', error);
    }
  }

  /**
   * Store safeguard action record
   * @param {string} detectionId - Detection ID
   * @param {Object} action - Action taken
   */
  storeSafeguardAction(detectionId, action) {
    try {
      const actionId = this.generateActionId(detectionId, action);
      
      this.db.prepare(`
        INSERT INTO safeguard_actions 
        (action_id, detection_id, action_type, entity_address, action_data, automated, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        actionId,
        detectionId,
        action.type,
        this.safeguardState.activeThreats.get(detectionId)?.entityAddress || 'unknown',
        JSON.stringify(action),
        action.automated,
        new Date().toISOString()
      );

    } catch (error) {
      console.error('Error storing safeguard action:', error);
    }
  }

  /**
   * Check cooldown status for an entity
   * @param {string} entityAddress - Entity address
   * @param {string} entityType - Entity type
   * @returns {Object} Cooldown status
   */
  checkCooldownStatus(entityAddress, entityType) {
    try {
      const cooldown = this.db.prepare(`
        SELECT cooldown_start, cooldown_end, reason, severity
        FROM entity_cooldowns
        WHERE entity_address = ? AND entity_type = ? AND is_active = TRUE AND cooldown_end > datetime('now')
      `).get(entityAddress, entityType);

      return {
        isActive: !!cooldown,
        cooldownStart: cooldown?.cooldown_start,
        cooldownEnd: cooldown?.cooldown_end,
        reason: cooldown?.reason,
        severity: cooldown?.severity
      };

    } catch (error) {
      console.error('Error checking cooldown status:', error);
      return { isActive: false };
    }
  }

  /**
   * Place entity in cooldown
   * @param {string} entityAddress - Entity address
   * @param {string} entityType - Entity type
   * @param {string} reason - Cooldown reason
   * @param {string} severity - Cooldown severity
   * @param {number} duration - Cooldown duration in milliseconds
   */
  placeInCooldown(entityAddress, entityType, reason, severity, duration = this.config.cooldownPeriod) {
    try {
      const cooldownStart = new Date().toISOString();
      const cooldownEnd = new Date(Date.now() + duration).toISOString();
      
      this.db.prepare(`
        INSERT OR REPLACE INTO entity_cooldowns 
        (entity_address, entity_type, cooldown_start, cooldown_end, reason, severity, is_active)
        VALUES (?, ?, ?, ?, ?, ?, TRUE)
      `).run(entityAddress, entityType, cooldownStart, cooldownEnd, reason, severity);

      this.safeguardState.blockedEntities.add(`${entityType}:${entityAddress}`);

    } catch (error) {
      console.error('Error placing entity in cooldown:', error);
    }
  }

  /**
   * Get adaptive threshold value
   * @param {string} thresholdName - Threshold name
   * @returns {number} Threshold value
   */
  getAdaptiveThreshold(thresholdName) {
    return this.safeguardState.adaptiveThresholds.get(thresholdName) || 
           this.config[thresholdName] || 
           1.0;
  }

  /**
   * Adjust adaptive threshold
   * @param {string} thresholdName - Threshold name
   * @param {number} newValue - New threshold value
   * @param {string} reason - Adjustment reason
   */
  adjustAdaptiveThreshold(thresholdName, newValue, reason) {
    try {
      const oldValue = this.getAdaptiveThreshold(thresholdName);
      
      this.db.prepare(`
        UPDATE adaptive_thresholds 
        SET current_value = ?, adjustment_count = adjustment_count + 1, 
            last_adjustment = datetime('now'), adjustment_reason = ?
        WHERE threshold_name = ?
      `).run(newValue, reason, thresholdName);

      this.safeguardState.adaptiveThresholds.set(thresholdName, newValue);
      this.metrics.adaptiveAdjustments++;

      console.log(`Adjusted threshold ${thresholdName}: ${oldValue} -> ${newValue} (${reason})`);

    } catch (error) {
      console.error('Error adjusting adaptive threshold:', error);
    }
  }

  /**
   * Run adaptive threshold optimization
   */
  runAdaptiveOptimization() {
    if (!this.config.enableAdaptiveThresholds) return;

    try {
      const now = Date.now();
      if (now - this.safeguardState.lastAdjustment < this.config.learningPeriod) {
        return; // Not time for adjustment yet
      }

      // Analyze recent performance
      const recentPerformance = this.getRecentPerformanceMetrics();
      
      // Adjust thresholds based on performance
      if (recentPerformance.falsePositiveRate > 0.2) {
        // Too many false positives - relax thresholds
        this.adjustAdaptiveThreshold('suspicious_engagement_threshold', 
          this.getAdaptiveThreshold('suspicious_engagement_threshold') * 1.1,
          'high_false_positive_rate');
      } else if (recentPerformance.detectionRate < 0.5) {
        // Low detection rate - tighten thresholds
        this.adjustAdaptiveThreshold('suspicious_engagement_threshold', 
          this.getAdaptiveThreshold('suspicious_engagement_threshold') * 0.9,
          'low_detection_rate');
      }

      this.safeguardState.lastAdjustment = now;

    } catch (error) {
      console.error('Error running adaptive optimization:', error);
    }
  }

  /**
   * Get recent performance metrics
   * @returns {Object} Performance metrics
   */
  getRecentPerformanceMetrics() {
    try {
      const metrics = this.db.prepare(`
        SELECT 
          AVG(CASE WHEN status = 'false_positive' THEN 1 ELSE 0 END) as false_positive_rate,
          AVG(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) as detection_rate,
          AVG(response_time) as avg_response_time
        FROM manipulation_detections
        WHERE timestamp > datetime('now', '-7 days')
      `).get();

      return {
        falsePositiveRate: metrics.false_positive_rate || 0,
        detectionRate: metrics.detection_rate || 0,
        averageResponseTime: metrics.avg_response_time || 0
      };

    } catch (error) {
      console.error('Error getting performance metrics:', error);
      return { falsePositiveRate: 0, detectionRate: 0, averageResponseTime: 0 };
    }
  }

  /**
   * Generate detection ID
   * @param {Object} analysis - Safeguard analysis
   * @returns {string} Detection ID
   */
  generateDetectionId(analysis) {
    const crypto = require('crypto');
    const data = {
      entityAddress: analysis.context.entityAddress,
      entityType: analysis.context.entityType,
      timestamp: Date.now(),
      threatTypes: analysis.threats.map(t => t.type)
    };
    
    return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex').substring(0, 24);
  }

  /**
   * Generate action ID
   * @param {string} detectionId - Detection ID
   * @param {Object} action - Action object
   * @returns {string} Action ID
   */
  generateActionId(detectionId, action) {
    const crypto = require('crypto');
    const data = {
      detectionId,
      actionType: action.type,
      timestamp: Date.now()
    };
    
    return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex').substring(0, 20);
  }

  /**
   * Get risk level from score
   * @param {number} score - Risk score (0-1)
   * @returns {string} Risk level
   */
  getRiskLevel(score) {
    if (score >= 0.9) return 'critical';
    if (score >= 0.7) return 'high';
    if (score >= 0.4) return 'medium';
    return 'low';
  }

  /**
   * Calculate variance of an array of numbers
   * @param {Array} values - Array of numbers
   * @returns {number} Variance
   */
  calculateVariance(values) {
    if (values.length === 0) return 0;
    
    const mean = values.reduce((sum, val) => sum + val, 0) / values.length;
    const squaredDiffs = values.map(val => Math.pow(val - mean, 2));
    return squaredDiffs.reduce((sum, diff) => sum + diff, 0) / values.length;
  }

  /**
   * Update performance metrics
   * @param {number} responseTime - Response time in milliseconds
   */
  updatePerformanceMetrics(responseTime) {
    this.metrics.averageResponseTime = 
      (this.metrics.averageResponseTime * (this.metrics.threatsDetected || 1) + responseTime) / 
      (this.metrics.threatsDetected + 1);
  }

  /**
   * Get safeguard system statistics
   * @returns {Object} System statistics
   */
  getSystemStatistics() {
    try {
      const stats = {
        totalDetections: 0,
        activeThreats: 0,
        blockedEntities: 0,
        adaptiveThresholds: 0,
        averageResponseTime: 0,
        systemHealth: 0
      };

      // Total detections
      stats.totalDetections = this.db.prepare(`
        SELECT COUNT(*) as count
        FROM manipulation_detections
      `).get()?.count || 0;

      // Active threats
      stats.activeThreats = this.db.prepare(`
        SELECT COUNT(*) as count
        FROM manipulation_detections
        WHERE status = 'active'
      `).get()?.count || 0;

      // Blocked entities
      stats.blockedEntities = this.db.prepare(`
        SELECT COUNT(*) as count
        FROM entity_cooldowns
        WHERE is_active = TRUE
      `).get()?.count || 0;

      // Adaptive thresholds
      stats.adaptiveThresholds = this.db.prepare(`
        SELECT COUNT(*) as count
        FROM adaptive_thresholds
      `).get()?.count || 0;

      // Average response time
      stats.averageResponseTime = this.db.prepare(`
        SELECT AVG(CASE 
          WHEN response_timestamp IS NOT NULL AND timestamp IS NOT NULL 
          THEN (strftime('%s', response_timestamp) - strftime('%s', timestamp)) * 1000 
          ELSE NULL 
        END) as avg_time
        FROM manipulation_detections
        WHERE response_timestamp IS NOT NULL
      `).get()?.avg_time || 0;

      // System health score
      const falsePositiveRate = this.getRecentPerformanceMetrics().falsePositiveRate;
      const detectionRate = this.getRecentPerformanceMetrics().detectionRate;
      stats.systemHealth = (detectionRate * 0.6 + (1 - falsePositiveRate) * 0.4);

      return stats;

    } catch (error) {
      console.error('Error getting system statistics:', error);
      return {};
    }
  }

  /**
   * Generate comprehensive safeguard report
   * @returns {Object} Safeguard report
   */
  generateSafeguardReport() {
    try {
      const stats = this.getSystemStatistics();
      const recentDetections = this.getRecentDetections();
      const adaptiveThresholds = this.getAdaptiveThresholds();
      const performanceMetrics = this.getRecentPerformanceMetrics();

      return {
        timestamp: new Date().toISOString(),
        statistics: stats,
        recentDetections,
        adaptiveThresholds,
        performanceMetrics,
        systemHealth: this.assessSystemHealth(stats),
        recommendations: this.generateSystemRecommendations(stats, performanceMetrics)
      };

    } catch (error) {
      console.error('Error generating safeguard report:', error);
      throw error;
    }
  }

  /**
   * Get recent detections
   * @returns {Array} Recent detections
   */
  getRecentDetections() {
    try {
      return this.db.prepare(`
        SELECT detection_id, threat_type, entity_address, confidence_score, risk_level, timestamp, status
        FROM manipulation_detections
        WHERE timestamp > datetime('now', '-24 hours')
        ORDER BY timestamp DESC
        LIMIT 20
      `).all();
    } catch (error) {
      console.error('Error getting recent detections:', error);
      return [];
    }
  }

  /**
   * Get adaptive thresholds
   * @returns {Array} Adaptive thresholds
   */
  getAdaptiveThresholds() {
    try {
      return this.db.prepare(`
        SELECT threshold_name, current_value, initial_value, adjustment_count, last_adjustment
        FROM adaptive_thresholds
        ORDER BY threshold_name
      `).all();
    } catch (error) {
      console.error('Error getting adaptive thresholds:', error);
      return [];
    }
  }

  /**
   * Assess system health
   * @param {Object} stats - System statistics
   * @returns {Object} Health assessment
   */
  assessSystemHealth(stats) {
    const healthScore = stats.systemHealth || 0;
    
    return {
      score: healthScore,
      status: healthScore > 0.8 ? 'excellent' : healthScore > 0.6 ? 'good' : 'concerning',
      issues: healthScore < 0.6 ? ['high_false_positives', 'low_detection_rate'] : []
    };
  }

  /**
   * Generate system recommendations
   * @param {Object} stats - System statistics
   * @param {Object} performance - Performance metrics
   * @returns {Array} Recommendations
   */
  generateSystemRecommendations(stats, performance) {
    const recommendations = [];

    if (performance.falsePositiveRate > 0.2) {
      recommendations.push({
        type: 'accuracy',
        priority: 'high',
        action: 'adjust_thresholds',
        message: 'High false positive rate. Consider adjusting detection thresholds.'
      });
    }

    if (performance.detectionRate < 0.5) {
      recommendations.push({
        type: 'effectiveness',
        priority: 'medium',
        action: 'enhance_detection',
        message: 'Low detection rate. Consider enhancing detection algorithms.'
      });
    }

    if (stats.averageResponseTime > 5000) {
      recommendations.push({
        type: 'performance',
        priority: 'low',
        action: 'optimize_processing',
        message: 'Slow response time. Consider optimizing detection processing.'
      });
    }

    return recommendations;
  }

  /**
   * Clean up expired cooldowns
   */
  cleanupExpiredCooldowns() {
    try {
      const result = this.db.prepare(`
        UPDATE entity_cooldowns
        SET is_active = FALSE
        WHERE is_active = TRUE AND cooldown_end < datetime('now')
      `).run();

      if (result.changes > 0) {
        console.log(`Cleaned up ${result.changes} expired cooldowns`);
      }

    } catch (error) {
      console.error('Error cleaning up cooldowns:', error);
    }
  }
}

module.exports = {
  AntiManipulationSafeguardsService
};
