const { FallbackPriceService } = require('../src/services/fallbackPriceService');

// Mock axios
jest.mock('axios');

describe('FallbackPriceService', () => {
  let fallbackService;
  let mockConfig;

  beforeEach(() => {
    mockConfig = {
      fallbackApis: [
        {
          name: 'TestAPI',
          url: 'https://api.test.com/price',
          rateLimit: 10,
          timeout: 5000
        }
      ],
      circuitBreakerThreshold: 3,
      circuitBreakerTimeout: 60000,
      cacheTtl: 300000
    };

    fallbackService = new FallbackPriceService(mockConfig);
  });

  describe('constructor', () => {
    test('should initialize with correct configuration', () => {
      expect(fallbackService.apis).toEqual(mockConfig.fallbackApis);
      expect(fallbackService.circuitBreakerThreshold).toBe(3);
      expect(fallbackService.cacheTtl).toBe(300000);
    });

    test('should use default values when not provided', () => {
      const minimalConfig = {};
      const minimalService = new FallbackPriceService(minimalConfig);

      expect(minimalService.apis).toHaveLength(3); // Default APIs
      expect(minimalService.circuitBreakerThreshold).toBe(5);
      expect(minimalService.cacheTtl).toBe(300000);
    });
  });

  describe('getUsdEquivalent', () => {
    test('should return cached price when available', async () => {
      const cacheKey = fallbackService.getCacheKey('XLM', null);
      const cachedPrice = {
        price: 0.1234,
        timestamp: new Date(),
        cachedAt: Date.now()
      };
      
      fallbackService.setCache(cacheKey, cachedPrice);

      const result = await fallbackService.getUsdEquivalent('XLM', null, 100, new Date());

      expect(result.usdEquivalent).toBe(12.34);
      expect(result.source).toBe('fallback-cache');
      expect(result.confidence).toBe(0.8);
      expect(result.backfillRequired).toBe(true);
    });

    test('should fetch from API when cache miss', async () => {
      const axios = require('axios');
      const mockResponse = {
        data: {
          stellar: {
            usd: 0.1234,
            last_updated_at: '2023-01-01T12:00:00Z'
          }
        }
      };
      axios.get.mockResolvedValue(mockResponse);

      const result = await fallbackService.getUsdEquivalent('XLM', null, 100, new Date());

      expect(result.usdEquivalent).toBe(12.34);
      expect(result.source).toBe('fallback-TestAPI');
      expect(result.confidence).toBe(0.8);
      expect(result.backfillRequired).toBe(true);
    });

    test('should return null when all APIs fail', async () => {
      const axios = require('axios');
      axios.get.mockRejectedValue(new Error('API Error'));

      const result = await fallbackService.getUsdEquivalent('XLM', null, 100, new Date());

      expect(result.usdEquivalent).toBeNull();
      expect(result.source).toBe('fallback-failed');
      expect(result.backfillRequired).toBe(true);
    });

    test('should skip APIs with open circuit breakers', async () => {
      // Trip circuit breaker
      const apiState = fallbackService.apiStates[0];
      fallbackService.tripCircuit(apiState);

      const axios = require('axios');
      axios.get.mockRejectedValue(new Error('Should not be called'));

      const result = await fallbackService.getUsdEquivalent('XLM', null, 100, new Date());

      expect(result.usdEquivalent).toBeNull();
      expect(result.source).toBe('fallback-failed');
      expect(axios.get).not.toHaveBeenCalled();
    });
  });

  describe('fetchFromCoinGecko', () => {
    test('should fetch price successfully', async () => {
      const apiState = fallbackService.apiStates.find(api => api.name === 'CoinGecko');
      if (!apiState) {
        // Add CoinGecko API for testing
        fallbackService.apis.push({
          name: 'CoinGecko',
          url: 'https://api.coingecko.com/api/v3/simple/price',
          rateLimit: 10,
          timeout: 5000
        });
      }

      const axios = require('axios');
      const mockResponse = {
        data: {
          stellar: {
            usd: 0.1234,
            last_updated_at: '2023-01-01T12:00:00Z'
          }
        }
      };
      axios.get.mockResolvedValue(mockResponse);

      const result = await fallbackService.fetchFromCoinGecko(apiState, 'XLM');

      expect(result.price).toBe(0.1234);
      expect(result.source).toBe('coingecko');
      expect(result.timestamp).toBeInstanceOf(Date);
    });

    test('should handle asset not found', async () => {
      const apiState = fallbackService.apiStates[0];
      apiState.name = 'CoinGecko';
      apiState.url = 'https://api.coingecko.com/api/v3/simple/price';

      const axios = require('axios');
      const mockResponse = {
        data: {}
      };
      axios.get.mockResolvedValue(mockResponse);

      await expect(fallbackService.fetchFromCoinGecko(apiState, 'UNKNOWN'))
        .rejects.toThrow('Asset UNKNOWN not found on CoinGecko');
    });
  });

  describe('fetchFromCoinCap', () => {
    test('should fetch price successfully', async () => {
      const apiState = { name: 'CoinCap', url: 'https://api.coincap.io/v2/rates' };

      const axios = require('axios');
      const mockResponse = {
        data: {
          data: [
            {
              symbol: 'XLM',
              rateUsd: '0.1234'
            }
          ]
        }
      };
      axios.get.mockResolvedValue(mockResponse);

      const result = await fallbackService.fetchFromCoinCap(apiState, 'XLM');

      expect(result.price).toBe(0.1234);
      expect(result.source).toBe('coincap');
      expect(result.timestamp).toBeInstanceOf(Date);
    });

    test('should handle asset not found', async () => {
      const apiState = { name: 'CoinCap', url: 'https://api.coincap.io/v2/rates' };

      const axios = require('axios');
      const mockResponse = {
        data: {
          data: []
        }
      };
      axios.get.mockResolvedValue(mockResponse);

      await expect(fallbackService.fetchFromCoinCap(apiState, 'UNKNOWN'))
        .rejects.toThrow('Asset UNKNOWN not found on CoinCap');
    });
  });

  describe('fetchFromCoinMarketCap', () => {
    test('should fetch price successfully', async () => {
      const apiState = {
        name: 'CoinMarketCap',
        url: 'https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest',
        headers: {
          'X-CMC_PRO_API_KEY': 'test-key'
        }
      };

      const axios = require('axios');
      const mockResponse = {
        data: {
          data: {
            XLM: {
              quote: {
                USD: {
                  price: 0.1234,
                  last_updated: '2023-01-01T12:00:00Z'
                }
              }
            }
          }
        }
      };
      axios.get.mockResolvedValue(mockResponse);

      const result = await fallbackService.fetchFromCoinMarketCap(apiState, 'XLM');

      expect(result.price).toBe(0.1234);
      expect(result.source).toBe('coinmarketcap');
      expect(result.timestamp).toBeInstanceOf(Date);
    });

    test('should handle missing API key', async () => {
      const apiState = {
        name: 'CoinMarketCap',
        url: 'https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest',
        headers: {}
      };

      await expect(fallbackService.fetchFromCoinMarketCap(apiState, 'XLM'))
        .rejects.toThrow('CoinMarketCap API key not configured');
    });

    test('should handle asset not found', async () => {
      const apiState = {
        name: 'CoinMarketCap',
        url: 'https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest',
        headers: {
          'X-CMC_PRO_API_KEY': 'test-key'
        }
      };

      const axios = require('axios');
      const mockResponse = {
        data: {
          data: {}
        }
      };
      axios.get.mockResolvedValue(mockResponse);

      await expect(fallbackService.fetchFromCoinMarketCap(apiState, 'UNKNOWN'))
        .rejects.toThrow('Asset UNKNOWN not found on CoinMarketCap');
    });
  });

  describe('handleApiFailure', () => {
    test('should increment failure count', () => {
      const apiState = fallbackService.apiStates[0];
      const initialFailures = apiState.failures;

      fallbackService.handleApiFailure(apiState, new Error('Test error'));

      expect(apiState.failures).toBe(initialFailures + 1);
      expect(apiState.lastFailureTime).toBeDefined();
    });

    test('should trip circuit breaker when threshold exceeded', () => {
      const apiState = fallbackService.apiStates[0];
      apiState.failures = 2; // One below threshold

      fallbackService.handleApiFailure(apiState, new Error('Test error'));

      expect(apiState.isCircuitOpen).toBe(true);
      expect(fallbackService.stats.circuitBreakerTrips).toBe(1);
    });
  });

  describe('circuit breaker management', () => {
    test('should close circuit breaker when timeout expires', () => {
      const apiState = fallbackService.apiStates[0];
      apiState.isCircuitOpen = true;
      apiState.lastFailureTime = Date.now() - 70000; // 70 seconds ago

      const isReady = fallbackService.isCircuitReadyToClose(apiState);

      expect(isReady).toBe(true);
    });

    test('should keep circuit breaker open when timeout not expired', () => {
      const apiState = fallbackService.apiStates[0];
      apiState.isCircuitOpen = true;
      apiState.lastFailureTime = Date.now() - 30000; // 30 seconds ago

      const isReady = fallbackService.isCircuitReadyToClose(apiState);

      expect(isReady).toBe(false);
    });

    test('should close circuit breaker', () => {
      const apiState = fallbackService.apiStates[0];
      apiState.isCircuitOpen = true;
      apiState.failures = 5;

      fallbackService.closeCircuit(apiState);

      expect(apiState.isCircuitOpen).toBe(false);
      expect(apiState.failures).toBe(0);
    });
  });

  describe('rate limiting', () => {
    test('should respect rate limits', () => {
      const apiState = fallbackService.apiStates[0];
      apiState.rateLimit = 10; // 10 requests per minute
      apiState.lastRequestTime = Date.now() - 1000; // 1 second ago

      const isLimited = fallbackService.isRateLimited(apiState);

      expect(isLimited).toBe(true); // Should be limited (min interval = 6000ms)
    });

    test('should allow requests when not rate limited', () => {
      const apiState = fallbackService.apiStates[0];
      apiState.rateLimit = 10;
      apiState.lastRequestTime = Date.now() - 10000; // 10 seconds ago

      const isLimited = fallbackService.isRateLimited(apiState);

      expect(isLimited).toBe(false);
    });
  });

  describe('cache management', () => {
    test('should get and set cache', () => {
      const key = 'test_key';
      const price = { price: 0.1234, timestamp: new Date() };

      fallbackService.setCache(key, price);
      const cached = fallbackService.getFromCache(key);

      expect(cached).toEqual(price);
      expect(cached.cachedAt).toBeDefined();
    });

    test('should check cache validity', () => {
      const validCache = {
        price: 0.1234,
        timestamp: new Date(),
        cachedAt: Date.now() - 1000 // 1 second ago
      };

      const invalidCache = {
        price: 0.1234,
        timestamp: new Date(),
        cachedAt: Date.now() - 400000 // 400 seconds ago (beyond 5 minute TTL)
      };

      expect(fallbackService.isCacheValid(validCache)).toBe(true);
      expect(fallbackService.isCacheValid(invalidCache)).toBe(false);
    });

    test('should clean up expired cache entries', () => {
      const key1 = 'key1';
      const key2 = 'key2';

      // Set one valid and one expired cache entry
      fallbackService.setCache(key1, {
        price: 0.1234,
        timestamp: new Date(),
        cachedAt: Date.now() - 1000
      });

      fallbackService.setCache(key2, {
        price: 0.5678,
        timestamp: new Date(),
        cachedAt: Date.now() - 400000
      });

      fallbackService.cleanupCache();

      expect(fallbackService.getFromCache(key1)).toBeDefined();
      expect(fallbackService.getFromCache(key2)).toBeUndefined();
    });
  });

  describe('getStats', () => {
    test('should return statistics', () => {
      fallbackService.stats.requestsMade = 10;
      fallbackService.stats.requestsSuccessful = 8;
      fallbackService.stats.requestsFailed = 2;
      fallbackService.stats.cacheHits = 3;
      fallbackService.stats.circuitBreakerTrips = 1;

      const stats = fallbackService.getStats();

      expect(stats.requestsMade).toBe(10);
      expect(stats.requestsSuccessful).toBe(8);
      expect(stats.requestsFailed).toBe(2);
      expect(stats.successRate).toBe(80);
      expect(stats.cacheSize).toBe(0);
      expect(stats.apiStates).toHaveLength(1);
    });
  });

  describe('getHealthStatus', () => {
    test('should return healthy status', () => {
      fallbackService.stats.requestsMade = 10;
      fallbackService.stats.requestsSuccessful = 8;

      const health = fallbackService.getHealthStatus();

      expect(health.healthy).toBe(true);
      expect(health.availableApis).toBe(1);
      expect(health.totalApis).toBe(1);
    });

    test('should return unhealthy status when all circuits open', () => {
      // Trip all circuit breakers
      fallbackService.apiStates.forEach(apiState => {
        fallbackService.tripCircuit(apiState);
      });

      const health = fallbackService.getHealthStatus();

      expect(health.healthy).toBe(false);
      expect(health.availableApis).toBe(0);
    });
  });

  describe('resetCircuitBreakers', () => {
    test('should reset all circuit breakers', () => {
      // Trip some circuit breakers
      fallbackService.apiStates[0].isCircuitOpen = true;
      fallbackService.apiStates[0].failures = 5;

      fallbackService.resetCircuitBreakers();

      expect(fallbackService.apiStates[0].isCircuitOpen).toBe(false);
      expect(fallbackService.apiStates[0].failures).toBe(0);
    });
  });

  describe('clearCache', () => {
    test('should clear all cache entries', () => {
      fallbackService.setCache('key1', { price: 0.1234 });
      fallbackService.setCache('key2', { price: 0.5678 });

      expect(fallbackService.priceCache.size).toBe(2);

      fallbackService.clearCache();

      expect(fallbackService.priceCache.size).toBe(0);
    });
  });

  describe('asset mapping', () => {
    test('should map asset codes correctly', () => {
      expect(fallbackService.assetMapping['XLM']).toContain('stellar');
      expect(fallbackService.assetMapping['XLM']).toContain('xlm-lumens');
      expect(fallbackService.assetMapping['USDC']).toContain('usd-coin');
      expect(fallbackService.assetMapping['USDC']).toContain('usdc');
    });
  });
});
