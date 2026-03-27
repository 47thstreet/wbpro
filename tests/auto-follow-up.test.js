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

// Clean sequences file before each test to isolate tests
beforeEach(() => {
  const seqFile = path.join('.', 'follow-up-sequences.json');
  const queueFile = path.join('.', 'follow-up-queue.json');
  // Reset to just the default sequence
  if (fs.existsSync(seqFile)) fs.unlinkSync(seqFile);
  if (fs.existsSync(queueFile)) fs.writeFileSync(queueFile, '[]');
});

const sampleSequence = {
  name: 'Test Follow-Up',
  description: 'A test follow-up sequence',
  trigger: 'manual',
  steps: [
    { id: 'step1', delayHours: 0, message: 'Hey {name}! Welcome to TBP.' },
    { id: 'step2', delayHours: 48, message: 'Hey {name}, check out {nextEvent}!' },
    { id: 'step3', delayHours: 168, message: 'Hey {name}, VIP offer for you!' },
  ],
};

describe('Follow-Up Sequences CRUD', () => {
  it('GET /api/whatsapp/leads/auto-follow-up should return sequences with default seed', async () => {
    const res = await request(app)
      .get('/api/whatsapp/leads/auto-follow-up')
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(200);
    expect(res.body.sequences).toBeDefined();
    expect(Array.isArray(res.body.sequences)).toBe(true);
    // Default sequence should be seeded
    expect(res.body.sequences.length).toBeGreaterThanOrEqual(1);
    const defaultSeq = res.body.sequences.find(s => s.id === 'hot-lead-welcome');
    expect(defaultSeq).toBeDefined();
    expect(defaultSeq.steps.length).toBe(3);
  });

  it('POST /api/whatsapp/leads/auto-follow-up should create a sequence', async () => {
    const res = await request(app)
      .post('/api/whatsapp/leads/auto-follow-up')
      .set('Cookie', sessionCookie)
      .send(sampleSequence);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.sequence).toHaveProperty('id');
    expect(res.body.sequence.name).toBe('Test Follow-Up');
    expect(res.body.sequence.steps.length).toBe(3);
    expect(res.body.sequence.trigger).toBe('manual');
  });

  it('POST /api/whatsapp/leads/auto-follow-up without name should return 400', async () => {
    const res = await request(app)
      .post('/api/whatsapp/leads/auto-follow-up')
      .set('Cookie', sessionCookie)
      .send({ ...sampleSequence, name: '' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('name');
  });

  it('POST /api/whatsapp/leads/auto-follow-up without steps should return 400', async () => {
    const res = await request(app)
      .post('/api/whatsapp/leads/auto-follow-up')
      .set('Cookie', sessionCookie)
      .send({ ...sampleSequence, steps: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('steps');
  });

  it('POST /api/whatsapp/leads/auto-follow-up with step missing message should return 400', async () => {
    const res = await request(app)
      .post('/api/whatsapp/leads/auto-follow-up')
      .set('Cookie', sessionCookie)
      .send({ ...sampleSequence, steps: [{ id: 'bad', delayHours: 0 }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('message');
  });

  it('POST /api/whatsapp/leads/auto-follow-up with step missing delayHours should return 400', async () => {
    const res = await request(app)
      .post('/api/whatsapp/leads/auto-follow-up')
      .set('Cookie', sessionCookie)
      .send({ ...sampleSequence, steps: [{ id: 's1', message: 'hi' }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('delayHours');
  });

  it('GET /api/whatsapp/leads/auto-follow-up/:id should return a sequence', async () => {
    const createRes = await request(app)
      .post('/api/whatsapp/leads/auto-follow-up')
      .set('Cookie', sessionCookie)
      .send(sampleSequence);
    const seqId = createRes.body.sequence.id;

    const res = await request(app)
      .get(`/api/whatsapp/leads/auto-follow-up/${seqId}`)
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(200);
    expect(res.body.sequence.id).toBe(seqId);
    expect(res.body.sequence).toHaveProperty('activeEnrollments');
  });

  it('GET /api/whatsapp/leads/auto-follow-up/:id with bad id should return 404', async () => {
    const res = await request(app)
      .get('/api/whatsapp/leads/auto-follow-up/nonexistent')
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(404);
  });

  it('PUT /api/whatsapp/leads/auto-follow-up/:id should update a sequence', async () => {
    const createRes = await request(app)
      .post('/api/whatsapp/leads/auto-follow-up')
      .set('Cookie', sessionCookie)
      .send(sampleSequence);
    const seqId = createRes.body.sequence.id;

    const res = await request(app)
      .put(`/api/whatsapp/leads/auto-follow-up/${seqId}`)
      .set('Cookie', sessionCookie)
      .send({ name: 'Updated Sequence', enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.sequence.name).toBe('Updated Sequence');
    expect(res.body.sequence.enabled).toBe(false);
  });

  it('PUT /api/whatsapp/leads/auto-follow-up/:id with bad id should return 404', async () => {
    const res = await request(app)
      .put('/api/whatsapp/leads/auto-follow-up/nonexistent')
      .set('Cookie', sessionCookie)
      .send({ name: 'x' });
    expect(res.status).toBe(404);
  });

  it('DELETE /api/whatsapp/leads/auto-follow-up/:id should delete a sequence', async () => {
    const createRes = await request(app)
      .post('/api/whatsapp/leads/auto-follow-up')
      .set('Cookie', sessionCookie)
      .send(sampleSequence);
    const seqId = createRes.body.sequence.id;

    const res = await request(app)
      .delete(`/api/whatsapp/leads/auto-follow-up/${seqId}`)
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('DELETE /api/whatsapp/leads/auto-follow-up/:id with bad id should return 404', async () => {
    const res = await request(app)
      .delete('/api/whatsapp/leads/auto-follow-up/nonexistent')
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(404);
  });
});

describe('Follow-Up Queue Management', () => {
  it('GET /api/whatsapp/leads/auto-follow-up-queue should return queue', async () => {
    const res = await request(app)
      .get('/api/whatsapp/leads/auto-follow-up-queue')
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('queue');
    expect(res.body).toHaveProperty('count');
    expect(Array.isArray(res.body.queue)).toBe(true);
  });

  it('POST /api/whatsapp/leads/auto-follow-up-enroll without contactId should return 400', async () => {
    const res = await request(app)
      .post('/api/whatsapp/leads/auto-follow-up-enroll')
      .set('Cookie', sessionCookie)
      .send({ sequenceId: 'hot-lead-welcome' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('contactId');
  });

  it('POST /api/whatsapp/leads/auto-follow-up-enroll with nonexistent contact should return 404', async () => {
    const res = await request(app)
      .post('/api/whatsapp/leads/auto-follow-up-enroll')
      .set('Cookie', sessionCookie)
      .send({ contactId: 'nonexistent999', sequenceId: 'hot-lead-welcome' });
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('Contact not found');
  });

  it('POST /api/whatsapp/leads/auto-follow-up-enroll should enroll a contact', async () => {
    // Create a test contact first
    await request(app)
      .post('/api/contacts/import')
      .set('Cookie', sessionCookie)
      .send({ contacts: [{ phone: '+27820099001', name: 'Follow-Up Test' }], source: 'test' });

    const res = await request(app)
      .post('/api/whatsapp/leads/auto-follow-up-enroll')
      .set('Cookie', sessionCookie)
      .send({ contactId: '27820099001', sequenceId: 'hot-lead-welcome' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.enrollment).toHaveProperty('contactId', '27820099001');
    expect(res.body.enrollment).toHaveProperty('sequenceId', 'hot-lead-welcome');
    expect(res.body.enrollment).toHaveProperty('stepIndex', 0);
    expect(res.body.enrollment).toHaveProperty('nextSendAt');
  });

  it('POST /api/whatsapp/leads/auto-follow-up-enroll should prevent double enrollment', async () => {
    await request(app)
      .post('/api/contacts/import')
      .set('Cookie', sessionCookie)
      .send({ contacts: [{ phone: '+27820099002', name: 'Double Test' }], source: 'test' });

    await request(app)
      .post('/api/whatsapp/leads/auto-follow-up-enroll')
      .set('Cookie', sessionCookie)
      .send({ contactId: '27820099002', sequenceId: 'hot-lead-welcome' });

    const res = await request(app)
      .post('/api/whatsapp/leads/auto-follow-up-enroll')
      .set('Cookie', sessionCookie)
      .send({ contactId: '27820099002', sequenceId: 'hot-lead-welcome' });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('already enrolled');
  });

  it('POST /api/whatsapp/leads/auto-follow-up-cancel should cancel a follow-up', async () => {
    await request(app)
      .post('/api/contacts/import')
      .set('Cookie', sessionCookie)
      .send({ contacts: [{ phone: '+27820099003', name: 'Cancel Test' }], source: 'test' });

    await request(app)
      .post('/api/whatsapp/leads/auto-follow-up-enroll')
      .set('Cookie', sessionCookie)
      .send({ contactId: '27820099003', sequenceId: 'hot-lead-welcome' });

    const res = await request(app)
      .post('/api/whatsapp/leads/auto-follow-up-cancel')
      .set('Cookie', sessionCookie)
      .send({ contactId: '27820099003' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('POST /api/whatsapp/leads/auto-follow-up-cancel with no active follow-up should return 404', async () => {
    const res = await request(app)
      .post('/api/whatsapp/leads/auto-follow-up-cancel')
      .set('Cookie', sessionCookie)
      .send({ contactId: 'nobody' });
    expect(res.status).toBe(404);
  });

  it('POST /api/whatsapp/leads/auto-follow-up-pause should pause a follow-up', async () => {
    await request(app)
      .post('/api/contacts/import')
      .set('Cookie', sessionCookie)
      .send({ contacts: [{ phone: '+27820099004', name: 'Pause Test' }], source: 'test' });

    await request(app)
      .post('/api/whatsapp/leads/auto-follow-up-enroll')
      .set('Cookie', sessionCookie)
      .send({ contactId: '27820099004', sequenceId: 'hot-lead-welcome' });

    const res = await request(app)
      .post('/api/whatsapp/leads/auto-follow-up-pause')
      .set('Cookie', sessionCookie)
      .send({ contactId: '27820099004', paused: true });
    expect(res.status).toBe(200);
    expect(res.body.paused).toBe(true);

    // Resume
    const res2 = await request(app)
      .post('/api/whatsapp/leads/auto-follow-up-pause')
      .set('Cookie', sessionCookie)
      .send({ contactId: '27820099004', paused: false });
    expect(res2.status).toBe(200);
    expect(res2.body.paused).toBe(false);
  });
});

describe('Follow-Up Status', () => {
  it('GET /api/whatsapp/leads/auto-follow-up-status should return status', async () => {
    const res = await request(app)
      .get('/api/whatsapp/leads/auto-follow-up-status')
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('sequences');
    expect(res.body).toHaveProperty('enabledSequences');
    expect(res.body).toHaveProperty('queueSize');
    expect(res.body).toHaveProperty('active');
    expect(res.body).toHaveProperty('paused');
    expect(res.body).toHaveProperty('hotThreshold', 70);
    expect(res.body).toHaveProperty('checkIntervalMs');
  });
});

describe('Follow-Up Alias Routes', () => {
  it('GET /api/leads/auto-follow-up should work via alias', async () => {
    const res = await request(app)
      .get('/api/leads/auto-follow-up')
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(200);
    expect(res.body.sequences).toBeDefined();
  });

  it('GET /api/leads/auto-follow-up-status should work via alias', async () => {
    const res = await request(app)
      .get('/api/leads/auto-follow-up-status')
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('sequences');
  });

  it('GET /api/leads/auto-follow-up-queue should work via alias', async () => {
    const res = await request(app)
      .get('/api/leads/auto-follow-up-queue')
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('queue');
  });
});

describe('Default Sequence Structure', () => {
  it('default sequence should have correct step structure', async () => {
    const res = await request(app)
      .get('/api/whatsapp/leads/auto-follow-up')
      .set('Cookie', sessionCookie);
    const defaultSeq = res.body.sequences.find(s => s.id === 'hot-lead-welcome');
    expect(defaultSeq).toBeDefined();
    expect(defaultSeq.trigger).toBe('score_threshold');
    expect(defaultSeq.triggerValue).toBe(70);
    expect(defaultSeq.enabled).toBe(true);

    // Verify step delays: Day 1 (0h), Day 3 (72h), Day 7 (168h)
    expect(defaultSeq.steps[0].id).toBe('day1');
    expect(defaultSeq.steps[0].delayHours).toBe(0);
    expect(defaultSeq.steps[0].message).toContain('{name}');

    expect(defaultSeq.steps[1].id).toBe('day3');
    expect(defaultSeq.steps[1].delayHours).toBe(72);
    expect(defaultSeq.steps[1].message).toContain('{nextEvent}');

    expect(defaultSeq.steps[2].id).toBe('day7');
    expect(defaultSeq.steps[2].delayHours).toBe(168);
    expect(defaultSeq.steps[2].message).toContain('VIP');
  });
});
