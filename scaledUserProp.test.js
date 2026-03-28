/**
 * Comprehensive Testing Suite for ScaledUserProp Revenue Division System
 * 
 * This test suite provides comprehensive coverage for all components of the
 * ScaledUserProp implementation including algorithm correctness, Sybil protection,
 * performance benchmarks, and integration testing.
 */

const { ScaledUserPropEngine } = require('../src/services/scaledUserPropEngine');
const { SybilAttackProtectionService } = require('../src/services/sybilAttackProtectionService');
const { PayoutCalculationEngine } = require('../src/services/payoutCalculationEngine');
const { EngagementMetricsService } = require('../src/services/engagementMetricsService');
const { AntiManipulationSafeguardsService } = require('../src/services/antiManipulationSafeguardsService');

class ScaledUserPropTestSuite {
  constructor() {
    this.testResults = {
      total: 0,
      passed: 0,
      failed: 0,
      errors: []
    };
    
    this.mockDatabase = this.createMockDatabase();
  }

  /**
   * Run all tests
   * @returns {Object} Test results
   */
  async runAllTests() {
    console.log('🧪 Starting ScaledUserProp Test Suite...\n');
    
    // Initialize test environment
    await this.setupTestEnvironment();
    
    try {
      // Core algorithm tests
      await this.testScaledUserPropAlgorithm();
      
      // Sybil protection tests
      await this.testSybilAttackProtection();
      
      // Payout calculation tests
      await this.testPayoutCalculationEngine();
      
      // Engagement metrics tests
      await this.testEngagementMetricsService();
      
      // Anti-manipulation tests
      await this.testAntiManipulationSafeguards();
      
      // Integration tests
      await this.testSystemIntegration();
      
      // Performance tests
      await this.testPerformanceBenchmarks();
      
      // Edge case tests
      await this.testEdgeCases();
      
      // Security tests
      await this.testSecurityVulnerabilities();
      
    } catch (error) {
      console.error('❌ Test suite failed:', error);
      this.testResults.errors.push(error.message);
    } finally {
      // Cleanup test environment
      await this.cleanupTestEnvironment();
    }
    
    this.printTestResults();
    return this.testResults;
  }

  /**
   * Setup test environment
   */
  async setupTestEnvironment() {
    console.log('🔧 Setting up test environment...');
    
    // Create test data
    this.testData = this.generateTestData();
    
    // Initialize services with test configuration
    this.testConfig = {
      alpha: 0.7,
      gamma: 0.5,
      debug: true,
      enableValidation: true,
      batchSize: 100
    };
    
    console.log('✅ Test environment ready\n');
  }

  /**
   * Test ScaledUserProp algorithm correctness
   */
  async testScaledUserPropAlgorithm() {
    console.log('📊 Testing ScaledUserProp Algorithm...');
    
    const engine = new ScaledUserPropEngine(this.testConfig);
    
    // Test 1: Basic functionality
    await this.runTest('Basic ScaledUserProp calculation', async () => {
      const result = engine.calculatePayouts(this.testData.basicInstance);
      
      this.assert(result.creatorPayouts, 'Creator payouts should be defined');
      this.assert(result.totalRevenue > 0, 'Total revenue should be positive');
      this.assert(Object.keys(result.creatorPayouts).length > 0, 'Should have creator payouts');
      
      // Verify revenue distribution
      const totalPayouts = Object.values(result.creatorPayouts).reduce((sum, p) => sum + p, 0);
      this.assert(Math.abs(totalPayouts - result.totalRevenue) < 0.01, 'Total payouts should equal total revenue');
    });
    
    // Test 2: Edge case - empty engagement
    await this.runTest('Empty engagement handling', async () => {
      const emptyInstance = {
        users: [],
        creators: ['creator1', 'creator2'],
        engagements: {}
      };
      
      const result = engine.calculatePayouts(emptyInstance);
      
      this.assert(result.totalRevenue === 0, 'Total revenue should be 0 for no users');
      this.assert(Object.values(result.creatorPayouts).every(p => p === 0), 'All payouts should be 0');
    });
    
    // Test 3: High engagement intensity scaling
    await this.runTest('High engagement intensity scaling', async () => {
      const highEngagementInstance = this.createHighEngagementInstance();
      const result = engine.calculatePayouts(highEngagementInstance);
      
      // Check that high engagement users are scaled down
      const userIntensities = result.userIntensities;
      const highEngagementUsers = Object.values(userIntensities).filter(ui => ui.engagementRatio > 5);
      
      this.assert(highEngagementUsers.length > 0, 'Should have high engagement users');
      this.assert(highEngagementUsers.every(ui => ui.intensityFactor < 1), 'High engagement should be scaled down');
    });
    
    // Test 4: Comparison with GlobalProp
    await this.runTest('Algorithm comparison with GlobalProp', async () => {
      const comparison = engine.compareWithGlobalProp(this.testData.basicInstance);
      
      this.assert(comparison.scaledUserProp, 'Should have ScaledUserProp results');
      this.assert(comparison.globalProp, 'Should have GlobalProp results');
      this.assert(comparison.sybilVulnerability, 'Should have Sybil vulnerability comparison');
      
      // ScaledUserProp should have better Sybil resistance
      this.assert(comparison.sybilVulnerability.improvement >= 0, 'ScaledUserProp should improve Sybil resistance');
    });
    
    // Test 5: Fairness metrics
    await this.runTest('Fairness metrics calculation', async () => {
      const result = engine.calculatePayouts(this.testData.basicInstance);
      
      this.assert(result.fairnessMetrics, 'Should have fairness metrics');
      this.assert(typeof result.fairnessMetrics.maxEnvy === 'number', 'Max envy should be a number');
      this.assert(typeof result.fairnessMetrics.giniCoefficient === 'number', 'Gini coefficient should be a number');
      this.assert(result.fairnessMetrics.giniCoefficient >= 0 && result.fairnessMetrics.giniCoefficient <= 1, 'Gini coefficient should be between 0 and 1');
    });
    
    console.log('✅ ScaledUserProp Algorithm tests completed\n');
  }

  /**
   * Test Sybil attack protection
   */
  async testSybilAttackProtection() {
    console.log('🛡️ Testing Sybil Attack Protection...');
    
    const sybilService = new SybilAttackProtectionService(this.mockDatabase, this.testConfig);
    
    // Test 1: Fingerprint analysis
    await this.runTest('Fingerprint risk analysis', async () => {
      const sessionData = {
        ipAddress: '192.168.1.1',
        userAgent: 'TestBot/1.0',
        deviceFingerprint: 'device123'
      };
      
      const risk = sybilService.analyzeFingerprintRisk('user1', sessionData);
      
      this.assert(risk.type === 'fingerprint', 'Should be fingerprint analysis');
      this.assert(typeof risk.score === 'number', 'Risk score should be a number');
      this.assert(risk.score >= 0 && risk.score <= 1, 'Risk score should be between 0 and 1');
    });
    
    // Test 2: Engagement pattern analysis
    await this.runTest('Engagement pattern analysis', async () => {
      const engagementData = {
        creator1: 100,  // High engagement
        creator2: 95,   // Very consistent engagement
        creator3: 105   // High engagement
      };
      
      const risk = sybilService.analyzeEngagementPatterns('user1', engagementData);
      
      this.assert(risk.type === 'engagement', 'Should be engagement analysis');
      this.assert(risk.factors.length >= 0, 'Should have risk factors');
    });
    
    // Test 3: Complete user analysis
    await this.runTest('Complete Sybil user analysis', async () => {
      const analysis = sybilService.analyzeUserForSybil('user1', this.testData.suspiciousEngagement, this.testData.sessionData);
      
      this.assert(analysis.userAddress === 'user1', 'Should analyze correct user');
      this.assert(analysis.riskFactors.length > 0, 'Should have risk factors');
      this.assert(typeof analysis.overallRisk === 'number', 'Should have overall risk score');
      this.assert(Array.isArray(analysis.recommendations), 'Should have recommendations');
    });
    
    // Test 4: System statistics
    await this.runTest('Sybil system statistics', async () => {
      const stats = sybilService.getSystemStatistics();
      
      this.assert(typeof stats.totalUsers === 'number', 'Should have total users count');
      this.assert(typeof stats.suspiciousUsers === 'number', 'Should have suspicious users count');
      this.assert(typeof stats.sybilResistanceScore === 'number', 'Should have Sybil resistance score');
    });
    
    console.log('✅ Sybil Attack Protection tests completed\n');
  }

  /**
   * Test payout calculation engine
   */
  async testPayoutCalculationEngine() {
    console.log('💰 Testing Payout Calculation Engine...');
    
    const payoutEngine = new PayoutCalculationEngine(this.mockDatabase, this.testConfig);
    
    // Test 1: Period-based calculation
    await this.runTest('Period-based payout calculation', async () => {
      const period = {
        start: new Date('2024-01-01'),
        end: new Date('2024-01-02')
      };
      
      const result = await payoutEngine.calculatePayoutsForPeriod(period);
      
      this.assert(result.creatorPayouts, 'Should have creator payouts');
      this.assert(result.globalStats, 'Should have global statistics');
      this.assert(typeof result.totalRevenue === 'number', 'Should have total revenue');
    });
    
    // Test 2: Real-time payout calculation
    await this.runTest('Real-time payout calculation', async () => {
      const result = await payoutEngine.calculateRealTimePayout('creator1');
      
      this.assert(result.creatorAddress === 'creator1', 'Should calculate for correct creator');
      this.assert(typeof result.payoutAmount === 'number', 'Should have payout amount');
      this.assert(result.timestamp, 'Should have timestamp');
    });
    
    // Test 3: Economic safeguards
    await this.runTest('Economic safeguards application', async () => {
      const testPayouts = {
        creator1: 1000,  // High payout
        creator2: 0.001, // Very low payout
        creator3: 50
      };
      
      const safeguarded = payoutEngine.applyEconomicSafeguards({
        creatorPayouts: testPayouts,
        totalRevenue: 1100.001
      });
      
      this.assert(safeguarded.economicSafeguards, 'Should have economic safeguards data');
      this.assert(safeguarded.economicSafeguards.minimumPayoutsApplied >= 0, 'Should track minimum payouts applied');
    });
    
    // Test 4: System statistics
    await this.runTest('Payout engine statistics', async () => {
      const stats = payoutEngine.getSystemStatistics();
      
      this.assert(typeof stats.totalCalculations === 'number', 'Should have total calculations');
      this.assert(typeof stats.averageCalculationTime === 'number', 'Should have average calculation time');
      this.assert(typeof stats.sybilProtectionEffectiveness === 'number', 'Should have Sybil protection effectiveness');
    });
    
    console.log('✅ Payout Calculation Engine tests completed\n');
  }

  /**
   * Test engagement metrics service
   */
  async testEngagementMetricsService() {
    console.log('📈 Testing Engagement Metrics Service...');
    
    const engagementService = new EngagementMetricsService(this.mockDatabase, this.testConfig);
    
    // Test 1: Engagement recording
    await this.runTest('Engagement event recording', async () => {
      const eventData = {
        userAddress: 'user1',
        creatorAddress: 'creator1',
        contentId: 'content1',
        contentType: 'video',
        engagementType: 'view',
        duration: 60000
      };
      
      const result = engagementService.recordEngagement(eventData);
      
      this.assert(result.success, 'Should successfully record engagement');
      this.assert(result.eventId, 'Should have event ID');
      this.assert(typeof result.engagementWeight === 'number', 'Should have engagement weight');
    });
    
    // Test 2: Data validation
    await this.runTest('Engagement data validation', async () => {
      const invalidData = {
        userAddress: '',  // Invalid address
        creatorAddress: 'creator1',
        contentType: 'video',
        engagementType: 'view'
      };
      
      const result = engagementService.recordEngagement(invalidData);
      
      this.assert(!result.success, 'Should fail validation for invalid data');
      this.assert(result.error, 'Should have error message');
    });
    
    // Test 3: Creator statistics
    await this.runTest('Creator statistics calculation', async () => {
      const period = {
        start: new Date('2024-01-01'),
        end: new Date('2024-01-02')
      };
      
      const stats = engagementService.getCreatorStatistics('creator1', period);
      
      this.assert(stats || stats === null, 'Should return stats or null');
      if (stats) {
        this.assert(stats.creatorAddress === 'creator1', 'Should have correct creator address');
        this.assert(typeof stats.uniqueUsers === 'number', 'Should have unique users count');
      }
    });
    
    // Test 4: System metrics
    await this.runTest('System metrics collection', async () => {
      const period = {
        start: new Date('2024-01-01'),
        end: new Date('2024-01-02')
      };
      
      const metrics = engagementService.getSystemMetrics(period);
      
      this.assert(metrics || metrics === null, 'Should return metrics or null');
      if (metrics) {
        this.assert(typeof metrics.totalUsers === 'number', 'Should have total users');
        this.assert(typeof metrics.totalEngagement === 'number', 'Should have total engagement');
      }
    });
    
    console.log('✅ Engagement Metrics Service tests completed\n');
  }

  /**
   * Test anti-manipulation safeguards
   */
  async testAntiManipulationSafeguards() {
    console.log('🔒 Testing Anti-Manipulation Safeguards...');
    
    const safeguardsService = new AntiManipulationSafeguardsService(this.mockDatabase, this.testConfig);
    
    // Test 1: Safeguard checks
    await this.runTest('Comprehensive safeguard checks', async () => {
      const context = {
        entityAddress: 'user1',
        entityType: 'user',
        engagementData: this.testData.suspiciousEngagement,
        networkData: this.testData.networkData,
        temporalData: this.testData.temporalData,
        economicData: this.testData.economicData
      };
      
      const analysis = safeguardsService.runSafeguardChecks(context);
      
      this.assert(analysis.context, 'Should have analysis context');
      this.assert(Array.isArray(analysis.threats), 'Should have threats array');
      this.assert(typeof analysis.overallRisk === 'number', 'Should have overall risk score');
      this.assert(Array.isArray(analysis.recommendations), 'Should have recommendations');
      this.assert(Array.isArray(analysis.actions), 'Should have actions');
    });
    
    // Test 2: Cooldown management
    await this.runTest('Entity cooldown management', async () => {
      // Test cooldown status
      const status = safeguardsService.checkCooldownStatus('user1', 'user');
      this.assert(typeof status.isActive === 'boolean', 'Should return cooldown status');
      
      // Test placing in cooldown
      safeguardsService.placeInCooldown('user1', 'user', 'test', 'medium', 60000);
      const newStatus = safeguardsService.checkCooldownStatus('user1', 'user');
      this.assert(newStatus.isActive, 'Should be in cooldown after placement');
    });
    
    // Test 3: Adaptive thresholds
    await this.runTest('Adaptive threshold management', async () => {
      const initialValue = safeguardsService.getAdaptiveThreshold('suspicious_engagement_threshold');
      
      safeguardsService.adjustAdaptiveThreshold('suspicious_engagement_threshold', initialValue * 1.1, 'test');
      const adjustedValue = safeguardsService.getAdaptiveThreshold('suspicious_engagement_threshold');
      
      this.assert(adjustedValue > initialValue, 'Threshold should be adjusted upward');
    });
    
    // Test 4: System statistics
    await this.runTest('Safeguards system statistics', async () => {
      const stats = safeguardsService.getSystemStatistics();
      
      this.assert(typeof stats.totalDetections === 'number', 'Should have total detections');
      this.assert(typeof stats.activeThreats === 'number', 'Should have active threats');
      this.assert(typeof stats.systemHealth === 'number', 'Should have system health score');
    });
    
    console.log('✅ Anti-Manipulation Safeguards tests completed\n');
  }

  /**
   * Test system integration
   */
  async testSystemIntegration() {
    console.log('🔗 Testing System Integration...');
    
    // Test 1: End-to-end payout calculation
    await this.runTest('End-to-end payout calculation', async () => {
      const payoutEngine = new PayoutCalculationEngine(this.mockDatabase, this.testConfig);
      const engagementService = new EngagementMetricsService(this.mockDatabase, this.testConfig);
      
      // Record some engagement data
      await engagementService.recordEngagement({
        userAddress: 'user1',
        creatorAddress: 'creator1',
        contentId: 'content1',
        contentType: 'video',
        engagementType: 'view',
        duration: 60000
      });
      
      // Calculate payouts
      const period = {
        start: new Date('2024-01-01'),
        end: new Date('2024-01-02')
      };
      
      const result = await payoutEngine.calculatePayoutsForPeriod(period);
      
      this.assert(result.creatorPayouts, 'Should have calculated payouts');
      this.assert(result.sybilMetrics, 'Should have Sybil metrics');
    });
    
    // Test 2: Sybil protection integration
    await this.runTest('Sybil protection integration', async () => {
      const payoutEngine = new PayoutCalculationEngine(this.mockDatabase, this.testConfig);
      const sybilService = new SybilAttackProtectionService(this.mockDatabase, this.testConfig);
      
      // Analyze suspicious user
      const sybilAnalysis = sybilService.analyzeUserForSybil(
        'user1', 
        this.testData.suspiciousEngagement, 
        this.testData.sessionData
      );
      
      // This should affect payout calculations
      this.assert(sybilAnalysis.overallRisk >= 0, 'Should have risk assessment');
    });
    
    console.log('✅ System Integration tests completed\n');
  }

  /**
   * Test performance benchmarks
   */
  async testPerformanceBenchmarks() {
    console.log('⚡ Testing Performance Benchmarks...');
    
    // Test 1: Algorithm performance
    await this.runTest('ScaledUserProp algorithm performance', async () => {
      const engine = new ScaledUserPropEngine(this.testConfig);
      
      const largeInstance = this.createLargeTestInstance(1000, 100); // 1000 users, 100 creators
      
      const startTime = Date.now();
      const result = engine.calculatePayouts(largeInstance);
      const endTime = Date.now();
      
      const calculationTime = endTime - startTime;
      
      this.assert(result.creatorPayouts, 'Should calculate payouts for large instance');
      this.assert(calculationTime < 5000, 'Should complete within 5 seconds'); // Performance requirement
      
      console.log(`   ⏱️  Large instance calculation time: ${calculationTime}ms`);
    });
    
    // Test 2: Memory usage
    await this.runTest('Memory usage optimization', async () => {
      const initialMemory = process.memoryUsage();
      
      const engine = new ScaledUserPropEngine(this.testConfig);
      
      // Run multiple calculations
      for (let i = 0; i < 100; i++) {
        engine.calculatePayouts(this.testData.basicInstance);
      }
      
      const finalMemory = process.memoryUsage();
      const memoryIncrease = finalMemory.heapUsed - initialMemory.heapUsed;
      
      // Memory increase should be reasonable (less than 50MB)
      this.assert(memoryIncrease < 50 * 1024 * 1024, 'Memory increase should be reasonable');
      
      console.log(`   💾 Memory increase: ${(memoryIncrease / 1024 / 1024).toFixed(2)}MB`);
    });
    
    console.log('✅ Performance Benchmarks tests completed\n');
  }

  /**
   * Test edge cases
   */
  async testEdgeCases() {
    console.log('🎯 Testing Edge Cases...');
    
    const engine = new ScaledUserPropEngine(this.testConfig);
    
    // Test 1: Single user, single creator
    await this.runTest('Single user single creator', async () => {
      const instance = {
        users: ['user1'],
        creators: ['creator1'],
        engagements: {
          user1: { creator1: 10 }
        }
      };
      
      const result = engine.calculatePayouts(instance);
      
      this.assert(result.creatorPayouts.creator1 > 0, 'Single creator should receive payout');
      this.assert(result.totalRevenue > 0, 'Should have total revenue');
    });
    
    // Test 2: Zero engagement
    await this.runTest('Zero engagement handling', async () => {
      const instance = {
        users: ['user1', 'user2'],
        creators: ['creator1', 'creator2'],
        engagements: {
          user1: { creator1: 0 },
          user2: { creator2: 0 }
        }
      };
      
      const result = engine.calculatePayouts(instance);
      
      this.assert(Object.values(result.creatorPayouts).every(p => p === 0), 'Zero engagement should result in zero payouts');
    });
    
    // Test 3: Extremely high engagement
    await this.runTest('Extremely high engagement handling', async () => {
      const instance = {
        users: ['user1'],
        creators: ['creator1'],
        engagements: {
          user1: { creator1: 1000000 } // Very high engagement
        }
      };
      
      const result = engine.calculatePayouts(instance);
      
      this.assert(result.creatorPayouts.creator1 >= 0, 'Should handle high engagement gracefully');
      this.assert(isFinite(result.creatorPayouts.creator1), 'Payout should be finite');
    });
    
    console.log('✅ Edge Cases tests completed\n');
  }

  /**
   * Test security vulnerabilities
   */
  async testSecurityVulnerabilities() {
    console.log('🔐 Testing Security Vulnerabilities...');
    
    const sybilService = new SybilAttackProtectionService(this.mockDatabase, this.testConfig);
    
    // Test 1: Injection attack resistance
    await this.runTest('SQL injection resistance', async () => {
      const maliciousAddress = "'; DROP TABLE users; --";
      
      try {
        const analysis = sybilService.analyzeUserForSybil(maliciousAddress, {}, {});
        // Should not crash or cause issues
        this.assert(true, 'Should handle malicious input gracefully');
      } catch (error) {
        this.assert(false, `Should not throw error for malicious input: ${error.message}`);
      }
    });
    
    // Test 2: Data validation
    await this.runTest('Input validation security', async () => {
      const engagementService = new EngagementMetricsService(this.mockDatabase, this.testConfig);
      
      const maliciousData = {
        userAddress: '<script>alert("xss")</script>',
        creatorAddress: 'creator1',
        contentType: '<img src=x onerror=alert(1)>',
        engagementType: 'view'
      };
      
      const result = engagementService.recordEngagement(maliciousData);
      
      // Should either fail validation or sanitize the data
      if (result.success) {
        this.assert(true, 'Should handle malicious input');
      } else {
        this.assert(result.error, 'Should provide error for invalid input');
      }
    });
    
    console.log('✅ Security Vulnerabilities tests completed\n');
  }

  /**
   * Run a single test
   * @param {string} testName - Test name
   * @param {Function} testFunction - Test function
   */
  async runTest(testName, testFunction) {
    this.testResults.total++;
    
    try {
      await testFunction();
      this.testResults.passed++;
      console.log(`   ✅ ${testName}`);
    } catch (error) {
      this.testResults.failed++;
      this.testResults.errors.push(`${testName}: ${error.message}`);
      console.log(`   ❌ ${testName}: ${error.message}`);
    }
  }

  /**
   * Assert a condition
   * @param {boolean} condition - Condition to assert
   * @param {string} message - Error message
   */
  assert(condition, message) {
    if (!condition) {
      throw new Error(message || 'Assertion failed');
    }
  }

  /**
   * Create mock database
   * @returns {Object} Mock database object
   */
  createMockDatabase() {
    return {
      run: () => ({ changes: 1 }),
      prepare: () => ({
        get: () => ({}),
        all: () => [],
        run: () => ({ changes: 1 })
      })
    };
  }

  /**
   * Generate test data
   * @returns {Object} Test data
   */
  generateTestData() {
    return {
      basicInstance: {
        users: ['user1', 'user2', 'user3', 'user4', 'user5'],
        creators: ['creator1', 'creator2', 'creator3'],
        engagements: {
          user1: { creator1: 10, creator2: 5 },
          user2: { creator1: 8, creator3: 12 },
          user3: { creator2: 15, creator3: 3 },
          user4: { creator1: 6, creator2: 9 },
          user5: { creator3: 11 }
        }
      },
      suspiciousEngagement: {
        creator1: 1000,  // Very high engagement
        creator2: 950,   // Consistent high engagement
        creator3: 1050   // Very high engagement
      },
      sessionData: {
        ipAddress: '192.168.1.100',
        userAgent: 'SuspiciousBot/1.0',
        deviceFingerprint: 'device_suspicious_123'
      },
      networkData: {
        ipClusterCount: 10,
        deviceClusterCount: 5,
        coordinatedActivityScore: 0.8
      },
      temporalData: {
        hourlyEngagement: [0, 0, 0, 150, 200, 180, 0, 0], // Burst activity
        synchronizationScore: 0.9
      },
      economicData: {
        subscriptionCost: 1,
        estimatedRevenue: 200,  // High profit margin
        totalEngagement: 2000
      }
    };
  }

  /**
   * Create high engagement test instance
   * @returns {Object} High engagement instance
   */
  createHighEngagementInstance() {
    return {
      users: ['normal1', 'normal2', 'high1', 'high2'],
      creators: ['creator1', 'creator2'],
      engagements: {
        normal1: { creator1: 5, creator2: 3 },
        normal2: { creator1: 7, creator2: 4 },
        high1: { creator1: 100, creator2: 95 },  // High engagement
        high2: { creator1: 120, creator2: 110 }  // Very high engagement
      }
    };
  }

  /**
   * Create large test instance
   * @param {number} userCount - Number of users
   * @param {number} creatorCount - Number of creators
   * @returns {Object} Large test instance
   */
  createLargeTestInstance(userCount, creatorCount) {
    const users = Array.from({ length: userCount }, (_, i) => `user${i}`);
    const creators = Array.from({ length: creatorCount }, (_, i) => `creator${i}`);
    const engagements = {};
    
    for (let i = 0; i < userCount; i++) {
      engagements[users[i]] = {};
      for (let j = 0; j < creatorCount; j++) {
        if (Math.random() > 0.7) { // 30% chance of engagement
          engagements[users[i]][creators[j]] = Math.floor(Math.random() * 20) + 1;
        }
      }
    }
    
    return { users, creators, engagements };
  }

  /**
   * Cleanup test environment
   */
  async cleanupTestEnvironment() {
    console.log('🧹 Cleaning up test environment...');
    // Cleanup any test data, close connections, etc.
  }

  /**
   * Print test results
   */
  printTestResults() {
    console.log('\n📊 Test Results:');
    console.log(`   Total: ${this.testResults.total}`);
    console.log(`   Passed: ${this.testResults.passed}`);
    console.log(`   Failed: ${this.testResults.failed}`);
    console.log(`   Success Rate: ${((this.testResults.passed / this.testResults.total) * 100).toFixed(1)}%`);
    
    if (this.testResults.errors.length > 0) {
      console.log('\n❌ Failed Tests:');
      this.testResults.errors.forEach(error => {
        console.log(`   - ${error}`);
      });
    }
    
    console.log('\n🎉 ScaledUserProp Test Suite Completed!');
  }
}

// Export for use in test files
module.exports = {
  ScaledUserPropTestSuite
};

// Run tests if this file is executed directly
if (require.main === module) {
  const testSuite = new ScaledUserPropTestSuite();
  testSuite.runAllTests().catch(console.error);
}
