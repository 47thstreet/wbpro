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

describe('Persona Templates API — GET /api/persona-templates', () => {
  it('should require auth', async () => {
    const res = await request(app).get('/api/persona-templates');
    expect(res.status).toBe(401);
  });

  it('should return all 6 persona templates', async () => {
    const res = await request(app)
      .get('/api/persona-templates')
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(6);
    const personas = res.body.map(t => t.persona);
    expect(personas).toContain('alex-rivera');
    expect(personas).toContain('mia-noir');
    expect(personas).toContain('bassline');
    expect(personas).toContain('n3ctvr');
    expect(personas).toContain('psychedelica');
    expect(personas).toContain('synth-ai');
  });

  it('each template should have displayName, role, tone, and variants', async () => {
    const res = await request(app)
      .get('/api/persona-templates')
      .set('Cookie', sessionCookie);
    for (const tpl of res.body) {
      expect(tpl).toHaveProperty('displayName');
      expect(tpl).toHaveProperty('role');
      expect(tpl).toHaveProperty('tone');
      expect(tpl).toHaveProperty('variants');
    }
  });
});

describe('Persona Templates API — GET /api/persona-templates/:persona', () => {
  it('should return alex-rivera template', async () => {
    const res = await request(app)
      .get('/api/persona-templates/alex-rivera')
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(200);
    expect(res.body.persona).toBe('alex-rivera');
    expect(res.body.displayName).toBe('Alex Rivera');
    expect(res.body.variants).toBeDefined();
    expect(res.body.variants.greeting).toBeDefined();
    expect(res.body.variants.event_announce).toBeDefined();
    expect(res.body.variants.reminder_24h).toBeDefined();
    expect(res.body.variants.day_of).toBeDefined();
    expect(res.body.variants.thank_you).toBeDefined();
  });

  it('should return 404 for unknown persona template', async () => {
    const res = await request(app)
      .get('/api/persona-templates/unknown-persona')
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('not found');
  });
});

describe('Persona Templates API — GET /api/persona-templates/:persona/:variant', () => {
  it('should return specific variant', async () => {
    const res = await request(app)
      .get('/api/persona-templates/bassline/greeting')
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('bassline-greeting');
    expect(res.body.message).toBeDefined();
    expect(res.body.message).toContain('{name}');
  });

  it('should return 404 for unknown persona', async () => {
    const res = await request(app)
      .get('/api/persona-templates/unknown/greeting')
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(404);
  });

  it('should return 404 for unknown variant', async () => {
    const res = await request(app)
      .get('/api/persona-templates/alex-rivera/nonexistent')
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('Variant');
  });
});

describe('Persona Templates API — POST /api/persona-templates/:persona/render', () => {
  it('should render template with variables', async () => {
    const res = await request(app)
      .post('/api/persona-templates/alex-rivera/render')
      .set('Cookie', sessionCookie)
      .send({
        variant: 'greeting',
        variables: { name: 'John' },
      });
    expect(res.status).toBe(200);
    expect(res.body.persona).toBe('alex-rivera');
    expect(res.body.variant).toBe('greeting');
    expect(res.body.rendered).toBeDefined();
    expect(res.body.rendered).toContain('John');
    expect(res.body.rendered).not.toContain('{name}');
  });

  it('should return 400 without variant', async () => {
    const res = await request(app)
      .post('/api/persona-templates/alex-rivera/render')
      .set('Cookie', sessionCookie)
      .send({ variables: { name: 'Test' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('variant');
  });

  it('should return 404 for unknown persona', async () => {
    const res = await request(app)
      .post('/api/persona-templates/unknown/render')
      .set('Cookie', sessionCookie)
      .send({ variant: 'greeting', variables: { name: 'Test' } });
    expect(res.status).toBe(404);
  });

  it('should return 404 for unknown variant', async () => {
    const res = await request(app)
      .post('/api/persona-templates/alex-rivera/render')
      .set('Cookie', sessionCookie)
      .send({ variant: 'nonexistent', variables: { name: 'Test' } });
    expect(res.status).toBe(404);
  });

  it('should render event_announce with all variables', async () => {
    const res = await request(app)
      .post('/api/persona-templates/mia-noir/render')
      .set('Cookie', sessionCookie)
      .send({
        variant: 'event_announce',
        variables: {
          name: 'Sarah',
          eventName: 'Neon Nights',
          date: '2026-04-15',
          venue: 'Club Matrix',
          ticketUrl: 'https://example.com/tickets',
        },
      });
    expect(res.status).toBe(200);
    expect(res.body.rendered).toContain('Sarah');
    expect(res.body.rendered).toContain('Neon Nights');
    expect(res.body.rendered).toContain('Club Matrix');
  });
});
