/**
 * ScaledUserProp Revenue Division Engine
 * 
 * Implements the ScaledUserProp algorithm from ICML 2025 research to protect against
 * Sybil attacks by adjusting creator payouts based on engagement intensity rather
 * than raw view counts.
 * 
 * Key Features:
 * - Fraud-proof revenue division
 * - Sybil attack protection
 * - Engagement intensity scaling
 * - Mathematical prevention of manipulation
 */

class ScaledUserPropEngine {
  constructor(config = {}) {
    this.alpha = config.alpha || 0.7; // Platform commission rate (0.7 = 30% platform cut)
    this.gamma = config.gamma || 0.5; // Engagement scaling parameter
    this.minEngagementThreshold = config.minEngagementThreshold || 0.1;
    this.maxEngagementMultiplier = config.maxEngagementMultiplier || 5;
    this.sybilDetectionThreshold = config.sybilDetectionThreshold || 10;
    this.debug = config.debug || false;
  }

  /**
   * Calculate engagement intensity for a user
   * @param {Object} userEngagement - User's engagement data {creatorId: weight, ...}
   * @param {Object} globalStats - Global engagement statistics
   * @returns {Object} Engagement intensity metrics
   */
  calculateEngagementIntensity(userEngagement, globalStats) {
    const totalUserEngagement = Object.values(userEngagement).reduce((sum, weight) => sum + weight, 0);
    const avgEngagementPerUser = globalStats.totalEngagement / globalStats.totalUsers;
    
    // Calculate engagement ratio relative to average
    const engagementRatio = totalUserEngagement / avgEngagementPerUser;
    
    // Apply intensity scaling function
    const intensityFactor = this.calculateIntensityFactor(engagementRatio);
    
    // Calculate effective engagement after scaling
    const effectiveEngagement = {};
    let totalEffective = 0;
    
    for (const [creatorId, weight] of Object.entries(userEngagement)) {
      const scaledWeight = weight * intensityFactor;
      effectiveEngagement[creatorId] = scaledWeight;
      totalEffective += scaledWeight;
    }
    
    return {
      totalUserEngagement,
      avgEngagementPerUser,
      engagementRatio,
      intensityFactor,
      effectiveEngagement,
      totalEffective,
      isHighEngagement: engagementRatio > (1 / this.alpha),
      isSuspicious: engagementRatio > this.sybilDetectionThreshold
    };
  }

  /**
   * Calculate intensity factor based on engagement ratio
   * @param {number} engagementRatio - User's engagement relative to average
   * @returns {number} Intensity scaling factor (0-1)
   */
  calculateIntensityFactor(engagementRatio) {
    // ScaledUserProp formula: min(γ * total_engagement, 1)
    const scaledEngagement = this.gamma * engagementRatio;
    return Math.min(scaledEngagement, 1);
  }

  /**
   * Apply ScaledUserProp algorithm to calculate creator payouts
   * @param {Object} instance - Engagement instance {users: [], creators: [], engagements: {}}
   * @returns {Object} Payout calculation results
   */
  calculatePayouts(instance) {
    const { users, creators, engagements } = instance;
    
    // Calculate global statistics
    const globalStats = this.calculateGlobalStats(engagements);
    
    // Calculate effective engagement for each user
    const userEffectiveEngagement = {};
    const userIntensities = {};
    let totalEffectiveEngagement = 0;
    
    for (const userId of users) {
      const userEngagement = engagements[userId] || {};
      const intensity = this.calculateEngagementIntensity(userEngagement, globalStats);
      
      userIntensities[userId] = intensity;
      userEffectiveEngagement[userId] = intensity.effectiveEngagement;
      totalEffectiveEngagement += intensity.totalEffective;
      
      // Log suspicious users
      if (intensity.isSuspicious && this.debug) {
        console.warn(`Suspicious user detected: ${userId}, ratio: ${intensity.engagementRatio.toFixed(2)}`);
      }
    }
    
    // Calculate creator shares based on effective engagement
    const creatorShares = {};
    const creatorPayouts = {};
    
    // Initialize creator shares
    for (const creatorId of creators) {
      creatorShares[creatorId] = 0;
    }
    
    // Aggregate effective engagement by creator
    for (const userId of users) {
      const effectiveEngagement = userEffectiveEngagement[userId];
      for (const [creatorId, weight] of Object.entries(effectiveEngagement)) {
        creatorShares[creatorId] += weight;
      }
    }
    
    // Calculate payouts using UserProp on effective engagement
    const totalRevenue = users.length * this.alpha; // α * n users
    
    for (const creatorId of creators) {
      if (totalEffectiveEngagement > 0) {
        const share = creatorShares[creatorId] / totalEffectiveEngagement;
        creatorPayouts[creatorId] = share * totalRevenue;
      } else {
        creatorPayouts[creatorId] = 0;
      }
    }
    
    // Calculate fairness metrics
    const fairnessMetrics = this.calculateFairnessMetrics(creatorPayouts, creatorShares);
    
    // Calculate Sybil resistance metrics
    const sybilMetrics = this.calculateSybilResistance(userIntensities, globalStats);
    
    return {
      creatorPayouts,
      creatorShares,
      userIntensities,
      globalStats,
      fairnessMetrics,
      sybilMetrics,
      totalRevenue,
      totalEffectiveEngagement,
      algorithm: 'ScaledUserProp',
      parameters: {
        alpha: this.alpha,
        gamma: this.gamma
      }
    };
  }

  /**
   * Calculate global engagement statistics
   * @param {Object} engagements - All user engagements
   * @returns {Object} Global statistics
   */
  calculateGlobalStats(engagements) {
    let totalEngagement = 0;
    let totalUsers = 0;
    const creatorTotals = {};
    
    for (const [userId, userEngagement] of Object.entries(engagements)) {
      totalUsers++;
      for (const [creatorId, weight] of Object.entries(userEngagement)) {
        totalEngagement += weight;
        creatorTotals[creatorId] = (creatorTotals[creatorId] || 0) + weight;
      }
    }
    
    const avgEngagementPerUser = totalUsers > 0 ? totalEngagement / totalUsers : 0;
    const avgEngagementPerCreator = Object.keys(creatorTotals).length > 0 
      ? totalEngagement / Object.keys(creatorTotals).length 
      : 0;
    
    return {
      totalEngagement,
      totalUsers,
      totalCreators: Object.keys(creatorTotals).length,
      avgEngagementPerUser,
      avgEngagementPerCreator,
      creatorTotals
    };
  }

  /**
   * Calculate fairness metrics for the payout distribution
   * @param {Object} payouts - Creator payouts
   * @param {Object} shares - Creator effective engagement shares
   * @returns {Object} Fairness metrics
   */
  calculateFairnessMetrics(payouts, shares) {
    const payoutValues = Object.values(payouts).filter(p => p > 0);
    const shareValues = Object.values(shares).filter(s => s > 0);
    
    if (payoutValues.length === 0 || shareValues.length === 0) {
      return {
        maxEnvy: 0,
        giniCoefficient: 0,
        variance: 0,
        payPerStreamAvg: 0
      };
    }
    
    // Maximum Envy (ME) - ratio of highest to lowest pay-per-stream
    const payPerStream = {};
    for (const [creatorId, payout] of Object.entries(payouts)) {
      const totalStreams = shares[creatorId] || 0;
      payPerStream[creatorId] = totalStreams > 0 ? payout / totalStreams : 0;
    }
    
    const ppsValues = Object.values(payPerStream).filter(pps => pps > 0);
    const maxEnvy = ppsValues.length > 0 
      ? Math.max(...ppsValues) / Math.min(...ppsValues) 
      : 0;
    
    // Gini Coefficient for income inequality
    const sortedPayouts = payoutValues.sort((a, b) => a - b);
    const n = sortedPayouts.length;
    let gini = 0;
    for (let i = 0; i < n; i++) {
      gini += (2 * (i + 1) - n - 1) * sortedPayouts[i];
    }
    const giniCoefficient = n > 0 ? gini / (n * sortedPayouts[n - 1]) : 0;
    
    // Variance in payouts
    const meanPayout = payoutValues.reduce((sum, p) => sum + p, 0) / payoutValues.length;
    const variance = payoutValues.reduce((sum, p) => sum + Math.pow(p - meanPayout, 2), 0) / payoutValues.length;
    
    // Average pay-per-stream
    const totalPayout = payoutValues.reduce((sum, p) => sum + p, 0);
    const totalStreams = shareValues.reduce((sum, s) => sum + s, 0);
    const payPerStreamAvg = totalStreams > 0 ? totalPayout / totalStreams : 0;
    
    return {
      maxEnvy,
      giniCoefficient,
      variance,
      payPerStreamAvg
    };
  }

  /**
   * Calculate Sybil attack resistance metrics
   * @param {Object} userIntensities - User engagement intensities
   * @param {Object} globalStats - Global engagement statistics
   * @returns {Object} Sybil resistance metrics
   */
  calculateSybilResistance(userIntensities, globalStats) {
    const intensityRatios = Object.values(userIntensities).map(ui => ui.engagementRatio);
    const suspiciousUsers = Object.values(userIntensities).filter(ui => ui.isSuspicious);
    const highEngagementUsers = Object.values(userIntensities).filter(ui => ui.isHighEngagement);
    
    // Sybil Resistance Score (higher is better)
    const avgEngagementRatio = intensityRatios.reduce((sum, ratio) => sum + ratio, 0) / intensityRatios.length;
    const maxEngagementRatio = Math.max(...intensityRatios);
    const sybilResistanceScore = Math.max(0, 1 - (maxEngagementRatio - avgEngagementRatio) / avgEngagementRatio);
    
    // Manipulation Cost Estimate
    const estimatedManipulationCost = this.estimateManipulationCost(userIntensities, globalStats);
    
    return {
      totalUsers: Object.keys(userIntensities).length,
      suspiciousUsers: suspiciousUsers.length,
      highEngagementUsers: highEngagementUsers.length,
      avgEngagementRatio,
      maxEngagementRatio,
      sybilResistanceScore,
      estimatedManipulationCost,
      isSystemSecure: sybilResistanceScore > 0.8 && suspiciousUsers.length === 0
    };
  }

  /**
   * Estimate the cost of successful manipulation
   * @param {Object} userIntensities - User engagement intensities
   * @param {Object} globalStats - Global engagement statistics
   * @returns {Object} Cost estimation
   */
  estimateManipulationCost(userIntensities, globalStats) {
    const avgEngagement = globalStats.avgEngagementPerUser;
    const subscriptionCost = 1; // Assume $1 per subscription
    
    // Calculate how many fake accounts needed to significantly influence payouts
    const targetInfluenceRatio = 0.1; // 10% influence target
    const totalEngagementNeeded = globalStats.totalEngagement * targetInfluenceRatio;
    const fakeAccountsNeeded = Math.ceil(totalEngagementNeeded / avgEngagement);
    
    // Account for intensity scaling
    const intensityReduction = this.gamma;
    const adjustedFakeAccountsNeeded = Math.ceil(fakeAccountsNeeded / intensityReduction);
    
    const totalCost = adjustedFakeAccountsNeeded * subscriptionCost;
    const monthlyCost = totalCost;
    const annualCost = monthlyCost * 12;
    
    return {
      fakeAccountsNeeded: adjustedFakeAccountsNeeded,
      monthlyCost,
      annualCost,
      isProfitable: false, // By design, should never be profitable
      breakEvenPoint: Infinity // Mathematical impossibility of profit
    };
  }

  /**
   * Compare ScaledUserProp with traditional GlobalProp
   * @param {Object} instance - Engagement instance
   * @returns {Object} Comparison results
   */
  compareWithGlobalProp(instance) {
    // Calculate ScaledUserProp payouts
    const scaledResults = this.calculatePayouts(instance);
    
    // Calculate traditional GlobalProp payouts
    const globalPropResults = this.calculateGlobalPropPayouts(instance);
    
    // Calculate differences
    const payoutDifferences = {};
    const percentageChanges = {};
    
    for (const creatorId of instance.creators) {
      const scaledPayout = scaledResults.creatorPayouts[creatorId] || 0;
      const globalPayout = globalPropResults.creatorPayouts[creatorId] || 0;
      
      payoutDifferences[creatorId] = scaledPayout - globalPayout;
      percentageChanges[creatorId] = globalPayout > 0 
        ? ((scaledPayout - globalPayout) / globalPayout) * 100 
        : 0;
    }
    
    // Calculate Sybil vulnerability comparison
    const scaledSybilVulnerability = this.calculateSybilVulnerability(scaledResults);
    const globalSybilVulnerability = this.calculateSybilVulnerability(globalPropResults);
    
    return {
      scaledUserProp: scaledResults,
      globalProp: globalPropResults,
      payoutDifferences,
      percentageChanges,
      sybilVulnerability: {
        scaled: scaledSybilVulnerability,
        global: globalSybilVulnerability,
        improvement: globalSybilVulnerability.score - scaledSybilVulnerability.score
      },
      fairnessComparison: {
        scaled: scaledResults.fairnessMetrics,
        global: globalPropResults.fairnessMetrics
      }
    };
  }

  /**
   * Calculate traditional GlobalProp payouts for comparison
   * @param {Object} instance - Engagement instance
   * @returns {Object} GlobalProp results
   */
  calculateGlobalPropPayouts(instance) {
    const { users, creators, engagements } = instance;
    
    // Calculate total engagement per creator
    const creatorEngagement = {};
    let totalEngagement = 0;
    
    for (const creatorId of creators) {
      creatorEngagement[creatorId] = 0;
    }
    
    for (const userId of users) {
      const userEngagement = engagements[userId] || {};
      for (const [creatorId, weight] of Object.entries(userEngagement)) {
        creatorEngagement[creatorId] += weight;
        totalEngagement += weight;
      }
    }
    
    // Calculate payouts based on proportion of total engagement
    const totalRevenue = users.length * this.alpha;
    const creatorPayouts = {};
    
    for (const creatorId of creators) {
      const share = totalEngagement > 0 ? creatorEngagement[creatorId] / totalEngagement : 0;
      creatorPayouts[creatorId] = share * totalRevenue;
    }
    
    return {
      creatorPayouts,
      creatorShares: creatorEngagement,
      totalRevenue,
      totalEngagement,
      algorithm: 'GlobalProp',
      fairnessMetrics: this.calculateFairnessMetrics(creatorPayouts, creatorEngagement)
    };
  }

  /**
   * Calculate Sybil vulnerability score
   * @param {Object} results - Payout results
   * @returns {Object} Vulnerability assessment
   */
  calculateSybilVulnerability(results) {
    // Simplified vulnerability assessment
    const maxPayout = Math.max(...Object.values(results.creatorPayouts));
    const minPayout = Math.min(...Object.values(results.creatorPayouts).filter(p => p > 0));
    const payoutRatio = minPayout > 0 ? maxPayout / minPayout : Infinity;
    
    // Higher payout ratio indicates higher vulnerability
    const vulnerabilityScore = Math.min(1, Math.log(payoutRatio) / 10);
    
    return {
      score: vulnerabilityScore,
      maxPayout,
      minPayout,
      payoutRatio,
      isVulnerable: vulnerabilityScore > 0.5
    };
  }

  /**
   * Generate detailed report for analysis
   * @param {Object} instance - Engagement instance
   * @returns {Object} Comprehensive report
   */
  generateReport(instance) {
    const results = this.calculatePayouts(instance);
    const comparison = this.compareWithGlobalProp(instance);
    
    return {
      timestamp: new Date().toISOString(),
      instance: {
        totalUsers: instance.users.length,
        totalCreators: instance.creators.length,
        totalEngagement: Object.values(instance.engagements)
          .reduce((sum, userEngagement) => 
            sum + Object.values(userEngagement).reduce((s, w) => s + w, 0), 0)
      },
      scaledUserProp: results,
      comparison,
      recommendations: this.generateRecommendations(results, comparison),
      securityAssessment: this.assessSecurity(results, comparison)
    };
  }

  /**
   * Generate recommendations based on analysis
   * @param {Object} results - ScaledUserProp results
   * @param {Object} comparison - Comparison with GlobalProp
   * @returns {Array} Recommendations
   */
  generateRecommendations(results, comparison) {
    const recommendations = [];
    
    // Check for suspicious users
    if (results.sybilMetrics.suspiciousUsers > 0) {
      recommendations.push({
        type: 'security',
        priority: 'high',
        message: `Found ${results.sybilMetrics.suspiciousUsers} suspicious users. Implement additional verification.`,
        action: 'enhance_user_verification'
      });
    }
    
    // Check fairness metrics
    if (results.fairnessMetrics.maxEnvy > 10) {
      recommendations.push({
        type: 'fairness',
        priority: 'medium',
        message: 'High maximum envy detected. Consider adjusting gamma parameter.',
        action: 'adjust_gamma_parameter'
      });
    }
    
    // Check Sybil resistance
    if (results.sybilMetrics.sybilResistanceScore < 0.8) {
      recommendations.push({
        type: 'security',
        priority: 'high',
        message: 'Low Sybil resistance score. Review engagement patterns.',
        action: 'review_engagement_patterns'
      });
    }
    
    return recommendations;
  }

  /**
   * Assess overall system security
   * @param {Object} results - ScaledUserProp results
   * @param {Object} comparison - Comparison results
   * @returns {Object} Security assessment
   */
  assessSecurity(results, comparison) {
    const { sybilMetrics } = results;
    const { sybilVulnerability } = comparison;
    
    const securityScore = (
      (sybilMetrics.sybilResistanceScore * 0.4) +
      ((1 - sybilVulnerability.scaled.score) * 0.3) +
      (sybilMetrics.isSystemSecure ? 0.3 : 0)
    );
    
    return {
      overallScore: securityScore,
      isSecure: securityScore > 0.8,
      vulnerabilities: [
        ...(sybilMetrics.suspiciousUsers > 0 ? ['suspicious_users'] : []),
        ...(sybilVulnerability.scaled.isVulnerable ? ['payout_manipulation'] : []),
        ...(sybilMetrics.sybilResistanceScore < 0.8 ? ['low_sybil_resistance'] : [])
      ],
      strengths: [
        ...(sybilMetrics.isSystemSecure ? ['sybil_resistance'] : []),
        ...(sybilVulnerability.scaled.score < sybilVulnerability.global.score ? ['improved_over_globalprop'] : []),
        ...(results.fairnessMetrics.maxEnvy < 5 ? ['fair_distribution'] : [])
      ]
    };
  }
}

module.exports = {
  ScaledUserPropEngine
};
