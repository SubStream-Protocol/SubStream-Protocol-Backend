/**
 * @module routes/content
 * @description Tier-gated content endpoints for the SubStream Protocol.
 *
 * `attachTier` runs globally in index.js, so `req.user.tier` is always
 * populated before any handler here runs.
 *
 * Endpoint summary:
 *
 *   GET /content                 List all content; items above the user's
 *                                tier are returned as censored previews.
 *
 *   GET /content/tier-status     Current user's tier info + upgrade hints.
 *                                Frontend uses this to render upgrade UI.
 *
 *   GET /content/:id             Single item — full or censored depending
 *                                on the user's tier vs the content's tier.
 *
 *   GET /content/tier/bronze     All bronze-tier content (requires bronze+)
 *   GET /content/tier/silver     All silver-tier content (requires silver+)
 *   GET /content/tier/gold       All gold-tier content  (requires gold)
 */

const express = require('express');
const router = express.Router();

const { requireTier } = require('../middleware/tierAuth');
const tierService = require('../services/tierService');
const contentService = require('../services/contentService');

// ── Open endpoints (tier filtering applied inside, not at the gate) ─────────

/**
 * GET /content
 *
 * Returns every content item the platform has.
 * - Items the user can access: returned in full with `locked: false`
 * - Items above the user's tier: returned as censored previews with
 *   `locked: true`, `contentUrl: null`, and an `upgrade` hint string.
 *
 * This lets the frontend show a unified catalogue where locked items
 * are visually greyed out but still discoverable.
 */
router.get('/', async (req, res) => {
  try {
    const userTier = req.user?.tier || 'guest';
    const allContent = await contentService.getAllContent();
    const filtered = tierService.filterContentList(allContent, userTier);

    return res.json({
      success: true,
      tier: userTier,
      total: filtered.length,
      unlocked: filtered.filter((i) => !i.locked).length,
      locked: filtered.filter((i) => i.locked).length,
      items: filtered,
    });
  } catch (err) {
    console.error('[content] GET / error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch content' });
  }
});

/**
 * GET /content/tier-status
 *
 * Returns the current user's tier rank, access map, next tier, and
 * an upgrade message. Intended for tier management / upgrade UI.
 *
 * Example response:
 * {
 *   current: 'bronze',
 *   rank: 1,
 *   canAccess: { guest: true, bronze: true, silver: false, gold: false },
 *   nextTier: 'silver',
 *   upgradeMessage: 'Upgrade to Silver to unlock more content.'
 * }
 */
router.get('/tier-status', (req, res) => {
  const userTier = req.user?.tier || 'guest';
  return res.json({ success: true, ...tierService.tierStatus(userTier) });
});

// ── Tier-gated list endpoints ───────────────────────────────────────────────

/**
 * GET /content/tier/bronze
 * Returns only bronze-tier content. Requires bronze subscription or above.
 * Guests receive a 403 with an upgrade suggestion.
 */
router.get('/tier/bronze', requireTier('bronze'), async (req, res) => {
  try {
    const items = await contentService.getContentByTier('bronze');
    return res.json({ success: true, tier: 'bronze', total: items.length, items });
  } catch (err) {
    console.error('[content] GET /tier/bronze error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch bronze content' });
  }
});

/**
 * GET /content/tier/silver
 * Returns only silver-tier content. Requires silver subscription or above.
 */
router.get('/tier/silver', requireTier('silver'), async (req, res) => {
  try {
    const items = await contentService.getContentByTier('silver');
    return res.json({ success: true, tier: 'silver', total: items.length, items });
  } catch (err) {
    console.error('[content] GET /tier/silver error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch silver content' });
  }
});

/**
 * GET /content/tier/gold
 * Returns only gold-tier content. Requires gold subscription.
 */
router.get('/tier/gold', requireTier('gold'), async (req, res) => {
  try {
    const items = await contentService.getContentByTier('gold');
    return res.json({ success: true, tier: 'gold', total: items.length, items });
  } catch (err) {
    console.error('[content] GET /tier/gold error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch gold content' });
  }
});

// ── Single-item endpoint (must come after /tier/* routes) ───────────────────

/**
 * GET /content/:id
 *
 * Returns a single content item by ID.
 *
 * - If the user's tier meets the content requirement: full item returned.
 * - If the user's tier is too low: 403 with a censored preview so the
 *   frontend can still render something meaningful (thumbnail, title,
 *   truncated description, upgrade suggestion).
 *
 * IMPORTANT: this route is defined AFTER /tier-status and /tier/* so
 * Express does not accidentally match those paths as :id values.
 */
router.get('/:id', async (req, res) => {
  try {
    const userTier = req.user?.tier || 'guest';
    const content = await contentService.getContentById(req.params.id);

    if (!content) {
      return res.status(404).json({ success: false, error: 'Content not found' });
    }

    if (!tierService.canAccess(userTier, content.tier)) {
      return res.status(403).json({
        success: false,
        error: 'Insufficient subscription tier',
        required: content.tier,
        current: userTier,
        preview: tierService.censorContent(content, userTier),
      });
    }

    return res.json({ success: true, ...content, locked: false });
  } catch (err) {
    console.error('[content] GET /:id error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch content' });
  }
});

module.exports = router;