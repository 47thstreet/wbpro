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

const GROUP_PROFILES_FILE = path.join(process.cwd(), 'group-profiles.json');

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

function authed(req) {
  return sessionCookie ? req.set('Cookie', sessionCookie) : req;
}

beforeEach(() => {
  // Reset group profiles
  fs.writeFileSync(GROUP_PROFILES_FILE, '[]');
});

describe('Smart Group Management', () => {

  // ─── Group Profiles CRUD ──────────────────────────────────────────────

  describe('POST /api/whatsapp/groups/profiles', () => {
    it('should create a group profile', async () => {
      const res = await authed(request(app).post('/api/whatsapp/groups/profiles')).send({
        groupId: 'g1@g.us',
        name: 'TLV Nightlife',
        city: 'Tel Aviv',
        category: 'nightlife',
        tags: ['clubs', 'events'],
        inviteLink: 'https://chat.whatsapp.com/abc123',
        maxCapacity: 256,
        tier: 'vip',
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.profile.groupId).toBe('g1@g.us');
      expect(res.body.profile.city).toBe('Tel Aviv');
      expect(res.body.profile.tier).toBe('vip');
    });

    it('should require groupId', async () => {
      const res = await authed(request(app).post('/api/whatsapp/groups/profiles')).send({
        name: 'No ID Group',
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('groupId');
    });
  });

  describe('GET /api/whatsapp/groups/profiles', () => {
    it('should list all group profiles with health', async () => {
      // Seed two profiles
      await authed(request(app).post('/api/whatsapp/groups/profiles')).send({
        groupId: 'g1@g.us', name: 'Group A', city: 'Tel Aviv', inviteLink: 'https://link1',
      });
      await authed(request(app).post('/api/whatsapp/groups/profiles')).send({
        groupId: 'g2@g.us', name: 'Group B', city: 'Haifa', inviteLink: 'https://link2',
      });

      const res = await authed(request(app).get('/api/whatsapp/groups/profiles'));
      expect(res.status).toBe(200);
      expect(res.body.profiles).toHaveLength(2);
      expect(res.body.profiles[0]).toHaveProperty('health');
      expect(res.body.profiles[0]).toHaveProperty('healthLevel');
    });
  });

  describe('GET /api/whatsapp/groups/profiles/:groupId', () => {
    it('should return a single profile with health and optimal times', async () => {
      await authed(request(app).post('/api/whatsapp/groups/profiles')).send({
        groupId: 'g1@g.us', name: 'Group A', city: 'Tel Aviv', inviteLink: 'https://link1',
      });

      const res = await authed(request(app).get('/api/whatsapp/groups/profiles/g1@g.us'));
      expect(res.status).toBe(200);
      expect(res.body.profile.groupId).toBe('g1@g.us');
      expect(res.body).toHaveProperty('health');
      expect(res.body).toHaveProperty('optimalTimes');
    });

    it('should 404 for unknown group', async () => {
      const res = await authed(request(app).get('/api/whatsapp/groups/profiles/nonexistent'));
      expect(res.status).toBe(404);
    });
  });

  describe('PUT /api/whatsapp/groups/profiles/:groupId', () => {
    it('should update an existing profile', async () => {
      await authed(request(app).post('/api/whatsapp/groups/profiles')).send({
        groupId: 'g1@g.us', name: 'Original', city: 'Tel Aviv',
      });

      const res = await authed(request(app).put('/api/whatsapp/groups/profiles/g1@g.us')).send({
        city: 'Jerusalem', tier: 'premium',
      });
      expect(res.status).toBe(200);
      expect(res.body.profile.city).toBe('Jerusalem');
      expect(res.body.profile.tier).toBe('premium');
    });
  });

  describe('DELETE /api/whatsapp/groups/profiles/:groupId', () => {
    it('should delete a profile', async () => {
      await authed(request(app).post('/api/whatsapp/groups/profiles')).send({
        groupId: 'g1@g.us', name: 'To Delete',
      });

      const res = await authed(request(app).delete('/api/whatsapp/groups/profiles/g1@g.us'));
      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe('g1@g.us');

      // Verify gone
      const check = await authed(request(app).get('/api/whatsapp/groups/profiles'));
      expect(check.body.profiles).toHaveLength(0);
    });

    it('should 404 for unknown group', async () => {
      const res = await authed(request(app).delete('/api/whatsapp/groups/profiles/nonexistent'));
      expect(res.status).toBe(404);
    });
  });

  // ─── Smart Join ───────────────────────────────────────────────────────

  describe('POST /api/groups/smart-join', () => {
    it('should require contactId', async () => {
      const res = await authed(request(app).post('/api/groups/smart-join')).send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('contactId');
    });

    it('should 404 for unknown contact', async () => {
      const res = await authed(request(app).post('/api/groups/smart-join')).send({
        contactId: 'unknown_contact',
      });
      expect(res.status).toBe(404);
    });

    it('should return recommendations when profiles exist', async () => {
      // Seed a CRM contact via the import endpoint (use unique phone not on blocklist)
      const importRes = await authed(request(app).post('/api/contacts/import')).send({
        contacts: [{ phone: '+972599887766', name: 'Test User TLV' }],
        source: 'smart-join-test',
      });
      expect(importRes.body.imported).toBe(1);

      // Create group profiles
      await authed(request(app).post('/api/whatsapp/groups/profiles')).send({
        groupId: 'g-tlv@g.us',
        name: 'TLV Clubs',
        city: 'Tel Aviv',
        category: 'nightlife',
        tags: ['clubs', 'events'],
        inviteLink: 'https://chat.whatsapp.com/tlv',
        tier: 'general',
      });
      await authed(request(app).post('/api/whatsapp/groups/profiles')).send({
        groupId: 'g-haifa@g.us',
        name: 'Haifa Events',
        city: 'Haifa',
        category: 'events',
        tags: ['festivals'],
        inviteLink: 'https://chat.whatsapp.com/haifa',
        tier: 'general',
      });

      const res = await authed(request(app).post('/api/groups/smart-join')).send({
        contactId: '972599887766',
      });
      expect(res.status).toBe(200);
      expect(res.body.contactId).toBe('972599887766');
      expect(res.body.recommendations).toBeInstanceOf(Array);
      expect(res.body.recommendations.length).toBeGreaterThanOrEqual(1);
    });

    it('should return empty when no profiles have invite links', async () => {
      await authed(request(app).post('/api/contacts/import')).send({
        contacts: [{ phone: '+972502222222', name: 'No Link User' }],
        source: 'no-link-test',
      });
      await authed(request(app).post('/api/whatsapp/groups/profiles')).send({
        groupId: 'g-nolink@g.us', name: 'No Link Group',
      });

      const res = await authed(request(app).post('/api/groups/smart-join')).send({
        contactId: '972502222222',
      });
      expect(res.status).toBe(200);
      expect(res.body.recommendations).toHaveLength(0);
    });
  });

  // ─── Group Health Dashboard ───────────────────────────────────────────

  describe('GET /api/whatsapp/groups/health', () => {
    it('should return health dashboard with summary', async () => {
      // Seed profiles
      await authed(request(app).post('/api/whatsapp/groups/profiles')).send({
        groupId: 'h1@g.us', name: 'Health Group 1', city: 'Tel Aviv', inviteLink: 'https://link1',
      });
      await authed(request(app).post('/api/whatsapp/groups/profiles')).send({
        groupId: 'h2@g.us', name: 'Health Group 2', city: 'Haifa',
      });

      const res = await authed(request(app).get('/api/whatsapp/groups/health'));
      expect(res.status).toBe(200);
      expect(res.body.summary).toBeDefined();
      expect(res.body.summary.total).toBe(2);
      expect(res.body.summary).toHaveProperty('healthy');
      expect(res.body.summary).toHaveProperty('moderate');
      expect(res.body.summary).toHaveProperty('needsAttention');
      expect(res.body.summary).toHaveProperty('avgHealth');
      expect(res.body.groups).toHaveLength(2);
      expect(res.body.groups[0]).toHaveProperty('healthLevel');
      expect(res.body.groups[0]).toHaveProperty('optimalTimes');
    });

    it('should return empty dashboard with zero summary when no profiles', async () => {
      const res = await authed(request(app).get('/api/whatsapp/groups/health'));
      expect(res.status).toBe(200);
      expect(res.body.summary.total).toBe(0);
      expect(res.body.summary.avgHealth).toBe(0);
      expect(res.body.groups).toHaveLength(0);
    });
  });

  // ─── Activity Tracking ────────────────────────────────────────────────

  describe('POST /api/whatsapp/groups/activity', () => {
    it('should track activity and member count', async () => {
      const res = await authed(request(app).post('/api/whatsapp/groups/activity')).send({
        groupId: 'act1@g.us',
        groupName: 'Active Group',
        memberCount: 150,
        messageCount: 10,
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.tracked).toBe(true);
    });

    it('should require groupId', async () => {
      const res = await authed(request(app).post('/api/whatsapp/groups/activity')).send({
        memberCount: 50,
      });
      expect(res.status).toBe(400);
    });

    it('should improve health score with activity', async () => {
      // Create profile
      await authed(request(app).post('/api/whatsapp/groups/profiles')).send({
        groupId: 'act2@g.us', name: 'Boosted Group', city: 'Tel Aviv', inviteLink: 'https://link',
      });

      // Health before activity
      const before = await authed(request(app).get('/api/whatsapp/groups/profiles/act2@g.us'));
      const healthBefore = before.body.health.health;

      // Add activity
      await authed(request(app).post('/api/whatsapp/groups/activity')).send({
        groupId: 'act2@g.us', memberCount: 100, messageCount: 20,
      });

      // Health after activity
      const after = await authed(request(app).get('/api/whatsapp/groups/profiles/act2@g.us'));
      expect(after.body.health.health).toBeGreaterThan(healthBefore);
    });
  });

  // ─── Alias Routes ─────────────────────────────────────────────────────

  describe('Alias routes', () => {
    it('GET /api/groups/profiles should work', async () => {
      const res = await authed(request(app).get('/api/groups/profiles'));
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('profiles');
    });

    it('GET /api/groups/health should work', async () => {
      const res = await authed(request(app).get('/api/groups/health'));
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('summary');
    });

    it('POST /api/groups/profiles should work', async () => {
      const res = await authed(request(app).post('/api/groups/profiles')).send({
        groupId: 'alias-test@g.us', name: 'Alias Test',
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it('POST /api/groups/activity should work', async () => {
      const res = await authed(request(app).post('/api/groups/activity')).send({
        groupId: 'alias-act@g.us', messageCount: 5,
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });
});
