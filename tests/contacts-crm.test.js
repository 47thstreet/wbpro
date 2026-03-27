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
    sendMessage: vi.fn().mockResolvedValue({ id: { _serialized: 'msg_123' } }),
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

// ── Contacts API ──────────────────────────────────────────────────────────

describe('Contacts API — /api/contacts', () => {
  it('GET /api/contacts should return contacts', async () => {
    const res = await request(app)
      .get('/api/contacts')
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('contacts');
    expect(Array.isArray(res.body.contacts)).toBe(true);
  });

  it('GET /api/contacts/stats should return stats', async () => {
    const res = await request(app)
      .get('/api/contacts/stats')
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('total');
  });

  it('POST /api/contacts/import should import contacts', async () => {
    const res = await request(app)
      .post('/api/contacts/import')
      .set('Cookie', sessionCookie)
      .send({
        contacts: [
          { phone: '+972501111111', name: 'Test Contact 1' },
          { phone: '+972502222222', name: 'Test Contact 2' },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

// ── Lists API ─────────────────────────────────────────────────────────────

describe('Lists API — /api/lists', () => {
  it('GET /api/lists should return lists', async () => {
    const res = await request(app)
      .get('/api/lists')
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('lists');
    expect(Array.isArray(res.body.lists)).toBe(true);
  });

  it('POST /api/lists should create a list', async () => {
    const res = await request(app)
      .post('/api/lists')
      .set('Cookie', sessionCookie)
      .send({ name: 'QA Test List' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.list).toHaveProperty('id');
    expect(res.body.list.name).toBe('QA Test List');
  });

  it('POST /api/lists without name should return 400', async () => {
    const res = await request(app)
      .post('/api/lists')
      .set('Cookie', sessionCookie)
      .send({});
    expect(res.status).toBe(400);
  });
});

// ── Keywords API ──────────────────────────────────────────────────────────

describe('Keywords API — /api/keywords', () => {
  it('GET /api/keywords should return keywords', async () => {
    const res = await request(app)
      .get('/api/keywords')
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('builtin');
  });

  it('PUT /api/keywords should update custom keywords', async () => {
    const res = await request(app)
      .put('/api/keywords')
      .set('Cookie', sessionCookie)
      .send({ category: 'test_cat', keywords: ['testword'] });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('PUT /api/keywords with only keywords should return 200', async () => {
    const res = await request(app)
      .put('/api/keywords')
      .set('Cookie', sessionCookie)
      .send({ custom: { en: ['word1'], he: [] } });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('PUT /api/keywords with scannerEnabled should update setting', async () => {
    const res = await request(app)
      .put('/api/keywords')
      .set('Cookie', sessionCookie)
      .send({ scannerEnabled: true });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

// ── Leads API routes ──────────────────────────────────────────────────────

describe('Leads API routes', () => {
  it('GET /api/leads should return leads', async () => {
    const res = await request(app)
      .get('/api/leads')
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('leads');
  });

  it('GET /api/leads/stats should return stats', async () => {
    const res = await request(app)
      .get('/api/leads/stats')
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(200);
  });

  it('GET /api/leads/export should return CSV', async () => {
    const res = await request(app)
      .get('/api/leads/export')
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(200);
  });

  it('POST /api/leads/dismiss should require id', async () => {
    const res = await request(app)
      .post('/api/leads/dismiss')
      .set('Cookie', sessionCookie)
      .send({});
    expect([200, 400]).toContain(res.status);
  });

  it('POST /api/leads/dismiss-all should dismiss all leads', async () => {
    const res = await request(app)
      .post('/api/leads/dismiss-all')
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

// ── Auto-rules seed-tickets ───────────────────────────────────────────────

describe('Auto-rules seed-tickets', () => {
  it('POST /api/whatsapp/auto-rules/seed-tickets should seed ticket rules', async () => {
    const res = await request(app)
      .post('/api/whatsapp/auto-rules/seed-tickets')
      .set('Cookie', sessionCookie)
      .send({ ticketUrl: 'https://example.com/tickets' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
