import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';

import './setup.js';

import { vi } from 'vitest';
vi.mock('whatsapp-web.js', () => ({
  Client: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    initialize: vi.fn(),
    getChats: vi.fn().mockResolvedValue([]),
    info: null,
  })),
  LocalAuth: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('puppeteer', () => ({
  default: { launch: vi.fn() },
}));

vi.mock('qrcode', () => ({
  toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,test'),
}));

let app;
let sessionCookie;

beforeAll(async () => {
  app = require('../server');
  const loginRes = await request(app)
    .post('/api/login')
    .send({ password: 'test-password-123' });
  const setCookie = loginRes.headers['set-cookie'];
  if (setCookie) {
    sessionCookie = setCookie[0].split(';')[0];
  }
});

describe('Settings API', () => {
  it('GET /api/whatsapp/settings should return settings', async () => {
    const res = await request(app)
      .get('/api/whatsapp/settings')
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('cooldownMinutes');
    expect(res.body).toHaveProperty('quietStart');
    expect(res.body).toHaveProperty('quietEnd');
  });

  it('PUT /api/whatsapp/settings should update settings', async () => {
    const res = await request(app)
      .put('/api/whatsapp/settings')
      .set('Cookie', sessionCookie)
      .send({ cooldownMinutes: 60, quietStart: '01:00', quietEnd: '09:00' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('Blocklist API', () => {
  it('GET /api/whatsapp/blocklist should return blocklist', async () => {
    const res = await request(app)
      .get('/api/whatsapp/blocklist')
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(200);
    expect(res.body.blocklist).toBeDefined();
    expect(Array.isArray(res.body.blocklist)).toBe(true);
  });

  it('POST /api/whatsapp/blocklist should add to blocklist', async () => {
    const uniquePhone = '+97250' + Date.now().toString().slice(-7);
    const res = await request(app)
      .post('/api/whatsapp/blocklist')
      .set('Cookie', sessionCookie)
      .send({ phone: uniquePhone, reason: 'spam' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('DELETE /api/whatsapp/blocklist/:phone should remove from blocklist', async () => {
    // First add
    await request(app)
      .post('/api/whatsapp/blocklist')
      .set('Cookie', sessionCookie)
      .send({ phone: '+972509999999', reason: 'test' });

    const res = await request(app)
      .delete('/api/whatsapp/blocklist/' + encodeURIComponent('+972509999999'))
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(200);
  });
});

describe('Cooldowns API', () => {
  it('GET /api/whatsapp/cooldowns should return cooldown data', async () => {
    const res = await request(app)
      .get('/api/whatsapp/cooldowns')
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('cooldowns');
    expect(res.body).toHaveProperty('cooldownMinutes');
  });

  it('POST /api/whatsapp/cooldowns/reset should reset cooldowns', async () => {
    const res = await request(app)
      .post('/api/whatsapp/cooldowns/reset')
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('Group Tags API', () => {
  it('POST /api/whatsapp/groups/:groupId/tags should set tags', async () => {
    const res = await request(app)
      .post('/api/whatsapp/groups/test-group-123/tags')
      .set('Cookie', sessionCookie)
      .send({ tags: ['kartis', 'events', 'VIP'] });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.tags).toContain('kartis');
    expect(res.body.tags).toContain('vip'); // lowercased
  });

  it('POST /api/whatsapp/groups/:groupId/tags without tags should return 400', async () => {
    const res = await request(app)
      .post('/api/whatsapp/groups/test-group-123/tags')
      .set('Cookie', sessionCookie)
      .send({});
    expect(res.status).toBe(400);
  });

  it('GET /api/whatsapp/groups/:groupId/tags should get tags', async () => {
    // Set tags first
    await request(app)
      .post('/api/whatsapp/groups/tag-get-test/tags')
      .set('Cookie', sessionCookie)
      .send({ tags: ['test-tag'] });

    const res = await request(app)
      .get('/api/whatsapp/groups/tag-get-test/tags')
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(200);
    expect(res.body.tags).toContain('test-tag');
  });
});

describe('Scanner API', () => {
  it('GET /api/whatsapp/scanner/feed should return feed', async () => {
    const res = await request(app)
      .get('/api/whatsapp/scanner/feed')
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(200);
    expect(res.body.feed).toBeDefined();
  });

  it('GET /api/whatsapp/scanner/stats should return stats', async () => {
    const res = await request(app)
      .get('/api/whatsapp/scanner/stats')
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(200);
  });
});

describe('Accounts API', () => {
  it('GET /api/accounts should return accounts list', async () => {
    const res = await request(app)
      .get('/api/accounts')
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('accounts');
    expect(Array.isArray(res.body.accounts)).toBe(true);
  });

  it('POST /api/accounts should create account with auto-generated id', async () => {
    const res = await request(app)
      .post('/api/accounts')
      .set('Cookie', sessionCookie)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.id).toMatch(/^acct-/);
  });

  it('POST /api/accounts with invalid id should return 400', async () => {
    const res = await request(app)
      .post('/api/accounts')
      .set('Cookie', sessionCookie)
      .send({ id: 'INVALID ID!' });
    expect(res.status).toBe(400);
  });
});
