import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import path from 'path';

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

// Clean auto-rules file before each test
beforeEach(() => {
  const rulesFile = path.join('.', 'auto-rules.json');
  if (fs.existsSync(rulesFile)) {
    fs.writeFileSync(rulesFile, '[]');
  }
});

describe('Auto-Response Rules API', () => {
  it('POST /api/whatsapp/auto-rules should create a rule', async () => {
    const res = await request(app)
      .post('/api/whatsapp/auto-rules')
      .set('Cookie', sessionCookie)
      .send({
        keywords: ['ticket', 'tickets', 'buy'],
        response: 'Get your tickets at example.com',
        enabled: true,
      });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.rule).toHaveProperty('id');
    expect(res.body.rule.keywords).toEqual(['ticket', 'tickets', 'buy']);
    expect(res.body.rule.enabled).toBe(true);
  });

  it('POST /api/whatsapp/auto-rules without keywords should return 400', async () => {
    const res = await request(app)
      .post('/api/whatsapp/auto-rules')
      .set('Cookie', sessionCookie)
      .send({ response: 'Some response' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('keywords');
  });

  it('POST /api/whatsapp/auto-rules without response should return 400', async () => {
    const res = await request(app)
      .post('/api/whatsapp/auto-rules')
      .set('Cookie', sessionCookie)
      .send({ keywords: ['test'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('response');
  });

  it('GET /api/whatsapp/auto-rules should list rules', async () => {
    // Create a rule first
    await request(app)
      .post('/api/whatsapp/auto-rules')
      .set('Cookie', sessionCookie)
      .send({ keywords: ['hello'], response: 'Hi there!' });

    const res = await request(app)
      .get('/api/whatsapp/auto-rules')
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(200);
    expect(res.body.rules).toBeDefined();
    expect(Array.isArray(res.body.rules)).toBe(true);
  });

  it('PUT /api/whatsapp/auto-rules/:id should update a rule', async () => {
    const createRes = await request(app)
      .post('/api/whatsapp/auto-rules')
      .set('Cookie', sessionCookie)
      .send({ keywords: ['old'], response: 'Old response' });

    const ruleId = createRes.body.rule.id;

    const updateRes = await request(app)
      .put(`/api/whatsapp/auto-rules/${ruleId}`)
      .set('Cookie', sessionCookie)
      .send({ keywords: ['new'], response: 'New response', enabled: false });

    expect(updateRes.status).toBe(200);
    expect(updateRes.body.rule.keywords).toEqual(['new']);
    expect(updateRes.body.rule.response).toBe('New response');
    expect(updateRes.body.rule.enabled).toBe(false);
  });

  it('PUT /api/whatsapp/auto-rules/:id with bad id should return 404', async () => {
    const res = await request(app)
      .put('/api/whatsapp/auto-rules/nonexistent-id')
      .set('Cookie', sessionCookie)
      .send({ keywords: ['x'], response: 'x' });
    expect(res.status).toBe(404);
  });

  it('DELETE /api/whatsapp/auto-rules/:id should delete a rule', async () => {
    const createRes = await request(app)
      .post('/api/whatsapp/auto-rules')
      .set('Cookie', sessionCookie)
      .send({ keywords: ['delete-me'], response: 'temp' });

    const ruleId = createRes.body.rule.id;

    const deleteRes = await request(app)
      .delete(`/api/whatsapp/auto-rules/${ruleId}`)
      .set('Cookie', sessionCookie);
    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.ok).toBe(true);
  });

  it('DELETE /api/whatsapp/auto-rules/:id with bad id should return 404', async () => {
    const res = await request(app)
      .delete('/api/whatsapp/auto-rules/nonexistent-id')
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(404);
  });
});
