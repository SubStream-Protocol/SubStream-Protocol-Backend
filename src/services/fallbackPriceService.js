const axios = require('axios');
const winston = require('winston');

/**
 * Fallback Price Service
 * Provides backup pricing when the main SEP-40 oracle cache is unavailable
 * Uses multiple external APIs with circuit breaker pattern
 */
class FallbackPriceService {
  constructor(config, logger = winston.createLogger()) {
    this.config = config;
    this.logger = logger;
    
    // Fallback API configurations
    this.apis = config.fallbackApis || [
      {
        name: 'CoinGecko',
        url: 'https://api.coingecko.com/api/v3/simple/price',
        rateLimit: 10, // requests per minute
        timeout: 5000
      },
      {
        name: 'CoinCap',
        url: 'https://api.coincap.io/v2/rates',
        rateLimit: 30,
        timeout: 5000
      },
      {
        name: 'CoinMarketCap',
        url: 'https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest',
        rateLimit: 33,
        timeout: 5000,
        headers: {
          'X-CMC_PRO_API_KEY': config.coinMarketCapApiKey
        }
      }
    ];
    
    // Circuit breaker configuration
    this.circuitBreakerThreshold = config.circuitBreakerThreshold || 5;
    this.circuitBreakerTimeout = config.circuitBreakerTimeout || 60000; // 1 minute
    
    // API state tracking
    this.apiStates = this.apis.map(api => ({
      ...api,
      failures: 0,
      lastFailureTime: null,
      isCircuitOpen: false,
      lastRequestTime: null,
      requestCount: 0
    }));
    
    // Cache for fallback prices (short-term)
    this.priceCache = new Map();
    this.cacheTtl = config.cacheTtl || 300000; // 5 minutes
    
    // Statistics
    this.stats = {
      requestsMade: 0,
      requestsSuccessful: 0,
      requestsFailed: 0,
      cacheHits: 0,
      circuitBreakerTrips: 0,
      fallbackUsed: 0,
      startTime: new Date().toISOString()
    };
    
    // Supported assets mapping
    this.assetMapping = {
      'XLM': ['stellar', 'xlm-lumens'],
      'USDC': ['usd-coin', 'usdc'],
      'ETH': ['ethereum', 'eth'],
      'BTC': ['bitcoin', 'btc']
    };
  }

  /**
   * Get USD equivalent using fallback APIs
   */
  async getUsdEquivalent(assetCode, assetIssuer, amount, timestamp) {
    this.stats.requestsMade++;
    
    try {
      // Check cache first
      const cacheKey = this.getCacheKey(assetCode, assetIssuer);
      const cached = this.getFromCache(cacheKey);
      
      if (cached && this.isCacheValid(cached)) {
        this.stats.cacheHits++;
        return {
          usdEquivalent: amount * cached.price,
          priceTimestamp: cached.timestamp,
          confidence: 0.8, // Lower confidence for fallback
          backfillRequired: true,
          source: 'fallback-cache'
        };
      }
      
      // Try each API in order
      for (const apiState of this.apiStates) {
        if (apiState.isCircuitOpen) {
          if (this.isCircuitReadyToClose(apiState)) {
            this.closeCircuit(apiState);
          } else {
            continue;
          }
        }
        
        try {
          const price = await this.fetchPriceFromApi(apiState, assetCode);
          
          if (price) {
            // Cache the price
            this.setCache(cacheKey, price);
            
            this.stats.requestsSuccessful++;
            this.stats.fallbackUsed++;
            
            return {
              usdEquivalent: amount * price.price,
              priceTimestamp: price.timestamp,
              confidence: 0.8,
              backfillRequired: true,
              source: `fallback-${apiState.name}`
            };
          }
        } catch (error) {
          this.handleApiFailure(apiState, error);
          continue;
        }
      }
      
      // All APIs failed
      this.stats.requestsFailed++;
      this.logger.error('All fallback APIs failed', {
        assetCode,
        amount,
        timestamp
      });
      
      return {
        usdEquivalent: null,
        priceTimestamp: null,
        confidence: null,
        backfillRequired: true,
        source: 'fallback-failed'
      };
      
    } catch (error) {
      this.stats.requestsFailed++;
      this.logger.error('Fallback price service error', {
        assetCode,
        amount,
        error: error.message
      });
      
      return {
        usdEquivalent: null,
        priceTimestamp: null,
        confidence: null,
        backfillRequired: true,
        source: 'fallback-error'
      };
    }
  }

  /**
   * Fetch price from specific API
   */
  async fetchPriceFromApi(apiState, assetCode) {
    const startTime = Date.now();
    
    try {
      // Check rate limiting
      if (this.isRateLimited(apiState)) {
        throw new Error(`Rate limited for ${apiState.name}`);
      }
      
      let price = null;
      
      switch (apiState.name) {
        case 'CoinGecko':
          price = await this.fetchFromCoinGecko(apiState, assetCode);
          break;
        case 'CoinCap':
          price = await this.fetchFromCoinCap(apiState, assetCode);
          break;
        case 'CoinMarketCap':
          price = await this.fetchFromCoinMarketCap(apiState, assetCode);
          break;
        default:
          throw new Error(`Unknown API: ${apiState.name}`);
      }
      
      // Update API state
      apiState.requestCount++;
      apiState.lastRequestTime = Date.now();
      apiState.failures = 0; // Reset failures on success
      
      this.logger.debug('Fallback price fetched', {
        api: apiState.name,
        assetCode,
        price: price.price,
        responseTime: Date.now() - startTime
      });
      
      return price;
      
    } catch (error) {
      this.handleApiFailure(apiState, error);
      throw error;
    }
  }

  /**
   * Fetch from CoinGecko API
   */
  async fetchFromCoinGecko(apiState, assetCode) {
    const coinIds = this.assetMapping[assetCode] || [assetCode.toLowerCase()];
    
    for (const coinId of coinIds) {
      try {
        const response = await axios.get(`${apiState.url}`, {
          params: {
            ids: coinId,
            vs_currencies: 'usd',
            include_last_updated_at: true
          },
          timeout: apiState.timeout,
          headers: apiState.headers || {}
        });
        
        const data = response.data;
        if (data[coinId]) {
          return {
            price: data[coinId].usd,
            timestamp: data[coinId].last_updated_at ? new Date(data[coinId].last_updated_at) : new Date(),
            source: 'coingecko'
          };
        }
      } catch (error) {
        continue; // Try next coin ID
      }
    }
    
    throw new Error(`Asset ${assetCode} not found on CoinGecko`);
  }

  /**
   * Fetch from CoinCap API
   */
  async fetchFromCoinCap(apiState, assetCode) {
    const response = await axios.get(`${apiState.url}`, {
      timeout: apiState.timeout,
      headers: apiState.headers || {}
    });
    
    const data = response.data;
    const rate = data.data.find(rate => 
      rate.symbol === assetCode.toUpperCase() || 
      rate.id === assetCode.toLowerCase()
    );
    
    if (!rate) {
      throw new Error(`Asset ${assetCode} not found on CoinCap`);
    }
    
    return {
      price: parseFloat(rate.rateUsd),
      timestamp: new Date(),
      source: 'coincap'
    };
  }

  /**
   * Fetch from CoinMarketCap API
   */
  async fetchFromCoinMarketCap(apiState, assetCode) {
    if (!apiState.headers || !apiState.headers['X-CMC_PRO_API_KEY']) {
      throw new Error('CoinMarketCap API key not configured');
    }
    
    const response = await axios.get(`${apiState.url}`, {
      params: {
        symbol: assetCode.toUpperCase(),
        convert: 'USD'
      },
      timeout: apiState.timeout,
      headers: apiState.headers
    });
    
    const data = response.data;
    const quote = data.data[assetCode.toUpperCase()];
    
    if (!quote || !quote.quote || !quote.quote.USD) {
      throw new Error(`Asset ${assetCode} not found on CoinMarketCap`);
    }
    
    return {
      price: quote.quote.USD.price,
      timestamp: new Date(quote.quote.USD.last_updated),
      source: 'coinmarketcap'
    };
  }

  /**
   * Handle API failure
   */
  handleApiFailure(apiState, error) {
    apiState.failures++;
    apiState.lastFailureTime = Date.now();
    
    this.logger.warn('Fallback API failure', {
      api: apiState.name,
      failure: apiState.failures,
      error: error.message
    });
    
    // Trip circuit breaker if threshold exceeded
    if (apiState.failures >= this.circuitBreakerThreshold) {
      this.tripCircuit(apiState);
    }
  }

  /**
   * Trip circuit breaker
   */
  tripCircuit(apiState) {
    apiState.isCircuitOpen = true;
    this.stats.circuitBreakerTrips++;
    
    this.logger.warn('Circuit breaker tripped', {
      api: apiState.name,
      failures: apiState.failures
    });
  }

  /**
   * Close circuit breaker
   */
  closeCircuit(apiState) {
    apiState.isCircuitOpen = false;
    apiState.failures = 0;
    
    this.logger.info('Circuit breaker closed', {
      api: apiState.name
    });
  }

  /**
   * Check if circuit is ready to close
   */
  isCircuitReadyToClose(apiState) {
    return apiState.isCircuitOpen && 
           apiState.lastFailureTime && 
           (Date.now() - apiState.lastFailureTime) >= this.circuitBreakerTimeout;
  }

  /**
   * Check if API is rate limited
   */
  isRateLimited(apiState) {
    if (!apiState.lastRequestTime) {
      return false;
    }
    
    const timeSinceLastRequest = Date.now() - apiState.lastRequestTime;
    const minInterval = 60000 / apiState.rateLimit; // milliseconds between requests
    
    return timeSinceLastRequest < minInterval;
  }

  /**
   * Get cache key
   */
  getCacheKey(assetCode, assetIssuer) {
    return `${assetCode}_${assetIssuer || 'native'}`;
  }

  /**
   * Get from cache
   */
  getFromCache(key) {
    return this.priceCache.get(key);
  }

  /**
   * Set cache
   */
  setCache(key, price) {
    this.priceCache.set(key, {
      ...price,
      cachedAt: Date.now()
    });
  }

  /**
   * Check if cache is valid
   */
  isCacheValid(cached) {
    return cached && (Date.now() - cached.cachedAt) < this.cacheTtl;
  }

  /**
   * Clean up expired cache entries
   */
  cleanupCache() {
    const now = Date.now();
    for (const [key, cached] of this.priceCache.entries()) {
      if (now - cached.cachedAt >= this.cacheTtl) {
        this.priceCache.delete(key);
      }
    }
  }

  /**
   * Get service statistics
   */
  getStats() {
    const uptime = Date.now() - new Date(this.stats.startTime).getTime();
    const successRate = this.stats.requestsMade > 0 
      ? (this.stats.requestsSuccessful / this.stats.requestsMade) * 100 
      : 0;
    
    return {
      ...this.stats,
      uptime,
      successRate,
      cacheSize: this.priceCache.size,
      apiStates: this.apiStates.map(state => ({
        name: state.name,
        failures: state.failures,
        isCircuitOpen: state.isCircuitOpen,
        requestCount: state.requestCount
      }))
    };
  }

  /**
   * Get health status
   */
  getHealthStatus() {
    const stats = this.getStats();
    const healthyApis = this.apiStates.filter(state => !state.isCircuitOpen).length;
    const isHealthy = healthyApis > 0 && stats.successRate >= 50;
    
    return {
      healthy: isHealthy,
      availableApis: healthyApis,
      totalApis: this.apiStates.length,
      stats,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Reset circuit breakers (for admin use)
   */
  resetCircuitBreakers() {
    this.apiStates.forEach(apiState => {
      if (apiState.isCircuitOpen) {
        this.closeCircuit(apiState);
      }
    });
    
    this.logger.info('All circuit breakers reset');
  }

  /**
   * Clear cache (for admin use)
   */
  clearCache() {
    this.priceCache.clear();
    this.logger.info('Fallback price cache cleared');
  }
}

module.exports = { FallbackPriceService };
