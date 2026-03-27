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

// ── CSV Import via String Body ──────────────────────────────────────────────

describe('Contact Import — /api/whatsapp/contacts/import', () => {
  it('POST should import contacts from CSV string', async () => {
    const res = await request(app)
      .post('/api/whatsapp/contacts/import')
      .set('Cookie', sessionCookie)
      .send({ csv: 'phone,name\n+15551234567,Alice\n+15559876543,Bob' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('imported');
    expect(res.body.imported).toBeGreaterThanOrEqual(2);
  });

  it('POST should reject missing csv field', async () => {
    const res = await request(app)
      .post('/api/whatsapp/contacts/import')
      .set('Cookie', sessionCookie)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/csv/i);
  });

  it('POST should skip invalid phone numbers', async () => {
    const res = await request(app)
      .post('/api/whatsapp/contacts/import')
      .set('Cookie', sessionCookie)
      .send({ csv: 'phone,name\nabc,BadNum\n+15551112222,Valid' });
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);
    expect(res.body.skipped + res.body.errors.length).toBeGreaterThanOrEqual(1);
  });

  it('POST should handle source tag', async () => {
    const res = await request(app)
      .post('/api/whatsapp/contacts/import')
      .set('Cookie', sessionCookie)
      .send({ csv: 'phone,name\n+15553334444,Tagged', source: 'website' });
    expect(res.status).toBe(200);
    expect(res.body.imported).toBeGreaterThanOrEqual(1);
  });
});

// ── CSV File Upload ──────────────────────────────────────────────────────────

describe('Contact Import — /api/whatsapp/contacts/import-file', () => {
  const validCSV = 'phone,name\n+15551001001,Alice\n+15551001002,Bob\n+15551001003,Charlie';

  it('POST should import contacts from file upload', async () => {
    const res = await request(app)
      .post('/api/whatsapp/contacts/import-file')
      .set('Cookie', sessionCookie)
      .attach('file', Buffer.from(validCSV), 'contacts.csv');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('imported');
    expect(res.body.imported).toBeGreaterThanOrEqual(3);
  });

  it('POST should reject missing file', async () => {
    const res = await request(app)
      .post('/api/whatsapp/contacts/import-file')
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/file/i);
  });

  it('POST should deduplicate contacts', async () => {
    const dupeCSV = 'phone,name\n+15552002001,Dupe1\n+15552002001,Dupe2';
    const res = await request(app)
      .post('/api/whatsapp/contacts/import-file')
      .set('Cookie', sessionCookie)
      .attach('file', Buffer.from(dupeCSV), 'dupes.csv');
    expect(res.status).toBe(200);
    // Both rows import (upsert), but second is an update not new
    expect(res.body.imported).toBe(2);
    expect(res.body.updated).toBeGreaterThanOrEqual(1);
  });

  it('POST should validate phone format and skip bad rows', async () => {
    const badCSV = 'phone,name\n123,Short\n+15553003001,Good';
    const res = await request(app)
      .post('/api/whatsapp/contacts/import-file')
      .set('Cookie', sessionCookie)
      .attach('file', Buffer.from(badCSV), 'bad.csv');
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);
  });

  it('POST should return listsUpdated field', async () => {
    const res = await request(app)
      .post('/api/whatsapp/contacts/import-file')
      .set('Cookie', sessionCookie)
      .attach('file', Buffer.from(validCSV), 'contacts.csv');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('listsUpdated');
  });

  it('POST should create a new broadcast list when createList is specified', async () => {
    const csv = 'phone,name\n+15554004001,ListUser1\n+15554004002,ListUser2';
    const res = await request(app)
      .post('/api/whatsapp/contacts/import-file')
      .set('Cookie', sessionCookie)
      .field('createList', 'CSV Import Test')
      .attach('file', Buffer.from(csv), 'newlist.csv');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('newList');
    expect(res.body.newList.name).toBe('CSV Import Test');
    expect(res.body.newList.contactCount).toBe(2);
  });

  it('POST should handle CSV with tags column', async () => {
    const tagCSV = 'phone,name,tags\n+15555005001,TagUser,vip;club';
    const res = await request(app)
      .post('/api/whatsapp/contacts/import-file')
      .set('Cookie', sessionCookie)
      .attach('file', Buffer.from(tagCSV), 'tags.csv');
    expect(res.status).toBe(200);
    expect(res.body.imported).toBeGreaterThanOrEqual(1);
  });

  it('POST should handle CSV with alternative header names', async () => {
    const altCSV = 'phone_number,full_name\n+15556006001,AltName';
    const res = await request(app)
      .post('/api/whatsapp/contacts/import-file')
      .set('Cookie', sessionCookie)
      .attach('file', Buffer.from(altCSV), 'alt.csv');
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);
  });

  it('POST should reject CSV without phone column', async () => {
    const noPhoneCSV = 'email,name\ntest@test.com,NoPhone';
    const res = await request(app)
      .post('/api/whatsapp/contacts/import-file')
      .set('Cookie', sessionCookie)
      .attach('file', Buffer.from(noPhoneCSV), 'nophone.csv');
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(0);
  });
});

// ── TBP Import Endpoint ─────────────────────────────────────────────────────

describe('Contact Import — /api/contacts/import (TBP)', () => {
  it('POST should import contacts array', async () => {
    const res = await request(app)
      .post('/api/contacts/import')
      .set('Cookie', sessionCookie)
      .send({
        contacts: [
          { phone: '+15557007001', name: 'TBP User 1' },
          { phone: '+15557007002', name: 'TBP User 2' },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.imported).toBe(2);
  });

  it('POST should reject missing contacts array', async () => {
    const res = await request(app)
      .post('/api/contacts/import')
      .set('Cookie', sessionCookie)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/contacts/i);
  });

  it('POST should skip invalid phones', async () => {
    const res = await request(app)
      .post('/api/contacts/import')
      .set('Cookie', sessionCookie)
      .send({
        contacts: [
          { phone: 'bad', name: 'Bad' },
          { phone: '+15558008001', name: 'Good' },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);
    expect(res.body.skipped).toBe(1);
  });
});

// ── Import HTML Page ─────────────────────────────────────────────────────────

describe('Import HTML Page — /import', () => {
  it('GET /import should serve the import page', async () => {
    const res = await request(app)
      .get('/import')
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
  });
});
