const crypto = require('crypto');

/**
 * Minimal HMAC JWT service for creator authentication.
 */
class CreatorAuthService {
  /**
   * @param {{auth: {creatorJwtSecret: string, issuer: string, audience: string}}} config Runtime config.
   */
  constructor(config) {
    this.config = config;
  }

  /**
   * Issue a signed creator token.
   *
   * @param {{creatorId: string, role?: string, expiresInSeconds?: number}} input Token payload.
   * @returns {string}
   */
  issueToken(input) {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: this.config.auth.issuer,
      aud: this.config.auth.audience,
      sub: input.creatorId,
      role: input.role || 'creator',
      iat: now,
      exp: now + (input.expiresInSeconds || 3600),
    };

    const header = encodeJson({ alg: 'HS256', typ: 'JWT' });
    const body = encodeJson(payload);
    const signature = sign(`${header}.${body}`, this.config.auth.creatorJwtSecret);
    return `${header}.${body}.${signature}`;
  }

  /**
   * Verify a creator token and return the normalized creator identity.
   *
   * @param {string} token Bearer token.
   * @returns {{id: string, role: string}}
   */
  verifyToken(token) {
    const parts = token.split('.');

    if (parts.length !== 3) {
      throw new Error('Malformed creator token');
    }

    const [header, payload, signature] = parts;
    const expectedSignature = sign(`${header}.${payload}`, this.config.auth.creatorJwtSecret);

    if (!safeCompare(signature, expectedSignature)) {
      throw new Error('Invalid creator token signature');
    }

    const decodedHeader = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
    const decodedPayload = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));

    if (decodedHeader.alg !== 'HS256' || decodedHeader.typ !== 'JWT') {
      throw new Error('Unsupported creator token');
    }

    if (
      decodedPayload.iss !== this.config.auth.issuer ||
      decodedPayload.aud !== this.config.auth.audience
    ) {
      throw new Error('Invalid creator token audience');
    }

    if (decodedPayload.role !== 'creator') {
      throw new Error('Creator role required');
    }

    if (!decodedPayload.sub) {
      throw new Error('Creator token missing subject');
    }

    if (decodedPayload.exp <= Math.floor(Date.now() / 1000)) {
      throw new Error('Creator token expired');
    }

    return {
      id: decodedPayload.sub,
      role: decodedPayload.role,
    };
  }
}

/**
 * Encode an object into a base64url JSON segment.
 *
 * @param {object} value Object to encode.
 * @returns {string}
 */
function encodeJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/**
 * Sign a token segment with HMAC SHA-256.
 *
 * @param {string} data Signed content.
 * @param {string} secret Signing secret.
 * @returns {string}
 */
function sign(data, secret) {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

/**
 * Constant-time string comparison helper.
 *
 * @param {string} left Left value.
 * @param {string} right Right value.
 * @returns {boolean}
 */
function safeCompare(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

module.exports = {
  CreatorAuthService,
};
