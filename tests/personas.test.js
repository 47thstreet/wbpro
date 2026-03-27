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

describe('Personas API', () => {
  describe('GET /api/personas', () => {
    it('should require auth', async () => {
      const res = await request(app).get('/api/personas');
      expect(res.status).toBe(401);
    });

    it('should return default personas', async () => {
      const res = await request(app)
        .get('/api/personas')
        .set('Cookie', sessionCookie);
      expect(res.status).toBe(200);
      expect(res.body.personas).toBeDefined();
      expect(Array.isArray(res.body.personas)).toBe(true);
      expect(res.body.personas.length).toBeGreaterThanOrEqual(5);
      const ids = res.body.personas.map(p => p.id);
      expect(ids).toContain('alex');
      expect(ids).toContain('mia');
      expect(ids).toContain('dj-vibe');
      expect(ids).toContain('noa');
      expect(ids).toContain('marco');
    });

    it('should include contactCount and templates list', async () => {
      const res = await request(app)
        .get('/api/personas')
        .set('Cookie', sessionCookie);
      const alex = res.body.personas.find(p => p.id === 'alex');
      expect(alex).toBeDefined();
      expect(alex.contactCount).toBeDefined();
      expect(typeof alex.contactCount).toBe('number');
      expect(alex.templates).toBeDefined();
      expect(Array.isArray(alex.templates)).toBe(true);
      expect(alex.templates).toContain('eventAnnouncement');
    });
  });

  describe('GET /api/personas/:id', () => {
    it('should return persona details', async () => {
      const res = await request(app)
        .get('/api/personas/alex')
        .set('Cookie', sessionCookie);
      expect(res.status).toBe(200);
      expect(res.body.persona.id).toBe('alex');
      expect(res.body.persona.name).toBe('Alex');
      expect(res.body.persona.role).toBe('Nightlife Host');
      expect(res.body.persona.tone).toBe('hype');
      expect(res.body.persona.templates).toBeDefined();
      expect(res.body.persona.templates.eventAnnouncement).toBeDefined();
    });

    it('should return 404 for unknown persona', async () => {
      const res = await request(app)
        .get('/api/personas/unknown-persona')
        .set('Cookie', sessionCookie);
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/personas/:id/contacts', () => {
    // Use unique phones per test run to avoid contamination from persisted JSON
    const uniquePhone1 = '+972' + Date.now().toString().slice(-7) + '1';
    const uniquePhone2 = '+972' + Date.now().toString().slice(-7) + '2';

    it('should add contacts to a persona', async () => {
      const res = await request(app)
        .post('/api/personas/alex/contacts')
        .set('Cookie', sessionCookie)
        .send({ phones: [uniquePhone1, uniquePhone2] });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.added).toBe(2);
      expect(res.body.total).toBeGreaterThanOrEqual(2);
    });

    it('should not add duplicate contacts', async () => {
      const res = await request(app)
        .post('/api/personas/alex/contacts')
        .set('Cookie', sessionCookie)
        .send({ phones: [uniquePhone1] });
      expect(res.status).toBe(200);
      expect(res.body.added).toBe(0);
    });

    it('should return 400 without phones array', async () => {
      const res = await request(app)
        .post('/api/personas/alex/contacts')
        .set('Cookie', sessionCookie)
        .send({ phone: '+972501111111' });
      expect(res.status).toBe(400);
    });

    it('should return 404 for unknown persona', async () => {
      const res = await request(app)
        .post('/api/personas/fake/contacts')
        .set('Cookie', sessionCookie)
        .send({ phones: ['+972501234567'] });
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/personas/:id/contacts', () => {
    it('should list contacts for a persona', async () => {
      const res = await request(app)
        .get('/api/personas/alex/contacts')
        .set('Cookie', sessionCookie);
      expect(res.status).toBe(200);
      expect(res.body.contacts).toBeDefined();
      expect(Array.isArray(res.body.contacts)).toBe(true);
      expect(res.body.contacts.length).toBeGreaterThanOrEqual(2);
      expect(res.body.contacts[0]).toHaveProperty('phone');
      expect(res.body.contacts[0]).toHaveProperty('score');
    });

    it('should return empty contacts for persona with none', async () => {
      const res = await request(app)
        .get('/api/personas/mia/contacts')
        .set('Cookie', sessionCookie);
      expect(res.status).toBe(200);
      expect(res.body.contacts).toEqual([]);
    });

    it('should return 404 for unknown persona', async () => {
      const res = await request(app)
        .get('/api/personas/fake/contacts')
        .set('Cookie', sessionCookie);
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/personas/:id/contacts', () => {
    it('should remove a contact from persona', async () => {
      // First get current count
      const before = await request(app)
        .get('/api/personas/alex/contacts')
        .set('Cookie', sessionCookie);
      const countBefore = before.body.contacts.length;

      // Add a known phone then remove it
      const testPhone = '+972500000001';
      await request(app)
        .post('/api/personas/alex/contacts')
        .set('Cookie', sessionCookie)
        .send({ phones: [testPhone] });

      const res = await request(app)
        .delete('/api/personas/alex/contacts')
        .set('Cookie', sessionCookie)
        .send({ phone: testPhone });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.total).toBe(countBefore);
    });

    it('should return 400 without phone', async () => {
      const res = await request(app)
        .delete('/api/personas/alex/contacts')
        .set('Cookie', sessionCookie)
        .send({});
      expect(res.status).toBe(400);
    });

    it('should return 404 for unknown persona', async () => {
      const res = await request(app)
        .delete('/api/personas/fake/contacts')
        .set('Cookie', sessionCookie)
        .send({ phone: '+972501234567' });
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/personas/:id/broadcast', () => {
    it('should return 404 for unknown persona', async () => {
      const res = await request(app)
        .post('/api/personas/fake/broadcast')
        .set('Cookie', sessionCookie)
        .send({ message: 'Hello!' });
      expect(res.status).toBe(404);
    });

    it('should return 400 without message or templateKey', async () => {
      const res = await request(app)
        .post('/api/personas/alex/broadcast')
        .set('Cookie', sessionCookie)
        .send({});
      expect(res.status).toBe(400);
    });

    it('should return 400 if persona has no contacts', async () => {
      const res = await request(app)
        .post('/api/personas/mia/broadcast')
        .set('Cookie', sessionCookie)
        .send({ message: 'Hello!' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('no contacts');
    });

    it('should accept broadcast with custom message', async () => {
      // alex still has 1 contact from the add/remove tests
      const res = await request(app)
        .post('/api/personas/alex/broadcast')
        .set('Cookie', sessionCookie)
        .send({ message: 'Hey {name}! Check this out!' });
      // 503 expected since no real WhatsApp account connected in test
      expect([200, 503]).toContain(res.status);
    });

    it('should accept broadcast with templateKey', async () => {
      const res = await request(app)
        .post('/api/personas/alex/broadcast')
        .set('Cookie', sessionCookie)
        .send({
          templateKey: 'eventAnnouncement',
          eventData: { name: 'Test Party', date: '2026-04-01', venue: 'Club X' },
        });
      expect([200, 503]).toContain(res.status);
    });
  });

  describe('PUT /api/personas/:id/templates', () => {
    it('should update persona templates', async () => {
      const res = await request(app)
        .put('/api/personas/mia/templates')
        .set('Cookie', sessionCookie)
        .send({ templates: { customGreeting: 'Hello {name}, welcome!' } });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.templates.customGreeting).toBe('Hello {name}, welcome!');
      // Existing templates should still be present
      expect(res.body.templates.eventAnnouncement).toBeDefined();
    });

    it('should return 400 without templates object', async () => {
      const res = await request(app)
        .put('/api/personas/mia/templates')
        .set('Cookie', sessionCookie)
        .send({});
      expect(res.status).toBe(400);
    });

    it('should return 404 for unknown persona', async () => {
      const res = await request(app)
        .put('/api/personas/fake/templates')
        .set('Cookie', sessionCookie)
        .send({ templates: { test: 'hi' } });
      expect(res.status).toBe(404);
    });
  });
});
