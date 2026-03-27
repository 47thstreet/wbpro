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

// ── One-time Scheduled Broadcasts ────────────────────────────────────────

describe('Schedule API — POST /api/schedule', () => {
  it('POST /api/schedule without auth should return 401', async () => {
    const res = await request(app)
      .post('/api/schedule')
      .send({ chatIds: ['g1@g.us'], message: 'test', sendAt: new Date(Date.now() + 60000).toISOString() });
    expect(res.status).toBe(401);
  });

  it('POST /api/schedule without chatIds should return 400 or 404', async () => {
    const res = await request(app)
      .post('/api/schedule')
      .set('Cookie', sessionCookie)
      .send({ message: 'Hello', sendAt: new Date(Date.now() + 60000).toISOString() });
    expect([400, 404]).toContain(res.status);
  });

  it('POST /api/schedule without message should return 400 or 404', async () => {
    const res = await request(app)
      .post('/api/schedule')
      .set('Cookie', sessionCookie)
      .send({ chatIds: ['g1@g.us'], sendAt: new Date(Date.now() + 60000).toISOString() });
    expect([400, 404]).toContain(res.status);
  });

  it('POST /api/schedule without sendAt should return 400 or 404', async () => {
    const res = await request(app)
      .post('/api/schedule')
      .set('Cookie', sessionCookie)
      .send({ chatIds: ['g1@g.us'], message: 'test' });
    expect([400, 404]).toContain(res.status);
  });

  it('POST /api/schedule with past sendAt should return 400 or 404', async () => {
    const res = await request(app)
      .post('/api/schedule')
      .set('Cookie', sessionCookie)
      .send({ chatIds: ['g1@g.us'], message: 'test', sendAt: '2020-01-01T00:00:00Z' });
    expect([400, 404]).toContain(res.status);
  });

  it('POST /api/schedule with invalid sendAt should return 400 or 404', async () => {
    const res = await request(app)
      .post('/api/schedule')
      .set('Cookie', sessionCookie)
      .send({ chatIds: ['g1@g.us'], message: 'test', sendAt: 'not-a-date' });
    expect([400, 404]).toContain(res.status);
  });

  it('POST /api/schedule with non-existent account should return 404', async () => {
    const res = await request(app)
      .post('/api/schedule')
      .set('Cookie', sessionCookie)
      .send({ account: 'nonexistent', chatIds: ['g1@g.us'], message: 'test', sendAt: new Date(Date.now() + 60000).toISOString() });
    expect(res.status).toBe(404);
  });
});

describe('Schedule API — GET /api/schedule', () => {
  it('GET /api/schedule without auth should return 401', async () => {
    const res = await request(app).get('/api/schedule');
    expect(res.status).toBe(401);
  });

  it('GET /api/schedule should return schedules array', async () => {
    const res = await request(app)
      .get('/api/schedule')
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(200);
    expect(res.body.schedules).toBeDefined();
    expect(Array.isArray(res.body.schedules)).toBe(true);
  });
});

describe('Schedule API — DELETE /api/schedule/:id', () => {
  it('DELETE /api/schedule/:id without auth should return 401', async () => {
    const res = await request(app).delete('/api/schedule/fake-id');
    expect(res.status).toBe(401);
  });

  it('DELETE /api/schedule/:id with non-existent id should return 404', async () => {
    const res = await request(app)
      .delete('/api/schedule/nonexistent-schedule-id')
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(404);
  });
});

// ── Plural alias routes (existing) ──────────────────────────────────────

describe('Schedule API — plural aliases /api/schedules', () => {
  it('GET /api/schedules should return schedules', async () => {
    const res = await request(app)
      .get('/api/schedules')
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(200);
    expect(res.body.schedules).toBeDefined();
  });

  it('POST /api/schedules without account should return 404', async () => {
    const res = await request(app)
      .post('/api/schedules')
      .set('Cookie', sessionCookie)
      .send({ account: 'nonexistent', chatIds: ['g1@g.us'], message: 'test', sendAt: new Date(Date.now() + 60000).toISOString() });
    expect(res.status).toBe(404);
  });

  it('DELETE /api/schedules/:id with bad id should return 404', async () => {
    const res = await request(app)
      .delete('/api/schedules/nonexistent')
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(404);
  });
});

// ── Recurring Schedules ──────────────────────────────────────────────────

describe('Recurring Schedule API', () => {
  it('GET /api/whatsapp/recurring without auth should return 401', async () => {
    const res = await request(app).get('/api/whatsapp/recurring');
    expect(res.status).toBe(401);
  });

  it('GET /api/whatsapp/recurring should return schedules and presets', async () => {
    const res = await request(app)
      .get('/api/whatsapp/recurring')
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.schedules).toBeDefined();
    expect(res.body.presets).toBeDefined();
  });

  it('GET /api/recurring alias should return 200', async () => {
    const res = await request(app)
      .get('/api/recurring')
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(200);
  });

  it('POST /api/whatsapp/recurring without cron should return 400 or 404', async () => {
    const res = await request(app)
      .post('/api/whatsapp/recurring')
      .set('Cookie', sessionCookie)
      .send({ chatIds: ['g1@g.us'], message: 'test' });
    expect([400, 404]).toContain(res.status);
  });

  it('POST /api/whatsapp/recurring with invalid cron should return 400 or 404', async () => {
    const res = await request(app)
      .post('/api/whatsapp/recurring')
      .set('Cookie', sessionCookie)
      .send({ chatIds: ['g1@g.us'], message: 'test', cron: 'bad' });
    expect([400, 404]).toContain(res.status);
  });

  it('POST /api/whatsapp/recurring without chatIds should return 400 or 404', async () => {
    const res = await request(app)
      .post('/api/whatsapp/recurring')
      .set('Cookie', sessionCookie)
      .send({ message: 'test', cron: '0 9 * * *' });
    expect([400, 404]).toContain(res.status);
  });

  it('POST /api/whatsapp/recurring without message should return 400 or 404', async () => {
    const res = await request(app)
      .post('/api/whatsapp/recurring')
      .set('Cookie', sessionCookie)
      .send({ chatIds: ['g1@g.us'], cron: '0 9 * * *' });
    expect([400, 404]).toContain(res.status);
  });

  it('POST /api/whatsapp/recurring with non-existent account should return 404', async () => {
    const res = await request(app)
      .post('/api/whatsapp/recurring')
      .set('Cookie', sessionCookie)
      .send({ account: 'nonexistent', chatIds: ['g1@g.us'], message: 'test', cron: '0 9 * * *' });
    expect(res.status).toBe(404);
  });

  it('DELETE /api/whatsapp/recurring/:id with bad id should return 404', async () => {
    const res = await request(app)
      .delete('/api/whatsapp/recurring/nonexistent')
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(404);
  });

  it('PUT /api/whatsapp/recurring/:id with bad id should return 404', async () => {
    const res = await request(app)
      .put('/api/whatsapp/recurring/nonexistent')
      .set('Cookie', sessionCookie)
      .send({ name: 'Updated' });
    expect(res.status).toBe(404);
  });

  it('POST /api/whatsapp/recurring/:id/trigger with bad id should return 404', async () => {
    const res = await request(app)
      .post('/api/whatsapp/recurring/nonexistent/trigger')
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(404);
  });
});

// ── Persona Template Scheduling ──────────────────────────────────────────

describe('Persona Template Scheduling', () => {
  it('POST /api/whatsapp/schedule with personaId and non-existent persona template should return 404', async () => {
    const res = await request(app)
      .post('/api/whatsapp/schedule')
      .set('Cookie', sessionCookie)
      .send({
        chatIds: ['g1@g.us'],
        personaId: 'nonexistent-persona',
        variant: 'eventAnnouncement',
        sendAt: new Date(Date.now() + 60000).toISOString(),
      });
    expect([404]).toContain(res.status);
  });

  it('POST /api/whatsapp/recurring with personaId and non-existent persona template should return 404', async () => {
    const res = await request(app)
      .post('/api/whatsapp/recurring')
      .set('Cookie', sessionCookie)
      .send({
        chatIds: ['g1@g.us'],
        personaId: 'nonexistent-persona',
        variant: 'eventAnnouncement',
        cron: '0 9 * * *',
      });
    expect([404]).toContain(res.status);
  });
});
