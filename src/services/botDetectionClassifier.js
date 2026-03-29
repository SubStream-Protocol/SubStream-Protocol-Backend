const { logger } = require('../utils/logger');

/**
 * Simple Machine Learning Classifier for Bot Detection
 * Uses rule-based logic and basic statistical analysis for bot detection
 */
class BotDetectionClassifier {
  constructor(config = {}) {
    this.config = {
      // Model configuration
      modelType: config.modelType || 'rule_based',
      confidenceThreshold: config.confidenceThreshold || 0.7,
      trainingThreshold: config.trainingThreshold || 100,
      
      // Feature weights (tuned based on training data)
      weights: {
        eventsPerMinute: config.weights?.eventsPerMinute || 0.3,
        mouseSpeedVariance: config.weights?.mouseSpeedVariance || 0.25,
        typingConsistency: config.weights?.typingConsistency || 0.2,
        rapidClicks: config.weights?.rapidClicks || 0.15,
        scrollSmoothness: config.weights?.scrollSmoothness || 0.1
      },
      
      // Thresholds for individual features
      thresholds: {
        highEventsPerMinute: config.thresholds?.highEventsPerMinute || 100,
        lowMouseSpeedVariance: config.thresholds?.lowMouseSpeedVariance || 0.1,
        highTypingConsistency: config.thresholds?.highTypingConsistency || 0.95,
        highRapidClicks: config.thresholds?.highRapidClicks || 0.5,
        lowScrollSmoothness: config.thresholds?.lowScrollSmoothness || 0.2
      },
      
      // Anomaly detection
      anomalyDetection: {
        enabled: config.anomalyDetection?.enabled !== false,
        sensitivity: config.anomalyDetection?.sensitivity || 0.8,
        windowSize: config.anomalyDetection?.windowSize || 50
      },
      
      ...config
    };

    // Training data storage
    this.trainingData = [];
    this.featureStats = this.initializeFeatureStats();
    this.isTrained = false;
    
    // Performance tracking
    this.performance = {
      totalPredictions: 0,
      correctPredictions: 0,
      falsePositives: 0,
      falseNegatives: 0,
      lastTrained: null
    };
  }

  /**
   * Initialize feature statistics for normalization
   * @returns {object} Initial feature statistics
   */
  initializeFeatureStats() {
    return {
      eventsPerMinute: { mean: 0, std: 0, min: 0, max: 0 },
      avgMouseSpeed: { mean: 0, std: 0, min: 0, max: 0 },
      mouseSpeedVariance: { mean: 0, std: 0, min: 0, max: 0 },
      avgClickInterval: { mean: 0, std: 0, min: 0, max: 0 },
      typingConsistency: { mean: 0, std: 0, min: 0, max: 0 },
      scrollSmoothness: { mean: 0, std: 0, min: 0, max: 0 },
      rapidClicks: { mean: 0, std: 0, min: 0, max: 0 },
      delayedClicks: { mean: 0, std: 0, min: 0, max: 0 }
    };
  }

  /**
   * Train the classifier with labeled data
   * @param {Array} data - Training data with features and labels
   */
  train(data) {
    try {
      logger.info('Training bot detection classifier', {
        dataSize: data.length,
        modelType: this.config.modelType
      });

      // Store training data
      this.trainingData = data;
      
      // Calculate feature statistics
      this.calculateFeatureStats(data);
      
      // Train the model
      if (this.config.modelType === 'rule_based') {
        this.trainRuleBasedModel(data);
      } else if (this.config.modelType === 'statistical') {
        this.trainStatisticalModel(data);
      }
      
      this.isTrained = true;
      this.performance.lastTrained = new Date().toISOString();
      
      logger.info('Classifier training completed', {
        trained: this.isTrained,
        featureStats: this.featureStats
      });

    } catch (error) {
      logger.error('Failed to train classifier', {
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Calculate feature statistics for normalization
   * @param {Array} data - Training data
   */
  calculateFeatureStats(data) {
    const features = ['eventsPerMinute', 'avgMouseSpeed', 'mouseSpeedVariance', 
                      'avgClickInterval', 'typingConsistency', 'scrollSmoothness', 
                      'rapidClicks', 'delayedClicks'];

    features.forEach(feature => {
      const values = data.map(d => d.features[feature] || 0).filter(v => !isNaN(v));
      
      if (values.length > 0) {
        const mean = values.reduce((a, b) => a + b, 0) / values.length;
        const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
        const std = Math.sqrt(variance);
        
        this.featureStats[feature] = {
          mean,
          std,
          min: Math.min(...values),
          max: Math.max(...values)
        };
      }
    });
  }

  /**
   * Train rule-based model
   * @param {Array} data - Training data
   */
  trainRuleBasedModel(data) {
    // Rule-based model uses predefined thresholds
    // Training helps optimize thresholds based on data
    this.optimizeThresholds(data);
  }

  /**
   * Train statistical model
   * @param {Array} data - Training data
   */
  trainStatisticalModel(data) {
    // For statistical model, we could implement simple logistic regression
    // For now, we'll use the rule-based approach with learned thresholds
    this.optimizeThresholds(data);
  }

  /**
   * Optimize thresholds based on training data
   * @param {Array} data - Training data
   */
  optimizeThresholds(data) {
    // Analyze feature distributions for bot vs human patterns
    const botData = data.filter(d => d.label === 'bot');
    const humanData = data.filter(d => d.label === 'human');

    if (botData.length === 0 || humanData.length === 0) {
      logger.warn('Insufficient labeled data for threshold optimization');
      return;
    }

    // Calculate optimal thresholds for each feature
    const features = ['eventsPerMinute', 'mouseSpeedVariance', 'typingConsistency', 'rapidClicks'];
    
    features.forEach(feature => {
      const botValues = botData.map(d => d.features[feature] || 0);
      const humanValues = humanData.map(d => d.features[feature] || 0);
      
      // Find threshold that maximizes separation
      const optimalThreshold = this.findOptimalThreshold(botValues, humanValues);
      
      if (optimalThreshold !== null) {
        this.config.thresholds[`high${feature.charAt(0).toUpperCase() + feature.slice(1)}`] = optimalThreshold;
      }
    });

    logger.info('Thresholds optimized', {
      thresholds: this.config.thresholds
    });
  }

  /**
   * Find optimal threshold for feature separation
   * @param {Array} botValues - Bot feature values
   * @param {Array} humanValues - Human feature values
   * @returns {number|null} Optimal threshold
   */
  findOptimalThreshold(botValues, humanValues) {
    const allValues = [...botValues, ...humanValues].sort((a, b) => a - b);
    let bestThreshold = null;
    let bestScore = 0;

    for (let i = 0; i < allValues.length - 1; i++) {
      const threshold = allValues[i];
      
      // Calculate classification accuracy at this threshold
      const tp = botValues.filter(v => v >= threshold).length; // True positives
      const fp = humanValues.filter(v => v >= threshold).length; // False positives
      const tn = humanValues.filter(v => v < threshold).length; // True negatives
      const fn = botValues.filter(v => v < threshold).length; // False negatives
      
      const accuracy = (tp + tn) / (tp + fp + tn + fn);
      
      if (accuracy > bestScore) {
        bestScore = accuracy;
        bestThreshold = threshold;
      }
    }

    return bestThreshold;
  }

  /**
   * Predict if session is bot-like
   * @param {object} features - Behavioral features
   * @returns {object} Prediction result
   */
  predict(features) {
    try {
      if (!this.isTrained) {
        // Use default rule-based prediction if not trained
        return this.ruleBasedPrediction(features);
      }

      // Normalize features
      const normalizedFeatures = this.normalizeFeatures(features);
      
      // Calculate bot score
      let botScore = 0;
      let confidence = 0;
      const factors = [];

      // Events per minute
      if (normalizedFeatures.eventsPerMinute !== null) {
        const score = Math.min(normalizedFeatures.eventsPerMinute / 2, 1);
        botScore += score * this.config.weights.eventsPerMinute;
        factors.push({ feature: 'eventsPerMinute', score, weight: this.config.weights.eventsPerMinute });
      }

      // Mouse speed variance (lower variance = more robotic)
      if (normalizedFeatures.mouseSpeedVariance !== null) {
        const score = 1 - normalizedFeatures.mouseSpeedVariance; // Invert: lower variance = higher bot score
        botScore += score * this.config.weights.mouseSpeedVariance;
        factors.push({ feature: 'mouseSpeedVariance', score, weight: this.config.weights.mouseSpeedVariance });
      }

      // Typing consistency (higher consistency = more robotic)
      if (normalizedFeatures.typingConsistency !== null) {
        const score = normalizedFeatures.typingConsistency;
        botScore += score * this.config.weights.typingConsistency;
        factors.push({ feature: 'typingConsistency', score, weight: this.config.weights.typingConsistency });
      }

      // Rapid clicks
      if (normalizedFeatures.rapidClicks !== null) {
        const score = normalizedFeatures.rapidClicks;
        botScore += score * this.config.weights.rapidClicks;
        factors.push({ feature: 'rapidClicks', score, weight: this.config.weights.rapidClicks });
      }

      // Scroll smoothness (lower smoothness = more robotic)
      if (normalizedFeatures.scrollSmoothness !== null) {
        const score = 1 - normalizedFeatures.scrollSmoothness; // Invert: lower smoothness = higher bot score
        botScore += score * this.config.weights.scrollSmoothness;
        factors.push({ feature: 'scrollSmoothness', score, weight: this.config.weights.scrollSmoothness });
      }

      // Calculate confidence based on factor agreement
      confidence = this.calculateConfidence(factors);

      // Apply anomaly detection if enabled
      if (this.config.anomalyDetection.enabled) {
        const anomalyScore = this.detectAnomalies(features);
        if (anomalyScore > this.config.anomalyDetection.sensitivity) {
          botScore = Math.min(botScore + anomalyScore, 1);
          confidence = Math.max(confidence, anomalyScore);
        }
      }

      // Update performance tracking
      this.performance.totalPredictions++;

      const prediction = {
        isBot: botScore >= this.config.confidenceThreshold,
        botScore: Math.round(botScore * 100) / 100,
        confidence: Math.round(confidence * 100) / 100,
        factors,
        features: normalizedFeatures
      };

      logger.debug('Bot detection prediction', {
        botScore: prediction.botScore,
        confidence: prediction.confidence,
        isBot: prediction.isBot
      });

      return prediction;

    } catch (error) {
      logger.error('Failed to predict bot score', {
        error: error.message
      });

      // Fail safe prediction
      return {
        isBot: false,
        botScore: 0.5,
        confidence: 0,
        error: error.message
      };
    }
  }

  /**
   * Rule-based prediction fallback
   * @param {object} features - Behavioral features
   * @returns {object} Prediction result
   */
  ruleBasedPrediction(features) {
    let botScore = 0;
    let factors = [];

    // High events per minute
    if (features.eventsPerMinute > this.config.thresholds.highEventsPerMinute) {
      botScore += 0.3;
      factors.push({ feature: 'eventsPerMinute', score: 0.3, reason: 'High event frequency' });
    }

    // Low mouse speed variance (robotic movement)
    if (features.mouseSpeedVariance < this.config.thresholds.lowMouseSpeedVariance && features.avgMouseSpeed > 0) {
      botScore += 0.25;
      factors.push({ feature: 'mouseSpeedVariance', score: 0.25, reason: 'Low movement variance' });
    }

    // Very consistent typing (robotic)
    if (features.typingConsistency > this.config.thresholds.highTypingConsistency && features.keyEvents > 10) {
      botScore += 0.2;
      factors.push({ feature: 'typingConsistency', score: 0.2, reason: 'Too consistent typing' });
    }

    // Many rapid clicks
    if (features.rapidClicks > features.clickEvents * 0.5) {
      botScore += 0.15;
      factors.push({ feature: 'rapidClicks', score: 0.15, reason: 'Many rapid clicks' });
    }

    // No natural delays
    if (features.delayedClicks === 0 && features.clickEvents > 5) {
      botScore += 0.1;
      factors.push({ feature: 'delayedClicks', score: 0.1, reason: 'No natural delays' });
    }

    const confidence = factors.length > 0 ? 0.7 : 0.3; // Moderate confidence for rule-based

    return {
      isBot: botScore >= this.config.confidenceThreshold,
      botScore,
      confidence,
      factors,
      method: 'rule_based'
    };
  }

  /**
   * Normalize features using z-score normalization
   * @param {object} features - Raw features
   * @returns {object} Normalized features
   */
  normalizeFeatures(features) {
    const normalized = {};

    Object.keys(this.featureStats).forEach(feature => {
      const stats = this.featureStats[feature];
      const value = features[feature];

      if (value !== undefined && value !== null && !isNaN(value) && stats.std > 0) {
        // Z-score normalization
        normalized[feature] = (value - stats.mean) / stats.std;
        // Clamp to reasonable range (-3 to 3)
        normalized[feature] = Math.max(-3, Math.min(3, normalized[feature]));
        // Convert to 0-1 scale
        normalized[feature] = (normalized[feature] + 3) / 6;
      } else {
        normalized[feature] = null;
      }
    });

    return normalized;
  }

  /**
   * Calculate prediction confidence
   * @param {Array} factors - Feature factors
   * @returns {number} Confidence score (0-1)
   */
  calculateConfidence(factors) {
    if (factors.length === 0) return 0;

    // Calculate agreement between factors
    const scores = factors.map(f => f.score);
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const variance = scores.reduce((sum, score) => sum + Math.pow(score - mean, 2), 0) / scores.length;
    
    // Higher confidence when factors agree (low variance)
    const agreement = 1 - Math.min(variance, 1);
    
    // Adjust confidence based on number of factors
    const factorBonus = Math.min(factors.length / 5, 1); // Bonus for more factors
    
    return Math.min(agreement + factorBonus, 1);
  }

  /**
   * Detect anomalies in behavioral patterns
   * @param {object} features - Behavioral features
   * @returns {number} Anomaly score (0-1)
   */
  detectAnomalies(features) {
    let anomalyScore = 0;
    let anomalies = [];

    // Check for unusual patterns
    if (features.eventsPerMinute > 200) {
      anomalyScore += 0.3;
      anomalies.push('Extremely high event frequency');
    }

    if (features.mouseSpeedVariance === 0 && features.avgMouseSpeed > 0) {
      anomalyScore += 0.2;
      anomalies.push('Perfectly consistent mouse movement');
    }

    if (features.typingConsistency === 1 && features.keyEvents > 20) {
      anomalyScore += 0.2;
      anomalies.push('Perfectly consistent typing');
    }

    if (features.rapidClicks === features.clickEvents && features.clickEvents > 10) {
      anomalyScore += 0.2;
      anomalies.push('All clicks are rapid');
    }

    if (features.scrollSmoothness === 0 && features.scrollEvents > 5) {
      anomalyScore += 0.1;
      anomalies.push('Perfectly linear scrolling');
    }

    // Log anomalies for debugging
    if (anomalies.length > 0) {
      logger.debug('Behavioral anomalies detected', {
        anomalies,
        anomalyScore,
        features
      });
    }

    return anomalyScore;
  }

  /**
   * Update model with new training data
   * @param {object} features - Behavioral features
   * @param {boolean} isBot - True if this is bot behavior
   */
  updateModel(features, isBot) {
    const trainingExample = {
      features,
      label: isBot ? 'bot' : 'human',
      timestamp: new Date().toISOString()
    };

    this.trainingData.push(trainingExample);

    // Retrain if we have enough new data
    if (this.trainingData.length >= this.config.trainingThreshold) {
      this.train(this.trainingData);
    }
  }

  /**
   * Get model performance statistics
   * @returns {object} Performance stats
   */
  getPerformanceStats() {
    const accuracy = this.performance.totalPredictions > 0 ? 
      this.performance.correctPredictions / this.performance.totalPredictions : 0;
    
    const precision = (this.performance.correctPredictions - this.performance.falsePositives) > 0 ?
      (this.performance.correctPredictions - this.performance.falsePositives) / this.performance.correctPredictions : 0;
    
    const recall = (this.performance.correctPredictions - this.performance.falseNegatives) > 0 ?
      (this.performance.correctPredictions - this.performance.falseNegatives) / this.performance.correctPredictions : 0;

    return {
      ...this.performance,
      accuracy: Math.round(accuracy * 100) / 100,
      precision: Math.round(precision * 100) / 100,
      recall: Math.round(recall * 100) / 100,
      f1Score: precision > 0 && recall > 0 ? Math.round(2 * (precision * recall) / (precision + recall) * 100) / 100 : 0
    };
  }

  /**
   * Reset model performance tracking
   */
  resetPerformanceStats() {
    this.performance = {
      totalPredictions: 0,
      correctPredictions: 0,
      falsePositives: 0,
      falseNegatives: 0,
      lastTrained: this.performance.lastTrained
    };
  }

  /**
   * Export model configuration
   * @returns {object} Model configuration
   */
  exportModel() {
    return {
      config: this.config,
      featureStats: this.featureStats,
      isTrained: this.isTrained,
      performance: this.getPerformanceStats(),
      trainingDataSize: this.trainingData.length
    };
  }

  /**
   * Import model configuration
   * @param {object} modelData - Model data to import
   */
  importModel(modelData) {
    try {
      this.config = { ...this.config, ...modelData.config };
      this.featureStats = modelData.featureStats || this.featureStats;
      this.isTrained = modelData.isTrained || false;
      this.performance = modelData.performance || this.performance;
      
      logger.info('Model imported successfully', {
        isTrained: this.isTrained,
        configType: this.config.modelType
      });

    } catch (error) {
      logger.error('Failed to import model', {
        error: error.message
      });
      throw error;
    }
  }
}

module.exports = { BotDetectionClassifier };
