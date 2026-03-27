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

describe('Analytics API — GET /api/analytics', () => {
  it('should return 401 without auth', async () => {
    const res = await request(app).get('/api/analytics');
    expect(res.status).toBe(401);
  });

  it('should return analytics with all required fields', async () => {
    const res = await request(app)
      .get('/api/analytics')
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(200);

    // Overview
    expect(res.body.overview).toBeDefined();
    expect(res.body.overview).toHaveProperty('totalBroadcasts');
    expect(res.body.overview).toHaveProperty('totalMessagesSent');
    expect(res.body.overview).toHaveProperty('totalMessagesFailed');
    expect(res.body.overview).toHaveProperty('deliveryRate');
    expect(res.body.overview).toHaveProperty('totalContacts');
    expect(res.body.overview).toHaveProperty('totalGroups');
    expect(res.body.overview).toHaveProperty('broadcastLists');
  });

  it('should include today stats', async () => {
    const res = await request(app)
      .get('/api/analytics')
      .set('Cookie', sessionCookie);
    expect(res.body.today).toBeDefined();
    expect(res.body.today).toHaveProperty('broadcasts');
    expect(res.body.today).toHaveProperty('messagesSent');
    expect(res.body.today).toHaveProperty('messagesFailed');
    expect(res.body.today).toHaveProperty('deliveryRate');
    expect(typeof res.body.today.broadcasts).toBe('number');
  });

  it('should include thisWeek stats', async () => {
    const res = await request(app)
      .get('/api/analytics')
      .set('Cookie', sessionCookie);
    expect(res.body.thisWeek).toBeDefined();
    expect(res.body.thisWeek).toHaveProperty('broadcasts');
    expect(res.body.thisWeek).toHaveProperty('messagesSent');
    expect(res.body.thisWeek).toHaveProperty('messagesFailed');
    expect(res.body.thisWeek).toHaveProperty('deliveryRate');
  });

  it('should include period buckets (7d, 30d, 90d)', async () => {
    const res = await request(app)
      .get('/api/analytics')
      .set('Cookie', sessionCookie);
    expect(res.body.periods).toBeDefined();
    expect(res.body.periods).toHaveProperty('7d');
    expect(res.body.periods).toHaveProperty('30d');
    expect(res.body.periods).toHaveProperty('90d');
    for (const key of ['7d', '30d', '90d']) {
      expect(res.body.periods[key]).toHaveProperty('broadcasts');
      expect(res.body.periods[key]).toHaveProperty('messagesSent');
      expect(res.body.periods[key]).toHaveProperty('messagesFailed');
      expect(res.body.periods[key]).toHaveProperty('uniqueGroups');
    }
  });

  it('should include dailyVolume array with 14 entries', async () => {
    const res = await request(app)
      .get('/api/analytics')
      .set('Cookie', sessionCookie);
    expect(Array.isArray(res.body.dailyVolume)).toBe(true);
    expect(res.body.dailyVolume.length).toBe(14);
    for (const day of res.body.dailyVolume) {
      expect(day).toHaveProperty('date');
      expect(day).toHaveProperty('broadcasts');
      expect(day).toHaveProperty('sent');
      expect(day).toHaveProperty('failed');
    }
  });

  it('should include topGroups array', async () => {
    const res = await request(app)
      .get('/api/analytics')
      .set('Cookie', sessionCookie);
    expect(Array.isArray(res.body.topGroups)).toBe(true);
  });

  it('should include topTemplates array', async () => {
    const res = await request(app)
      .get('/api/analytics')
      .set('Cookie', sessionCookie);
    expect(Array.isArray(res.body.topTemplates)).toBe(true);
  });

  it('should include perBroadcast array with delivery rates', async () => {
    const res = await request(app)
      .get('/api/analytics')
      .set('Cookie', sessionCookie);
    expect(Array.isArray(res.body.perBroadcast)).toBe(true);
  });

  it('should include recentBroadcasts array', async () => {
    const res = await request(app)
      .get('/api/analytics')
      .set('Cookie', sessionCookie);
    expect(Array.isArray(res.body.recentBroadcasts)).toBe(true);
  });

  it('delivery rate should be a number between 0 and 100', async () => {
    const res = await request(app)
      .get('/api/analytics')
      .set('Cookie', sessionCookie);
    const rate = res.body.overview.deliveryRate;
    expect(typeof rate).toBe('number');
    expect(rate).toBeGreaterThanOrEqual(0);
    expect(rate).toBeLessThanOrEqual(100);
  });
});

describe('Analytics HTML — GET /analytics', () => {
  it('should serve the analytics page when authenticated', async () => {
    const res = await request(app)
      .get('/analytics')
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
  });
});
