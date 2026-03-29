const { logger } = require('../utils/logger');

/**
 * Creator Collaboration Revenue Attribution Service
 * Handles revenue sharing for co-authored content with precise watch time tracking
 */
class CollaborationRevenueService {
  constructor(config, database, redisClient) {
    this.config = config;
    this.database = database;
    this.redis = redisClient;
    
    // Configuration
    this.defaultSplitRatio = config.collaboration?.defaultSplitRatio || 0.5; // 50/50 default
    this.minWatchTimeSeconds = config.collaboration?.minWatchTimeSeconds || 30;
    this.cacheTTL = config.collaboration?.cacheTTL || 3600; // 1 hour cache
    this.prefix = config.collaboration?.cachePrefix || 'collaboration:';
  }

  /**
   * Create a collaboration for content
   * @param {object} collaborationData Collaboration details
   * @returns {Promise<object>} Created collaboration
   */
  async createCollaboration(collaborationData) {
    try {
      const {
        contentId,
        primaryCreatorAddress,
        collaboratorAddresses,
        splitRatios,
        status = 'active',
        metadata = {}
      } = collaborationData;

      // Validate primary creator owns the content
      const content = this.database.db.prepare(`
        SELECT creator_address FROM content WHERE id = ?
      `).get(contentId);

      if (!content || content.creator_address !== primaryCreatorAddress) {
        throw new Error('Only content owner can create collaborations');
      }

      // Validate collaborators
      if (!collaboratorAddresses || collaboratorAddresses.length === 0) {
        throw new Error('At least one collaborator is required');
      }

      // Validate split ratios
      const totalSplit = Object.values(splitRatios || {}).reduce((sum, ratio) => sum + ratio, 0);
      if (totalSplit > 1) {
        throw new Error('Total split ratios cannot exceed 1.0 (100%)');
      }

      // Generate unique collaboration ID
      const collaborationId = this.generateCollaborationId();

      // Store collaboration
      const insertQuery = `
        INSERT INTO content_collaborations (
          id, content_id, primary_creator_address, status,
          total_watch_seconds, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `;

      this.database.db.prepare(insertQuery).run(
        collaborationId,
        contentId,
        primaryCreatorAddress,
        status,
        0, // total_watch_seconds
        new Date().toISOString(),
        new Date().toISOString()
      );

      // Add collaborators
      const collaboratorInsert = `
        INSERT INTO collaboration_participants (
          collaboration_id, creator_address, split_ratio, role, 
          watch_seconds, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `;

      // Add primary creator
      this.database.db.prepare(collaboratorInsert).run(
        collaborationId,
        primaryCreatorAddress,
        splitRatios?.[primaryCreatorAddress] || (1 - (totalSplit || 0)),
        'primary',
        0, // watch_seconds
        new Date().toISOString(),
        new Date().toISOString()
      );

      // Add collaborators
      for (const collaboratorAddress of collaboratorAddresses) {
        const splitRatio = splitRatios?.[collaboratorAddress] || 
          ((1 - (splitRatios?.[primaryCreatorAddress] || (1 - totalSplit))) / collaboratorAddresses.length);

        this.database.db.prepare(collaboratorInsert).run(
          collaborationId,
          collaboratorAddress,
          splitRatio,
          'collaborator',
          0, // watch_seconds
          new Date().toISOString(),
          new Date().toISOString()
        );
      }

      // Update content to mark as collaborative
      this.database.db.prepare(`
        UPDATE content 
        SET is_collaborative = 1, collaboration_id = ?, updated_at = ?
        WHERE id = ?
      `).run(collaborationId, new Date().toISOString(), contentId);

      const collaboration = await this.getCollaboration(collaborationId);

      logger.info('Collaboration created', {
        collaborationId,
        contentId,
        primaryCreatorAddress,
        collaboratorCount: collaboratorAddresses.length
      });

      return collaboration;
    } catch (error) {
      logger.error('Failed to create collaboration', {
        error: error.message,
        collaborationData
      });
      throw error;
    }
  }

  /**
   * Get collaboration by ID
   * @param {string} collaborationId Collaboration ID
   * @returns {Promise<object>} Collaboration details
   */
  async getCollaboration(collaborationId) {
    try {
      // Get collaboration details
      const collaborationQuery = `
        SELECT 
          id, content_id, primary_creator_address, status,
          total_watch_seconds, created_at, updated_at
        FROM content_collaborations 
        WHERE id = ?
      `;

      const collaboration = this.database.db.prepare(collaborationQuery).get(collaborationId);
      
      if (!collaboration) {
        throw new Error('Collaboration not found');
      }

      // Get participants
      const participantsQuery = `
        SELECT 
          creator_address, split_ratio, role, watch_seconds,
          created_at, updated_at
        FROM collaboration_participants 
        WHERE collaboration_id = ?
        ORDER BY role DESC, created_at ASC
      `;

      const participants = this.database.db.prepare(participantsQuery).all(collaborationId);

      return {
        ...collaboration,
        participants,
        totalParticipants: participants.length
      };
    } catch (error) {
      logger.error('Failed to get collaboration', {
        error: error.message,
        collaborationId
      });
      throw error;
    }
  }

  /**
   * Get collaboration for content
   * @param {string} contentId Content ID
   * @returns {Promise<object|null>} Collaboration details
   */
  async getCollaborationForContent(contentId) {
    try {
      const cacheKey = this.getCollaborationCacheKey(contentId);
      
      // Try cache first
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }

      const query = `
        SELECT id FROM content_collaborations 
        WHERE content_id = ? AND status = 'active'
      `;

      const result = this.database.db.prepare(query).get(contentId);
      
      if (!result) {
        return null;
      }

      const collaboration = await this.getCollaboration(result.id);
      
      // Cache the result
      await this.redis.setex(cacheKey, this.cacheTTL, JSON.stringify(collaboration));

      return collaboration;
    } catch (error) {
      logger.error('Failed to get collaboration for content', {
        error: error.message,
        contentId
      });
      return null;
    }
  }

  /**
   * Record watch time for collaborative content
   * @param {string} contentId Content ID
   * @param {string} userAddress User wallet address
   * @param {number} watchSeconds Number of seconds watched
   * @returns {Promise<object>} Watch time recording result
   */
  async recordWatchTime(contentId, userAddress, watchSeconds) {
    try {
      // Get collaboration for content
      const collaboration = await this.getCollaborationForContent(contentId);
      
      if (!collaboration) {
        return { isCollaborative: false };
      }

      // Validate watch time
      if (watchSeconds < this.minWatchTimeSeconds) {
        return { 
          isCollaborative: true, 
          recorded: false, 
          reason: 'Watch time below minimum threshold',
          minimumSeconds: this.minWatchTimeSeconds
        };
      }

      // Check if this user already watched this content
      const existingWatchQuery = `
        SELECT watch_seconds FROM collaboration_watch_logs 
        WHERE collaboration_id = ? AND user_address = ?
      `;

      const existingWatch = this.database.db.prepare(existingWatchQuery).get(
        collaboration.id, 
        userAddress
      );

      let totalWatchSeconds = watchSeconds;

      if (existingWatch) {
        // Update existing record
        totalWatchSeconds = Math.max(existingWatch.watch_seconds, watchSeconds);
        
        this.database.db.prepare(`
          UPDATE collaboration_watch_logs 
          SET watch_seconds = ?, last_watched_at = ?, updated_at = ?
          WHERE collaboration_id = ? AND user_address = ?
        `).run(
          totalWatchSeconds,
          new Date().toISOString(),
          new Date().toISOString(),
          collaboration.id,
          userAddress
        );
      } else {
        // Insert new record
        this.database.db.prepare(`
          INSERT INTO collaboration_watch_logs (
            collaboration_id, user_address, watch_seconds, 
            first_watched_at, last_watched_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          collaboration.id,
          userAddress,
          totalWatchSeconds,
          new Date().toISOString(),
          new Date().toISOString(),
          new Date().toISOString(),
          new Date().toISOString()
        );
      }

      // Update collaboration total watch time
      const newTotalWatchSeconds = collaboration.total_watch_seconds + (totalWatchSeconds - (existingWatch?.watch_seconds || 0));
      
      this.database.db.prepare(`
        UPDATE content_collaborations 
        SET total_watch_seconds = ?, updated_at = ?
        WHERE id = ?
      `).run(
        newTotalWatchSeconds,
        new Date().toISOString(),
        collaboration.id
      );

      // Update participant watch times
      await this.updateParticipantWatchTimes(collaboration.id);

      // Invalidate cache
      await this.redis.del(this.getCollaborationCacheKey(contentId));

      logger.debug('Watch time recorded for collaboration', {
        collaborationId: collaboration.id,
        contentId,
        userAddress,
        watchSeconds,
        totalWatchSeconds
      });

      return {
        isCollaborative: true,
        recorded: true,
        collaborationId: collaboration.id,
        watchSeconds: totalWatchSeconds,
        totalWatchSeconds: newTotalWatchSeconds
      };
    } catch (error) {
      logger.error('Failed to record watch time', {
        error: error.message,
        contentId,
        userAddress,
        watchSeconds
      });
      throw error;
    }
  }

  /**
   * Update participant watch times
   * @param {string} collaborationId Collaboration ID
   */
  async updateParticipantWatchTimes(collaborationId) {
    try {
      // Calculate watch time distribution among participants
      const watchDistributionQuery = `
        SELECT 
          cp.creator_address,
          cp.split_ratio,
          COALESCE(SUM(cwl.watch_seconds), 0) as total_watch_seconds
        FROM collaboration_participants cp
        LEFT JOIN collaboration_watch_logs cwl ON cp.creator_address = cwl.user_address
        WHERE cp.collaboration_id = ?
        GROUP BY cp.creator_address, cp.split_ratio
      `;

      const distribution = this.database.db.prepare(watchDistributionQuery).all(collaborationId);

      // Update each participant's watch time
      for (const participant of distribution) {
        this.database.db.prepare(`
          UPDATE collaboration_participants 
          SET watch_seconds = ?, updated_at = ?
          WHERE collaboration_id = ? AND creator_address = ?
        `).run(
          participant.total_watch_seconds,
          new Date().toISOString(),
          collaborationId,
          participant.creator_address
        );
      }
    } catch (error) {
      logger.error('Failed to update participant watch times', {
        error: error.message,
        collaborationId
      });
    }
  }

  /**
   * Calculate revenue attribution for a time period
   * @param {object} attributionParams Attribution parameters
   * @returns {Promise<object>} Attribution results
   */
  async calculateRevenueAttribution(attributionParams) {
    try {
      const {
        collaborationId,
        startTime,
        endTime,
        totalRevenue,
        currency = 'XLM'
      } = attributionParams;

      const collaboration = await this.getCollaboration(collaborationId);
      
      if (!collaboration) {
        throw new Error('Collaboration not found');
      }

      // Get watch time within period
      const watchTimeQuery = `
        SELECT 
          creator_address,
          split_ratio,
          watch_seconds
        FROM collaboration_participants 
        WHERE collaboration_id = ?
      `;

      const participants = this.database.db.prepare(watchTimeQuery).all(collaborationId);

      // Calculate total watch time
      const totalWatchSeconds = participants.reduce((sum, p) => sum + (p.watch_seconds || 0), 0);

      if (totalWatchSeconds === 0) {
        return {
          collaborationId,
          totalRevenue,
          currency,
          totalWatchSeconds: 0,
          attribution: []
        };
      }

      // Calculate revenue attribution
      const attribution = participants.map(participant => {
        const watchTimeShare = (participant.watch_seconds || 0) / totalWatchSeconds;
        const revenueShare = participant.split_ratio || (1 / participants.length);
        const attributedRevenue = totalRevenue * revenueShare;

        return {
          creatorAddress: participant.creator_address,
          role: participant.role,
          watchSeconds: participant.watch_seconds || 0,
          watchTimeShare: watchTimeShare,
          splitRatio: participant.split_ratio,
          revenueShare,
          attributedRevenue,
          currency
        };
      });

      // Verify attribution totals
      const totalAttributedRevenue = attribution.reduce((sum, a) => sum + a.attributedRevenue, 0);
      const totalAttributedWatchTime = attribution.reduce((sum, a) => sum + a.watchSeconds, 0);

      logger.info('Revenue attribution calculated', {
        collaborationId,
        totalRevenue,
        currency,
        totalWatchSeconds,
        totalAttributedRevenue,
        participantCount: attribution.length
      });

      return {
        collaborationId,
        contentId: collaboration.content_id,
        totalRevenue,
        currency,
        totalWatchSeconds,
        totalAttributedRevenue,
        totalAttributedWatchTime,
        attribution,
        calculatedAt: new Date().toISOString()
      };
    } catch (error) {
      logger.error('Failed to calculate revenue attribution', {
        error: error.message,
        attributionParams
      });
      throw error;
    }
  }

  /**
   * Get revenue attribution for content
   * @param {string} contentId Content ID
   * @param {object} period Period parameters
   * @returns {Promise<object|null>} Attribution results
   */
  async getContentRevenueAttribution(contentId, period = {}) {
    try {
      const collaboration = await this.getCollaborationForContent(contentId);
      
      if (!collaboration) {
        return null;
      }

      // Default to last 30 days if no period specified
      const endTime = period.endTime || new Date();
      const startTime = period.startTime || new Date(endTime.getTime() - (30 * 24 * 60 * 60 * 1000));

      // For now, we'll use the total watch time as a proxy for revenue calculation
      // In a real implementation, this would integrate with actual revenue data
      const totalRevenue = period.totalRevenue || 0; // Would come from payment processing

      return await this.calculateRevenueAttribution({
        collaborationId: collaboration.id,
        startTime,
        endTime,
        totalRevenue
      });
    } catch (error) {
      logger.error('Failed to get content revenue attribution', {
        error: error.message,
        contentId,
        period
      });
      return null;
    }
  }

  /**
   * Update collaboration status
   * @param {string} collaborationId Collaboration ID
   * @param {string} status New status
   * @returns {Promise<boolean>} Whether update was successful
   */
  async updateCollaborationStatus(collaborationId, status) {
    try {
      const result = this.database.db.prepare(`
        UPDATE content_collaborations 
        SET status = ?, updated_at = ?
        WHERE id = ?
      `).run(status, new Date().toISOString(), collaborationId);

      const updated = result.changes > 0;

      if (updated) {
        logger.info('Collaboration status updated', {
          collaborationId,
          status
        });
      }

      return updated;
    } catch (error) {
      logger.error('Failed to update collaboration status', {
        error: error.message,
        collaborationId,
        status
      });
      return false;
    }
  }

  /**
   * Get collaboration statistics for a creator
   * @param {string} creatorAddress Creator wallet address
   * @param {object} filters Filter options
   * @returns {Promise<object>} Statistics
   */
  async getCreatorCollaborationStats(creatorAddress, filters = {}) {
    try {
      const { 
        status = 'active',
        startTime,
        endTime 
      } = filters;

      // Get collaborations where creator is primary or participant
      const collaborationsQuery = `
        SELECT DISTINCT cc.id, cc.content_id, cc.status, cc.created_at
        FROM content_collaborations cc
        LEFT JOIN collaboration_participants cp ON cc.id = cp.collaboration_id
        WHERE (cc.primary_creator_address = ? OR cp.creator_address = ?)
        AND cc.status = COALESCE(?, cc.status)
        AND cc.created_at >= COALESCE(?, cc.created_at)
        AND cc.created_at <= COALESCE(?, cc.created_at)
      `;

      const collaborations = this.database.db.prepare(collaborationsQuery).all(
        creatorAddress, 
        creatorAddress, 
        status, 
        startTime, 
        endTime
      );

      if (collaborations.length === 0) {
        return {
          creatorAddress,
          totalCollaborations: 0,
          totalWatchSeconds: 0,
          totalRevenue: 0,
          collaboratorCount: 0,
          topCollaborators: []
        };
      }

      // Calculate statistics
      let totalWatchSeconds = 0;
      let collaboratorSet = new Set();
      let totalRevenue = 0;

      for (const collaboration of collaborations) {
        const collabData = await this.getCollaboration(collaboration.id);
        totalWatchSeconds += collabData.total_watch_seconds || 0;
        
        // Add collaborators to set (excluding primary creator)
        collabData.participants.forEach(p => {
          if (p.creator_address !== creatorAddress) {
            collaboratorSet.add(p.creator_address);
          }
        });

        // Calculate revenue (would come from actual payment data)
        // For now, using a simple calculation based on watch time
        const estimatedRevenue = (collabData.total_watchSeconds || 0) * 0.001; // Example rate
        totalRevenue += estimatedRevenue;
      }

      // Get top collaborators
      const topCollaboratorsQuery = `
        SELECT 
          cp.creator_address,
          COUNT(*) as collaboration_count,
          SUM(cp.watch_seconds) as total_watch_seconds,
          AVG(cp.split_ratio) as avg_split_ratio
        FROM collaboration_participants cp
        JOIN content_collaborations cc ON cp.collaboration_id = cc.id
        WHERE cc.primary_creator_address = ? AND cp.creator_address != ?
          AND cc.status = 'active'
        GROUP BY cp.creator_address
        ORDER BY collaboration_count DESC, total_watch_seconds DESC
        LIMIT 10
      `;

      const topCollaborators = this.database.db.prepare(topCollaboratorsQuery).all(
        creatorAddress, 
        creatorAddress
      );

      return {
        creatorAddress,
        totalCollaborations: collaborations.length,
        totalWatchSeconds,
        totalRevenue,
        collaboratorCount: collaboratorSet.size,
        topCollaborators: topCollaborators.map(c => ({
          creatorAddress: c.creator_address,
          collaborationCount: c.collaboration_count,
          totalWatchSeconds: c.total_watch_seconds || 0,
          avgSplitRatio: c.avg_split_ratio || 0
        })),
        period: {
          startTime,
          endTime,
          status
        }
      };
    } catch (error) {
      logger.error('Failed to get creator collaboration stats', {
        error: error.message,
        creatorAddress,
        filters
      });
      return null;
    }
  }

  /**
   * Generate collaboration ID
   * @returns {string} Unique collaboration ID
   */
  generateCollaborationId() {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 15);
    return `collab_${timestamp}_${random}`;
  }

  /**
   * Get collaboration cache key
   * @param {string} contentId Content ID
   * @returns {string} Cache key
   */
  getCollaborationCacheKey(contentId) {
    return `${this.prefix}content:${contentId}`;
  }

  /**
   * Invalidate collaboration cache
   * @param {string} contentId Content ID
   */
  async invalidateCollaborationCache(contentId) {
    try {
      await this.redis.del(this.getCollaborationCacheKey(contentId));
    } catch (error) {
      logger.error('Failed to invalidate collaboration cache', {
        error: error.message,
        contentId
      });
    }
  }

  /**
   * Get smart contract payout data for collaboration
   * @param {string} collaborationId Collaboration ID
   * @returns {Promise<object>} Payout data for smart contract
   */
  async getSmartContractPayoutData(collaborationId) {
    try {
      const collaboration = await this.getCollaboration(collaborationId);
      
      if (!collaboration) {
        throw new Error('Collaboration not found');
      }

      // Calculate final attribution for the period
      const attribution = await this.calculateRevenueAttribution({
        collaborationId,
        startTime: collaboration.created_at,
        endTime: new Date(),
        totalRevenue: 0 // Smart contract will provide actual revenue
      });

      // Format for smart contract
      const payoutData = {
        collaborationId: collaboration.id,
        contentId: collaboration.content_id,
        primaryCreator: collaboration.primary_creator_address,
        participants: attribution.attribution.map(p => ({
          creatorAddress: p.creatorAddress,
          splitRatio: p.splitRatio,
          watchSeconds: p.watchSeconds,
          attributedRevenue: p.attributedRevenue
        })),
        totalWatchSeconds: attribution.totalAttributedWatchTime,
        calculatedAt: attribution.calculatedAt,
        signature: null // Would be signed by primary creator
      };

      return payoutData;
    } catch (error) {
      logger.error('Failed to get smart contract payout data', {
        error: error.message,
        collaborationId
      });
      throw error;
    }
  }

  /**
   * Verify smart contract payout matches offline attribution
   * @param {string} collaborationId Collaboration ID
   * @param {object} contractPayout Smart contract payout data
   * @returns {Promise<object>} Verification result
   */
  async verifyPayoutAttribution(collaborationId, contractPayout) {
    try {
      const offlineAttribution = await this.getSmartContractPayoutData(collaborationId);
      
      // Compare key metrics
      const verification = {
        collaborationId,
        matches: true,
        discrepancies: [],
        verifiedAt: new Date().toISOString()
      };

      // Verify total watch seconds
      if (Math.abs(offlineAttribution.totalWatchSeconds - contractPayout.totalWatchSeconds) > 60) {
        verification.matches = false;
        verification.discrepancies.push({
          field: 'totalWatchSeconds',
          offline: offlineAttribution.totalWatchSeconds,
          contract: contractPayout.totalWatchSeconds,
          difference: Math.abs(offlineAttribution.totalWatchSeconds - contractPayout.totalWatchSeconds)
        });
      }

      // Verify participant attribution
      const offlineParticipants = offlineAttribution.participants.reduce((map, p) => {
        map[p.creatorAddress] = p;
        return map;
      }, {});

      const contractParticipants = contractPayout.participants.reduce((map, p) => {
        map[p.creatorAddress] = p;
        return map;
      }, {});

      for (const [address, offlineData] of Object.entries(offlineParticipants)) {
        const contractData = contractParticipants[address];
        
        if (!contractData) {
          verification.matches = false;
          verification.discrepancies.push({
            field: 'missing_participant',
            address,
            offline: offlineData
          });
          continue;
        }

        // Verify split ratio
        if (Math.abs(offlineData.splitRatio - contractData.splitRatio) > 0.01) {
          verification.matches = false;
          verification.discrepancies.push({
            field: 'split_ratio',
            address,
            offline: offlineData.splitRatio,
            contract: contractData.splitRatio,
            difference: Math.abs(offlineData.splitRatio - contractData.splitRatio)
          });
        }

        // Verify watch seconds (allow small tolerance)
        if (Math.abs(offlineData.watchSeconds - contractData.watchSeconds) > 30) {
          verification.matches = false;
          verification.discrepancies.push({
            field: 'watch_seconds',
            address,
            offline: offlineData.watchSeconds,
            contract: contractData.watchSeconds,
            difference: Math.abs(offlineData.watchSeconds - contractData.watchSeconds)
          });
        }
      }

      // Check for extra participants in contract
      for (const [address, contractData] of Object.entries(contractParticipants)) {
        if (!offlineParticipants[address]) {
          verification.matches = false;
          verification.discrepancies.push({
            field: 'extra_participant',
            address,
            contract: contractData
          });
        }
      }

      logger.info('Payout attribution verification completed', {
        collaborationId,
        matches: verification.matches,
        discrepancyCount: verification.discrepancies.length
      });

      return verification;
    } catch (error) {
      logger.error('Failed to verify payout attribution', {
        error: error.message,
        collaborationId
      });
      throw error;
    }
  }
}

module.exports = CollaborationRevenueService;
