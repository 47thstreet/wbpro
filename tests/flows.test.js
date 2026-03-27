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

// Clean flows file before each test
beforeEach(() => {
  const flowsFile = path.join('.', 'flows.json');
  if (fs.existsSync(flowsFile)) {
    fs.writeFileSync(flowsFile, '[]');
  }
});

const sampleFlow = {
  name: 'Welcome Bot',
  triggers: [
    { type: 'contains', value: 'hello' },
    { type: 'exact', value: 'menu' },
  ],
  nodes: [
    {
      id: 'start',
      message: 'Hi {name}! Welcome.\n1. Events\n2. Tickets',
      options: [
        { label: 'Events', next: 'events' },
        { label: 'Tickets', next: 'tickets' },
      ],
      errorMessage: 'Please reply 1 or 2',
    },
    { id: 'events', message: 'Check our events page!', terminal: true },
    { id: 'tickets', message: 'Get tickets at our site!', terminal: true },
  ],
  startNode: 'start',
  scope: 'dm',
};

describe('Flows CRUD API', () => {
  it('POST /api/whatsapp/flows without auth should return 401', async () => {
    const res = await request(app)
      .post('/api/whatsapp/flows')
      .send(sampleFlow);
    expect(res.status).toBe(401);
  });

  it('POST /api/whatsapp/flows should create a flow', async () => {
    const res = await request(app)
      .post('/api/whatsapp/flows')
      .set('Cookie', sessionCookie)
      .send(sampleFlow);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.flow).toHaveProperty('id');
    expect(res.body.flow.name).toBe('Welcome Bot');
    expect(res.body.flow.nodes.length).toBe(3);
    expect(res.body.flow.triggers.length).toBe(2);
    expect(res.body.flow.enabled).toBe(true);
    expect(res.body.flow.scope).toBe('dm');
    expect(res.body.flow.startNode).toBe('start');
  });

  it('POST /api/whatsapp/flows without name should return 400', async () => {
    const res = await request(app)
      .post('/api/whatsapp/flows')
      .set('Cookie', sessionCookie)
      .send({ ...sampleFlow, name: '' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('name');
  });

  it('POST /api/whatsapp/flows without nodes should return 400', async () => {
    const res = await request(app)
      .post('/api/whatsapp/flows')
      .set('Cookie', sessionCookie)
      .send({ ...sampleFlow, nodes: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('nodes');
  });

  it('POST /api/whatsapp/flows without triggers should return 400', async () => {
    const res = await request(app)
      .post('/api/whatsapp/flows')
      .set('Cookie', sessionCookie)
      .send({ ...sampleFlow, triggers: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('triggers');
  });

  it('POST /api/whatsapp/flows with invalid trigger type should return 400', async () => {
    const res = await request(app)
      .post('/api/whatsapp/flows')
      .set('Cookie', sessionCookie)
      .send({ ...sampleFlow, triggers: [{ type: 'regex', value: '.*' }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('trigger type');
  });

  it('POST /api/whatsapp/flows with missing startNode should return 400', async () => {
    const res = await request(app)
      .post('/api/whatsapp/flows')
      .set('Cookie', sessionCookie)
      .send({ ...sampleFlow, startNode: 'nonexistent' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('startNode');
  });

  it('POST /api/whatsapp/flows with node missing message should return 400', async () => {
    const res = await request(app)
      .post('/api/whatsapp/flows')
      .set('Cookie', sessionCookie)
      .send({
        ...sampleFlow,
        nodes: [{ id: 'start' }],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('message');
  });

  it('GET /api/whatsapp/flows should list flows', async () => {
    await request(app)
      .post('/api/whatsapp/flows')
      .set('Cookie', sessionCookie)
      .send(sampleFlow);

    const res = await request(app)
      .get('/api/whatsapp/flows')
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(200);
    expect(res.body.flows).toBeDefined();
    expect(Array.isArray(res.body.flows)).toBe(true);
    expect(res.body.flows.length).toBeGreaterThanOrEqual(1);
    expect(res.body.flows[0]).toHaveProperty('activeSessions');
  });

  it('GET /api/whatsapp/flows/:id should return a flow', async () => {
    const createRes = await request(app)
      .post('/api/whatsapp/flows')
      .set('Cookie', sessionCookie)
      .send(sampleFlow);
    const flowId = createRes.body.flow.id;

    const res = await request(app)
      .get(`/api/whatsapp/flows/${flowId}`)
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(200);
    expect(res.body.flow.id).toBe(flowId);
    expect(res.body.flow.name).toBe('Welcome Bot');
  });

  it('GET /api/whatsapp/flows/:id with bad id should return 404', async () => {
    const res = await request(app)
      .get('/api/whatsapp/flows/nonexistent')
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(404);
  });

  it('PUT /api/whatsapp/flows/:id should update a flow', async () => {
    const createRes = await request(app)
      .post('/api/whatsapp/flows')
      .set('Cookie', sessionCookie)
      .send(sampleFlow);
    const flowId = createRes.body.flow.id;

    const res = await request(app)
      .put(`/api/whatsapp/flows/${flowId}`)
      .set('Cookie', sessionCookie)
      .send({ name: 'Updated Bot', enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.flow.name).toBe('Updated Bot');
    expect(res.body.flow.enabled).toBe(false);
  });

  it('PUT /api/whatsapp/flows/:id with bad id should return 404', async () => {
    const res = await request(app)
      .put('/api/whatsapp/flows/nonexistent')
      .set('Cookie', sessionCookie)
      .send({ name: 'x' });
    expect(res.status).toBe(404);
  });

  it('DELETE /api/whatsapp/flows/:id should delete a flow', async () => {
    const createRes = await request(app)
      .post('/api/whatsapp/flows')
      .set('Cookie', sessionCookie)
      .send(sampleFlow);
    const flowId = createRes.body.flow.id;

    const res = await request(app)
      .delete(`/api/whatsapp/flows/${flowId}`)
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('DELETE /api/whatsapp/flows/:id with bad id should return 404', async () => {
    const res = await request(app)
      .delete('/api/whatsapp/flows/nonexistent')
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(404);
  });

  it('POST /api/whatsapp/flows/:id/duplicate should clone a flow', async () => {
    const createRes = await request(app)
      .post('/api/whatsapp/flows')
      .set('Cookie', sessionCookie)
      .send(sampleFlow);
    const flowId = createRes.body.flow.id;

    const res = await request(app)
      .post(`/api/whatsapp/flows/${flowId}/duplicate`)
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(200);
    expect(res.body.flow.name).toBe('Welcome Bot (copy)');
    expect(res.body.flow.enabled).toBe(false);
    expect(res.body.flow.id).not.toBe(flowId);
    expect(res.body.flow.nodes.length).toBe(3);
  });

  it('POST /api/whatsapp/flows/:id/duplicate with bad id should return 404', async () => {
    const res = await request(app)
      .post('/api/whatsapp/flows/nonexistent/duplicate')
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(404);
  });
});

describe('Flows Alias Routes', () => {
  it('GET /api/flows should list flows', async () => {
    const res = await request(app)
      .get('/api/flows')
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(200);
    expect(res.body.flows).toBeDefined();
  });

  it('POST /api/flows should create a flow', async () => {
    const res = await request(app)
      .post('/api/flows')
      .set('Cookie', sessionCookie)
      .send(sampleFlow);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('Flow Sessions API', () => {
  it('GET /api/whatsapp/flow-sessions should return sessions', async () => {
    const res = await request(app)
      .get('/api/whatsapp/flow-sessions')
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(200);
    expect(res.body.sessions).toBeDefined();
    expect(Array.isArray(res.body.sessions)).toBe(true);
    expect(typeof res.body.count).toBe('number');
  });

  it('DELETE /api/whatsapp/flow-sessions/:id with bad id should return 404', async () => {
    const res = await request(app)
      .delete('/api/whatsapp/flow-sessions/nonexistent')
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(404);
  });
});

describe('Flows HTML Page', () => {
  it('GET /flows should serve HTML when authenticated', async () => {
    const res = await request(app)
      .get('/flows')
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
  });
});
