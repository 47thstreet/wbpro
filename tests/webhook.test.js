import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';

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

beforeAll(() => {
  app = require('../server');
});

const WEBHOOK_SECRET = 'test-webhook-secret';

function signPayload(payload) {
  const raw = JSON.stringify(payload);
  return crypto.createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');
}

describe('Kartis Webhook Receiver', () => {
  it('POST /api/webhooks/kartis without signature should return 401', async () => {
    const res = await request(app)
      .post('/api/webhooks/kartis')
      .send({ type: 'event.published', data: {} });
    expect(res.status).toBe(401);
    expect(res.body.error).toContain('Missing or invalid signature');
  });

  it('POST /api/webhooks/kartis with invalid HMAC should return 401', async () => {
    const payload = { type: 'event.published', data: { event: { name: 'Test' } } };
    const res = await request(app)
      .post('/api/webhooks/kartis')
      .set('x-kartis-signature', 'sha256=0000000000000000000000000000000000000000000000000000000000000000')
      .send(payload);
    expect(res.status).toBe(401);
    expect(res.body.error).toContain('Invalid signature');
  });

  it('POST /api/webhooks/kartis with valid HMAC should return 200', async () => {
    const payload = { type: 'event.published', data: { event: { name: 'Test Party' } } };
    const sig = signPayload(payload);
    const res = await request(app)
      .post('/api/webhooks/kartis')
      .set('x-kartis-signature', `sha256=${sig}`)
      .send(payload);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.received).toBe('event.published');
  });

  it('POST /api/webhooks/kartis with legacy x-webhook-secret should work', async () => {
    const payload = { type: 'event.published', data: { event: { name: 'Legacy Event' } } };
    const res = await request(app)
      .post('/api/webhooks/kartis')
      .set('x-webhook-secret', WEBHOOK_SECRET)
      .send(payload);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('POST /api/webhooks/kartis with wrong legacy secret should return 401', async () => {
    const payload = { type: 'event.published', data: {} };
    const res = await request(app)
      .post('/api/webhooks/kartis')
      .set('x-webhook-secret', 'wrong-secret')
      .send(payload);
    expect(res.status).toBe(401);
  });

  it('should accept legacy payload format', async () => {
    const payload = { event: 'event.published', data: { name: 'Legacy Format Event' } };
    const sig = signPayload(payload);
    const res = await request(app)
      .post('/api/webhooks/kartis')
      .set('x-kartis-signature', `sha256=${sig}`)
      .send(payload);
    expect(res.status).toBe(200);
    expect(res.body.received).toBe('event.published');
  });

  it('should skip auth for webhook routes (no session needed)', async () => {
    // Webhook routes bypass session auth
    const payload = { type: 'test.event', data: {} };
    const sig = signPayload(payload);
    const res = await request(app)
      .post('/api/webhooks/kartis')
      .set('x-kartis-signature', `sha256=${sig}`)
      .send(payload);
    // Should not get 401 from session middleware
    expect(res.status).toBe(200);
  });
});
