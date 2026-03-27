import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';

import './setup.js';

// Mock whatsapp-web.js before requiring server
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
  // Login to get session cookie
  const loginRes = await request(app)
    .post('/api/login')
    .send({ password: 'test-password-123' });
  const setCookie = loginRes.headers['set-cookie'];
  if (setCookie) {
    sessionCookie = setCookie[0].split(';')[0];
  }
});

describe('Health Endpoints', () => {
  it('GET /health should return status without auth', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status');
    expect(res.body.status).toBe('ok');
  });

  it('GET /health should include whatsapp status', async () => {
    const res = await request(app).get('/health');
    expect(res.body).toHaveProperty('whatsapp');
  });

  it('GET /health should include webhook_registered field', async () => {
    const res = await request(app).get('/health');
    expect(res.body).toHaveProperty('webhook_registered');
  });
});

describe('Login / Auth', () => {
  it('POST /api/login with correct password should succeed', async () => {
    const res = await request(app)
      .post('/api/login')
      .send({ password: 'test-password-123' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.headers['set-cookie']).toBeDefined();
  });

  it('POST /api/login with wrong password should return 401', async () => {
    const res = await request(app)
      .post('/api/login')
      .send({ password: 'wrong-password' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Wrong password');
  });

  it('POST /api/login with no body should return 401', async () => {
    const res = await request(app)
      .post('/api/login')
      .send({});
    expect(res.status).toBe(401);
  });

  it('POST /api/logout should clear cookie and redirect', async () => {
    const res = await request(app)
      .post('/api/logout');
    expect(res.status).toBe(302);
    const setCookie = res.headers['set-cookie'];
    expect(setCookie).toBeDefined();
    expect(setCookie[0]).toContain('Max-Age=0');
  });

  it('API routes without auth should return 401', async () => {
    const res = await request(app)
      .get('/api/whatsapp/templates');
    expect(res.status).toBe(401);
  });

  it('API routes with valid session should succeed', async () => {
    const res = await request(app)
      .get('/api/whatsapp/templates')
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(200);
  });
});
