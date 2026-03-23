const request = require('supertest');

const { loadConfig } = require('./src/config');
const { CdnTokenService } = require('./src/services/cdnTokenService');
const { createApp } = require('./index');

describe('SubStream Protocol API', () => {
  const baseConfig = {
    ...loadConfig({
      CDN_BASE_URL: 'https://cdn.substream.test/private',
      CDN_TOKEN_SECRET: 'test-secret',
      CDN_TOKEN_TTL_SECONDS: '300',
      SOROBAN_CONTRACT_ID: 'CAOUX2FZ65IDC4F2X7LJJ2SVF23A35CCTZB7KVVN475JCLKTTU4CEY6L',
    }),
  };

  it('should return 200 and project information on GET /', async () => {
    const app = createApp({
      config: baseConfig,
      subscriptionVerifier: {
        verifySubscription: jest.fn(),
      },
    });

    const res = await request(app).get('/');

    expect(res.statusCode).toEqual(200);
    expect(res.body).toHaveProperty('project', 'SubStream Protocol');
    expect(res.body).toHaveProperty('status', 'Active');
    expect(res.body).toHaveProperty('contract', 'CAOUX2FZ65IDC4F2X7LJJ2SVF23A35CCTZB7KVVN475JCLKTTU4CEY6L');
  });

  it('should issue a short-lived CDN token for an active subscriber', async () => {
    const subscriptionVerifier = {
      verifySubscription: jest.fn().mockResolvedValue({
        active: true,
        status: 'active',
      }),
    };

    const app = createApp({
      config: baseConfig,
      subscriptionVerifier,
    });

    const res = await request(app).post('/api/cdn/token').send({
      walletAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      creatorAddress: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBR5Q',
      contentId: 'bafy-content',
      segmentPath: '/segments/episode-1/00001.ts',
    });

    expect(res.statusCode).toBe(200);
    expect(subscriptionVerifier.verifySubscription).toHaveBeenCalledTimes(1);
    expect(res.body).toHaveProperty('token');
    expect(res.body).toHaveProperty('tokenType', 'Bearer');
    expect(res.body.playbackUrl).toContain('https://cdn.substream.test/private/segments/episode-1/00001.ts');
    expect(res.body.playbackUrl).toContain('contentId=bafy-content');
  });

  it('should reject token issuance for inactive subscribers', async () => {
    const app = createApp({
      config: baseConfig,
      subscriptionVerifier: {
        verifySubscription: jest.fn().mockResolvedValue({
          active: false,
          status: 'inactive',
        }),
      },
    });

    const res = await request(app).post('/api/cdn/token').send({
      walletAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      creatorAddress: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBR5Q',
      contentId: 'bafy-content',
      segmentPath: '/segments/episode-1/00001.ts',
    });

    expect(res.statusCode).toBe(403);
    expect(res.body).toHaveProperty('error', 'Active on-chain subscription required');
  });

  it('should validate a token for the matching content and segment', async () => {
    const tokenService = new CdnTokenService(baseConfig);
    const { token } = tokenService.issueToken({
      walletAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      creatorAddress: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBR5Q',
      contentId: 'bafy-content',
      segmentPath: '/segments/episode-1/00001.ts',
      subscription: { status: 'active' },
    });

    const app = createApp({
      config: baseConfig,
      subscriptionVerifier: {
        verifySubscription: jest.fn(),
      },
    });

    const res = await request(app)
      .get('/api/cdn/validate')
      .query({
        token,
        contentId: 'bafy-content',
        segmentPath: '/segments/episode-1/00001.ts',
      });

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      valid: true,
      claims: {
        contentId: 'bafy-content',
        segmentPath: '/segments/episode-1/00001.ts',
      },
    });
  });

  it('should reject an expired token', async () => {
    const expiredConfig = {
      ...baseConfig,
      cdn: {
        ...baseConfig.cdn,
        tokenTtlSeconds: -1,
      },
    };
    const tokenService = new CdnTokenService(expiredConfig);
    const { token } = tokenService.issueToken({
      walletAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      creatorAddress: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBR5Q',
      contentId: 'bafy-content',
      segmentPath: '/segments/episode-1/00001.ts',
      subscription: { status: 'active' },
    });

    const app = createApp({
      config: expiredConfig,
      subscriptionVerifier: {
        verifySubscription: jest.fn(),
      },
    });

    const res = await request(app)
      .get('/api/cdn/validate')
      .query({ token, contentId: 'bafy-content', segmentPath: '/segments/episode-1/00001.ts' });

    expect(res.statusCode).toBe(401);
    expect(res.body).toHaveProperty('error', 'Token expired');
  });
});
