/**
 * @file tier-access.test.js
 * @description Integration tests for tier-based access control.
 *
 * Tests cover:
 *  - attachTier middleware (no token, valid token, bad token)
 *  - requireTier gate (blocked, allowed, exact boundary)
 *  - GET /content list filtering (guest, bronze, silver, gold)
 *  - GET /content/:id single item (allowed vs censored)
 *  - GET /content/tier/bronze|silver|gold gated endpoints
 *  - GET /content/tier-status access map
 *  - tierService unit tests (canAccess, censorContent, filterContentList)
 *
 * Run: npm test
 */
afterAll((done) => {
  done();
});

const request = require('supertest');
const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || 'dev-secret';

/** Build a signed JWT matching the shape produced by routes/auth.js */
function makeToken(tier, address = '0xTestWallet') {
  return jwt.sign({ address, tier }, SECRET, { expiresIn: '1h' });
}

/** Attach an Authorization header to a supertest request */
function withToken(req, tier) {
  return req.set('Authorization', `Bearer ${makeToken(tier)}`);
}

// ── Load app after helpers so env is set ────────────────────────────────────
let app;
beforeAll(() => {
  app = require('../index');
});

// ════════════════════════════════════════════════════════════════════════════
// tierService unit tests (no HTTP)
// ════════════════════════════════════════════════════════════════════════════

describe('tierService', () => {
  const svc = require('./tierService');

  describe('canAccess()', () => {
    it('guest can access guest content', () => {
      expect(svc.canAccess('guest', 'guest')).toBe(true);
    });
    it('guest cannot access bronze content', () => {
      expect(svc.canAccess('guest', 'bronze')).toBe(false);
    });
    it('bronze can access guest content', () => {
      expect(svc.canAccess('bronze', 'guest')).toBe(true);
    });
    it('bronze can access bronze content', () => {
      expect(svc.canAccess('bronze', 'bronze')).toBe(true);
    });
    it('bronze cannot access silver content', () => {
      expect(svc.canAccess('bronze', 'silver')).toBe(false);
    });
    it('silver can access bronze content', () => {
      expect(svc.canAccess('silver', 'bronze')).toBe(true);
    });
    it('gold can access everything', () => {
      ['guest', 'bronze', 'silver', 'gold'].forEach((t) => {
        expect(svc.canAccess('gold', t)).toBe(true);
      });
    });
    it('treats unknown tier as guest', () => {
      expect(svc.canAccess('vip', 'bronze')).toBe(false);
    });
    it('treats missing required tier as guest (open content)', () => {
      expect(svc.canAccess('guest', null)).toBe(true);
    });
  });

  describe('nextTier()', () => {
    it('guest → bronze', () => expect(svc.nextTier('guest')).toBe('bronze'));
    it('bronze → silver', () => expect(svc.nextTier('bronze')).toBe('silver'));
    it('silver → gold', () => expect(svc.nextTier('silver')).toBe('gold'));
    it('gold → null (already max)', () => expect(svc.nextTier('gold')).toBeNull());
  });

  describe('censorContent()', () => {
    const full = {
      id: '99',
      title: 'Secret Video',
      description: 'A'.repeat(200),
      thumbnail: 'https://example.com/thumb.jpg',
      contentUrl: 'https://example.com/stream.m3u8',
      body: 'Full body text',
      tier: 'gold',
    };

    it('redacts contentUrl', () => {
      expect(svc.censorContent(full, 'bronze').contentUrl).toBeNull();
    });
    it('redacts body', () => {
      expect(svc.censorContent(full, 'bronze').body).toBeNull();
    });
    it('keeps thumbnail visible', () => {
      expect(svc.censorContent(full, 'bronze').thumbnail).toBe(full.thumbnail);
    });
    it('truncates description to 120 chars + ellipsis', () => {
      const desc = svc.censorContent(full, 'bronze').description;
      expect(desc.length).toBeLessThanOrEqual(124); // 120 + '…'
      expect(desc.endsWith('…')).toBe(true);
    });
    it('sets locked: true', () => {
      expect(svc.censorContent(full, 'bronze').locked).toBe(true);
    });
    it('includes an upgrade message', () => {
      const upgrade = svc.censorContent(full, 'bronze').upgrade;
      expect(typeof upgrade).toBe('string');
      expect(upgrade.length).toBeGreaterThan(0);
    });
  });

  describe('filterContentList()', () => {
    const items = [
      { id: '1', title: 'Free', tier: 'guest', contentUrl: '/1', body: 'free' },
      { id: '2', title: 'Bronze', tier: 'bronze', contentUrl: '/2', body: 'b' },
      { id: '3', title: 'Gold', tier: 'gold', contentUrl: '/3', body: 'g' },
    ];

    it('guest sees guest unlocked, others locked', () => {
      const result = svc.filterContentList(items, 'guest');
      expect(result.find((i) => i.id === '1').locked).toBe(false);
      expect(result.find((i) => i.id === '2').locked).toBe(true);
      expect(result.find((i) => i.id === '3').locked).toBe(true);
    });

    it('bronze sees guest + bronze unlocked, gold locked', () => {
      const result = svc.filterContentList(items, 'bronze');
      expect(result.find((i) => i.id === '1').locked).toBe(false);
      expect(result.find((i) => i.id === '2').locked).toBe(false);
      expect(result.find((i) => i.id === '3').locked).toBe(true);
    });

    it('gold sees everything unlocked', () => {
      const result = svc.filterContentList(items, 'gold');
      result.forEach((item) => expect(item.locked).toBe(false));
    });

    it('locked items have null contentUrl', () => {
      const result = svc.filterContentList(items, 'guest');
      const locked = result.filter((i) => i.locked);
      locked.forEach((i) => expect(i.contentUrl).toBeNull());
    });
  });

  describe('tierStatus()', () => {
    it('silver has correct canAccess map', () => {
      const status = svc.tierStatus('silver');
      expect(status.canAccess.guest).toBe(true);
      expect(status.canAccess.bronze).toBe(true);
      expect(status.canAccess.silver).toBe(true);
      expect(status.canAccess.gold).toBe(false);
    });
    it('gold has all true in canAccess', () => {
      const status = svc.tierStatus('gold');
      Object.values(status.canAccess).forEach((v) => expect(v).toBe(true));
    });
    it('gold nextTier is null', () => {
      expect(svc.tierStatus('gold').nextTier).toBeNull();
    });
    it('bronze nextTier is silver', () => {
      expect(svc.tierStatus('bronze').nextTier).toBe('silver');
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET /content  (list endpoint)
// ════════════════════════════════════════════════════════════════════════════

describe('GET /content', () => {
  it('responds 200 with no token (guest)', async () => {
    const res = await request(app).get('/content');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.tier).toBe('guest');
  });

  it('guest: guest-tier item is unlocked', async () => {
    const res = await request(app).get('/content');
    const item = res.body.items.find((i) => i.tier === 'guest');
    expect(item.locked).toBe(false);
    expect(item.contentUrl).not.toBeNull();
  });

  it('guest: gold-tier item is locked with null contentUrl', async () => {
    const res = await request(app).get('/content');
    const item = res.body.items.find((i) => i.tier === 'gold');
    expect(item.locked).toBe(true);
    expect(item.contentUrl).toBeNull();
  });

  it('bronze: bronze item is unlocked', async () => {
    const res = await withToken(request(app).get('/content'), 'bronze');
    const item = res.body.items.find((i) => i.tier === 'bronze');
    expect(item.locked).toBe(false);
  });

  it('bronze: silver item is locked', async () => {
    const res = await withToken(request(app).get('/content'), 'bronze');
    const item = res.body.items.find((i) => i.tier === 'silver');
    expect(item.locked).toBe(true);
    expect(item.contentUrl).toBeNull();
  });

  it('gold: all items are unlocked', async () => {
    const res = await withToken(request(app).get('/content'), 'gold');
    expect(res.status).toBe(200);
    res.body.items.forEach((item) => expect(item.locked).toBe(false));
  });

  it('returns unlocked + locked counts', async () => {
    const res = await withToken(request(app).get('/content'), 'bronze');
    expect(typeof res.body.unlocked).toBe('number');
    expect(typeof res.body.locked).toBe('number');
    expect(res.body.unlocked + res.body.locked).toBe(res.body.total);
  });

  it('invalid token is treated as guest', async () => {
    const res = await request(app)
      .get('/content')
      .set('Authorization', 'Bearer this.is.invalid');
    expect(res.status).toBe(200);
    expect(res.body.tier).toBe('guest');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET /content/:id  (single item)
// ════════════════════════════════════════════════════════════════════════════

describe('GET /content/:id', () => {
  it('returns 404 for unknown id', async () => {
    const res = await request(app).get('/content/9999');
    expect(res.status).toBe(404);
  });

  it('guest can fetch guest-tier item in full', async () => {
    const res = await request(app).get('/content/1');
    expect(res.status).toBe(200);
    expect(res.body.locked).toBe(false);
    expect(res.body.contentUrl).not.toBeNull();
  });

  it('guest gets 403 with preview for bronze item', async () => {
    const res = await request(app).get('/content/2');
    expect(res.status).toBe(403);
    expect(res.body.preview).toBeDefined();
    expect(res.body.preview.contentUrl).toBeNull();
    expect(res.body.preview.locked).toBe(true);
    expect(typeof res.body.preview.upgrade).toBe('string');
  });

  it('bronze can fetch bronze item in full', async () => {
    const res = await withToken(request(app).get('/content/2'), 'bronze');
    expect(res.status).toBe(200);
    expect(res.body.locked).toBe(false);
    expect(res.body.contentUrl).not.toBeNull();
  });

  it('bronze gets 403 with preview for gold item', async () => {
    const res = await withToken(request(app).get('/content/4'), 'bronze');
    expect(res.status).toBe(403);
    expect(res.body.preview.contentUrl).toBeNull();
  });

  it('silver can fetch silver item in full', async () => {
    const res = await withToken(request(app).get('/content/3'), 'silver');
    expect(res.status).toBe(200);
    expect(res.body.locked).toBe(false);
  });

  it('gold can fetch any item in full', async () => {
    for (const id of ['1', '2', '3', '4']) {
      const res = await withToken(request(app).get(`/content/${id}`), 'gold');
      expect(res.status).toBe(200);
      expect(res.body.locked).toBe(false);
    }
  });

  it('403 response includes required and current tier fields', async () => {
    const res = await request(app).get('/content/4'); // gold item, no token
    expect(res.status).toBe(403);
    expect(res.body.required).toBe('gold');
    expect(res.body.current).toBe('guest');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET /content/tier/:tier  (gated list endpoints)
// ════════════════════════════════════════════════════════════════════════════

describe('GET /content/tier/bronze', () => {
  it('blocks guest — 403 with upgrade suggestion', async () => {
    const res = await request(app).get('/content/tier/bronze');
    expect(res.status).toBe(403);
    expect(res.body.upgrade).toBeDefined();
  });

  it('allows bronze — returns bronze items', async () => {
    const res = await withToken(request(app).get('/content/tier/bronze'), 'bronze');
    expect(res.status).toBe(200);
    expect(res.body.items.every((i) => i.tier === 'bronze')).toBe(true);
  });

  it('allows silver (higher tier) — returns bronze items', async () => {
    const res = await withToken(request(app).get('/content/tier/bronze'), 'silver');
    expect(res.status).toBe(200);
  });
});

describe('GET /content/tier/silver', () => {
  it('blocks bronze — 403', async () => {
    const res = await withToken(request(app).get('/content/tier/silver'), 'bronze');
    expect(res.status).toBe(403);
    expect(res.body.required).toBe('silver');
    expect(res.body.current).toBe('bronze');
  });

  it('allows silver', async () => {
    const res = await withToken(request(app).get('/content/tier/silver'), 'silver');
    expect(res.status).toBe(200);
    expect(res.body.items.every((i) => i.tier === 'silver')).toBe(true);
  });

  it('allows gold (higher tier)', async () => {
    const res = await withToken(request(app).get('/content/tier/silver'), 'gold');
    expect(res.status).toBe(200);
  });
});

describe('GET /content/tier/gold', () => {
  it('blocks guest — 403', async () => {
    const res = await request(app).get('/content/tier/gold');
    expect(res.status).toBe(403);
  });

  it('blocks bronze — 403', async () => {
    const res = await withToken(request(app).get('/content/tier/gold'), 'bronze');
    expect(res.status).toBe(403);
  });

  it('blocks silver — 403', async () => {
    const res = await withToken(request(app).get('/content/tier/gold'), 'silver');
    expect(res.status).toBe(403);
  });

  it('allows gold', async () => {
    const res = await withToken(request(app).get('/content/tier/gold'), 'gold');
    expect(res.status).toBe(200);
    expect(res.body.items.every((i) => i.tier === 'gold')).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET /content/tier-status
// ════════════════════════════════════════════════════════════════════════════

describe('GET /content/tier-status', () => {
  it('guest gets correct status', async () => {
    const res = await request(app).get('/content/tier-status');
    expect(res.status).toBe(200);
    expect(res.body.current).toBe('guest');
    expect(res.body.canAccess.bronze).toBe(false);
    expect(res.body.nextTier).toBe('bronze');
  });

  it('silver gets correct status', async () => {
    const res = await withToken(request(app).get('/content/tier-status'), 'silver');
    expect(res.status).toBe(200);
    expect(res.body.current).toBe('silver');
    expect(res.body.canAccess.silver).toBe(true);
    expect(res.body.canAccess.gold).toBe(false);
    expect(res.body.nextTier).toBe('gold');
  });

  it('gold gets null nextTier and all-true canAccess', async () => {
    const res = await withToken(request(app).get('/content/tier-status'), 'gold');
    expect(res.status).toBe(200);
    expect(res.body.nextTier).toBeNull();
    Object.values(res.body.canAccess).forEach((v) => expect(v).toBe(true));
  });
});