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

describe('Templates API', () => {
  it('POST /api/whatsapp/templates should create a template', async () => {
    const res = await request(app)
      .post('/api/whatsapp/templates')
      .set('Cookie', sessionCookie)
      .send({ id: 'test-tpl-1', name: 'Test Template', message: 'Hello {name}!' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.template.id).toBe('test-tpl-1');
  });

  it('POST /api/whatsapp/templates without id should return 400', async () => {
    const res = await request(app)
      .post('/api/whatsapp/templates')
      .set('Cookie', sessionCookie)
      .send({ message: 'test' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('id');
  });

  it('POST /api/whatsapp/templates without message should return 400', async () => {
    const res = await request(app)
      .post('/api/whatsapp/templates')
      .set('Cookie', sessionCookie)
      .send({ id: 'bad-tpl' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('message');
  });

  it('POST /api/whatsapp/templates should update existing template', async () => {
    await request(app)
      .post('/api/whatsapp/templates')
      .set('Cookie', sessionCookie)
      .send({ id: 'update-tpl', name: 'Original', message: 'Original message' });

    const res = await request(app)
      .post('/api/whatsapp/templates')
      .set('Cookie', sessionCookie)
      .send({ id: 'update-tpl', name: 'Updated', message: 'Updated message' });

    expect(res.status).toBe(200);
    expect(res.body.template.message).toBe('Updated message');
  });

  it('GET /api/whatsapp/templates should list templates', async () => {
    const res = await request(app)
      .get('/api/whatsapp/templates')
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(200);
    expect(res.body.templates).toBeDefined();
    expect(Array.isArray(res.body.templates)).toBe(true);
  });

  it('DELETE /api/whatsapp/templates/:id should delete template', async () => {
    await request(app)
      .post('/api/whatsapp/templates')
      .set('Cookie', sessionCookie)
      .send({ id: 'delete-tpl', message: 'To be deleted' });

    const res = await request(app)
      .delete('/api/whatsapp/templates/delete-tpl')
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('DELETE /api/whatsapp/templates/:id with bad id should return 404', async () => {
    const res = await request(app)
      .delete('/api/whatsapp/templates/nonexistent')
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(404);
  });
});
