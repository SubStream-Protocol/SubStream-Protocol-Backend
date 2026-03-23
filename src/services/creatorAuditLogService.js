/**
 * Append-only audit logging service for creator actions.
 */
class CreatorAuditLogService {
  /**
   * @param {import('../db/appDatabase').AppDatabase} database Database wrapper.
   */
  constructor(database) {
    this.database = database;
  }

  /**
   * Persist a new immutable audit log entry.
   *
   * @param {{creatorId: string, actionType: string, entityType: string, entityId: string, timestamp: string, ipAddress: string, metadata: object}} entry Audit payload.
   * @returns {object}
   */
  append(entry) {
    return normalizeAuditLogRow(this.database.insertAuditLog(entry));
  }

  /**
   * Return all audit logs owned by a creator.
   *
   * @param {string} creatorId Creator identifier.
   * @returns {object[]}
   */
  listByCreatorId(creatorId) {
    return this.database
      .listAuditLogsByCreatorId(creatorId)
      .map((row) => normalizeAuditLogRow(row));
  }
}

/**
 * Normalize raw audit log rows into API-safe objects.
 *
 * @param {object} row Raw database row.
 * @returns {object}
 */
function normalizeAuditLogRow(row) {
  return {
    id: row.id,
    creator_id: row.creatorId,
    timestamp: row.timestamp,
    action_type: row.actionType,
    entity_type: row.entityType,
    entity_id: row.entityId,
    ip_address: row.ipAddress,
    metadata: JSON.parse(row.metadataJson),
    created_at: row.createdAt,
  };
}

module.exports = {
  CreatorAuditLogService,
};
