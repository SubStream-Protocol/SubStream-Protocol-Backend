const express = require('express');
const router = express.Router();
const { authenticateToken, requireCreator } = require('../middleware/auth');
const { logger } = require('../utils/logger');

/**
 * Creator Collaboration Revenue Attribution API Routes
 * Provides endpoints for managing co-authored content and revenue sharing
 */

/**
 * Create a new collaboration (creator only)
 * POST /api/collaborations
 */
router.post('/', authenticateToken, requireCreator, async (req, res) => {
  try {
    const {
      contentId,
      collaboratorAddresses,
      splitRatios,
      status = 'active'
    } = req.body;

    // Validate required fields
    if (!contentId || !collaboratorAddresses || !Array.isArray(collaboratorAddresses)) {
      return res.status(400).json({
        success: false,
        error: 'contentId and collaboratorAddresses array are required',
        code: 'MISSING_REQUIRED_FIELDS'
      });
    }

    if (collaboratorAddresses.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'At least one collaborator is required',
        code: 'NO_COLLABORATORS'
      });
    }

    // Validate split ratios if provided
    if (splitRatios) {
      const totalSplit = Object.values(splitRatios).reduce((sum, ratio) => sum + ratio, 0);
      if (totalSplit > 1) {
        return res.status(400).json({
          success: false,
          error: 'Total split ratios cannot exceed 1.0 (100%)',
          code: 'INVALID_SPLIT_TOTAL'
        });
      }

      // Validate all addresses in split ratios are valid
      for (const [address, ratio] of Object.entries(splitRatios)) {
        if (!address.match(/^G[A-Z0-9]{55}$/)) {
          return res.status(400).json({
            success: false,
            error: `Invalid Stellar address format: ${address}`,
            code: 'INVALID_ADDRESS'
          });
        }
      }
    }

    // Validate collaborator addresses
    for (const address of collaboratorAddresses) {
      if (!address.match(/^G[A-Z0-9]{55}$/)) {
        return res.status(400).json({
          success: false,
          error: `Invalid Stellar address format: ${address}`,
          code: 'INVALID_ADDRESS'
        });
      }

      // Ensure no duplicates
      if (collaboratorAddresses.filter(a => a === address).length > 1) {
        return res.status(400).json({
          success: false,
          error: `Duplicate collaborator address: ${address}`,
          code: 'DUPLICATE_COLLABORATOR'
        });
      }
    }

    const collaborationService = req.app.get('collaborationService');
    if (!collaborationService) {
      return res.status(503).json({
        success: false,
        error: 'Collaboration service not available',
        code: 'SERVICE_UNAVAILABLE'
      });
    }

    // Create collaboration
    const collaboration = await collaborationService.createCollaboration({
      contentId,
      primaryCreatorAddress: req.user.address,
      collaboratorAddresses,
      splitRatios,
      status
    });

    res.status(201).json({
      success: true,
      data: {
        collaboration,
        message: 'Collaboration created successfully'
      }
    });

  } catch (error) {
    logger.error('Create collaboration error', {
      error: error.message,
      creatorAddress: req.user.address,
      contentId: req.body.contentId
    });

    if (error.message.includes('owner can only create')) {
      return res.status(403).json({
        success: false,
        error: error.message,
        code: 'NOT_CONTENT_OWNER'
      });
    }

    res.status(500).json({
      success: false,
      error: 'Failed to create collaboration',
      code: 'COLLABORATION_CREATE_FAILED'
    });
  }
});

/**
 * Get collaboration by ID
 * GET /api/collaborations/:collaborationId
 */
router.get('/:collaborationId', authenticateToken, async (req, res) => {
  try {
    const { collaborationId } = req.params;

    const collaborationService = req.app.get('collaborationService');
    if (!collaborationService) {
      return res.status(503).json({
        success: false,
        error: 'Collaboration service not available',
        code: 'SERVICE_UNAVAILABLE'
      });
    }

    const collaboration = await collaborationService.getCollaboration(collaborationId);

    // Verify user is part of this collaboration
    const isParticipant = collaboration.participants.some(
      p => p.creator_address === req.user.address
    );

    if (!isParticipant) {
      return res.status(403).json({
        success: false,
        error: 'Access denied - not a collaboration participant',
        code: 'ACCESS_DENIED'
      });
    }

    res.json({
      success: true,
      data: { collaboration }
    });

  } catch (error) {
    logger.error('Get collaboration error', {
      error: error.message,
      collaborationId: req.params.collaborationId,
      userAddress: req.user.address
    });

    if (error.message.includes('not found')) {
      return res.status(404).json({
        success: false,
        error: 'Collaboration not found',
        code: 'COLLABORATION_NOT_FOUND'
      });
    }

    res.status(500).json({
      success: false,
      error: 'Failed to get collaboration',
      code: 'COLLABORATION_GET_FAILED'
    });
  }
});

/**
 * Update collaboration status (primary creator only)
 * PATCH /api/collaborations/:collaborationId/status
 */
router.patch('/:collaborationId/status', authenticateToken, async (req, res) => {
  try {
    const { collaborationId } = req.params;
    const { status } = req.body;

    if (!status || !['active', 'inactive', 'completed'].includes(status)) {
      return res.status(400).json({
        success: false,
        error: 'Valid status required: active, inactive, or completed',
        code: 'INVALID_STATUS'
      });
    }

    const collaborationService = req.app.get('collaborationService');
    if (!collaborationService) {
      return res.status(503).json({
        success: false,
        error: 'Collaboration service not available',
        code: 'SERVICE_UNAVAILABLE'
      });
    }

    // Verify user is primary creator
    const collaboration = await collaborationService.getCollaboration(collaborationId);
    
    if (collaboration.primary_creator_address !== req.user.address) {
      return res.status(403).json({
        success: false,
        error: 'Only primary creator can update collaboration status',
        code: 'NOT_PRIMARY_CREATOR'
      });
    }

    const updated = await collaborationService.updateCollaborationStatus(collaborationId, status);

    if (!updated) {
      return res.status(404).json({
        success: false,
        error: 'Collaboration not found',
        code: 'COLLABORATION_NOT_FOUND'
      });
    }

    const updatedCollaboration = await collaborationService.getCollaboration(collaborationId);

    res.json({
      success: true,
      data: {
        collaboration: updatedCollaboration,
        message: 'Collaboration status updated successfully'
      }
    });

  } catch (error) {
    logger.error('Update collaboration status error', {
      error: error.message,
      collaborationId: req.params.collaborationId,
      userAddress: req.user.address,
      status: req.body.status
    });

    res.status(500).json({
      success: false,
      error: 'Failed to update collaboration status',
      code: 'STATUS_UPDATE_FAILED'
    });
  }
});

/**
 * Record watch time for collaborative content
 * POST /api/collaborations/watch-time
 */
router.post('/watch-time', authenticateToken, async (req, res) => {
  try {
    const { contentId, watchSeconds } = req.body;

    if (!contentId || !watchSeconds) {
      return res.status(400).json({
        success: false,
        error: 'contentId and watchSeconds are required',
        code: 'MISSING_REQUIRED_FIELDS'
      });
    }

    const watchTime = parseInt(watchSeconds);
    if (isNaN(watchTime) || watchTime <= 0) {
      return res.status(400).json({
        success: false,
        error: 'watchSeconds must be a positive integer',
        code: 'INVALID_WATCH_TIME'
      });
    }

    const collaborationService = req.app.get('collaborationService');
    if (!collaborationService) {
      return res.status(503).json({
        success: false,
        error: 'Collaboration service not available',
        code: 'SERVICE_UNAVAILABLE'
      });
    }

    // Record watch time
    const result = await collaborationService.recordWatchTime(
      contentId,
      req.user.address,
      watchTime
    );

    res.json({
      success: true,
      data: {
        contentId,
        userAddress: req.user.address,
        watchSeconds,
        result
      }
    });

  } catch (error) {
    logger.error('Record watch time error', {
      error: error.message,
      contentId: req.body.contentId,
      userAddress: req.user.address,
      watchSeconds: req.body.watchSeconds
    });

    res.status(500).json({
      success: false,
      error: 'Failed to record watch time',
      code: 'WATCH_TIME_RECORD_FAILED'
    });
  }
});

/**
 * Get revenue attribution for collaboration
 * GET /api/collaborations/:collaborationId/attribution
 */
router.get('/:collaborationId/attribution', authenticateToken, async (req, res) => {
  try {
    const { collaborationId } = req.params;
    const { startTime, endTime, totalRevenue } = req.query;

    const collaborationService = req.app.get('collaborationService');
    if (!collaborationService) {
      return res.status(503).json({
        success: false,
        error: 'Collaboration service not available',
        code: 'SERVICE_UNAVAILABLE'
      });
    }

    // Verify user is part of this collaboration
    const collaboration = await collaborationService.getCollaboration(collaborationId);
    const isParticipant = collaboration.participants.some(
      p => p.creator_address === req.user.address
    );

    if (!isParticipant) {
      return res.status(403).json({
        success: false,
        error: 'Access denied - not a collaboration participant',
        code: 'ACCESS_DENIED'
      });
    }

    // Parse optional parameters
    const attributionParams = {
      collaborationId,
      startTime: startTime ? new Date(startTime) : null,
      endTime: endTime ? new Date(endTime) : null,
      totalRevenue: totalRevenue ? parseFloat(totalRevenue) : 0
    };

    const attribution = await collaborationService.calculateRevenueAttribution(attributionParams);

    res.json({
      success: true,
      data: {
        attribution
      }
    });

  } catch (error) {
    logger.error('Get revenue attribution error', {
      error: error.message,
      collaborationId: req.params.collaborationId,
      userAddress: req.user.address
    });

    if (error.message.includes('not found')) {
      return res.status(404).json({
        success: false,
        error: 'Collaboration not found',
        code: 'COLLABORATION_NOT_FOUND'
      });
    }

    res.status(500).json({
      success: false,
      error: 'Failed to get revenue attribution',
      code: 'ATTRIBUTION_GET_FAILED'
    });
  }
});

/**
 * Get revenue attribution for content
 * GET /api/collaborations/content/:contentId/attribution
 */
router.get('/content/:contentId/attribution', authenticateToken, async (req, res) => {
  try {
    const { contentId } = req.params;
    const { startTime, endTime, totalRevenue } = req.query;

    const collaborationService = req.app.get('collaborationService');
    if (!collaborationService) {
      return res.status(503).json({
        success: false,
        error: 'Collaboration service not available',
        code: 'SERVICE_UNAVAILABLE'
      });
    }

    // Parse optional parameters
    const period = {
      startTime: startTime ? new Date(startTime) : null,
      endTime: endTime ? new Date(endTime) : null,
      totalRevenue: totalRevenue ? parseFloat(totalRevenue) : 0
    };

    const attribution = await collaborationService.getContentRevenueAttribution(contentId, period);

    if (!attribution) {
      return res.status(404).json({
        success: false,
        error: 'No collaboration found for this content',
        code: 'NO_COLLABORATION_FOUND'
      });
    }

    // Verify user is part of this collaboration
    const isParticipant = attribution.attribution.some(
      p => p.creatorAddress === req.user.address
    );

    if (!isParticipant) {
      return res.status(403).json({
        success: false,
        error: 'Access denied - not a collaboration participant',
        code: 'ACCESS_DENIED'
      });
    }

    res.json({
      success: true,
      data: { attribution }
    });

  } catch (error) {
    logger.error('Get content attribution error', {
      error: error.message,
      contentId: req.params.contentId,
      userAddress: req.user.address
    });

    res.status(500).json({
      success: false,
      error: 'Failed to get content attribution',
      code: 'CONTENT_ATTRIBUTION_GET_FAILED'
    });
  }
});

/**
 * Get creator collaboration statistics (creator only)
 * GET /api/collaborations/stats
 */
router.get('/stats', authenticateToken, requireCreator, async (req, res) => {
  try {
    const creatorAddress = req.user.address;
    const { 
      status = 'active',
      startTime,
      endTime 
    } = req.query;

    const collaborationService = req.app.get('collaborationService');
    if (!collaborationService) {
      return res.status(503).json({
        success: false,
        error: 'Collaboration service not available',
        code: 'SERVICE_UNAVAILABLE'
      });
    }

    const filters = {
      status,
      startTime: startTime ? new Date(startTime) : null,
      endTime: endTime ? new Date(endTime) : null
    };

    const stats = await collaborationService.getCreatorCollaborationStats(creatorAddress, filters);

    if (!stats) {
      return res.status(404).json({
        success: false,
        error: 'No collaboration statistics available',
        code: 'NO_STATS_FOUND'
      });
    }

    res.json({
      success: true,
      data: stats
    });

  } catch (error) {
    logger.error('Get creator collaboration stats error', {
      error: error.message,
      creatorAddress: req.user.address
    });

    res.status(500).json({
      success: false,
      error: 'Failed to get collaboration statistics',
      code: 'STATS_GET_FAILED'
    });
  }
});

/**
 * Get smart contract payout data for collaboration
 * GET /api/collaborations/:collaborationId/payout-data
 */
router.get('/:collaborationId/payout-data', authenticateToken, async (req, res) => {
  try {
    const { collaborationId } = req.params;

    const collaborationService = req.app.get('collaborationService');
    if (!collaborationService) {
      return res.status(503).json({
        success: false,
        error: 'Collaboration service not available',
        code: 'SERVICE_UNAVAILABLE'
      });
    }

    // Verify user is primary creator
    const collaboration = await collaborationService.getCollaboration(collaborationId);
    
    if (collaboration.primary_creator_address !== req.user.address) {
      return res.status(403).json({
        success: false,
        error: 'Only primary creator can access payout data',
        code: 'NOT_PRIMARY_CREATOR'
      });
    }

    const payoutData = await collaborationService.getSmartContractPayoutData(collaborationId);

    res.json({
      success: true,
      data: {
        payoutData
      }
    });

  } catch (error) {
    logger.error('Get payout data error', {
      error: error.message,
      collaborationId: req.params.collaborationId,
      userAddress: req.user.address
    });

    if (error.message.includes('not found')) {
      return res.status(404).json({
        success: false,
        error: 'Collaboration not found',
        code: 'COLLABORATION_NOT_FOUND'
      });
    }

    res.status(500).json({
      success: false,
      error: 'Failed to get payout data',
      code: 'PAYOUT_DATA_GET_FAILED'
    });
  }
});

/**
 * Verify payout attribution against smart contract (primary creator only)
 * POST /api/collaborations/:collaborationId/verify-payout
 */
router.post('/:collaborationId/verify-payout', authenticateToken, async (req, res) => {
  try {
    const { collaborationId } = req.params;
    const { contractPayout } = req.body;

    if (!contractPayout) {
      return res.status(400).json({
        success: false,
        error: 'contractPayout is required',
        code: 'MISSING_CONTRACT_PAYOUT'
      });
    }

    const collaborationService = req.app.get('collaborationService');
    if (!collaborationService) {
      return res.status(503).json({
        success: false,
        error: 'Collaboration service not available',
        code: 'SERVICE_UNAVAILABLE'
      });
    }

    // Verify user is primary creator
    const collaboration = await collaborationService.getCollaboration(collaborationId);
    
    if (collaboration.primary_creator_address !== req.user.address) {
      return res.status(403).json({
        success: false,
        error: 'Only primary creator can verify payout attribution',
        code: 'NOT_PRIMARY_CREATOR'
      });
    }

    const verification = await collaborationService.verifyPayoutAttribution(collaborationId, contractPayout);

    res.json({
      success: true,
      data: {
        verification
      }
    });

  } catch (error) {
    logger.error('Verify payout attribution error', {
      error: error.message,
      collaborationId: req.params.collaborationId,
      userAddress: req.user.address
    });

    if (error.message.includes('not found')) {
      return res.status(404).json({
        success: false,
        error: 'Collaboration not found',
        code: 'COLLABORATION_NOT_FOUND'
      });
    }

    res.status(500).json({
      success: false,
      error: 'Failed to verify payout attribution',
      code: 'PAYOUT_VERIFICATION_FAILED'
    });
  }
});

/**
 * Get collaboration for content (internal use)
 * GET /api/collaborations/content/:contentId
 */
router.get('/content/:contentId', authenticateToken, async (req, res) => {
  try {
    const { contentId } = req.params;

    const collaborationService = req.app.get('collaborationService');
    if (!collaborationService) {
      return res.status(503).json({
        success: false,
        error: 'Collaboration service not available',
        code: 'SERVICE_UNAVAILABLE'
      });
    }

    const collaboration = await collaborationService.getCollaborationForContent(contentId);

    if (!collaboration) {
      return res.status(404).json({
        success: false,
        error: 'No collaboration found for this content',
        code: 'NO_COLLABORATION_FOUND'
      });
    }

    // Verify user is part of this collaboration
    const isParticipant = collaboration.participants.some(
      p => p.creator_address === req.user.address
    );

    if (!isParticipant) {
      return res.status(403).json({
        success: false,
        error: 'Access denied - not a collaboration participant',
        code: 'ACCESS_DENIED'
      });
    }

    res.json({
      success: true,
      data: { collaboration }
    });

  } catch (error) {
    logger.error('Get content collaboration error', {
      error: error.message,
      contentId: req.params.contentId,
      userAddress: req.user.address
    });

    res.status(500).json({
      success: false,
      error: 'Failed to get content collaboration',
      code: 'CONTENT_COLLABORATION_GET_FAILED'
    });
  }
});

module.exports = router;
