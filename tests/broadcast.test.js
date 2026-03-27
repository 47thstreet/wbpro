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

describe('Broadcast API', () => {
  it('POST /api/whatsapp/broadcast without auth should return 401', async () => {
    const res = await request(app)
      .post('/api/whatsapp/broadcast')
      .send({ chatIds: ['g1'], message: 'test' });
    expect(res.status).toBe(401);
  });

  it('POST /api/whatsapp/broadcast without chatIds should return 400', async () => {
    const res = await request(app)
      .post('/api/whatsapp/broadcast')
      .set('Cookie', sessionCookie)
      .send({ message: 'Hello everyone!' });
    // Account not found or bad request
    expect([400, 404]).toContain(res.status);
  });

  it('POST /api/whatsapp/broadcast without message should return 400 or 404', async () => {
    const res = await request(app)
      .post('/api/whatsapp/broadcast')
      .set('Cookie', sessionCookie)
      .send({ chatIds: ['123@g.us'] });
    // Either 400 (no message) or 404 (account not found)
    expect([400, 404]).toContain(res.status);
  });

  it('POST /api/whatsapp/broadcast with too many chatIds should return 400 or 404', async () => {
    const chatIds = Array(51).fill('group@g.us');
    const res = await request(app)
      .post('/api/whatsapp/broadcast')
      .set('Cookie', sessionCookie)
      .send({ chatIds, message: 'test' });
    expect([400, 404]).toContain(res.status);
  });

  it('POST /api/whatsapp/broadcast with non-existent account should return 404', async () => {
    const res = await request(app)
      .post('/api/whatsapp/broadcast')
      .set('Cookie', sessionCookie)
      .send({ account: 'nonexistent', chatIds: ['g1'], message: 'test' });
    expect(res.status).toBe(404);
  });
});

describe('Broadcast History API', () => {
  it('GET /api/whatsapp/history should return history array', async () => {
    const res = await request(app)
      .get('/api/whatsapp/history')
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(200);
    expect(res.body.history).toBeDefined();
    expect(Array.isArray(res.body.history)).toBe(true);
  });

  it('GET /api/whatsapp/history with limit should respect it', async () => {
    const res = await request(app)
      .get('/api/whatsapp/history?limit=5')
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(200);
    expect(res.body.history.length).toBeLessThanOrEqual(5);
  });

  it('GET /api/whatsapp/history/:id with bad id should return 404', async () => {
    const res = await request(app)
      .get('/api/whatsapp/history/nonexistent')
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(404);
  });
});

describe('Broadcast Lists API', () => {
  it('POST /api/whatsapp/broadcast-lists should create a list', async () => {
    const res = await request(app)
      .post('/api/whatsapp/broadcast-lists')
      .set('Cookie', sessionCookie)
      .send({ name: 'Test List', description: 'A test broadcast list' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.list).toHaveProperty('id');
    expect(res.body.list.name).toBe('Test List');
  });

  it('GET /api/whatsapp/broadcast-lists should list all lists', async () => {
    const res = await request(app)
      .get('/api/whatsapp/broadcast-lists')
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(200);
    expect(res.body.lists).toBeDefined();
    expect(Array.isArray(res.body.lists)).toBe(true);
  });
});
