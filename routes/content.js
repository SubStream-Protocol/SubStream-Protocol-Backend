const express = require('express');
const router = express.Router();
const contentService = require('../services/contentService');
const { authenticateToken, requireTierUnified, getUserId } = require('../middleware/unifiedAuth');

// Get content by ID with tier-based filtering
router.get('/:contentId', authenticateToken, (req, res) => {
  try {
    const { contentId } = req.params;
    const content = contentService.getContent(contentId, getUserId(req.user));
    
    res.json({
      success: true,
      content
    });

  } catch (error) {
    console.error('Get content error:', error);
    res.status(404).json({
      success: false,
      error: error.message || 'Content not found'
    });
  }
});

// List content with tier-based filtering
router.get('/', authenticateToken, (req, res) => {
  try {
    const filters = {
      creator: req.query.creator,
      tier: req.query.tier,
      tags: req.query.tags ? req.query.tags.split(',') : undefined,
      userAddress: getUserId(req.user),
      search: req.query.search
    };

    const contentList = contentService.listContent(getUserId(req.user), filters);
    
    res.json({
      success: true,
      content: contentList,
      count: contentList.length,
      filters
    });

  } catch (error) {
    console.error('List content error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to list content'
    });
  }
});

// Create new content (creator only)
router.post('/', authenticateToken, requireTierUnified('bronze'), (req, res) => {
  try {
    const {
      title,
      description,
      requiredTier = 'bronze',
      thumbnail,
      duration,
      price,
      tags
    } = req.body;

    if (!title || !description) {
      return res.status(400).json({
        success: false,
        error: 'Title and description are required'
      });
    }

    const content = contentService.addContent({
      title,
      description,
      requiredTier,
      thumbnail,
      duration: parseFloat(duration),
      price,
      tags: tags || []
    }, getUserId(req.user));

    res.status(201).json({
      success: true,
      content
    });

  } catch (error) {
    console.error('Create content error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to create content'
    });
  }
});

// Update content (creator only)
router.put('/:contentId', authenticateToken, (req, res) => {
  try {
    const { contentId } = req.params;
    const updates = req.body;

    // Don't allow updating creator or creation date
    delete updates.creator;
    delete updates.createdAt;

    const updatedContent = contentService.updateContent(contentId, updates, getUserId(req.user));
    
    res.json({
      success: true,
      content: updatedContent
    });

  } catch (error) {
    console.error('Update content error:', error);
    res.status(403).json({
      success: false,
      error: error.message || 'Failed to update content'
    });
  }
});

// Delete content (creator only)
router.delete('/:contentId', authenticateToken, (req, res) => {
  try {
    const { contentId } = req.params;
    
    contentService.deleteContent(contentId, getUserId(req.user));
    
    res.json({
      success: true,
      message: 'Content deleted successfully'
    });

  } catch (error) {
    console.error('Delete content error:', error);
    res.status(403).json({
      success: false,
      error: error.message || 'Failed to delete content'
    });
  }
});

// Check if user can access content
router.get('/:contentId/access', authenticateToken, (req, res) => {
  try {
    const { contentId } = req.params;
    const canAccess = contentService.canAccessContent(contentId, getUserId(req.user));
    
    res.json({
      success: true,
      contentId,
      canAccess,
      userTier: contentService.getUserTier(getUserId(req.user))
    });

  } catch (error) {
    console.error('Check access error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to check access'
    });
  }
});

// Get creator statistics
router.get('/creator/:creatorAddress/stats', authenticateToken, (req, res) => {
  try {
    const { creatorAddress } = req.params;
    const stats = contentService.getCreatorStats(creatorAddress, getUserId(req.user));
    
    res.json({
      success: true,
      creatorAddress,
      stats
    });

  } catch (error) {
    console.error('Get creator stats error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get creator statistics'
    });
  }
});

// Get upgrade suggestions for user
router.get('/upgrade/suggestions', authenticateToken, (req, res) => {
  try {
    const suggestions = contentService.getUpgradeSuggestions(getUserId(req.user));
    
    res.json({
      success: true,
      suggestions
    });

  } catch (error) {
    console.error('Get upgrade suggestions error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get upgrade suggestions'
    });
  }
});

// Get content by tier (for discovery)
router.get('/tier/:tierName', authenticateToken, (req, res) => {
  try {
    const { tierName } = req.params;
    
    // Validate tier name
    const validTiers = ['bronze', 'silver', 'gold'];
    if (!validTiers.includes(tierName)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid tier. Must be bronze, silver, or gold'
      });
    }

    const filters = {
      ...req.query,
      requiredTier: tierName,
      userAddress: getUserId(req.user)
    };

    const contentList = contentService.listContent(getUserId(req.user), filters);
    
    res.json({
      success: true,
      tier: tierName,
      content: contentList,
      count: contentList.length
    });

  } catch (error) {
    console.error('Get content by tier error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get content by tier'
    });
  }
});

// Search content with tier awareness
router.post('/search', authenticateToken, (req, res) => {
  try {
    const { query, filters = {} } = req.body;
    
    if (!query) {
      return res.status(400).json({
        success: false,
        error: 'Search query is required'
      });
    }

    const searchFilters = {
      ...filters,
      search: query,
      userAddress: getUserId(req.user)
    };

    const results = contentService.listContent(getUserId(req.user), searchFilters);
    
    res.json({
      success: true,
      query,
      filters,
      userAddress: getUserId(req.user),
      results,
      count: results.length
    });

  } catch (error) {
    console.error('Search content error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to search content'
    });
  }
});

// Get user's accessible content summary
router.get('/user/summary', authenticateToken, (req, res) => {
  try {
    const userTier = contentService.getUserTier(getUserId(req.user));
    const allContent = contentService.listContent(getUserId(req.user));
    
    const summary = {
      userTier,
      totalContent: allContent.length,
      accessibleContent: allContent.filter(c => !c.censored).length,
      restrictedContent: allContent.filter(c => c.censored).length,
      contentByTier: {
        bronze: allContent.filter(c => c.requiredTier === 'bronze').length,
        silver: allContent.filter(c => c.requiredTier === 'silver').length,
        gold: allContent.filter(c => c.requiredTier === 'gold').length
      }
    };

    res.json({
      success: true,
      summary
    });

  } catch (error) {
    console.error('Get user summary error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get user summary'
    });
  }
});

module.exports = router;
