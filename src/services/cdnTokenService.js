const crypto = require('crypto');

class TokenValidationError extends Error {}

class CdnTokenService {
  constructor(config) {
    this.config = config;
  }

  issueToken({ walletAddress, creatorAddress, contentId, segmentPath, subscription }) {
    const now = Math.floor(Date.now() / 1000);
    const expiresInSeconds = this.config.cdn.tokenTtlSeconds;
    const payload = {
      iss: this.config.cdn.issuer,
      aud: this.config.cdn.audience,
      sub: walletAddress,
      creatorAddress,
      contentId,
      segmentPath,
      subscriptionStatus: subscription.status || 'active',
      iat: now,
      exp: now + expiresInSeconds,
      jti: crypto.randomUUID(),
    };

    return {
      token: this.sign(payload),
      expiresAt: new Date(payload.exp * 1000).toISOString(),
      expiresInSeconds,
    };
  }

  verifyToken(token, expectedResource = {}) {
    const [encodedHeader, encodedPayload, encodedSignature] = token.split('.');

    if (!encodedHeader || !encodedPayload || !encodedSignature) {
      throw new TokenValidationError('Malformed JWT');
    }

    const signedPortion = `${encodedHeader}.${encodedPayload}`;
    const expectedSignature = createBase64Url(
      crypto
        .createHmac('sha256', this.config.cdn.tokenSecret)
        .update(signedPortion)
        .digest(),
    );

    if (!safeCompare(encodedSignature, expectedSignature)) {
      throw new TokenValidationError('Invalid token signature');
    }

    const header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'));
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));

    if (header.alg !== 'HS256' || header.typ !== 'JWT') {
      throw new TokenValidationError('Unsupported token header');
    }

    const now = Math.floor(Date.now() / 1000);

    if (payload.iss !== this.config.cdn.issuer || payload.aud !== this.config.cdn.audience) {
      throw new TokenValidationError('Invalid token audience');
    }

    if (payload.exp <= now) {
      throw new TokenValidationError('Token expired');
    }

    if (expectedResource.contentId && payload.contentId !== expectedResource.contentId) {
      throw new TokenValidationError('Token content does not match requested asset');
    }

    if (expectedResource.segmentPath && payload.segmentPath !== expectedResource.segmentPath) {
      throw new TokenValidationError('Token segment does not match requested asset');
    }

    return payload;
  }

  buildPlaybackUrl({ contentId, segmentPath, token }) {
    if (!this.config.cdn.baseUrl) {
      return null;
    }

    const url = new URL(stripLeadingSlash(segmentPath), appendTrailingSlash(this.config.cdn.baseUrl));
    url.searchParams.set('token', token);
    url.searchParams.set('contentId', contentId);
    return url.toString();
  }

  sign(payload) {
    const header = { alg: 'HS256', typ: 'JWT' };
    const encodedHeader = createBase64Url(Buffer.from(JSON.stringify(header)));
    const encodedPayload = createBase64Url(Buffer.from(JSON.stringify(payload)));
    const signature = createBase64Url(
      crypto
        .createHmac('sha256', this.config.cdn.tokenSecret)
        .update(`${encodedHeader}.${encodedPayload}`)
        .digest(),
    );

    return `${encodedHeader}.${encodedPayload}.${signature}`;
  }
}

function appendTrailingSlash(value) {
  return value.endsWith('/') ? value : `${value}/`;
}

function stripLeadingSlash(value) {
  return value.startsWith('/') ? value.slice(1) : value;
}

function createBase64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function safeCompare(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

module.exports = {
  CdnTokenService,
  TokenValidationError,
};
