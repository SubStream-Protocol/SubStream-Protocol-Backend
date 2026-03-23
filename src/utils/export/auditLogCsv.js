/**
 * Build a CSV export for creator audit logs.
 *
 * @param {Array<{timestamp: string, action_type: string, entity_type: string, entity_id: string, ip_address: string, metadata: object}>} logs Audit logs.
 * @returns {string}
 */
function buildAuditLogCsv(logs) {
  const headers = ['timestamp', 'action_type', 'entity_type', 'entity_id', 'ip_address', 'metadata'];
  const rows = logs.map((log) => [
    log.timestamp,
    log.action_type,
    log.entity_type,
    log.entity_id,
    log.ip_address,
    JSON.stringify(sanitizeMetadata(log.metadata)),
  ]);

  return [headers, ...rows]
    .map((row) => row.map((value) => escapeCsvCell(value)).join(','))
    .join('\n');
}

/**
 * Escape a CSV cell and neutralize spreadsheet formula injection.
 *
 * @param {unknown} value Raw cell value.
 * @returns {string}
 */
function escapeCsvCell(value) {
  let normalized = value == null ? '' : String(value);

  if (/^[=+\-@]/.test(normalized)) {
    normalized = `'${normalized}`;
  }

  normalized = normalized.replace(/"/g, '""');
  return `"${normalized}"`;
}

/**
 * Recursively sanitize metadata strings before JSON serialization.
 *
 * @param {unknown} value Metadata value.
 * @returns {unknown}
 */
function sanitizeMetadata(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeMetadata(entry));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, sanitizeMetadata(entry)]),
    );
  }

  if (typeof value === 'string' && /^[=+\-@]/.test(value)) {
    return `'${value}`;
  }

  return value;
}

module.exports = {
  buildAuditLogCsv,
};
