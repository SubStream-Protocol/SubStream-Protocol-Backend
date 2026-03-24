const VALID_VIDEO_VISIBILITY = new Set(['public', 'private', 'subscribers_only', 'unlisted']);

/**
 * Service responsible for audited creator mutations.
 */
class CreatorActionService {
  /**
   * @param {import('../db/appDatabase').AppDatabase} database Database wrapper.
   * @param {import('./creatorAuditLogService').CreatorAuditLogService} auditLogService Audit log service.
   */
  constructor(database, auditLogService) {
    this.database = database;
    this.auditLogService = auditLogService;
  }

  /**
   * Update a creator flow rate and append an audit trail entry in the same transaction.
   *
   * @param {{creatorId: string, flowRate: string, currency: string|null, ipAddress: string}} input Mutation payload.
   * @returns {object}
   */
  updateFlowRate(input) {
    return this.database.transaction(() => {
      const timestamp = new Date().toISOString();
      const previous = this.database.getCreatorSettings(input.creatorId);
      const updated = this.database.upsertCreatorSettings({
        creatorId: input.creatorId,
        flowRate: input.flowRate,
        currency: input.currency || previous?.currency || null,
        updatedAt: timestamp,
      });

      this.auditLogService.append({
        creatorId: input.creatorId,
        actionType: 'FLOW_RATE_UPDATED',
        entityType: 'creator_settings',
        entityId: input.creatorId,
        timestamp,
        ipAddress: input.ipAddress,
        metadata: {
          previous_flow_rate: previous?.flowRate || null,
          new_flow_rate: updated.flowRate,
          currency: updated.currency,
        },
      });

      return updated;
    });
  }

  /**
   * Update a creator-owned video visibility and append an audit trail entry.
   *
   * @param {{creatorId: string, videoId: string, visibility: string, ipAddress: string}} input Mutation payload.
   * @returns {object}
   */
  updateVideoVisibility(input) {
    if (!VALID_VIDEO_VISIBILITY.has(input.visibility)) {
      throw createError(400, 'Unsupported visibility value');
    }

    return this.database.transaction(() => {
      const existing = this.database.getVideoById(input.videoId);

      if (!existing || existing.creatorId !== input.creatorId) {
        throw createError(404, 'Video not found');
      }

      const timestamp = new Date().toISOString();
      const updated = this.database.updateVideoVisibility({
        videoId: input.videoId,
        visibility: input.visibility,
        updatedAt: timestamp,
      });

      this.auditLogService.append({
        creatorId: input.creatorId,
        actionType: 'VIDEO_VISIBILITY_CHANGED',
        entityType: 'video',
        entityId: input.videoId,
        timestamp,
        ipAddress: input.ipAddress,
        metadata: {
          video_title: existing.title || null,
          previous_visibility: existing.visibility,
          new_visibility: updated.visibility,
        },
      });

      return updated;
    });
  }

  /**
   * Update a creator-owned co-op split and append an audit trail entry.
   *
   * @param {{creatorId: string, splitId: string, splits: object[], ipAddress: string}} input Mutation payload.
   * @returns {object}
   */
  updateCoopSplit(input) {
    validateSplits(input.splits);

    return this.database.transaction(() => {
      const existing = this.database.getCoopSplitById(input.splitId);

      if (!existing || existing.creatorId !== input.creatorId) {
        throw createError(404, 'Co-op split not found');
      }

      const timestamp = new Date().toISOString();
      const updated = this.database.updateCoopSplit({
        splitId: input.splitId,
        splits: input.splits,
        updatedAt: timestamp,
      });

      this.auditLogService.append({
        creatorId: input.creatorId,
        actionType: 'COOP_SPLIT_MODIFIED',
        entityType: 'coop_split',
        entityId: input.splitId,
        timestamp,
        ipAddress: input.ipAddress,
        metadata: {
          previous_split: summarizeSplits(existing.splits),
          new_split: summarizeSplits(updated.splits),
        },
      });

      return updated;
    });
  }
}

/**
 * Create a typed request error.
 *
 * @param {number} statusCode HTTP status code.
 * @param {string} message Error message.
 * @returns {Error & {statusCode: number}}
 */
function createError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

/**
 * Validate incoming split payloads.
 *
 * @param {object[]} splits Proposed split configuration.
 * @returns {void}
 */
function validateSplits(splits) {
  if (!Array.isArray(splits) || splits.length === 0) {
    throw createError(400, 'splits must be a non-empty array');
  }

  for (const split of splits) {
    if (
      !split ||
      typeof split !== 'object' ||
      !split.walletAddress ||
      typeof split.percentage !== 'number'
    ) {
      throw createError(400, 'Each split must include walletAddress and numeric percentage');
    }
  }
}

/**
 * Reduce split data to a compliance-friendly summary.
 *
 * @param {object[]} splits Split configuration.
 * @returns {{participants: number, total_percentage: number, allocations: object[]}}
 */
function summarizeSplits(splits) {
  return {
    participants: splits.length,
    total_percentage: splits.reduce((sum, split) => sum + split.percentage, 0),
    allocations: splits.map((split) => ({
      walletAddress: split.walletAddress,
      percentage: split.percentage,
    })),
  };
}

module.exports = {
  CreatorActionService,
};
