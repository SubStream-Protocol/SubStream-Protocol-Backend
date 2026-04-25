const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { getRedisClient } = require('../config/redis');

/**
 * API Key Service
 * Manages tenant-specific API keys with granular permissions
 */

class ApiKeyService {
  constructor(database, redisService) {
    this.database = database;
    this.redisService = redisService;
    this.redisClient = getRedisClient();
    
    // API key configuration
    this.keyLength = 32;
    this.saltRounds = 12;
    this.defaultExpirationDays = 365;
    
    // Permission definitions
    this.permissions = {
      'read:subscriptions': 'Read subscription data',
      'write:subscriptions': 'Create and update subscriptions',
      'delete:subscriptions': 'Delete subscriptions',
      'read:billing_events': 'Read billing events',
      'write:billing_events': 'Create billing events',
      'read:users': 'Read user data',
      'write:users': 'Create and update users',
      'read:analytics': 'Read analytics data',
      'write:analytics': 'Write analytics data',
      'read:videos': 'Read video data',
      'write:videos': 'Create and update videos',
      'delete:videos': 'Delete videos',
      'admin:all': 'Full administrative access'
    };
  }

  /**
   * Generate a new API key for a tenant
   * @param {string} tenantId - Tenant ID
   * @param {object} options - API key options
   * @returns {Promise<object>} Generated API key information
   */
  async generateApiKey(tenantId, options = {}) {
    const {
      name = 'API Key',
      permissions = ['read:subscriptions'],
      expiresAt = null,
      metadata = {}
    } = options;

    try {
      // Generate raw API key
      const rawKey = this.generateRawKey();
      
      // Hash the API key for storage
      const hashedKey = await bcrypt.hash(rawKey, this.saltRounds);
      
      // Set expiration if not provided
      const expirationDate = expiresAt || this.calculateDefaultExpiration();
      
      // Store API key in database
      const apiKeyRecord = await this.storeApiKey({
        tenantId,
        name,
        hashedKey,
        permissions,
        expiresAt: expirationDate,
        metadata,
        createdAt: new Date().toISOString()
      });

      // Log creation for security audit
      await this.logApiKeyEvent(tenantId, apiKeyRecord.id, 'created', {
        name,
        permissions,
        expiresAt: expirationDate
      });

      return {
        id: apiKeyRecord.id,
        apiKey: rawKey, // Only returned once during creation
        name,
        permissions,
        expiresAt: expirationDate,
        createdAt: apiKeyRecord.created_at,
        lastUsedAt: null,
        isActive: true
      };
    } catch (error) {
      console.error('Error generating API key:', error);
      throw new Error(`Failed to generate API key: ${error.message}`);
    }
  }

  /**
   * Validate an API key and return its information
   * @param {string} apiKey - Raw API key to validate
   * @returns {Promise<object|null>} API key information or null if invalid
   */
  async validateApiKey(apiKey) {
    try {
      if (!apiKey || typeof apiKey !== 'string') {
        return null;
      }

      // Check cache first
      const cacheKey = `api_key:${apiKey}`;
      const cached = await this.redisClient.get(cacheKey);
      if (cached) {
        const cachedKey = JSON.parse(cached);
        if (cachedKey.isValid) {
          await this.updateLastUsed(cachedKey.id);
          return cachedKey;
        }
      }

      // Get all active API keys (in production, this should be optimized)
      const activeKeys = await this.getActiveApiKeys();
      
      for (const keyRecord of activeKeys) {
        const isValid = await bcrypt.compare(apiKey, keyRecord.hashed_key);
        
        if (isValid) {
          // Check if key is expired
          if (keyRecord.expires_at && new Date(keyRecord.expires_at) < new Date()) {
            await this.deactivateApiKey(keyRecord.id);
            continue;
          }

          const keyInfo = {
            id: keyRecord.id,
            tenantId: keyRecord.tenant_id,
            name: keyRecord.name,
            permissions: keyRecord.permissions,
            expiresAt: keyRecord.expires_at,
            createdAt: keyRecord.created_at,
            lastUsedAt: keyRecord.last_used_at,
            isValid: true
          };

          // Cache successful validation
          await this.redisClient.setex(cacheKey, 300, JSON.stringify(keyInfo)); // 5 minutes
          
          // Update last used timestamp
          await this.updateLastUsed(keyRecord.id);
          
          return keyInfo;
        }
      }

      // Cache failed validation
      await this.redisClient.setex(cacheKey, 60, JSON.stringify({ isValid: false }));
      return null;
    } catch (error) {
      console.error('Error validating API key:', error);
      return null;
    }
  }

  /**
   * Check if an API key has a specific permission
   * @param {object} apiKeyInfo - API key information
   * @param {string} permission - Permission to check
   * @returns {boolean} True if key has permission
   */
  hasPermission(apiKeyInfo, permission) {
    if (!apiKeyInfo || !apiKeyInfo.permissions) {
      return false;
    }

    // Admin access grants all permissions
    if (apiKeyInfo.permissions.includes('admin:all')) {
      return true;
    }

    return apiKeyInfo.permissions.includes(permission);
  }

  /**
   * Revoke an API key
   * @param {string} keyId - API key ID
   * @param {string} tenantId - Tenant ID for authorization
   * @returns {Promise<boolean>} True if successfully revoked
   */
  async revokeApiKey(keyId, tenantId) {
    try {
      const client = await this.database.pool.connect();
      
      try {
        await client.query('BEGIN');
        
        // Delete the API key
        const result = await client.query(
          'DELETE FROM api_keys WHERE id = $1 AND tenant_id = $2 RETURNING id',
          [keyId, tenantId]
        );

        if (result.rows.length === 0) {
          await client.query('ROLLBACK');
          return false;
        }

        // Clear cache
        await this.clearApiKeyCache(keyId);

        // Log revocation
        await this.logApiKeyEvent(tenantId, keyId, 'revoked');

        await client.query('COMMIT');
        return true;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Error revoking API key:', error);
      throw new Error(`Failed to revoke API key: ${error.message}`);
    }
  }

  /**
   * List API keys for a tenant
   * @param {string} tenantId - Tenant ID
   * @param {object} options - List options
   * @returns {Promise<Array>} List of API keys
   */
  async listApiKeys(tenantId, options = {}) {
    const { includeInactive = false, limit = 50, offset = 0 } = options;

    const client = await this.database.pool.connect();
    
    try {
      let query = `
        SELECT id, name, permissions, expires_at, created_at, last_used_at, is_active
        FROM api_keys 
        WHERE tenant_id = $1
      `;
      
      const params = [tenantId];
      
      if (!includeInactive) {
        query += ' AND is_active = true';
      }
      
      query += ' ORDER BY created_at DESC LIMIT $2 OFFSET $3';
      params.push(limit, offset);

      const result = await client.query(query, params);
      
      return result.rows.map(key => ({
        id: key.id,
        name: key.name,
        permissions: key.permissions,
        expiresAt: key.expires_at,
        createdAt: key.created_at,
        lastUsedAt: key.last_used_at,
        isActive: key.is_active
      }));
    } finally {
      client.release();
    }
  }

  /**
   * Update API key permissions
   * @param {string} keyId - API key ID
   * @param {string} tenantId - Tenant ID
   * @param {Array} permissions - New permissions
   * @returns {Promise<boolean>} True if successfully updated
   */
  async updateApiKeyPermissions(keyId, tenantId, permissions) {
    try {
      const client = await this.database.pool.connect();
      
      try {
        await client.query('BEGIN');
        
        const result = await client.query(
          'UPDATE api_keys SET permissions = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3 RETURNING id',
          [JSON.stringify(permissions), keyId, tenantId]
        );

        if (result.rows.length === 0) {
          await client.query('ROLLBACK');
          return false;
        }

        // Clear cache
        await this.clearApiKeyCache(keyId);

        // Log update
        await this.logApiKeyEvent(tenantId, keyId, 'permissions_updated', { permissions });

        await client.query('COMMIT');
        return true;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Error updating API key permissions:', error);
      throw new Error(`Failed to update API key permissions: ${error.message}`);
    }
  }

  /**
   * Get API key usage statistics
   * @param {string} tenantId - Tenant ID
   * @returns {Promise<object>} Usage statistics
   */
  async getApiKeyStatistics(tenantId) {
    const client = await this.database.pool.connect();
    
    try {
      const [totalResult, activeResult, usageResult] = await Promise.all([
        client.query('SELECT COUNT(*) as count FROM api_keys WHERE tenant_id = $1', [tenantId]),
        client.query('SELECT COUNT(*) as count FROM api_keys WHERE tenant_id = $1 AND is_active = true', [tenantId]),
        client.query(`
          SELECT 
            id,
            name,
            last_used_at,
            created_at
          FROM api_keys 
          WHERE tenant_id = $1 
          ORDER BY last_used_at DESC NULLS LAST
        `, [tenantId])
      ]);

      return {
        tenantId,
        totalKeys: parseInt(totalResult.rows[0].count),
        activeKeys: parseInt(activeResult.rows[0].count),
        keys: usageResult.rows.map(key => ({
          id: key.id,
          name: key.name,
          lastUsedAt: key.last_used_at,
          createdAt: key.created_at,
          daysSinceLastUse: key.last_used_at ? 
            Math.floor((new Date() - new Date(key.last_used_at)) / (1000 * 60 * 60 * 24)) : 
            Math.floor((new Date() - new Date(key.created_at)) / (1000 * 60 * 60 * 24))
        }))
      };
    } finally {
      client.release();
    }
  }

  /**
   * Clean up expired API keys
   * @returns {Promise<object>} Cleanup results
   */
  async cleanupExpiredKeys() {
    const client = await this.database.pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Deactivate expired keys
      const result = await client.query(
        'UPDATE api_keys SET is_active = false WHERE expires_at < NOW() AND is_active = true RETURNING id, tenant_id'
      );

      const deactivatedKeys = result.rows;
      
      // Clear cache for deactivated keys
      for (const key of deactivatedKeys) {
        await this.clearApiKeyCache(key.id);
        await this.logApiKeyEvent(key.tenant_id, key.id, 'expired');
      }

      await client.query('COMMIT');

      return {
        deactivated: deactivatedKeys.length,
        keys: deactivatedKeys
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Generate raw API key string
   * @returns {string} Raw API key
   */
  generateRawKey() {
    const bytes = crypto.randomBytes(this.keyLength);
    return `sk_${bytes.toString('hex')}`;
  }

  /**
   * Calculate default expiration date
   * @returns {string} ISO date string
   */
  calculateDefaultExpiration() {
    const expiration = new Date();
    expiration.setDate(expiration.getDate() + this.defaultExpirationDays);
    return expiration.toISOString();
  }

  /**
   * Store API key in database
   * @param {object} keyData - Key data to store
   * @returns {Promise<object>} Stored key record
   */
  async storeApiKey(keyData) {
    const client = await this.database.pool.connect();
    
    try {
      const result = await client.query(
        `INSERT INTO api_keys (tenant_id, name, hashed_key, permissions, expires_at, metadata, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, created_at`,
        [
          keyData.tenantId,
          keyData.name,
          keyData.hashedKey,
          JSON.stringify(keyData.permissions),
          keyData.expiresAt,
          JSON.stringify(keyData.metadata),
          keyData.createdAt
        ]
      );

      return result.rows[0];
    } finally {
      client.release();
    }
  }

  /**
   * Get active API keys from database
   * @returns {Promise<Array>} Active API keys
   */
  async getActiveApiKeys() {
    const client = await this.database.pool.connect();
    
    try {
      const result = await client.query(
        'SELECT id, tenant_id, name, hashed_key, permissions, expires_at, created_at, last_used_at FROM api_keys WHERE is_active = true'
      );
      
      return result.rows;
    } finally {
      client.release();
    }
  }

  /**
   * Update last used timestamp for API key
   * @param {string} keyId - API key ID
   * @returns {Promise<void>}
   */
  async updateLastUsed(keyId) {
    const client = await this.database.pool.connect();
    
    try {
      await client.query(
        'UPDATE api_keys SET last_used_at = NOW() WHERE id = $1',
        [keyId]
      );
    } catch (error) {
      console.error('Error updating last used timestamp:', error);
    } finally {
      client.release();
    }
  }

  /**
   * Deactivate API key
   * @param {string} keyId - API key ID
   * @returns {Promise<void>}
   */
  async deactivateApiKey(keyId) {
    const client = await this.database.pool.connect();
    
    try {
      await client.query(
        'UPDATE api_keys SET is_active = false WHERE id = $1',
        [keyId]
      );
    } finally {
      client.release();
    }
  }

  /**
   * Clear API key cache
   * @param {string} keyId - API key ID
   * @returns {Promise<void>}
   */
  async clearApiKeyCache(keyId) {
    try {
      // In a real implementation, you'd need to track which raw keys map to which key IDs
      // For now, we'll clear all API key caches
      const keys = await this.redisClient.keys('api_key:*');
      if (keys.length > 0) {
        await this.redisClient.del(...keys);
      }
    } catch (error) {
      console.error('Error clearing API key cache:', error);
    }
  }

  /**
   * Log API key event for security audit
   * @param {string} tenantId - Tenant ID
   * @param {string} keyId - API key ID
   * @param {string} event - Event type
   * @param {object} metadata - Event metadata
   * @returns {Promise<void>}
   */
  async logApiKeyEvent(tenantId, keyId, event, metadata = {}) {
    const client = await this.database.pool.connect();
    
    try {
      await client.query(
        `INSERT INTO api_key_audit_logs (tenant_id, key_id, event, metadata, timestamp)
         VALUES ($1, $2, $3, $4, NOW())`,
        [tenantId, keyId, event, JSON.stringify(metadata)]
      );
    } catch (error) {
      console.error('Error logging API key event:', error);
    } finally {
      client.release();
    }
  }

  /**
   * Get API key audit logs
   * @param {string} tenantId - Tenant ID
   * @param {object} options - Query options
   * @returns {Promise<Array>} Audit logs
   */
  async getApiKeyAuditLogs(tenantId, options = {}) {
    const { keyId, limit = 100, offset = 0, startDate, endDate } = options;

    const client = await this.database.pool.connect();
    
    try {
      let query = `
        SELECT key_id, event, metadata, timestamp
        FROM api_key_audit_logs 
        WHERE tenant_id = $1
      `;
      
      const params = [tenantId];
      let paramIndex = 2;

      if (keyId) {
        query += ` AND key_id = $${paramIndex++}`;
        params.push(keyId);
      }

      if (startDate) {
        query += ` AND timestamp >= $${paramIndex++}`;
        params.push(startDate);
      }

      if (endDate) {
        query += ` AND timestamp <= $${paramIndex++}`;
        params.push(endDate);
      }

      query += ` ORDER BY timestamp DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
      params.push(limit, offset);

      const result = await client.query(query, params);
      
      return result.rows.map(log => ({
        keyId: log.key_id,
        event: log.event,
        metadata: log.metadata,
        timestamp: log.timestamp
      }));
    } finally {
      client.release();
    }
  }

  /**
   * Get available permissions
   * @returns {object} Available permissions
   */
  getAvailablePermissions() {
    return { ...this.permissions };
  }
}

module.exports = ApiKeyService;
