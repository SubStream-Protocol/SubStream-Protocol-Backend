const { BehavioralBiometricService } = require('../src/services/behavioralBiometricService');
const { BotDetectionClassifier } = require('../src/services/botDetectionClassifier');

describe('Behavioral Biometric System', () => {
  let behavioralService;
  let classifier;
  let mockDatabase;

  beforeEach(() => {
    // Mock database
    mockDatabase = {
      db: {
        prepare: jest.fn(),
        exec: jest.fn(),
        run: jest.fn(),
        get: jest.fn(),
        all: jest.fn()
      }
    };

    // Initialize services
    behavioralService = new BehavioralBiometricService(mockDatabase, {
      collection: { enabled: true, maxEventsPerSession: 100 },
      classifier: { enabled: true, confidenceThreshold: 0.7 },
      thresholds: { botScoreThreshold: 0.8, throttlingThreshold: 0.6 },
      privacy: { dataRetentionDays: 30 }
    });

    classifier = new BotDetectionClassifier({
      confidenceThreshold: 0.7,
      thresholds: {
        highEventsPerMinute: 100,
        lowMouseSpeedVariance: 0.1,
        highTypingConsistency: 0.95,
        highRapidClicks: 0.5
      }
    });
  });

  afterEach(() => {
    // Clean up
    behavioralService.stop();
  });

  describe('BehavioralBiometricService', () => {
    describe('Session Management', () => {
      test('should start tracking session', async () => {
        const sessionId = 'test-session-123';
        const sessionData = {
          userAgent: 'Mozilla/5.0',
          viewport: { width: 1920, height: 1080 }
        };

        const result = behavioralService.startSession(sessionId, sessionData);
        
        expect(result.tracking).toBe(true);
        expect(result.sessionId).toBe(sessionId);
        expect(result.fingerprint).toBeDefined();
        expect(behaviorService.activeSessions.has(sessionId)).toBe(true);
      });

      test('should record behavioral events', async () => {
        const sessionId = 'test-session-456';
        behavioralService.startSession(sessionId);

        const eventData = {
          type: 'click',
          coordinates: { x: 100, y: 200 },
          targetElement: 'button'
        };

        const result = behavioralService.recordEvent(sessionId, eventData);
        
        expect(result.recorded).toBe(true);
        expect(result.eventId).toBeDefined();
      });

      test('should analyze session for bot detection', async () => {
        const sessionId = 'test-session-789';
        behavioralService.startSession(sessionId);

        // Simulate some events
        behavioralService.recordEvent(sessionId, { type: 'mousemove', coordinates: { x: 50, y: 50 } });
        behavioralService.recordEvent(sessionId, { type: 'click', coordinates: { x: 100, y: 100 } });
        behavioralService.recordEvent(sessionId, { type: 'keydown', key: 'a' });

        const result = behavioralService.analyzeSession(sessionId);
        
        expect(result.sessionId).toBe(sessionId);
        expect(result.botScore).toBeDefined();
        expect(result.riskLevel).toBeDefined();
        expect(result.confidence).toBeDefined();
        expect(result.features).toBeDefined();
      });

      test('should end session tracking', async () => {
        const sessionId = 'test-session-end-123';
        behavioralService.startSession(sessionId);
        
        const result = behavioralService.endSession(sessionId);
        
        expect(result.sessionId).toBe(sessionId);
        expect(result.duration).toBeGreaterThan(0);
        expect(result.totalEvents).toBeGreaterThanOrEqual(0);
        expect(behavioralService.activeSessions.has(sessionId)).toBe(false);
      });

      test('should handle session timeout', async () => {
        const sessionId = 'test-session-timeout-123';
        
        // Mock session that has timed out
        const expiredSession = {
          id: 'expired-session',
          sessionId,
          startTime: new Date(Date.now() - (35 * 60 * 1000)).toISOString(), // 35 minutes ago
        };
        
        behavioralService.activeSessions.set(sessionId, expiredSession);
        behavioralService.cleanupExpiredSessions();
        
        expect(behavioralService.activeSessions.has(sessionId)).toBe(false);
      });
    });

    describe('Behavioral Feature Extraction', () => {
      test('should extract features from session data', () => {
        const session = {
          startTime: Date.now() - 60000, // 1 minute ago
          events: [
            { type: 'mousemove', timestamp: Date.now() - 59000, coordinates: { x: 10, y: 20 }, movementSpeed: 0.5 },
            { type: 'mousemove', timestamp: Date.now() - 58000, coordinates: { x: 15, y: 25 }, movementSpeed: 0.8 },
            { type: 'click', timestamp: Date.now() - 57000, clickPattern: 'normal_click' },
            { type: 'click', timestamp: Date.now() - 56000, clickPattern: 'normal_click' },
            { type: 'keydown', timestamp: Date.now() - 55000, keystrokeTiming: { pattern: 'normal_typing', interval: 100 } }
          ]
        };

        const features = behavioralService.extractBehavioralFeatures(session);
        
        expect(features.sessionDuration).toBe(60000);
        expect(features.eventsPerMinute).toBe(10);
        expect(features.totalEvents).toBe(6);
        expect(features.mouseEvents).toBe(2);
        expect(features.clickEvents).toBe(2);
        expect(features.keyEvents).toBe(1);
        expect(features.avgMouseSpeed).toBe(0.65);
        expect(features.rapidClicks).toBe(0);
        expect(features.delayedClicks).toBe(0);
      });

      test('should calculate typing consistency', () => {
        const keyEvents = [
          { timestamp: Date.now() - 3000, keystrokeTiming: { interval: 100 } },
          { timestamp: Date.now() - 2900, keystrokeTiming: { interval: 100 } },
          { timestamp: Date.now() - 2800, keystrokeTiming: { interval: 100 } },
          { timestamp: Date.now() - 2700, keystrokeTiming: { interval: 100 } },
          { timestamp: Date.now() - 2600, keystrokeTiming: { interval: 100 } }
        ];

        const consistency = behavioralService.calculateTypingConsistency(keyEvents);
        
        expect(consistency).toBe(1); // Perfect consistency
      });

      test('should calculate scroll smoothness', () => {
        const scrollEvents = [
          { timestamp: Date.now() - 1000, metadata: { scrollDelta: 10 } },
          { timestamp: Date.now() - 900, metadata: { scrollDelta: 12 } },
          { timestamp: Date.now() - 800, metadata: { scrollDelta: 11 } },
          { timestamp: Date.now() - 700, metadata: { scrollDelta: 10 } },
          { timestamp: Date.now() - 600, metadata: { scrollDelta: 9 } }
        ];

        const smoothness = behavioralService.calculateScrollSmoothness(scrollEvents);
        
        expect(smoothness).toBeGreaterThan(0.8); // High smoothness
      });

      test('should analyze click patterns', () => {
        const previousEvents = [
          { type: 'click', timestamp: Date.now() - 2000 },
          { type: 'click', timestamp: Date.now() - 1000 }
        ];
        
        const pattern = behavioralService.analyzeClickPattern(previousEvents, {
          timestamp: Date.now()
        });
        
        expect(pattern).toBe('normal_click');
      });

      test('should analyze keystroke timing', () => {
        const previousEvents = [
          { type: 'keydown', timestamp: Date.now() - 2000 },
          { type: 'keydown', timestamp: Date.now() - 1900 }
        ];
        
        const timing = behavioralService.analyzeKeystrokeTiming(previousEvents, {
          timestamp: Date.now()
        });
        
        expect(timing.pattern).toBe('normal_typing');
        expect(timing.interval).toBe(100);
        expect(timing.consistency).toBeDefined();
      });
    });

    describe('Hash Generation', () => {
      test('should generate behavioral hash', () => {
        const features = {
          eventsPerMinute: 10,
          avgMouseSpeed: 0.5,
          typingConsistency: 0.8,
          rapidClicks: 0,
          totalEvents: 50
        };

        const hash1 = behavioralService.generateBehavioralHash(features);
        const hash2 = behavioralService.generateBehavioralHash(features);
        
        expect(hash1).toBe(hash2); // Same input should produce same hash
        expect(hash1).toMatch(/^[a-f0-9]{64}$/); // Should be a hex string
      });

      test('should generate user fingerprint', () => {
        const sessionData = {
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          viewport: { width: 1920, height: 1080 },
          platform: 'Win32',
          language: 'en-US'
        };

        const fingerprint = behavioralService.generateUserFingerprint(sessionData);
        
        expect(fingerprint).toMatch(/^[a-f0-9]{64}$/); // Should be a hex string
        expect(fingerprint).not.toBe(sessionData.userAgent); // Should not contain raw data
      });

      test('should hash sensitive data', () => {
        const data = 'sensitive-information';
        const hashed = behavioralService.hashData(data);
        
        expect(hashed).toMatch(/^[a-f0-9]{64}$/); // Should be a hex string
        expect(hashed).not.toBe(data); // Should not contain raw data
      });
    });

    describe('Risk Level Calculation', () => {
      test('should calculate minimal risk level', () => {
        const riskLevel = behavioralService.calculateRiskLevel(0.1);
        expect(riskLevel).toBe('minimal');
      });

      test('should calculate low risk level', () => {
        const riskLevel = behavioralService.calculateRiskLevel(0.3);
        expect(riskLevel).toBe('low');
      });

      test('should calculate medium risk level', () => {
        const riskLevel = behavioralService.calculateRiskLevel(0.6);
        expect(riskLevel).toBe('medium');
      });

      test('should calculate high risk level', () => {
        const riskLevel = behavioralService.calculateRiskLevel(0.8);
        expect(riskLevel).toBe('high');
      });

      test('should calculate critical risk level', () => {
        const riskLevel = behavioralService.calculateRiskLevel(0.95);
        expect(riskLevel).toBe('critical');
      });
    });

    describe('Bot Detection', () => {
      test('should use rule-based detection when not trained', () => {
        const features = {
          eventsPerMinute: 150, // High frequency
          mouseSpeedVariance: 0.05, // Very low variance
          typingConsistency: 0.98, // Very consistent
          rapidClicks: 8, // Many rapid clicks
          totalEvents: 100
        };

        const prediction = behavioralService.analyzeSession('test-session');
        
        expect(prediction.botScore).toBeGreaterThan(0.8); // Should detect as bot
        expect(prediction.riskLevel).toBe('high');
      });

      test('should detect human-like behavior', () => {
        const features = {
          eventsPerMinute: 5, // Low frequency
          mouseSpeedVariance: 0.5, // Normal variance
          typingConsistency: 0.7, // Normal consistency
          rapidClicks: 1, // Few rapid clicks
          totalEvents: 10
        };

        const prediction = behavioralService.analyzeSession('test-session');
        
        expect(prediction.botScore).toBeLessThan(0.5); // Should detect as human
        expect(prediction.riskLevel).toBe('low');
      });
    });

    describe('Watch List Management', () => {
      test('should add address to watch list', async () => {
        const sessionId = 'test-session-watchlist';
        const stellarAddress = 'GD5DJQDKEZCHR3BVVXZB4H5QGQDQZQZQZQZQZQZQ';
        const riskScore = 0.95;
        const reason = 'High bot score detected';

        behavioralService.startSession(sessionId);
        behavioralService.addToWatchList(sessionId, riskScore, reason);
        
        const watchListStatus = behavioralService.checkWatchList(stellarAddress);
        
        expect(watchListStatus.onWatchList).toBe(true);
        expect(watchListStatus.riskScore).toBe(riskScore);
        expect(watchListStatus.reason).toBe(reason);
      });

      test('should check if address is not on watch list', async () => {
        const stellarAddress = 'GD5DJQDKEZCHR3BVVXZB4H5QGQDQZQZQZQZQZQZQ';
        
        const watchListStatus = behavioralService.checkWatchList(stellarAddress);
        
        expect(watchListStatus.onWatchList).toBe(false);
      });
    });

    describe('Throttling', () => {
      test('should apply throttling to high-risk sessions', async () => {
        const sessionId = 'test-session-throttle';
        
        // Mock high bot score session
        const session = {
          sessionId,
          botScore: 0.9,
          riskLevel: 'critical'
        };
        behavioralService.activeSessions.set(sessionId, session);

        behavioralService.applySessionThrottling(sessionId);
        
        const updatedSession = behavioralService.activeSessions.get(sessionId);
        
        expect(updatedSession.throttledAt).toBeDefined();
        expect(updatedSession.throttlingLevel).toBeLessThan(1);
      });

      test('should calculate throttling level based on bot score', () => {
        expect(behavioralService.calculateThrottlingLevel(0.9)).toBe(0.1); // 90% throttling
        expect(behavioralService.calculateThrottlingLevel(0.7)).toBe(0.3); // 70% throttling
        expect(behavioral.calculateThrottling(0.5)).toBe(0.7); // 30% throttling
        expect(behavioral.calculateThrottling(0.3)).toBe(1); // No throttling
      });
    });

    describe('Analytics', () => {
      test('should generate behavioral analytics', () => {
        const analytics = behavioralService.getBehavioralAnalytics({
          period: '24h',
          includeDetails: false
        });

        expect(analytics).toBeDefined();
        expect(analytics.period).toBe('24h');
        expect(analytics.sessionStats).toBeDefined();
        expect(analytics.riskDistribution).toBeDefined();
        expect(analytics.activeSessions).toBeDefined();
      });

      test('should include session statistics', () => {
        const analytics = behavioralService.getBehavioralAnalytics({
          period: '24h'
        });

        expect(analytics.sessionStats.totalSessions).toBeGreaterThanOrEqual(0);
        expect(analytics.sessionStats.avgBotScore).toBeGreaterThanOrEqual(0);
        expect(analytics.sessionStats.flaggedSessions).toBeGreaterThanOrEqual(0);
        expect(analytics.sessionStats.throttledSessions).toBeGreaterThanOrEqual(0);
      });
    });

    describe('Privacy Protection', () => {
      test('should anonymize IP addresses when enabled', () => {
        const config = { collection: { anonymizeIP: true, hashSalt: 'test-salt' } };
        const service = new BehavioralBiometricService(mockDatabase, config);

        const metadata = { ip: '192.168.1.1' };
        const processedEvent = service.processEvent({ metadata }, { metadata });

        expect(processedEvent.metadata.ip).toMatch(/^[a-f0-9]{64}$/); // Should be hashed
        expect(processedEvent.metadata.ip).not.toBe('192.168.1.1'); // Should not contain raw IP
      });

      test('should exclude PII when enabled', () => {
        const config = { privacy: { excludePII: true } };
        const service = new BehavioralBiometricService(mockDatabase, config);

        const metadata = {
          email: 'user@example.com',
          name: 'John Doe',
          phone: '+1234567890'
        };
        const processedEvent = service.processEvent({ metadata }, { metadata });

        expect(processedEvent.metadata.email).toBeUndefined();
        expect(processedEvent.metadata.name).toBeUndefined();
        expect(processedEvent.metadata.phone).toBeUndefined();
      });
    });

    describe('Performance', () => {
      test('should get service statistics', () => {
        const stats = behavioralService.getServiceStats();
        
        expect(stats.config).toBeDefined();
        expect(stats.activeSessions).toBe(0);
        expect(stats.databaseStats).toBeDefined();
        expect(stats.modelStats).toBeNull(); // ML model not trained by default
      });

      test('should track performance metrics', async () => {
        const sessionId = 'test-performance';
        behavioralService.startSession(sessionId);
        
        // Simulate some events
        for (let i = 0; i < 10; i++) {
          behavioralService.recordEvent(sessionId, { type: 'click' });
        }

        const metrics = behavioralService.getServiceStats();
        
        expect(metrics.databaseStats.totalSessions).toBe(1);
        expect(metrics.databaseStats.totalEvents).toBe(10);
        expect(metrics.performance.errors).toBe(0);
      });
    });

    describe('Data Cleanup', () => {
      test('should clean up old data', () => {
        const initialCount = mockDatabase.db.prepare.mock.results.length;
        
        behavioralService.cleanupOldData();
        
        expect(mockDatabase.db.run).toHaveBeenCalledWith(
          expect.stringContaining('DELETE FROM behavioral_sessions'),
          expect.any(Array)
        );
      });
    });

    describe('Error Handling', () => {
      test('should handle invalid session gracefully', () => {
        const result = behavioralService.startSession('', {});
        
        expect(result.tracking).toBe(false);
        expect(result.error).toBeDefined();
      });

      event('should handle event recording errors gracefully', () => {
        const result = behavioralService.recordEvent('invalid-session', {});
        
        expect(result.recorded).toBe(false);
        expect(result.error).toBeDefined();
      });

      test('should handle analysis errors gracefully', () => {
        const result = behavioralService.analyzeSession('non-existent-session');
        
        expect(result.error).toBeDefined();
      });
    });
  });

  describe('BotDetectionClassifier', () => {
    describe('Training', () => {
      test('should train with labeled data', () => {
        const trainingData = [
          {
            features: {
              eventsPerMinute: 150,
              mouseSpeedVariance: 0.05,
              typingConsistency: 0.98,
              rapidClicks: 8,
              totalEvents: 100
            },
            label: 'bot'
          },
          {
            features: {
              eventsPerMinute: 5,
              mouseSpeedVariance: 0.5,
              typingConsistency: 0.7,
              rapidClicks: 1,
              totalEvents: 10
            },
            label: 'human'
          }
        ];

        classifier.train(trainingData);
        
        expect(classifier.isTrained).toBe(true);
        expect(classifier.featureStats).toBeDefined();
        expect(classifier.performance.lastTrained).toBeDefined();
      });

      test('should calculate feature statistics', () => {
        const trainingData = [
          {
            features: { eventsPerMinute: 100 },
            label: 'bot'
          },
          {
            features: { eventsPerMinute: 50 },
            label: 'human'
          },
          {
            features: { eventsPerMinute: 25 },
            label: 'human'
          }
        ];

        classifier.train(trainingData);
        
        const stats = classifier.featureStats;
        expect(stats.eventsPerMinute.mean).toBe((100 + 50 + 25) / 3);
        expect(stats.eventsPerMinute.min).toBe(25);
        expect(stats.eventsPerMinute.max).toBe(100);
      });
    });

    describe('Prediction', () => {
      test('should predict bot behavior with trained model', () => {
      const trainingData = [
        {
          features: { eventsPerMinute: 150, mouseSpeedVariance: 0.05, typingConsistency: 0.98 },
          label: 'bot'
        },
        {
          features: { eventsPerMinute: 5, mouseSpeedVariance: 0.5, typingConsistency: 0.7 },
          label: 'human'
        }
      ];

      classifier.train(trainingData);

      // Test bot prediction
      const botFeatures = {
        eventsPerMinute: 120,
        mouseSpeedVariance: 0.08,
        typingConsistency: 0.95,
        rapidClicks: 6,
        totalEvents: 80
      };

      const botPrediction = classifier.predict(botFeatures);
      
      expect(botPrediction.isBot).toBe(true);
      expect(botPrediction.botScore).toBeGreaterThan(0.8);
      expect(botPrediction.confidence).toBeGreaterThan(0.5);

      // Test human prediction
      const humanFeatures = {
        eventsPerMinute: 8,
        mouseSpeedVariance: 0.6,
        typingConsistency: 0.6,
        rapidClicks: 0,
        totalEvents: 12
      };

      const humanPrediction = classifier.predict(humanFeatures);
      
      expect(humanPrediction.isBot).toBe(false);
      expect(humanPrediction.botScore).toBeLessThan(0.5);
    });

    test('should use rule-based prediction when not trained', () => {
      const features = {
        eventsPerMinute: 200,
        mouseSpeedVariance: 0.02,
        typingConsistency: 0.99,
        rapidClicks: 10,
        totalEvents: 150
      };

      const prediction = classifier.predict(features);
      
      expect(prediction.isBot).toBe(true);
      expect(prediction.botScore).toBeGreaterThan(0.8);
      expect(prediction.confidence).toBeLessThan(1);
      expect(prediction.method).toBe('rule_based');
    });

    test('should normalize features', () => {
      const features = {
        eventsPerMinute: 150,
        mouseSpeedVariance: 0.05,
        typingConsistency: 0.98,
        rapidClicks: 8,
        totalEvents: 100
      };

      classifier.train([
        { features: { eventsPerMinute: 100 }, label: 'bot' },
        { features: { eventsPerMinute: 50 }, label: 'human' },
        { features: { eventsPerMinute: 25 }, label: 'human' }
      ]);

      const normalized = classifier.normalizeFeatures(features);
      
      expect(normalized.eventsPerMinute).toBeGreaterThanOrEqual(0);
      expect(normalized.eventsPerMinute).toBeLessThanOrEqual(1);
      expect(normalized.mouseSpeedVariance).toBeGreaterThanOrEqual(0);
      expect(normalized.typingConsistency).toBeGreaterThanOrEqual(0);
    });

    test('should calculate prediction confidence', () => {
      const features = {
        eventsPerMinute: 100,
        mouseSpeedVariance: 0.5,
        typingConsistency: 0.7,
        rapidClicks: 4,
        totalEvents: 50
      };

      classifier.train([
        { features: { eventsPerMinute: 100 }, label: 'bot' },
        { features: { eventsPerMinute: 50 }, label: 'human' }
      ]);

      const prediction = classifier.predict(features);
      
      expect(prediction.confidence).toBeGreaterThanOrEqual(0);
      expect(prediction.confidence).toBeLessThanOrEqual(1);
    });

    test('should detect anomalies', () => {
      const features = {
        eventsPerMinute: 300, // Extremely high
        mouseSpeedVariance: 0, // Perfectly consistent
        typingConsistency: 1, // Perfectly consistent
        rapidClicks: 15, // All clicks rapid
        totalEvents: 200
      };

      const prediction = classifier.predict(features);
      
      expect(prediction.isBot).toBe(true);
      expect(prediction.botScore).toBeCloseTo(1, 1);
    });

    test('should update model with new data', () => {
      const initialData = [
        { features: { eventsPerMinute: 50 }, label: 'human' }
      ];

      classifier.train(initialData);
      expect(classifier.isTrained).toBe(true);

      // Add new training data
      const newData = [
        { features: { eventsPerMinute: 150 }, label: 'bot' },
        { features: { eventsPerMinute: 25 }, label: 'human' }
      ];

      classifier.updateModel({ eventsPerMinute: 120 }, false);
      
      expect(classifier.trainingData.length).toBe(3);
    });

    describe('Performance Tracking', () => {
      test('should track prediction performance', () => {
        classifier.resetPerformanceStats();
        
        // Simulate some predictions
        classifier.predict({ eventsPerMinute: 100 }, true); // Correct prediction
        classifier.predict({ eventsPerMinute: 50 }, false); // False positive
        classifier.predict({ eventsPerMinute: 80 }, true); // Correct prediction
        classifier.predict({ eventsPerMinute: 30 }, false); // False negative

        const stats = classifier.getPerformanceStats();
        
        expect(stats.totalPredictions).toBe(4);
        expect(stats.correctPredictions).toBe(2);
        expect(stats.falsePositives).toBe(1);
        expect(stats.falseNegatives).toBe(1);
        expect(stats.accuracy).toBe(0.5);
        expect(stats.precision).toBe(0.67);
        expect(stats.recall).toBe(0.67);
        expect(stats.f1Score).toBe(0.67);
      });

      test('should export and import model', () => {
        const exportedModel = classifier.exportModel();
        
        expect(exportedModel.config).toBeDefined();
        expect(exportedModel.featureStats).toBeDefined();
        expect(exportedModel.isTrained).toBe(true);
        expect(exportedModel.trainingDataSize).toBeGreaterThanOrEqual(0);

        // Create new classifier and import model
        const newClassifier = new BotDetectionClassifier();
        newClassifier.importModel(exportedModel);
        
        expect(newClassifier.isTrained).toBe(true);
        expect(newClassifier.config.confidenceThreshold).toBe(0.7);
      });
    });
  });

  describe('Integration Tests', () => {
    test('should handle complete session lifecycle', async () => {
      const sessionId = 'integration-test-session';
      
      // Start session
      const startResult = behavioralService.startSession(sessionId, {
        userAgent: 'Test Agent',
        viewport: { width: 1024, height: 768 }
      });
      expect(startResult.tracking).toBe(true);

      // Record various events
      behavioralService.recordEvent(sessionId, { type: 'mousemove', coordinates: { x: 100, y: 100 } });
      behavioralService.recordEvent(sessionId, { type: 'click', coordinates: { x: 200, y: 200 } });
      behavioralService.recordEvent(sessionId, { type: 'keydown', key: 'a' });
      behavioralService.recordEvent(sessionId, { type: 'scroll', scrollY: 100 });

      // Analyze session
      const analysis = behavioralService.analyzeSession(sessionId);
      expect(analysis.sessionId).toBe(sessionId);
      expect(analysis.botScore).toBeDefined();
      expect(analysis.riskLevel).toBeDefined();

      // End session
      const endResult = behavioralService.endSession(sessionId);
      expect(endResult.sessionId).toBe(sessionId);
      expect(endResult.duration).toBeGreaterThan(0);
    });

    test('should handle high-risk session workflow', async () => {
      const sessionId = 'high-risk-session';
      const stellarAddress = 'GD5DJQDKEZCHR3BVVXZB4H5QGQDQZQZQZQZQZQ';
      
      // Start session
      behavioralService.startSession(sessionId, {
        userAgent: 'Bot Agent 3000',
        viewport: { width: 1920, height: 1080 }
      });

      // Simulate bot-like behavior
      for (let i = 0; i < 50; i++) {
        behavioralService.recordEvent(sessionId, { type: 'mousemove', coordinates: { x: Math.random() * 1000, y: Math.random() * 1000 } });
      }
      
      // Analyze session (should detect as bot)
      const analysis = behavioralService.analyzeSession(sessionId);
      expect(analysis.isBot).toBe(true);
      expect(analysis.botScore).toBeGreaterThan(0.8);

      // Should be added to watch list
      const watchListStatus = behavioralService.checkWatchList(stellarAddress);
      expect(watchListStatus.onWatchList).toBe(true);

      // End session
      behavioralService.endSession(sessionId);
      
      // Verify watch list entry
      const watchListEntry = behavioralService.database.db.prepare(
        'SELECT * FROM high_risk_watch_list WHERE stellar_address = ? AND is_active = 1'
      ).get(stellarAddress);
      
      expect(watchListEntry).toBeDefined();
      expect(watchEntry.reason).toContain('High bot score detected');
    });

    test('should handle throttling for flagged sessions', async () => {
      const sessionId = 'throttle-test-session';
      
      behavioralService.startSession(sessionId);
      
      // Simulate behavior that triggers throttling
      for (let i = 0; i < 100; i++) {
        behavioralService.recordEvent(sessionId, { type: 'mousemove' });
      }
      
      // Analyze session (should trigger throttling)
      const analysis = behavioralService.analyzeSession(sessionId);
      expect(analysis.isThrottled).toBe(true);
      expect(analysis.throttlingLevel).toBeLessThan(1);

      // Verify throttling level
      const session = behavioralService.activeSessions.get(sessionId);
      expect(session.throttlingLevel).toBeLessThan(1);
      expect(session.throttledAt).toBeDefined();
    });

    test('should handle privacy requirements', async () => {
      const sessionId = 'privacy-test-session';
      
      // Start session with PII
      const sessionData = {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        viewport: { width: 1920, height: 1080 },
        stellarAddress: 'GD5DJQDKEZCHR3BVVXZB4H5QGQDQZQZQZQZQZQ'
      };

      behavioralService.startSession(sessionId, sessionData);
      
      // Record event with PII
      behavioralService.recordEvent(sessionId, {
        type: 'click',
        metadata: {
          email: 'user@example.com',
          name: 'John Doe',
          stellarAddress: 'GD5DJQDKEZCHR3BVVXZB4H5QGQDQZQZQZQZQZQ'
        }
      });

      // Check if PII is excluded
      const session = behavioralService.activeSessions.get(sessionId);
      const event = session.events[session.events.length - 1];
      
      expect(event.metadata.email).toBeUndefined();
      expect(event.metadata.name).toBeUndefined();
      expect(event.metadata.stellarAddress).toBeUndefined();
    });
  });
});

module.exports = {};
