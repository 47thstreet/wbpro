import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
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

// Seed a test contact with known profile data
async function seedContact(id, profileOverrides = {}) {
  const profile = {
    messageCount: 0,
    eventsClicked: 0,
    ticketsPurchased: 0,
    dmSent: false,
    responded: false,
    lastActive: new Date().toISOString(),
    ...profileOverrides,
  };

  // Use the contacts import endpoint to create contacts, then boost them
  const res = await request(app)
    .post('/api/contacts/import')
    .set('Cookie', sessionCookie)
    .send({
      contacts: [{ phone: '+' + id, name: 'Test User ' + id }],
      source: 'test-scoring',
    });

  // Boost the contact profile via the score boost endpoint
  if (profileOverrides.eventsClicked || profileOverrides.ticketsPurchased || profileOverrides.messageCount) {
    await request(app)
      .post(`/api/whatsapp/leads/score/${id}/boost`)
      .set('Cookie', sessionCookie)
      .send({
        eventsClicked: profileOverrides.eventsClicked || 0,
        ticketsPurchased: profileOverrides.ticketsPurchased || 0,
        messageCount: profileOverrides.messageCount || 0,
      });
  }

  return id;
}

describe('Lead Scoring API', () => {
  describe('GET /api/whatsapp/leads/score', () => {
    it('should return scored leads list', async () => {
      const res = await request(app)
        .get('/api/whatsapp/leads/score')
        .set('Cookie', sessionCookie);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('leads');
      expect(res.body).toHaveProperty('total');
      expect(res.body).toHaveProperty('limit');
      expect(res.body).toHaveProperty('offset');
      expect(Array.isArray(res.body.leads)).toBe(true);
    });

    it('should return leads sorted by score descending', async () => {
      const res = await request(app)
        .get('/api/whatsapp/leads/score')
        .set('Cookie', sessionCookie);
      expect(res.status).toBe(200);
      const scores = res.body.leads.map(l => l.score);
      for (let i = 1; i < scores.length; i++) {
        expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]);
      }
    });

    it('should support limit and offset query params', async () => {
      const res = await request(app)
        .get('/api/whatsapp/leads/score?limit=5&offset=0')
        .set('Cookie', sessionCookie);
      expect(res.status).toBe(200);
      expect(res.body.limit).toBe(5);
      expect(res.body.offset).toBe(0);
      expect(res.body.leads.length).toBeLessThanOrEqual(5);
    });

    it('should support minScore filter', async () => {
      const res = await request(app)
        .get('/api/whatsapp/leads/score?minScore=50')
        .set('Cookie', sessionCookie);
      expect(res.status).toBe(200);
      for (const lead of res.body.leads) {
        expect(lead.score).toBeGreaterThanOrEqual(50);
      }
    });

    it('should support tier filter', async () => {
      const res = await request(app)
        .get('/api/whatsapp/leads/score?tier=hot')
        .set('Cookie', sessionCookie);
      expect(res.status).toBe(200);
      for (const lead of res.body.leads) {
        expect(lead.tier).toBe('hot');
      }
    });

    it('should include breakdown in each scored lead', async () => {
      const res = await request(app)
        .get('/api/whatsapp/leads/score?limit=5')
        .set('Cookie', sessionCookie);
      expect(res.status).toBe(200);
      for (const lead of res.body.leads) {
        expect(lead).toHaveProperty('score');
        expect(lead).toHaveProperty('tier');
        expect(lead).toHaveProperty('breakdown');
        expect(lead.breakdown).toHaveProperty('messageFrequency');
        expect(lead.breakdown).toHaveProperty('eventAttendance');
        expect(lead.breakdown).toHaveProperty('ticketPurchases');
        expect(lead.breakdown).toHaveProperty('responseRate');
        expect(lead.breakdown).toHaveProperty('decay');
      }
    });

    it('should include profile data in each scored lead', async () => {
      const res = await request(app)
        .get('/api/whatsapp/leads/score?limit=5')
        .set('Cookie', sessionCookie);
      expect(res.status).toBe(200);
      for (const lead of res.body.leads) {
        expect(lead).toHaveProperty('profile');
        expect(lead.profile).toHaveProperty('messageCount');
        expect(lead.profile).toHaveProperty('eventsClicked');
        expect(lead.profile).toHaveProperty('ticketsPurchased');
        expect(lead.profile).toHaveProperty('dmSent');
        expect(lead.profile).toHaveProperty('responded');
      }
    });
  });

  describe('GET /api/whatsapp/leads/score/:id', () => {
    it('should return 404 for nonexistent contact', async () => {
      const res = await request(app)
        .get('/api/whatsapp/leads/score/nonexistent999')
        .set('Cookie', sessionCookie);
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/whatsapp/leads/score/:id/boost', () => {
    it('should return 404 for nonexistent contact', async () => {
      const res = await request(app)
        .post('/api/whatsapp/leads/score/nonexistent999/boost')
        .set('Cookie', sessionCookie)
        .send({ eventsClicked: 1 });
      expect(res.status).toBe(404);
    });

    it('should require at least one boost field', async () => {
      // Seed a contact first
      await seedContact('27820000001');
      const res = await request(app)
        .post('/api/whatsapp/leads/score/27820000001/boost')
        .set('Cookie', sessionCookie)
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Provide at least one');
    });

    it('should boost eventsClicked and recalculate score', async () => {
      await seedContact('27820000002');
      const res = await request(app)
        .post('/api/whatsapp/leads/score/27820000002/boost')
        .set('Cookie', sessionCookie)
        .send({ eventsClicked: 5 });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.score).toBeGreaterThan(0);
      expect(res.body.breakdown.eventAttendance).toBeGreaterThan(0);
    });

    it('should boost ticketsPurchased and recalculate score', async () => {
      await seedContact('27820000003');
      const res = await request(app)
        .post('/api/whatsapp/leads/score/27820000003/boost')
        .set('Cookie', sessionCookie)
        .send({ ticketsPurchased: 3 });
      expect(res.status).toBe(200);
      expect(res.body.score).toBeGreaterThan(0);
      expect(res.body.breakdown.ticketPurchases).toBeGreaterThan(0);
    });

    it('should boost messageCount and recalculate score', async () => {
      await seedContact('27820000004');
      const res = await request(app)
        .post('/api/whatsapp/leads/score/27820000004/boost')
        .set('Cookie', sessionCookie)
        .send({ messageCount: 10 });
      expect(res.status).toBe(200);
      expect(res.body.score).toBeGreaterThan(0);
      expect(res.body.breakdown.messageFrequency).toBeGreaterThan(0);
    });

    it('should produce higher score with more signals', async () => {
      await seedContact('27820000005');
      // First boost: just messages
      const r1 = await request(app)
        .post('/api/whatsapp/leads/score/27820000005/boost')
        .set('Cookie', sessionCookie)
        .send({ messageCount: 5 });
      const scoreAfterMsg = r1.body.score;

      // Second boost: add events
      const r2 = await request(app)
        .post('/api/whatsapp/leads/score/27820000005/boost')
        .set('Cookie', sessionCookie)
        .send({ eventsClicked: 3 });
      const scoreAfterEvents = r2.body.score;

      // Third boost: add tickets
      const r3 = await request(app)
        .post('/api/whatsapp/leads/score/27820000005/boost')
        .set('Cookie', sessionCookie)
        .send({ ticketsPurchased: 2 });
      const scoreAfterTickets = r3.body.score;

      expect(scoreAfterEvents).toBeGreaterThan(scoreAfterMsg);
      expect(scoreAfterTickets).toBeGreaterThan(scoreAfterEvents);
    });
  });

  describe('GET /api/whatsapp/leads/score-summary', () => {
    it('should return summary with tiers and averageScore', async () => {
      const res = await request(app)
        .get('/api/whatsapp/leads/score-summary')
        .set('Cookie', sessionCookie);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('totalContacts');
      expect(res.body).toHaveProperty('averageScore');
      expect(res.body).toHaveProperty('tiers');
      expect(res.body.tiers).toHaveProperty('hot');
      expect(res.body.tiers).toHaveProperty('warm');
      expect(res.body.tiers).toHaveProperty('cool');
      expect(res.body.tiers).toHaveProperty('cold');
      expect(res.body).toHaveProperty('weights');
      expect(res.body).toHaveProperty('thresholds');
    });

    it('should return scoring weights configuration', async () => {
      const res = await request(app)
        .get('/api/whatsapp/leads/score-summary')
        .set('Cookie', sessionCookie);
      expect(res.body.weights).toEqual({
        messageFrequency: 25,
        eventAttendance: 25,
        ticketPurchases: 30,
        responseRate: 20,
      });
    });
  });

  describe('Alias routes', () => {
    it('GET /api/leads/score should work', async () => {
      const res = await request(app)
        .get('/api/leads/score')
        .set('Cookie', sessionCookie);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('leads');
    });

    it('GET /api/leads/score-summary should work', async () => {
      const res = await request(app)
        .get('/api/leads/score-summary')
        .set('Cookie', sessionCookie);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('totalContacts');
    });
  });

  describe('Score tier classification', () => {
    it('should classify high-engagement contacts as hot', async () => {
      await seedContact('27820000010');
      // Give maximum signals
      await request(app)
        .post('/api/whatsapp/leads/score/27820000010/boost')
        .set('Cookie', sessionCookie)
        .send({ messageCount: 25, eventsClicked: 12, ticketsPurchased: 6 });

      const res = await request(app)
        .get('/api/whatsapp/leads/score/27820000010')
        .set('Cookie', sessionCookie);
      expect(res.status).toBe(200);
      expect(res.body.tier).toBe('hot');
      expect(res.body.score).toBeGreaterThanOrEqual(70);
    });

    it('should classify low-engagement contacts as cold', async () => {
      await seedContact('27820000011');
      // No boosts, minimal signals
      const res = await request(app)
        .get('/api/whatsapp/leads/score/27820000011')
        .set('Cookie', sessionCookie);
      expect(res.status).toBe(200);
      expect(res.body.tier).toBe('cold');
      expect(res.body.score).toBeLessThan(15);
    });
  });
});
