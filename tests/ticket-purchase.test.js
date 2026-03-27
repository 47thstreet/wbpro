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

const FLOWS_FILE = path.join(process.cwd(), 'flows.json');

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

describe('Ticket Purchase Flow', () => {

  // ─── Flow Template & Seeding ──────────────────────────────────────────

  describe('POST /api/whatsapp/tickets/seed-flow', () => {
    beforeEach(() => {
      // Reset flows to remove any ticket flow
      const flows = JSON.parse(fs.readFileSync(FLOWS_FILE, 'utf8') || '[]');
      const filtered = flows.filter(f => f.name !== 'Ticket Purchase');
      fs.writeFileSync(FLOWS_FILE, JSON.stringify(filtered));
    });

    it('should seed the ticket purchase flow', async () => {
      const res = await authed(request(app).post('/api/whatsapp/tickets/seed-flow'));
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.seeded).toBe(true);
      expect(res.body.flow).toBeDefined();
      expect(res.body.flow.name).toBe('Ticket Purchase');
      expect(res.body.flow.triggers.length).toBeGreaterThanOrEqual(3);
      // Verify it has ticket_purchase node
      const ticketNode = res.body.flow.nodes.find(n => n.type === 'ticket_purchase');
      expect(ticketNode).toBeDefined();
    });

    it('should not duplicate when seeded twice', async () => {
      await authed(request(app).post('/api/whatsapp/tickets/seed-flow'));
      const res = await authed(request(app).post('/api/whatsapp/tickets/seed-flow'));
      expect(res.status).toBe(200);
      expect(res.body.seeded).toBe(false);
      expect(res.body.message).toContain('already exists');
    });
  });

  // ─── Flow Validation ──────────────────────────────────────────────────

  describe('Flow validation for ticket_purchase type', () => {
    it('should accept ticket_purchase node type in flow creation', async () => {
      const res = await authed(request(app).post('/api/whatsapp/flows')).send({
        name: 'Test Ticket Flow',
        triggers: [{ type: 'exact', value: 'test-ticket' }],
        startNode: 'start',
        nodes: [
          {
            id: 'start',
            type: 'ticket_purchase',
            message: 'Looking up tickets...',
            ticketConfig: { maxResults: 3 },
          },
        ],
      });
      expect(res.status).toBe(200);
      expect(res.body.flow.nodes[0].type).toBe('ticket_purchase');
    });

    it('should still reject invalid node types', async () => {
      const res = await authed(request(app).post('/api/whatsapp/flows')).send({
        name: 'Bad Flow',
        triggers: [{ type: 'exact', value: 'bad-type' }],
        startNode: 'start',
        nodes: [
          { id: 'start', type: 'invalid_type', message: 'nope' },
        ],
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('invalid type');
    });
  });

  // ─── Ticket Lookup ────────────────────────────────────────────────────

  describe('GET /api/whatsapp/tickets/lookup', () => {
    it('should return events list', async () => {
      const res = await authed(request(app).get('/api/whatsapp/tickets/lookup'));
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('events');
      expect(res.body).toHaveProperty('count');
      expect(Array.isArray(res.body.events)).toBe(true);
    });

    it('should filter by query parameter', async () => {
      const res = await authed(request(app).get('/api/whatsapp/tickets/lookup?q=test'));
      expect(res.status).toBe(200);
      expect(res.body.query).toBe('test');
    });

    it('should respect limit parameter', async () => {
      const res = await authed(request(app).get('/api/whatsapp/tickets/lookup?limit=2'));
      expect(res.status).toBe(200);
      expect(res.body.events.length).toBeLessThanOrEqual(2);
    });

    it('should include ticketUrl in each event', async () => {
      const res = await authed(request(app).get('/api/whatsapp/tickets/lookup'));
      if (res.body.events.length > 0) {
        expect(res.body.events[0]).toHaveProperty('ticketUrl');
        expect(res.body.events[0].ticketUrl).toBeTruthy();
      }
    });
  });

  // ─── Ticket Simulate ──────────────────────────────────────────────────

  describe('POST /api/whatsapp/tickets/simulate', () => {
    it('should require message', async () => {
      const res = await authed(request(app).post('/api/whatsapp/tickets/simulate')).send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('message');
    });

    it('should handle ticket query message', async () => {
      const res = await authed(request(app).post('/api/whatsapp/tickets/simulate')).send({
        message: 'buy tickets',
      });
      expect(res.status).toBe(200);
      expect(res.body.type).toBe('lookup');
      expect(res.body).toHaveProperty('reply');
      expect(res.body).toHaveProperty('events');
    });

    it('should handle specific event query', async () => {
      const res = await authed(request(app).post('/api/whatsapp/tickets/simulate')).send({
        message: 'tickets for friday party',
      });
      expect(res.status).toBe(200);
      expect(res.body.type).toBe('lookup');
      expect(res.body.reply).toBeTruthy();
    });

    it('should handle event selection with sessionEvents', async () => {
      const mockEvents = [
        { name: 'Friday Night Bash', date: '2026-04-03', time: '22:00', venue: 'Club XYZ', price: 'R150', ticketUrl: 'https://kartis.test/event/friday' },
        { name: 'Saturday Vibes', date: '2026-04-04', time: '21:00', venue: 'Beach Bar', price: 'R200', ticketUrl: 'https://kartis.test/event/saturday' },
      ];

      const res = await authed(request(app).post('/api/whatsapp/tickets/simulate')).send({
        message: '1',
        sessionEvents: mockEvents,
      });
      expect(res.status).toBe(200);
      expect(res.body.type).toBe('selection');
      expect(res.body.event.name).toBe('Friday Night Bash');
      expect(res.body.ticketUrl).toBe('https://kartis.test/event/friday');
      expect(res.body.reply).toContain('Buy now');
    });

    it('should handle second event selection', async () => {
      const mockEvents = [
        { name: 'Event A', date: '2026-04-03', ticketUrl: 'https://kartis.test/a' },
        { name: 'Event B', date: '2026-04-04', ticketUrl: 'https://kartis.test/b' },
      ];

      const res = await authed(request(app).post('/api/whatsapp/tickets/simulate')).send({
        message: '2',
        sessionEvents: mockEvents,
      });
      expect(res.status).toBe(200);
      expect(res.body.type).toBe('selection');
      expect(res.body.event.name).toBe('Event B');
    });

    it('should fall through to lookup if selection number is invalid', async () => {
      const mockEvents = [
        { name: 'Event A', date: '2026-04-03', ticketUrl: 'https://kartis.test/a' },
      ];

      const res = await authed(request(app).post('/api/whatsapp/tickets/simulate')).send({
        message: '5',
        sessionEvents: mockEvents,
      });
      expect(res.status).toBe(200);
      expect(res.body.type).toBe('lookup');
    });

    it('should handle Hebrew ticket query', async () => {
      const res = await authed(request(app).post('/api/whatsapp/tickets/simulate')).send({
        message: 'לקנות כרטיסים',
      });
      expect(res.status).toBe(200);
      expect(res.body.type).toBe('lookup');
    });
  });

  // ─── Flow Status ──────────────────────────────────────────────────────

  describe('GET /api/whatsapp/tickets/flow-status', () => {
    it('should report flow status when not seeded', async () => {
      // Remove ticket flow first
      const flows = JSON.parse(fs.readFileSync(FLOWS_FILE, 'utf8') || '[]');
      const filtered = flows.filter(f => f.name !== 'Ticket Purchase');
      fs.writeFileSync(FLOWS_FILE, JSON.stringify(filtered));

      const res = await authed(request(app).get('/api/whatsapp/tickets/flow-status'));
      expect(res.status).toBe(200);
      expect(res.body.exists).toBe(false);
      expect(res.body.enabled).toBe(false);
    });

    it('should report flow status when seeded', async () => {
      await authed(request(app).post('/api/whatsapp/tickets/seed-flow'));
      const res = await authed(request(app).get('/api/whatsapp/tickets/flow-status'));
      expect(res.status).toBe(200);
      expect(res.body.exists).toBe(true);
      expect(res.body.enabled).toBe(true);
      expect(res.body.flowId).toBeTruthy();
      expect(res.body.triggers.length).toBeGreaterThanOrEqual(3);
    });
  });

  // ─── Alias Routes ─────────────────────────────────────────────────────

  describe('Alias routes', () => {
    it('POST /api/tickets/seed-flow should work', async () => {
      const res = await authed(request(app).post('/api/tickets/seed-flow'));
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it('GET /api/tickets/lookup should work', async () => {
      const res = await authed(request(app).get('/api/tickets/lookup'));
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('events');
    });

    it('POST /api/tickets/simulate should work', async () => {
      const res = await authed(request(app).post('/api/tickets/simulate')).send({
        message: 'buy tickets',
      });
      expect(res.status).toBe(200);
    });

    it('GET /api/tickets/flow-status should work', async () => {
      const res = await authed(request(app).get('/api/tickets/flow-status'));
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('exists');
    });
  });
});
