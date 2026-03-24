const net = require('net');

/**
 * Extract a normalized IP address from the request context.
 *
 * This prefers Express' `req.ip`, which only trusts forwarded headers when the
 * application explicitly enables trusted proxy handling. If no valid IP can be
 * resolved, the function returns `unknown`.
 *
 * @param {import('express').Request} req Current request.
 * @returns {string}
 */
function getRequestIp(req) {
  const candidates = [req.ip, req.socket?.remoteAddress];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    const normalized = normalizeIp(candidate);

    if (normalized) {
      return normalized;
    }
  }

  return 'unknown';
}

/**
 * Normalize an IP address for storage.
 *
 * @param {string} value Raw address string.
 * @returns {string|null}
 */
function normalizeIp(value) {
  let normalized = String(value).trim();

  if (normalized.startsWith('::ffff:')) {
    normalized = normalized.slice('::ffff:'.length);
  }

  return net.isIP(normalized) ? normalized : null;
}

module.exports = {
  getRequestIp,
};
