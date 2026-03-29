/**
 * @module services/tierService
 * @description Business logic for tier-based content access control.
 *
 * This module is the single source of truth for:
 *   - Access decisions (can a tier view this content?)
 *   - Censored previews (what does a locked item look like?)
 *   - Upgrade suggestions (what should the UI tell the user?)
 *   - List filtering (which items in a list are locked vs open?)
 *   - Tier status (what can a user currently access?)
 */

const { tierRank, TIER_LEVELS } = require('../middleware/tierAuth');

/**
 * Decide whether a user's tier meets the content's required tier.
 *
 * @param {string} userTier      - e.g. 'bronze'
 * @param {string} requiredTier  - e.g. 'silver'  (falsy → 'guest', open to all)
 * @returns {boolean}
 */
function canAccess(userTier, requiredTier) {
  return tierRank(userTier) >= tierRank(requiredTier || 'guest');
}

/**
 * Return the next tier above the user's current tier.
 * Returns null when the user is already on the highest tier.
 *
 * @param {string} userTier
 * @returns {string|null}
 */
function nextTier(userTier) {
  const rank = tierRank(userTier);
  return TIER_LEVELS[rank + 1] || null;
}

/**
 * Build a human-readable upgrade suggestion message.
 *
 * @param {string} current   - User's current tier
 * @param {string} required  - Tier required by the content
 * @returns {string}
 */
function upgradeSuggestion(current, required) {
  if (canAccess(current, required)) return '';

  const label = (t) => {
    const s = (t || 'guest').toLowerCase();
    return s.charAt(0).toUpperCase() + s.slice(1);
  };

  const next = nextTier(current);
  // If the very next tier already unlocks this content, suggest it specifically
  if (next && tierRank(next) >= tierRank(required)) {
    return `Upgrade to ${label(next)} to unlock this content.`;
  }
  return `You need a ${label(required)} subscription to access this content.`;
}

/**
 * Generate a censored preview of a content document.
 *
 * Keeps public metadata visible (title, thumbnail, tier label) but
 * redacts the actual content URL and body so unauthorized users get
 * just enough information to understand what they are missing and
 * how to upgrade.
 *
 * @param {Object} content    - Full content document from the database
 * @param {string} userTier   - The requesting user's current tier
 * @returns {Object}          - Safe, censored representation
 */
function censorContent(content, userTier) {
  return {
    id: content.id,
    title: content.title || 'Premium Content',
    // Truncate description to 120 chars so users get a tease, not the full text
    description: content.description
      ? content.description.slice(0, 120) + (content.description.length > 120 ? '…' : '')
      : 'Subscribe to view this content.',
    // Thumbnail stays visible — acts as a visual teaser in the UI
    thumbnail: content.thumbnail || null,
    // These are the sensitive fields — always null for locked content
    contentUrl: null,
    body: null,
    tier: content.tier,
    locked: true,
    upgrade: upgradeSuggestion(userTier, content.tier),
    previewAvailable: true,
  };
}

/**
 * Filter a list of content items for a given user tier.
 *
 * Items the user can access are returned in full (with `locked: false`).
 * Items above the user's tier are returned as censored previews.
 *
 * This is the main function called by GET /content to produce a
 * mixed list of open and locked items in a single response.
 *
 * @param {Object[]} items    - Array of content documents from the DB
 * @param {string}   userTier - The requesting user's tier
 * @returns {Object[]}
 */
function filterContentList(items, userTier) {
  return items.map((item) => {
    if (canAccess(userTier, item.tier)) {
      return { ...item, locked: false };
    }
    return censorContent(item, userTier);
  });
}

/**
 * Build a complete tier-status summary for the requesting user.
 *
 * Used by GET /content/tier-status to give the frontend everything it
 * needs to render a tier management / upgrade UI without extra round-trips.
 *
 * @param {string} userTier
 * @returns {Object}
 */
function tierStatus(userTier) {
  const current = (userTier || 'guest').toLowerCase();
  const next = nextTier(current);

  return {
    current,
    rank: tierRank(current),
    // Map of every tier → whether the user can currently access it
    canAccess: Object.fromEntries(TIER_LEVELS.map((t) => [t, canAccess(current, t)])),
    nextTier: next,
    upgradeMessage: next
      ? `Upgrade to ${next.charAt(0).toUpperCase() + next.slice(1)} to unlock more content.`
      : 'You are on the highest tier. Enjoy all content!',
  };
}

module.exports = {
  canAccess,
  censorContent,
  filterContentList,
  upgradeSuggestion,
  nextTier,
  tierStatus,
};