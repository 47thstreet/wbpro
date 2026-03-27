const express = require('express');
const crypto = require('crypto');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const leads = require('./leads');

const app = express();
const PORT = process.env.PORT || 8080;
const JWT_SECRET = process.env.JWT_SECRET;
const WBPRO_PASSWORD = process.env.WBPRO_PASSWORD;
if (!WBPRO_PASSWORD && require.main === module) {
  console.error('FATAL: WBPRO_PASSWORD environment variable is required. Refusing to start with default password.');
  process.exit(1);
}
const KARTIS_EVENTS_URL = process.env.KARTIS_EVENTS_URL || 'http://localhost:3031/api/cms/public-events';
const KARTIS_URL = process.env.KARTIS_URL || 'http://localhost:3031';
const KARTIS_WEBHOOK_SECRET = process.env.KARTIS_WEBHOOK_SECRET;
const WBPRO_URL = process.env.WBPRO_URL || 'https://wbpro.onrender.com';
const TBP_URL = process.env.TBP_URL || 'https://tbp-website-astro.vercel.app';

// ─── Webhook Registration State ─────────────────────────────────────────
let webhookRegistered = false;

if (!JWT_SECRET) {
  console.warn('WARNING: JWT_SECRET not set — external API auth disabled');
}

// ─── Data Directory ─────────────────────────────────────────────────────
const DATA_DIR = fs.existsSync('/data') ? '/data' : '.';
const AUTH_DIR = path.join(DATA_DIR, 'wwebjs_auth');
console.log('Data dir:', DATA_DIR);
console.log('Auth dir:', AUTH_DIR);

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
ensureDir(AUTH_DIR);

// ─── WhatsApp Session Persistence Check ─────────────────────────────────
const sessionDir = path.join(AUTH_DIR, 'session-default');
if (fs.existsSync(sessionDir)) {
  console.log('WhatsApp session: RESTORED from', sessionDir);
} else {
  console.log('WhatsApp session: FRESH start (no previous session found)');
}

// ─── Session Cookie Auth Helpers ────────────────────────────────────────
const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // 30 days in seconds

function signSession(timestamp) {
  const secret = WBPRO_PASSWORD + (JWT_SECRET || '');
  return crypto.createHmac('sha256', secret).update(String(timestamp)).digest('hex');
}

function createSessionValue() {
  const ts = Date.now();
  return ts + ':' + signSession(ts);
}

function verifySession(value) {
  if (!value || typeof value !== 'string') return false;
  const idx = value.indexOf(':');
  if (idx === -1) return false;
  const ts = value.substring(0, idx);
  const hash = value.substring(idx + 1);
  // Check hash validity
  if (signSession(ts) !== hash) return false;
  // Check expiration (30 days)
  const age = (Date.now() - Number(ts)) / 1000;
  return age < SESSION_MAX_AGE;
}

function parseCookie(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach(part => {
    const [k, ...v] = part.trim().split('=');
    if (k) cookies[k.trim()] = decodeURIComponent(v.join('='));
  });
  return cookies;
}

function setSessionCookie(res, value) {
  const flags = [
    `wbpro_session=${value}`,
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_MAX_AGE}`,
    'Path=/',
    ...(process.env.NODE_ENV === 'production' ? ['Secure'] : []),
  ];
  res.setHeader('Set-Cookie', flags.join('; '));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'wbpro_session=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/');
}

// ─── JSON File Persistence Helpers ──────────────────────────────────────
function loadJSON(filePath, fallback = []) {
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) { console.error(`Failed to load ${filePath}:`, e.message); }
  return fallback;
}

function saveJSON(filePath, data) {
  try { fs.writeFileSync(filePath, JSON.stringify(data, null, 2)); }
  catch (e) { console.error(`Failed to save ${filePath}:`, e.message); }
}

const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const SCHEDULES_FILE = path.join(DATA_DIR, 'schedules.json');
const TEMPLATES_FILE = path.join(DATA_DIR, 'templates.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const GROUP_TAGS_FILE = path.join(DATA_DIR, 'group-tags.json');
const AUTO_RULES_FILE = path.join(DATA_DIR, 'auto-rules.json');
const CONTACTS_FILE = path.join(DATA_DIR, 'contacts.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const GROUP_STATS_FILE = path.join(DATA_DIR, 'group-stats.json');
const CRM_FILE = path.join(DATA_DIR, 'crm.json');
const BLOCKLIST_FILE = path.join(DATA_DIR, 'blocklist.json');
const LISTS_FILE = path.join(DATA_DIR, 'lists.json');
const BROADCAST_LISTS_FILE = path.join(DATA_DIR, 'broadcast-lists.json');
const PERSONAS_FILE = path.join(DATA_DIR, 'personas.json');
const PERSONA_TEMPLATES_DIR = path.join(DATA_DIR, 'templates');
const ANNOUNCED_FILE = path.join(DATA_DIR, 'announced.json');
const RECURRING_FILE = path.join(DATA_DIR, 'recurring-schedules.json');

// ─── Cooldown System ─────────────────────────────────────────────────────
const groupCooldowns = new Map(); // groupId -> timestamp

function getCooldownMinutes() {
  const settings = loadJSON(SETTINGS_FILE, {});
  return settings.cooldownMinutes || parseInt(process.env.COOLDOWN_MINUTES) || 30;
}

function isCooldownActive(groupId) {
  const last = groupCooldowns.get(groupId);
  if (!last) return false;
  const cooldownMs = getCooldownMinutes() * 60 * 1000;
  return (Date.now() - last) < cooldownMs;
}

function setCooldown(groupId) {
  groupCooldowns.set(groupId, Date.now());
}

// ─── Quiet Hours ─────────────────────────────────────────────────────────
function getQuietHours() {
  const settings = loadJSON(SETTINGS_FILE, {});
  return {
    start: settings.quietStart || process.env.QUIET_START || '02:00',
    end: settings.quietEnd || process.env.QUIET_END || '10:00',
  };
}

function isQuietHours() {
  const { start, end } = getQuietHours();
  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  const startMin = sh * 60 + sm;
  const endMin = eh * 60 + em;
  if (startMin < endMin) {
    return currentMinutes >= startMin && currentMinutes < endMin;
  }
  // Wraps midnight (e.g. 02:00 -> 10:00 doesn't wrap, but 22:00 -> 06:00 does)
  return currentMinutes >= startMin || currentMinutes < endMin;
}

// ─── Group Stats ─────────────────────────────────────────────────────────
function updateGroupStats(groupId, groupName, field) {
  const stats = loadJSON(GROUP_STATS_FILE, {});
  if (!stats[groupId]) {
    stats[groupId] = { groupName, queriesDetected: 0, responseSent: 0, lastQueryAt: null, lastResponseAt: null };
  }
  stats[groupId].groupName = groupName || stats[groupId].groupName;
  if (field === 'query') {
    stats[groupId].queriesDetected++;
    stats[groupId].lastQueryAt = new Date().toISOString();
  } else if (field === 'response') {
    stats[groupId].responseSent++;
    stats[groupId].lastResponseAt = new Date().toISOString();
  }
  saveJSON(GROUP_STATS_FILE, stats);
}

// ─── Scanner Feed (ring buffer, last 100) ────────────────────────────────
const scannerFeed = [];
const MAX_FEED = 100;

function addToFeed(entry) {
  scannerFeed.unshift(entry);
  if (scannerFeed.length > MAX_FEED) scannerFeed.length = MAX_FEED;
}

// ─── CRM In-Memory Store ────────────────────────────────────────────────
const crmContacts = new Map(); // phone -> contact object
let crmDirty = false;

function loadCRM() {
  const data = loadJSON(CRM_FILE, []);
  crmContacts.clear();
  for (const c of data) {
    crmContacts.set(c.id, c);
  }
  console.log(`CRM loaded: ${crmContacts.size} contacts`);
}

function saveCRM() {
  if (!crmDirty) return;
  const arr = Array.from(crmContacts.values());
  saveJSON(CRM_FILE, arr);
  crmDirty = false;
}

// Flush CRM to disk every 30 seconds
setInterval(saveCRM, 30000);

function getBlocklist() {
  return loadJSON(BLOCKLIST_FILE, []);
}

function isBlocked(phone) {
  const bl = getBlocklist();
  return bl.some(b => b.phone === phone);
}

function phoneFromJid(jid) {
  // "972501234567@c.us" -> "972501234567"
  return jid.split('@')[0];
}

function formatPhone(id) {
  // Ensure phone starts with +
  const num = id.replace(/[^0-9]/g, '');
  return '+' + num;
}

// ─── Multer Upload (for CSV file import) ─────────────────────────────────
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ─── Phone Number Normalization ──────────────────────────────────────────
function normalizePhone(raw) {
  if (!raw || typeof raw !== 'string') return null;
  // Strip spaces, dashes, parentheses, dots
  let phone = raw.replace(/[\s\-\(\)\.]/g, '').trim();
  if (!phone) return null;
  // If starts with +, keep it; otherwise add default +
  if (!phone.startsWith('+')) {
    // If looks like a full international number (10+ digits), prepend +
    const digits = phone.replace(/[^0-9]/g, '');
    if (digits.length >= 10) {
      phone = '+' + digits;
    } else {
      return null; // too short to be valid
    }
  }
  // Final cleanup: only digits after +
  const cleaned = '+' + phone.slice(1).replace(/[^0-9]/g, '');
  if (cleaned.length < 8) return null; // too short
  return cleaned;
}

// ─── CSV Parsing Helper ─────────────────────────────────────────────────
function parseCSV(csvText) {
  const lines = csvText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim());
  if (lines.length < 2) return { rows: [], errors: ['CSV must have a header row and at least one data row'] };

  // Parse header
  const header = parseCSVLine(lines[0]).map(h => h.trim().toLowerCase());
  const phoneIdx = header.findIndex(h => h === 'phone' || h === 'phone_number' || h === 'phonenumber' || h === 'mobile' || h === 'number');
  const nameIdx = header.findIndex(h => h === 'name' || h === 'full_name' || h === 'fullname' || h === 'contact_name');
  const tagsIdx = header.findIndex(h => h === 'tags' || h === 'tag' || h === 'labels' || h === 'label');

  if (phoneIdx === -1) return { rows: [], errors: ['CSV must have a "phone" column'] };

  const rows = [];
  const errors = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);
    const phone = fields[phoneIdx] ? fields[phoneIdx].trim() : '';
    const name = nameIdx >= 0 && fields[nameIdx] ? fields[nameIdx].trim() : null;
    const tagsRaw = tagsIdx >= 0 && fields[tagsIdx] ? fields[tagsIdx].trim() : '';
    const tags = tagsRaw ? tagsRaw.split(';').map(t => t.trim()).filter(Boolean) : [];

    if (!phone) {
      errors.push(`Row ${i + 1}: empty phone number`);
      continue;
    }

    const normalized = normalizePhone(phone);
    if (!normalized) {
      errors.push(`Row ${i + 1}: invalid phone "${phone}"`);
      continue;
    }

    rows.push({ phone: normalized, name, tags });
  }

  return { rows, errors };
}

function parseCSVLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++; // skip escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        fields.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  fields.push(current);
  return fields;
}

// ─── CSV Contact Import Logic ───────────────────────────────────────────
function importCSVContacts(csvText, source) {
  const { rows, errors } = parseCSV(csvText);
  let imported = 0, newCount = 0, updated = 0, skipped = 0;

  for (const row of rows) {
    const phoneId = row.phone.replace(/[^0-9]/g, '');
    if (!phoneId || phoneId.length < 5) { skipped++; continue; }
    if (isBlocked(row.phone)) { skipped++; continue; }

    const existing = crmContacts.has(phoneId);
    const tags = [...row.tags];
    if (source) tags.push(`import:${source}`);

    upsertCrmContact(phoneId, {
      name: row.name,
      tags,
      source: { type: 'csv_import', importSource: source || 'manual', firstSeen: new Date().toISOString() },
      profile: { lastActive: new Date().toISOString() },
    });

    imported++;
    if (existing) updated++;
    else newCount++;
  }

  saveCRM();
  return { imported, new: newCount, updated, skipped, errors };
}

// ─── Broadcast Lists In-Memory Store ────────────────────────────────────
let broadcastLists = [];
let broadcastListsDirty = false;

function loadBroadcastLists() {
  broadcastLists = loadJSON(BROADCAST_LISTS_FILE, []);
  console.log(`Broadcast lists loaded: ${broadcastLists.length}`);
}

function saveBroadcastLists() {
  if (!broadcastListsDirty) return;
  saveJSON(BROADCAST_LISTS_FILE, broadcastLists);
  broadcastListsDirty = false;
}

// Flush broadcast lists every 30 seconds
setInterval(saveBroadcastLists, 30000);

function getBroadcastList(id) {
  return broadcastLists.find(l => l.id === id) || null;
}

// ─── Personas In-Memory Store ────────────────────────────────────────────

const DEFAULT_PERSONAS = [
  {
    id: 'alex',
    name: 'Alex',
    role: 'Nightlife Host',
    tone: 'hype',
    contacts: [],
    templates: {
      eventAnnouncement: 'Yo {name}! 🔥 *{eventName}* is going OFF this {day}!\n\n📅 {date} | 📍 {venue}\n🎟️ Grab your ticket: {ticketUrl}\n\nDon\'t sleep on this one! 🚀',
      lastChance: 'LAST CALL {name}! ⏰ *{eventName}* is TONIGHT!\n\nThis is your FINAL chance — tickets selling fast!\n🎟️ {ticketUrl}\n\nSee you there! 💯',
      welcome: 'Hey {name}! 👋 Welcome to the crew! I\'m Alex — your go-to for the best nightlife in town. Stay tuned for fire events! 🔥',
    },
    createdAt: new Date().toISOString(),
  },
  {
    id: 'mia',
    name: 'Mia',
    role: 'VIP Concierge',
    tone: 'elegant',
    contacts: [],
    templates: {
      eventAnnouncement: 'Hi {name} ✨ We\'d love to invite you to *{eventName}*\n\n📅 {date} | 📍 {venue}\n🎟️ Reserve your spot: {ticketUrl}\n\nLooking forward to seeing you there 💫',
      lastChance: 'Gentle reminder, {name} — *{eventName}* is tonight ✨\n\nLimited availability remaining.\n🎟️ {ticketUrl}\n\nHope to see you! 🥂',
      welcome: 'Hello {name} ✨ I\'m Mia, your VIP concierge. I\'ll keep you updated on our most exclusive events and experiences. Welcome aboard!',
    },
    createdAt: new Date().toISOString(),
  },
  {
    id: 'dj-vibe',
    name: 'DJ Vibe',
    role: 'Music Curator',
    tone: 'chill',
    contacts: [],
    templates: {
      eventAnnouncement: 'What\'s good {name} 🎵 Check this out — *{eventName}*\n\n📅 {date} | 📍 {venue}\n🎟️ Tickets: {ticketUrl}\n\nThe lineup is insane. Trust me on this one 🎧',
      lastChance: 'Heads up {name} 🎶 *{eventName}* — TONIGHT\n\nLast chance to get in!\n🎟️ {ticketUrl}\n\nThe vibes are gonna be unreal 🎧✨',
      welcome: 'Hey {name} 🎵 DJ Vibe here. I curate the best music events around. Follow along and never miss a beat! 🎧',
    },
    createdAt: new Date().toISOString(),
  },
  {
    id: 'noa',
    name: 'Noa',
    role: 'Events Coordinator',
    tone: 'friendly',
    contacts: [],
    templates: {
      eventAnnouncement: 'Hey {name}! 🎉 Exciting news — *{eventName}* just dropped!\n\n📅 {date} | 📍 {venue}\n🎟️ Get tickets: {ticketUrl}\n\nWould love to see you there! 😊',
      lastChance: 'Hey {name}! Quick heads up — *{eventName}* is happening tonight! 🎉\n\nDon\'t miss out!\n🎟️ {ticketUrl}\n\nSee you soon! 😊',
      welcome: 'Hi {name}! 😊 I\'m Noa, your events coordinator. I\'ll keep you in the loop on all the amazing events coming up. Excited to have you!',
    },
    createdAt: new Date().toISOString(),
  },
  {
    id: 'marco',
    name: 'Marco',
    role: 'Promoter',
    tone: 'bold',
    contacts: [],
    templates: {
      eventAnnouncement: '{name}! 💥 BIG one coming — *{eventName}*\n\n📅 {date} | 📍 {venue}\n🎟️ Lock it in: {ticketUrl}\n\nThis is gonna be MASSIVE. You in? 🙌',
      lastChance: '{name} — TONIGHT IS THE NIGHT! 💥 *{eventName}*\n\nNo excuses. Get your ticket NOW!\n🎟️ {ticketUrl}\n\nLet\'s GO! 🙌🔥',
      welcome: 'Yo {name}! 💥 Marco here — I bring the biggest parties to your city. Stick with me and you\'ll never miss the action! 🙌',
    },
    createdAt: new Date().toISOString(),
  },
];

let personas = [];
let personasDirty = false;

function loadPersonas() {
  personas = loadJSON(PERSONAS_FILE, []);
  if (personas.length === 0) {
    personas = DEFAULT_PERSONAS.map(p => ({ ...p }));
    personasDirty = true;
    savePersonas();
  }
  console.log(`Personas loaded: ${personas.length}`);
}

function savePersonas() {
  if (!personasDirty) return;
  saveJSON(PERSONAS_FILE, personas);
  personasDirty = false;
}

// Flush personas every 30 seconds
setInterval(savePersonas, 30000);

// Load personas immediately (seeds defaults if file is missing)
loadPersonas();

function getPersona(id) {
  return personas.find(p => p.id === id) || null;
}

function formatPersonaTemplate(template, vars) {
  let msg = template;
  for (const [key, value] of Object.entries(vars)) {
    msg = msg.replace(new RegExp(`\\{${key}\\}`, 'g'), value || '');
  }
  return msg;
}

function calculateScore(contact) {
  let score = contact.score || 0;
  // Apply decay: -5 per week of inactivity
  if (contact.profile && contact.profile.lastActive) {
    const lastActive = new Date(contact.profile.lastActive).getTime();
    const weeksSinceActive = Math.floor((Date.now() - lastActive) / (7 * 24 * 60 * 60 * 1000));
    if (weeksSinceActive > 0) {
      score = Math.max(0, score - (weeksSinceActive * 5));
    }
  }
  return Math.min(100, Math.max(0, score));
}

function statusFromScore(score) {
  if (score <= 20) return 'cold';
  if (score <= 40) return 'new';
  if (score <= 60) return 'warm';
  if (score <= 80) return 'hot';
  return 'vip';
}

function getCrmContact(phoneId) {
  const contact = crmContacts.get(phoneId);
  if (!contact) return null;
  // Recalculate score with decay
  contact.score = calculateScore(contact);
  contact.status = contact.blocked ? 'blocked' : statusFromScore(contact.score);
  return contact;
}

function upsertCrmContact(phoneId, updates) {
  const now = new Date().toISOString();
  let contact = crmContacts.get(phoneId);
  if (!contact) {
    contact = {
      id: phoneId,
      phone: formatPhone(phoneId),
      name: null,
      pushName: null,
      profilePic: null,
      source: { type: 'unknown', firstSeen: now },
      tags: [],
      lists: ['all-contacts'],
      profile: {
        language: null,
        interests: [],
        lastActive: now,
        messageCount: 0,
        firstMessage: null,
        lastMessage: null,
        triggeredKeywords: [],
        dmSent: false,
        dmSentAt: null,
        responded: false,
        respondedAt: null,
        eventsClicked: 0,
        ticketsPurchased: 0,
      },
      score: 0,
      status: 'new',
      blocked: false,
      createdAt: now,
      updatedAt: now,
    };
    crmContacts.set(phoneId, contact);
  }
  // Apply updates
  if (updates.name) contact.name = updates.name;
  if (updates.pushName) contact.pushName = updates.pushName;
  if (updates.source && !contact.source.groupId) contact.source = updates.source;
  if (updates.tags) {
    for (const tag of updates.tags) {
      if (!contact.tags.includes(tag)) contact.tags.push(tag);
    }
  }
  if (updates.lists) {
    for (const list of updates.lists) {
      if (!contact.lists.includes(list)) contact.lists.push(list);
    }
  }
  if (updates.profile) {
    Object.assign(contact.profile, updates.profile);
  }
  if (updates.score !== undefined) {
    contact.score = Math.min(100, Math.max(0, updates.score));
  }
  contact.updatedAt = now;
  contact.score = calculateScore(contact);
  contact.status = contact.blocked ? 'blocked' : statusFromScore(contact.score);
  crmDirty = true;
  return contact;
}

// ─── CRM Settings Helpers ───────────────────────────────────────────────

function getCrmSettings() {
  const settings = loadJSON(SETTINGS_FILE, {});
  return {
    autoDmEnabled: settings.autoDmEnabled || false,
    autoDmTemplate: settings.autoDmTemplate || "Hey {name}! 🎉 Saw you're looking for events. Here's what's coming up:\n\n{events}\n\n— The Best Parties",
    autoDmCooldownHours: settings.autoDmCooldownHours || 24,
    scrapeIntervalHours: settings.scrapeIntervalHours || 6,
  };
}

function canSendAutoDm(contact) {
  const settings = getCrmSettings();
  if (!settings.autoDmEnabled) return false;
  if (contact.blocked) return false;
  if (contact.profile.dmSent && contact.profile.dmSentAt) {
    const cooldownMs = settings.autoDmCooldownHours * 60 * 60 * 1000;
    if (Date.now() - new Date(contact.profile.dmSentAt).getTime() < cooldownMs) return false;
  }
  return true;
}

// ─── Group Scraper ──────────────────────────────────────────────────────

async function scrapeGroupParticipants(client, chat) {
  const results = { scraped: 0, new: 0, updated: 0 };
  try {
    const groupId = chat.id._serialized;
    const groupName = chat.name || groupId;
    const listSlug = groupName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    // Ensure list exists for this group
    const lists = loadJSON(LISTS_FILE, []);
    if (!lists.find(l => l.id === listSlug)) {
      lists.push({ id: listSlug, name: groupName, description: `Auto-created from group: ${groupName}`, createdAt: new Date().toISOString() });
      saveJSON(LISTS_FILE, lists);
    }

    // Get participants - chat.participants is populated for groups
    const participants = chat.participants || [];
    for (const p of participants) {
      const phoneId = p.id._serialized ? phoneFromJid(p.id._serialized) : phoneFromJid(p.id.user || p.id._serialized);
      if (!phoneId || phoneId.length < 5) continue;
      if (isBlocked(formatPhone(phoneId))) continue;

      results.scraped++;
      const existing = crmContacts.has(phoneId);

      upsertCrmContact(phoneId, {
        source: {
          type: 'group_scrape',
          groupId,
          groupName,
          firstSeen: new Date().toISOString(),
        },
        tags: [listSlug],
        lists: ['all-contacts', listSlug],
        profile: { lastActive: new Date().toISOString() },
      });

      if (existing) results.updated++;
      else results.new++;
    }
  } catch (err) {
    console.error(`Scrape error for group ${chat.name}:`, err.message);
  }
  return results;
}

async function scrapeAllGroups() {
  console.log('CRM: Starting group scrape across all accounts...');
  const totals = { scraped: 0, new: 0, updated: 0 };

  for (const [accountId, acc] of accounts) {
    if (!acc.ready) continue;
    try {
      const chats = await acc.client.getChats();
      const groups = chats.filter(c => c.isGroup);
      console.log(`[${accountId}] Scraping ${groups.length} groups...`);

      for (const group of groups) {
        const result = await scrapeGroupParticipants(acc.client, group);
        totals.scraped += result.scraped;
        totals.new += result.new;
        totals.updated += result.updated;
      }
    } catch (err) {
      console.error(`[${accountId}] Scrape failed:`, err.message);
    }
  }

  saveCRM(); // Force flush after scrape
  console.log(`CRM: Scrape complete — scraped: ${totals.scraped}, new: ${totals.new}, updated: ${totals.updated}`);
  return totals;
}

// Schedule periodic scraping
let scrapeInterval = null;
function startScrapeSchedule() {
  const hours = getCrmSettings().scrapeIntervalHours;
  if (scrapeInterval) clearInterval(scrapeInterval);
  scrapeInterval = setInterval(() => scrapeAllGroups(), hours * 60 * 60 * 1000);
  console.log(`CRM: Scrape scheduled every ${hours} hours`);
}

// ─── Contact Profiling ──────────────────────────────────────────────────

const INTEREST_KEYWORDS = {
  parties: ['party', 'parties', 'מסיבה', 'מסיבות'],
  tickets: ['ticket', 'tickets', 'כרטיס', 'כרטיסים', 'טיקט'],
  tables: ['table', 'tables', 'שולחן', 'שולחנות'],
  vip: ['vip', 'אוויאיפי'],
  bottles: ['bottle', 'bottles', 'בקבוק', 'בקבוקים'],
  nightlife: ['club', 'nightlife', 'מועדון'],
};

function detectLanguage(text) {
  return /[\u0590-\u05FF]/.test(text) ? 'he' : 'en';
}

function extractInterests(text) {
  const lower = text.toLowerCase();
  const found = [];
  for (const [interest, keywords] of Object.entries(INTEREST_KEYWORDS)) {
    if (keywords.some(kw => lower.includes(kw))) found.push(interest);
  }
  return found;
}

function profileContactFromMessage(phoneId, message, pushName) {
  const contact = getCrmContact(phoneId) || upsertCrmContact(phoneId, {});
  const lang = detectLanguage(message);
  const interests = extractInterests(message);
  const lower = message.toLowerCase();

  let scoreBoost = 0;
  const newKeywords = [];

  // Check for keyword triggers
  for (const kw of PARTY_KEYWORDS) {
    if (lower.includes(kw.toLowerCase()) && !contact.profile.triggeredKeywords.includes(kw)) {
      newKeywords.push(kw);
      scoreBoost += contact.profile.triggeredKeywords.length === 0 ? 10 : 5;
    }
  }

  // Ticket/price interest
  if (/ticket|price|כרטיס|מחיר|כמה עולה|how much/.test(lower)) scoreBoost += 15;
  // Table/VIP interest
  if (/table|vip|שולחן/.test(lower)) scoreBoost += 30;

  const updates = {
    pushName: pushName || contact.pushName,
    profile: {
      language: lang,
      lastActive: new Date().toISOString(),
      messageCount: (contact.profile.messageCount || 0) + 1,
      lastMessage: message.slice(0, 500),
      triggeredKeywords: [...contact.profile.triggeredKeywords, ...newKeywords],
    },
    score: (contact.score || 0) + scoreBoost,
  };

  if (!contact.profile.firstMessage) {
    updates.profile.firstMessage = message.slice(0, 500);
  }

  if (interests.length > 0) {
    updates.profile.interests = [...new Set([...(contact.profile.interests || []), ...interests])];
  }

  return upsertCrmContact(phoneId, updates);
}

// ─── Contact Capture (legacy, still used for DMs) ───────────────────────
function autoTagContact(message) {
  const lower = message.toLowerCase();
  if (/ticket|כרטיס|טיקט/.test(lower)) return 'tickets';
  if (/table|שולחן/.test(lower)) return 'tables';
  if (/vip/.test(lower)) return 'vip';
  return 'general';
}

function captureContact(phoneNumber, name, message) {
  const contacts = loadJSON(CONTACTS_FILE, []);
  const existing = contacts.find(c => c.phone === phoneNumber);
  const tag = autoTagContact(message);
  if (existing) {
    existing.name = name || existing.name;
    existing.lastMessage = message;
    existing.lastMessageAt = new Date().toISOString();
    if (!existing.tags.includes(tag)) existing.tags.push(tag);
  } else {
    contacts.push({
      id: crypto.randomUUID(),
      phone: phoneNumber,
      name: name || null,
      firstMessage: message,
      lastMessage: message,
      tags: [tag],
      capturedAt: new Date().toISOString(),
      lastMessageAt: new Date().toISOString(),
    });
  }
  saveJSON(CONTACTS_FILE, contacts);
}

// ─── Smart Chat Scanner — Intent Detection ───────────────────────────────

const INTENT_PATTERNS_EN = [
  /anyone\s+know\s+what.?s\s+happen/i,
  /where\s+should\s+we\s+go\s+out/i,
  /looking\s+for\s+something\s+fun/i,
  /any\s+(events?|parties?|clubs?)\s*(happening|tonight|this|around)?/i,
  /recommendations?\s+(for\s+)?(tonight|thursday|friday|saturday|this)/i,
  /who.?s\s+going\s+out/i,
  /what.?s\s+(going\s+on|happening)/i,
  /where\s+can\s+i\s+buy\s+ticket/i,
  /any\s+good\s+(clubs?|parties?|events?|places?)/i,
  /want\s+to\s+go\s+out/i,
  /let.?s\s+go\s+out/i,
  /plans?\s+for\s+(tonight|this|the)/i,
  /anything\s+happening/i,
  /what\s+are\s+we\s+doing/i,
  /where\s+to\s+go\s+(tonight|this|out)/i,
  /what\s+to\s+do\s+(tonight|this)/i,
];

const INTENT_PATTERNS_HE = [
  /מישה[וּ]?\s*יוד[עת]\s*מה\s*(יש|קורה)/,
  /איפה\s*יוצאים/,
  /מחפש[ת]?\s*משהו\s*(לעשות|כיף)/,
  /יש\s*(אירועים|מסיבות|משהו)/,
  /המלצות?\s*(ל|על)/,
  /מי\s*יוצא/,
  /מה\s*קורה\s*(ב|ה)?(סופש|סוף\s*שבוע|ערב)/,
  /רוצ[הה]\s*לצאת/,
  /בוא[וי]?\s*נצא/,
  /תוכניות?\s*(ל|ה)?/,
  /יש\s*משהו/,
  /מה\s*עושים/,
  /לאן\s*(הולכים|יוצאים|נלך)/,
  /מה\s*יש\s*(ה)?ערב/,
  /מה\s*יש\s*(ב)?(סופש|סוף\s*שבוע)/,
];

function isPartyIntent(message) {
  const text = message.trim();
  for (const re of INTENT_PATTERNS_EN) {
    if (re.test(text)) return true;
  }
  for (const re of INTENT_PATTERNS_HE) {
    if (re.test(text)) return true;
  }
  return false;
}

// ─── Event Recommender (standalone, no ClawdAgent) ───────────────────────

let cachedEvents = [];
let cacheTimestamp = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 min

async function fetchEvents() {
  if (Date.now() - cacheTimestamp < CACHE_TTL && cachedEvents.length > 0) {
    return cachedEvents;
  }
  try {
    const res = await fetch(KARTIS_EVENTS_URL, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    cachedEvents = Array.isArray(data) ? data : [];
    cacheTimestamp = Date.now();
    console.log(`Fetched ${cachedEvents.length} events from Kartis`);
    return cachedEvents;
  } catch (err) {
    console.error('Failed to fetch events:', err.message);
    return cachedEvents; // stale cache
  }
}

function getUpcoming(events) {
  const now = new Date();
  return events
    .filter(e => { try { return new Date(e.date) >= now; } catch { return false; } })
    .sort((a, b) => new Date(a.date) - new Date(b.date));
}

function isHebrew(text) { return /[\u0590-\u05FF]/.test(text); }

function formatEvent(e, heb) {
  const lines = [];
  try {
    const d = new Date(e.date);
    const dateStr = d.toLocaleDateString(heb ? 'he-IL' : 'en-US', { weekday: 'short', day: 'numeric', month: 'short' });
    lines.push(`*${e.name}*`);
    lines.push(`📅 ${dateStr}${e.time ? ' | ' + e.time : ''}`);
  } catch {
    lines.push(`*${e.name}*`);
  }
  if (e.venue) lines.push(`📍 ${e.venue}${e.location ? ', ' + e.location : ''}`);
  if (e.price) lines.push(`💰 ${e.price}`);
  if (e.ticketUrl) lines.push(`🎟️ ${e.ticketUrl}`);
  return lines.join('\n');
}

const DAY_MAP = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  'ראשון': 0, 'שני': 1, 'שלישי': 2, 'רביעי': 3, 'חמישי': 4, 'שישי': 5, 'שבת': 6,
};

async function getRecommendation(userMessage) {
  const events = await fetchEvents();
  const upcoming = getUpcoming(events);
  const heb = isHebrew(userMessage);
  const lower = userMessage.toLowerCase();

  let matched = [];

  // Today/tonight
  if (lower.includes('tonight') || lower.includes('today') || lower.includes('הערב') || lower.includes('היום')) {
    const today = new Date().toISOString().slice(0, 10);
    matched = upcoming.filter(e => e.date?.startsWith(today));
  }
  // Weekend
  else if (lower.includes('weekend') || lower.includes('סוף שבוע') || lower.includes('סופש')) {
    const now = new Date();
    const day = now.getDay();
    const thu = new Date(now); thu.setDate(now.getDate() + ((4 - day + 7) % 7));
    const sun = new Date(now); sun.setDate(now.getDate() + ((0 - day + 7) % 7) + 7);
    matched = upcoming.filter(e => {
      try { const d = new Date(e.date); return d >= thu && d <= sun; } catch { return false; }
    });
  }
  // Specific day
  else {
    for (const [kw, dayNum] of Object.entries(DAY_MAP)) {
      if (lower.includes(kw)) {
        const now = new Date();
        const ahead = (dayNum - now.getDay() + 7) % 7 || 7;
        const target = new Date(now); target.setDate(now.getDate() + ahead);
        const targetStr = target.toISOString().slice(0, 10);
        matched = upcoming.filter(e => e.date?.startsWith(targetStr));
        break;
      }
    }
  }

  // Keyword search fallback
  if (matched.length === 0) {
    const terms = lower.replace(/[^\w\u0590-\u05FF\s]/g, '').split(/\s+/).filter(w => w.length > 2);
    matched = upcoming.filter(e => {
      const hay = `${e.name} ${e.description || ''} ${e.venue || ''}`.toLowerCase();
      return terms.some(t => hay.includes(t));
    });
  }

  const header = '🎉 *The Best Parties*\n\n';

  if (matched.length > 0) {
    const list = matched.slice(0, 3).map(e => formatEvent(e, heb)).join('\n\n');
    const footer = heb
      ? `\n\n_כל האירועים_ ➡️ ${TBP_URL}/events`
      : `\n\nAll events ➡️ ${TBP_URL}/events`;
    return header + list + footer;
  }

  if (upcoming.length > 0) {
    const intro = heb ? '🔥 הנה מה שבקרוב:\n\n' : "🔥 Here's what's coming up:\n\n";
    const list = upcoming.slice(0, 3).map(e => formatEvent(e, heb)).join('\n\n');
    const footer = heb
      ? `\n\n_כל האירועים_ ➡️ ${TBP_URL}/events`
      : `\n\nAll events ➡️ ${TBP_URL}/events`;
    return header + intro + list + footer;
  }

  return heb
    ? '🎉 *The Best Parties*\n\nאין אירועים קרובים כרגע.\nעקבו ➡️ ' + TBP_URL
    : '🎉 *The Best Parties*\n\nNo upcoming events right now.\nStay tuned ➡️ ' + TBP_URL;
}

async function formatEventsForBroadcast(max = 5) {
  const events = await fetchEvents();
  const upcoming = getUpcoming(events);
  if (upcoming.length === 0) return '🎉 *The Best Parties*\n\nNo upcoming events.';
  const list = upcoming.slice(0, max).map(e => formatEvent(e, true)).join('\n\n');
  return `🎉 *The Best Parties — אירועים קרובים*\n\n${list}\n\n_כל האירועים_ ➡️ ${TBP_URL}/events`;
}

// ─── Default Event Templates ────────────────────────────────────────────

const DEFAULT_EVENT_TEMPLATES = [
  {
    id: 'event-announcement',
    name: 'Event Announcement',
    message: '🎉 *{{eventName}}*\n\n📅 {{date}} | {{time}}\n📍 {{venue}}, {{location}}\n💰 Starting at {{price}}\n\n🎟️ Get tickets: {{ticketUrl}}\n\n_The Best Parties 🐙_',
  },
  {
    id: 'last-chance',
    name: 'Last Chance',
    message: '⚡ *LAST CHANCE* — {{eventName}}\n\nHappening {{date}}! Don\'t miss out.\n\n🎟️ Tickets selling fast: {{ticketUrl}}\n\n_The Best Parties_',
  },
  {
    id: 'recap-hype',
    name: 'Recap Hype',
    message: '🔥 *{{eventName}}* was INSANE!\n\nNext one is coming... Stay tuned 👀\n\nFollow us for updates ➡️ instagram.com/thebestparties.ofc\n\n_The Best Parties_',
  },
];

function seedDefaultTemplates() {
  const templates = loadJSON(TEMPLATES_FILE, []);
  if (templates.length > 0) return; // Don't overwrite existing templates
  console.log('Seeding default event templates...');
  saveJSON(TEMPLATES_FILE, DEFAULT_EVENT_TEMPLATES);
}

// ─── Auto-Announce Scheduler ────────────────────────────────────────────

function formatEventWithTemplate(event, templateMessage) {
  const d = new Date(event.date);
  const dateStr = d.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' });
  const variables = {
    eventName: event.name || 'TBA',
    date: dateStr,
    time: event.time || 'TBA',
    venue: event.venue || 'TBA',
    location: event.location || '',
    price: event.price || 'Free',
    ticketUrl: event.ticketUrl || `${TBP_URL}/events`,
  };
  return applyTemplate(templateMessage, variables);
}

async function checkAutoAnnounce() {
  const settings = loadJSON(SETTINGS_FILE, {});
  if (!settings.autoAnnounceEnabled) return;

  try {
    const events = await fetchEvents();
    const now = new Date();
    const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const announced = loadJSON(ANNOUNCED_FILE, {});

    // Find events in the next 24 hours that haven't been announced
    const upcoming = events.filter(e => {
      try {
        const eventDate = new Date(e.date);
        return eventDate >= now && eventDate <= in24h && !announced[e.id || e.name];
      } catch { return false; }
    });

    if (upcoming.length === 0) return;

    // Get the "Last Chance" template
    const templates = loadJSON(TEMPLATES_FILE, []);
    const lastChanceTpl = templates.find(t => t.id === 'last-chance');
    if (!lastChanceTpl) {
      console.warn('Auto-announce: "last-chance" template not found, skipping');
      return;
    }

    // Get all groups from the first ready account
    let acc = null, accountId = null;
    for (const [id, a] of accounts) {
      if (a.ready) { acc = a; accountId = id; break; }
    }
    if (!acc) { console.warn('Auto-announce: no ready account'); return; }

    const chats = await acc.client.getChats();
    const groupIds = chats.filter(c => c.isGroup).map(c => c.id._serialized);
    if (groupIds.length === 0) return;

    for (const event of upcoming) {
      const message = formatEventWithTemplate(event, lastChanceTpl.message);
      const broadcastId = crypto.randomUUID();
      try {
        await executeBroadcast(accountId, groupIds, message, broadcastId, `Auto: Last Chance — ${event.name}`);
        announced[event.id || event.name] = { announcedAt: new Date().toISOString(), type: 'last-chance' };
        saveJSON(ANNOUNCED_FILE, announced);
        console.log(`Auto-announced: ${event.name}`);
      } catch (err) {
        console.error(`Auto-announce failed for ${event.name}:`, err.message);
      }
    }
  } catch (err) {
    console.error('Auto-announce check failed:', err.message);
  }
}

// Check every hour
let autoAnnounceInterval = null;
function startAutoAnnounceSchedule() {
  if (autoAnnounceInterval) clearInterval(autoAnnounceInterval);
  autoAnnounceInterval = setInterval(checkAutoAnnounce, 60 * 60 * 1000);
  console.log('Auto-announce scheduler started (hourly)');
}

// ─── Party keywords for auto-response (default rule) ─────────────────────

const PARTY_KEYWORDS = [
  // English
  'ticket', 'tickets', 'how much', 'buy ticket', 'where to buy',
  'party', 'event', 'tonight', 'this weekend', 'thursday', 'friday', 'saturday',
  'club', 'nightlife', 'table', 'vip', 'bottle', 'guestlist', 'guest list', 'rsvp',
  'thebestparties', 'kartis', 'tbp',
  // Hebrew
  'כרטיס', 'כרטיסים', 'טיקט', 'טיקטים', 'כמה עולה', 'כמה זה עולה',
  'מסיבה', 'מסיבות', 'אירוע', 'אירועים', 'הערב', 'סוף שבוע', 'סופש',
  'מועדון', 'שולחן', 'בקבוק', 'רשימת אורחים',
  'איפה קונים', 'איפה אפשר', 'קנות כרטיס', 'לקנות כרטיס',
];

// ─── Express Middleware ──────────────────────────────────────────────────

app.use(express.json());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─── Login / Logout API (before session middleware) ─────────────────────

app.post('/api/login', (req, res) => {
  const { password } = req.body || {};
  if (password === WBPRO_PASSWORD) {
    const sessionVal = createSessionValue();
    setSessionCookie(res, sessionVal);
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: 'Wrong password' });
});

app.post('/api/logout', (req, res) => {
  clearSessionCookie(res);
  return res.redirect('/login');
});

// Serve login page (before session check)
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// ─── Session Cookie Middleware ──────────────────────────────────────────

function sessionAuth(req, res, next) {
  // Skip health check, login routes, webhooks, and static assets for login page
  if (req.path === '/health' || req.path === '/login' || req.path === '/api/login' || req.path === '/api/logout') return next();
  if (req.path.startsWith('/api/webhooks/')) return next(); // webhooks have their own auth

  // JWT auth still works for external API access
  if (req.path.startsWith('/api/') && req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    return next(); // will be verified by authMiddleware below
  }

  // Check session cookie
  const cookies = parseCookie(req.headers.cookie || '');
  if (cookies.wbpro_session && verifySession(cookies.wbpro_session)) {
    return next();
  }

  // Not authenticated
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
  return res.redirect('/login');
}

app.use(sessionAuth);

// Serve frontend (after session check)
app.use(express.static(path.join(__dirname, 'public')));

// ─── JWT Auth (for external API access) ─────────────────────────────────

function verifyJWT(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Bad token format');
  const [header, payload, sig] = parts;
  const expected = crypto.createHmac('sha256', secret)
    .update(header + '.' + payload)
    .digest('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  if (sig !== expected) throw new Error('Signature mismatch');
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString());
  if (decoded.exp && decoded.exp < Math.floor(Date.now() / 1000)) throw new Error('Expired');
  return decoded;
}

function authMiddleware(req, res, next) {
  // Skip for health check, login routes, webhooks, and non-API routes (static files, frontend)
  if (req.path === '/health' || req.path === '/login' || req.path === '/api/login' || req.path === '/api/logout') return next();
  if (req.path.startsWith('/api/webhooks/')) return next();
  if (!req.path.startsWith('/api/')) return next();

  // Check for JWT token (external API access)
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      req.user = verifyJWT(authHeader.slice(7), JWT_SECRET);
      return next();
    } catch (e) {
      return res.status(401).json({ error: 'Invalid token', detail: e.message });
    }
  }

  // Session-authenticated web UI user
  const cookies = parseCookie(req.headers.cookie || '');
  if (cookies.wbpro_session && verifySession(cookies.wbpro_session)) {
    req.user = { userId: 'web-ui', role: 'admin' };
    return next();
  }

  return res.status(401).json({ error: 'Authentication required' });
}

app.use(authMiddleware);

// ─── TBP Frontend Route Aliases & New Handlers ─────────────────────────
// The TBP frontend uses short /api/* paths. These aliases forward to the
// existing /api/whatsapp/* routes so both path styles work side by side.

// --- Status / QR / Groups / Broadcast (simple aliases) ---
app.get('/api/status', (req, res, next) => { req.url = '/api/whatsapp/status' + (req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : ''); next(); });
app.get('/api/qr', (req, res, next) => { req.url = '/api/whatsapp/qr' + (req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : ''); next(); });
app.get('/api/groups', (req, res, next) => { req.url = '/api/whatsapp/groups' + (req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : ''); next(); });
app.post('/api/broadcast', (req, res, next) => { req.url = '/api/whatsapp/broadcast'; next(); });
app.post('/api/auto-announce', (req, res, next) => { req.url = '/api/whatsapp/auto-announce'; next(); });

// --- Accounts DELETE with ?id= query param (TBP style) ---
app.delete('/api/accounts', (req, res, next) => {
  const id = req.query.id;
  if (id) { req.url = '/api/accounts/' + encodeURIComponent(id); next(); }
  else { res.status(400).json({ error: 'id query param required' }); }
});

// --- Leads aliases ---
app.get('/api/leads', (req, res, next) => { req.url = '/api/whatsapp/leads' + (req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : ''); next(); });
app.get('/api/leads/stats', (req, res, next) => { req.url = '/api/whatsapp/leads/stats'; next(); });
app.get('/api/leads/export', (req, res, next) => { req.url = '/api/whatsapp/leads/export' + (req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : ''); next(); });

// --- Schedules aliases ---
app.get('/api/schedules', (req, res, next) => { req.url = '/api/whatsapp/schedules'; next(); });
app.post('/api/schedules', (req, res, next) => { req.url = '/api/whatsapp/schedule'; next(); });
app.delete('/api/schedules/:id', (req, res, next) => { req.url = '/api/whatsapp/schedules/' + req.params.id; next(); });

// --- Templates aliases ---
app.get('/api/templates', (req, res, next) => { req.url = '/api/whatsapp/templates'; next(); });
app.post('/api/templates', (req, res, next) => { req.url = '/api/whatsapp/templates'; next(); });
app.delete('/api/templates/:id', (req, res, next) => { req.url = '/api/whatsapp/templates/' + req.params.id; next(); });

// --- History aliases ---
app.get('/api/history', (req, res, next) => { req.url = '/api/whatsapp/history'; next(); });

// --- Auto-Rules aliases ---
app.get('/api/auto-rules', (req, res, next) => { req.url = '/api/whatsapp/auto-rules'; next(); });
app.post('/api/auto-rules', (req, res, next) => { req.url = '/api/whatsapp/auto-rules'; next(); });
app.put('/api/auto-rules/:id', (req, res, next) => { req.url = '/api/whatsapp/auto-rules/' + req.params.id; next(); });
app.delete('/api/auto-rules/:id', (req, res, next) => { req.url = '/api/whatsapp/auto-rules/' + req.params.id; next(); });

// --- Settings aliases ---
app.get('/api/settings', (req, res, next) => { req.url = '/api/whatsapp/settings'; next(); });
app.put('/api/settings', (req, res, next) => { req.url = '/api/whatsapp/settings'; next(); });

// --- Blocklist aliases ---
app.get('/api/blocklist', (req, res, next) => { req.url = '/api/whatsapp/blocklist'; next(); });
app.post('/api/blocklist', (req, res, next) => { req.url = '/api/whatsapp/blocklist'; next(); });
app.delete('/api/blocklist/:phone', (req, res, next) => { req.url = '/api/whatsapp/blocklist/' + encodeURIComponent(req.params.phone); next(); });

// --- Cooldowns aliases ---
app.get('/api/cooldowns', (req, res, next) => { req.url = '/api/whatsapp/cooldowns'; next(); });
app.post('/api/cooldowns/reset', (req, res, next) => { req.url = '/api/whatsapp/cooldowns/reset'; next(); });

// --- Scanner aliases ---
app.get('/api/scanner/feed', (req, res, next) => { req.url = '/api/whatsapp/scanner/feed'; next(); });
app.get('/api/scanner/stats', (req, res, next) => { req.url = '/api/whatsapp/scanner/stats'; next(); });

// --- Groups stats alias ---
app.get('/api/groups/stats', (req, res, next) => { req.url = '/api/whatsapp/groups/stats'; next(); });

// --- Health check endpoint for uptime monitoring ---
app.get('/api/health', (req, res) => {
  const checks = {};

  // Check WhatsApp client status
  try {
    const info = client.info;
    checks.whatsapp = info ? { status: 'ok' } : { status: 'error', error: 'Not connected' };
  } catch {
    checks.whatsapp = { status: 'error', error: 'Client not initialized' };
  }

  // Check data directory is writable
  try {
    fs.accessSync(DATA_DIR, fs.constants.W_OK);
    checks.storage = { status: 'ok' };
  } catch {
    checks.storage = { status: 'error', error: 'Data directory not writable' };
  }

  const overall = Object.values(checks).every(c => c.status === 'ok') ? 'healthy' : 'degraded';

  res.status(overall === 'healthy' ? 200 : 503).json({
    service: 'wbpro',
    status: overall,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    checks,
  });
});

// --- Leads: dismiss (TBP sends {id}, sets lead status to 'dismissed') ---
app.post('/api/leads/dismiss', (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'id required' });
  try {
    const lead = leads.updateLeadStatus(id, 'dismissed');
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// --- Leads: dismiss-all ---
app.post('/api/leads/dismiss-all', (req, res) => {
  try {
    const allLeads = leads.getLeads({});
    const list = allLeads.leads || [];
    let count = 0;
    for (const l of list) {
      if (l.status !== 'dismissed') {
        try { leads.updateLeadStatus(l.id, 'dismissed'); count++; } catch {}
      }
    }
    res.json({ ok: true, dismissed: count });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Leads: reply via DM ---
app.post('/api/leads/reply', async (req, res) => {
  const { leadId, message } = req.body;
  if (!leadId || !message) return res.status(400).json({ error: 'leadId and message required' });

  // Find the lead to get sender info
  const allLeads = leads.getLeads({});
  const lead = (allLeads.leads || []).find(l => l.id === leadId);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  const senderId = lead.senderId || lead.senderJid;
  if (!senderId) return res.status(400).json({ error: 'No sender info on lead' });

  // Find a connected account (prefer the one that captured the lead)
  const accountId = lead.account || 'default';
  const acc = accounts.get(accountId) || accounts.get('default');
  if (!acc || !acc.ready) return res.status(503).json({ error: 'No connected account' });

  try {
    await acc.client.sendMessage(senderId, message);
    // Mark lead as replied
    try { leads.updateLeadStatus(leadId, 'replied'); } catch {}
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Keywords aliases (TBP uses GET + PUT with different payload shape) ---
app.get('/api/keywords', (req, res) => {
  const kwData = leads.getCustomKeywords();
  const settings = loadJSON(SETTINGS_FILE, {});
  const builtin = kwData.builtin || {};
  const builtinEn = []; const builtinHe = [];
  for (const words of Object.values(builtin.en || {})) builtinEn.push(...words);
  for (const words of Object.values(builtin.he || {})) builtinHe.push(...words);
  // Custom keywords (user-added, removable)
  const customEn = []; const customHe = [];
  for (const words of Object.values(kwData.custom || {})) {
    for (const w of (Array.isArray(words) ? words : [])) {
      if (/[\u0590-\u05FF]/.test(w)) customHe.push(w);
      else customEn.push(w);
    }
  }
  res.json({
    builtin: { en: [...new Set(builtinEn)], he: [...new Set(builtinHe)] },
    custom: { en: [...new Set(customEn)], he: [...new Set(customHe)] },
    keywords: { en: [...new Set([...builtinEn, ...customEn])], he: [...new Set([...builtinHe, ...customHe])] },
    scannerEnabled: settings.scannerEnabled !== false,
  });
});

app.put('/api/keywords', (req, res) => {
  const settings = loadJSON(SETTINGS_FILE, {});
  const { keywords, scannerEnabled } = req.body;

  if (scannerEnabled !== undefined) {
    settings.scannerEnabled = Boolean(scannerEnabled);
    saveJSON(SETTINGS_FILE, settings);
  }

  // Handle custom keywords from frontend
  const custom = req.body.custom || req.body.keywords;
  if (custom) {
    const allWords = [...(custom.en || []), ...(custom.he || [])];
    try {
      leads.setCustomKeywords({ keywords: allWords, category: 'user' });
    } catch {}
  }

  res.json({ ok: true });
});

// --- Contacts aliases (TBP uses /api/contacts, WBpro uses /api/whatsapp/crm/contacts) ---

// GET /api/contacts — map to CRM contacts with TBP-compatible response shape
app.get('/api/contacts', (req, res) => {
  let contactList = Array.from(crmContacts.values()).map(c => {
    c.score = calculateScore(c);
    c.status = c.blocked ? 'blocked' : statusFromScore(c.score);
    return c;
  });

  // Search by name/phone
  if (req.query.q) {
    const q = req.query.q.toLowerCase();
    contactList = contactList.filter(c =>
      (c.name && c.name.toLowerCase().includes(q)) ||
      (c.pushName && c.pushName.toLowerCase().includes(q)) ||
      (c.phone && c.phone.includes(q)) ||
      (c.id && c.id.includes(q))
    );
  }

  // Filter by group
  if (req.query.group) {
    contactList = contactList.filter(c => {
      const groupSlug = (c.source?.groupId || '');
      return c.lists.includes(req.query.group) || groupSlug === req.query.group ||
        c.tags.some(t => t === req.query.group);
    });
  }

  // Sort by score descending
  contactList.sort((a, b) => (b.score || 0) - (a.score || 0));

  // Limit
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  contactList = contactList.slice(0, limit);

  // Transform to TBP shape
  const contacts = contactList.map(c => {
    const score = c.score || 0;
    let activityLevel = 'cold';
    if (score >= 60) activityLevel = 'hot';
    else if (score >= 30) activityLevel = 'warm';

    const userTags = (c.tags || []).filter(t => !t.startsWith('all-'));
    const groups = (c.lists || []).filter(l => l !== 'all-contacts').map(l => l);

    return {
      jid: c.id + '@s.whatsapp.net',
      phone: c.phone || formatPhone(c.id),
      name: c.name || c.pushName || null,
      messageCount: c.profile?.messageCount || 0,
      activityScore: score,
      activityLevel,
      tags: userTags,
      groups,
      firstSeen: c.createdAt,
      lastSeen: c.profile?.lastActive || c.updatedAt,
    };
  });

  res.json({ contacts });
});

// GET /api/contacts/stats — TBP expects { total, today, week, topGroups }
app.get('/api/contacts/stats', (req, res) => {
  const all = Array.from(crmContacts.values());
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  let today = 0, week = 0;
  const groupCounts = {};

  for (const c of all) {
    const created = c.createdAt || '';
    if (created.startsWith(todayStr)) today++;
    if (new Date(created) >= weekAgo) week++;

    const groupName = c.source?.groupName;
    const groupId = c.source?.groupId;
    if (groupName && groupId) {
      if (!groupCounts[groupId]) groupCounts[groupId] = { group_id: groupId, group_name: groupName, contact_count: 0 };
      groupCounts[groupId].contact_count++;
    }
  }

  const topGroups = Object.values(groupCounts).sort((a, b) => b.contact_count - a.contact_count).slice(0, 20);

  res.json({ total: all.length, today, week, topGroups });
});

// GET /api/contacts/detail?jid=... — TBP expects detailed contact object
app.get('/api/contacts/detail', (req, res) => {
  const jid = req.query.jid;
  if (!jid) return res.status(400).json({ error: 'jid required' });
  const phoneId = jid.split('@')[0];
  const contact = getCrmContact(phoneId);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });

  const score = contact.score || 0;
  let activityLevel = 'cold';
  if (score >= 60) activityLevel = 'hot';
  else if (score >= 30) activityLevel = 'warm';

  const userTags = (contact.tags || []).filter(t => !t.startsWith('all-'));
  const groups = (contact.lists || []).filter(l => l !== 'all-contacts').map(l => ({
    group_id: l, group_name: l, message_count: 0,
  }));

  res.json({
    contact: {
      jid: contact.id + '@s.whatsapp.net',
      phone: contact.phone || formatPhone(contact.id),
      name: contact.name || contact.pushName || null,
      messageCount: contact.profile?.messageCount || 0,
      activityScore: score,
      activityLevel,
      tags: userTags,
      interests: contact.profile?.interests || [],
      groups,
      notes: contact.profile?.notes || '',
      firstSeen: contact.createdAt,
      lastSeen: contact.profile?.lastActive || contact.updatedAt,
    }
  });
});

// POST /api/contacts/tag — add tag to contact
app.post('/api/contacts/tag', (req, res) => {
  const { jid, tag } = req.body;
  if (!jid || !tag) return res.status(400).json({ error: 'jid and tag required' });
  const phoneId = jid.split('@')[0];
  const contact = getCrmContact(phoneId);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });

  if (!contact.tags.includes(tag)) {
    contact.tags.push(tag);
    crmDirty = true;
    saveCRM();
  }
  res.json({ ok: true });
});

// DELETE /api/contacts/tag — remove tag from contact
app.delete('/api/contacts/tag', (req, res) => {
  const { jid, tag } = req.body;
  if (!jid || !tag) return res.status(400).json({ error: 'jid and tag required' });
  const phoneId = jid.split('@')[0];
  const contact = getCrmContact(phoneId);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });

  const idx = contact.tags.indexOf(tag);
  if (idx >= 0) {
    contact.tags.splice(idx, 1);
    crmDirty = true;
    saveCRM();
  }
  res.json({ ok: true });
});

// PUT /api/contacts/notes — save notes for contact
app.put('/api/contacts/notes', (req, res) => {
  const { jid, notes } = req.body;
  if (!jid) return res.status(400).json({ error: 'jid required' });
  const phoneId = jid.split('@')[0];
  const contact = getCrmContact(phoneId);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });

  upsertCrmContact(phoneId, { profile: { notes: notes || '' } });
  saveCRM();
  res.json({ ok: true });
});

// POST /api/contacts/delete — delete contact
app.post('/api/contacts/delete', (req, res) => {
  const { jid } = req.body;
  if (!jid) return res.status(400).json({ error: 'jid required' });
  const phoneId = jid.split('@')[0];
  if (!crmContacts.has(phoneId)) return res.status(404).json({ error: 'Contact not found' });

  crmContacts.delete(phoneId);
  crmDirty = true;
  saveCRM();
  res.json({ ok: true });
});

// GET /api/contacts/export — CSV export alias
app.get('/api/contacts/export', (req, res, next) => {
  req.url = '/api/whatsapp/crm/contacts/export' + (req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '');
  next();
});

// POST /api/contacts/import — TBP sends { contacts: [...rows], listId }
app.post('/api/contacts/import', (req, res) => {
  const { contacts: rows, listId } = req.body;
  if (!rows || !Array.isArray(rows)) return res.status(400).json({ error: 'contacts array required' });

  let imported = 0, skipped = 0;
  for (const row of rows) {
    const rawPhone = row.phone || row.Phone || '';
    const phone = normalizePhone(rawPhone);
    if (!phone) { skipped++; continue; }

    const phoneId = phone.replace(/[^0-9]/g, '');
    if (!phoneId || phoneId.length < 5) { skipped++; continue; }
    if (isBlocked(phone)) { skipped++; continue; }

    const tags = [];
    if (row.tag) tags.push(row.tag);
    if (row.source) tags.push('import:' + row.source);

    const updates = {
      name: row.name || row.Name || null,
      tags,
      source: { type: 'csv_import', importSource: row.source || 'manual', firstSeen: new Date().toISOString() },
      profile: { lastActive: new Date().toISOString() },
    };

    // Add to broadcast list if specified
    if (listId) {
      updates.lists = [listId];
    }

    upsertCrmContact(phoneId, updates);
    imported++;
  }
  saveCRM();
  res.json({ ok: true, imported, skipped });
});

// --- Broadcast Lists (TBP uses /api/lists, WBpro uses /api/whatsapp/broadcast-lists) ---

// GET /api/lists — return all broadcast lists in TBP shape
app.get('/api/lists', (req, res) => {
  const result = broadcastLists.map(l => ({
    id: l.id,
    name: l.name,
    member_count: (l.contacts || []).length,
    created_at: l.createdAt,
  }));
  res.json({ lists: result });
});

// POST /api/lists — create a new broadcast list
app.post('/api/lists', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });

  const id = 'list_' + crypto.randomUUID().slice(0, 12);
  const list = {
    id,
    name,
    description: '',
    contacts: [],
    tags: [],
    createdAt: new Date().toISOString(),
    lastBroadcastAt: null,
    broadcastCount: 0,
  };
  broadcastLists.push(list);
  broadcastListsDirty = true;
  saveBroadcastLists();
  res.json({ ok: true, list: { id: list.id, name: list.name, member_count: 0, created_at: list.createdAt } });
});

// DELETE /api/lists?id=... — delete a broadcast list
app.delete('/api/lists', (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'id query param required' });
  const idx = broadcastLists.findIndex(l => l.id === id);
  if (idx === -1) return res.status(404).json({ error: 'List not found' });
  broadcastLists.splice(idx, 1);
  broadcastListsDirty = true;
  saveBroadcastLists();
  res.json({ ok: true });
});

// GET /api/lists/members?id=... — get members of a broadcast list
app.get('/api/lists/members', (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'id query param required' });
  const list = broadcastLists.find(l => l.id === id);
  if (!list) return res.status(404).json({ error: 'List not found' });

  const members = (list.contacts || []).map(phone => {
    const phoneId = phone.replace(/[^0-9]/g, '');
    const contact = getCrmContact(phoneId);
    const score = contact ? (contact.score || 0) : 0;
    let activityLevel = 'cold';
    if (score >= 60) activityLevel = 'hot';
    else if (score >= 30) activityLevel = 'warm';

    return {
      jid: phoneId + '@s.whatsapp.net',
      phone: phone,
      name: contact ? (contact.name || contact.pushName || null) : null,
      activityScore: score,
      activityLevel,
    };
  });

  res.json({ members });
});

// POST /api/lists/members — add members { listId, jids: [...] }
app.post('/api/lists/members', (req, res) => {
  const { listId, jids } = req.body;
  if (!listId || !jids || !Array.isArray(jids)) return res.status(400).json({ error: 'listId and jids[] required' });
  const list = broadcastLists.find(l => l.id === listId);
  if (!list) return res.status(404).json({ error: 'List not found' });

  let added = 0;
  for (const jid of jids) {
    const phoneId = jid.split('@')[0];
    const phone = formatPhone(phoneId);
    if (!list.contacts.includes(phone)) {
      list.contacts.push(phone);
      added++;
    }
  }
  broadcastListsDirty = true;
  saveBroadcastLists();
  res.json({ ok: true, added });
});

// DELETE /api/lists/members — remove member { listId, jid }
app.delete('/api/lists/members', (req, res) => {
  const { listId, jid } = req.body;
  if (!listId || !jid) return res.status(400).json({ error: 'listId and jid required' });
  const list = broadcastLists.find(l => l.id === listId);
  if (!list) return res.status(404).json({ error: 'List not found' });

  const phoneId = jid.split('@')[0];
  const phone = formatPhone(phoneId);
  const idx = list.contacts.indexOf(phone);
  if (idx >= 0) {
    list.contacts.splice(idx, 1);
    broadcastListsDirty = true;
    saveBroadcastLists();
  }
  res.json({ ok: true });
});

// POST /api/lists/broadcast — send DM to all list members
app.post('/api/lists/broadcast', async (req, res) => {
  const { listId, message } = req.body;
  if (!listId || !message) return res.status(400).json({ error: 'listId and message required' });
  const list = broadcastLists.find(l => l.id === listId);
  if (!list) return res.status(404).json({ error: 'List not found' });

  // Find a connected account
  let acc = null;
  for (const [, a] of accounts) {
    if (a.ready) { acc = a; break; }
  }
  if (!acc) return res.status(503).json({ error: 'No connected account' });

  let sent = 0, failed = 0;
  for (const phone of list.contacts) {
    const phoneId = phone.replace(/[^0-9]/g, '');
    try {
      const jid = phoneId + '@c.us';
      await acc.client.sendMessage(jid, message);
      sent++;
      if (sent < list.contacts.length) await new Promise(r => setTimeout(r, 3000));
    } catch (err) {
      console.error(`List broadcast DM failed for ${phone}:`, err.message);
      failed++;
    }
  }

  list.lastBroadcastAt = new Date().toISOString();
  list.broadcastCount = (list.broadcastCount || 0) + 1;
  broadcastListsDirty = true;
  saveBroadcastLists();

  res.json({ sent, failed, total: list.contacts.length });
});

// ─── End TBP Frontend Route Aliases ─────────────────────────────────────

// ─── Chromium Args (shared across all clients) ──────────────────────────

const PUPPETEER_ARGS = [
  '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
  '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote',
  '--single-process', '--disable-gpu', '--disable-extensions',
  '--disable-background-networking', '--disable-default-apps',
  '--disable-sync', '--disable-translate', '--metrics-recording-only',
  '--no-default-browser-check', '--mute-audio',
  '--disable-component-update', '--disable-breakpad',
  '--disable-features=TranslateUI,BlinkGenPropertyTrees',
  '--js-flags=--max-old-space-size=128 --gc-interval=100',
];

// ─── Multi-Account WhatsApp System ──────────────────────────────────────

// accounts map: accountId -> { id, name, client, qr, ready, status }
const accounts = new Map();

function cleanStaleLocks(dir) {
  try {
    if (!fs.existsSync(dir)) return;
    const walk = (d) => {
      try {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.name.startsWith('Singleton')) {
            try { fs.unlinkSync(full); console.log('Removed stale lock:', full); } catch {}
          }
        }
      } catch {}
    };
    walk(dir);
  } catch (e) { console.log('Lock cleanup skipped:', e.message); }
}

function createWhatsAppClient(accountId) {
  const dataPath = path.join(AUTH_DIR, accountId);
  ensureDir(dataPath);
  cleanStaleLocks(dataPath);

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: accountId, dataPath: AUTH_DIR }),
    puppeteer: {
      headless: true,
      args: PUPPETEER_ARGS,
    },
    webVersionCache: { type: 'none' },
  });

  return client;
}

function setupClientEvents(accountId, client) {
  const acc = accounts.get(accountId);
  if (!acc) return;

  client.on('qr', (qr) => {
    acc.qr = qr;
    acc.status = 'waiting_for_qr_scan';
    console.log(`[${accountId}] QR ready`);
  });

  client.on('ready', async () => {
    acc.qr = null;
    acc.ready = true;
    acc.status = 'ready';
    // Pull phone number and display name from WhatsApp profile
    try {
      const info = client.info;
      if (info) {
        acc.phone = info.wid?.user ? '+' + info.wid.user : null;
        acc.pushname = info.pushname || null;
        acc.platform = info.platform || null;
        // Update the account name to the WhatsApp display name if it's still "Default"
        if (acc.name === 'Default' && info.pushname) {
          acc.name = info.pushname;
        }
        console.log(`[${accountId}] WhatsApp connected! Phone: ${acc.phone}, Name: ${acc.pushname}`);
      }
    } catch (e) {
      console.log(`[${accountId}] WhatsApp connected! (couldn't read profile: ${e.message})`);
    }
    // Save updated account info
    try { saveJSON(ACCOUNTS_FILE, Array.from(accounts.entries()).map(([id, a]) => ({ id, name: a.name, phone: a.phone, pushname: a.pushname }))); } catch {}
  });

  client.on('authenticated', () => {
    acc.status = 'authenticated';
    console.log(`[${accountId}] WhatsApp authenticated`);
  });

  client.on('auth_failure', (msg) => {
    acc.ready = false;
    acc.status = 'auth_failure';
    console.error(`[${accountId}] Auth fail:`, msg);
  });

  client.on('disconnected', (reason) => {
    acc.ready = false;
    acc.status = 'disconnected';
    acc.qr = null;
    console.log(`[${accountId}] Disconnected:`, reason);
    setTimeout(() => {
      client.initialize().catch(e => console.error(`[${accountId}] Reconnect fail:`, e.message));
    }, 5000);
  });

  // ─── Message handler: auto-response with custom rules + default party bot ─
  client.on('message', async (msg) => {
    if (msg.fromMe) return;

    const chat = await msg.getChat().catch(() => null);
    if (!chat) return;

    const lower = msg.body.toLowerCase();
    const autoRules = loadJSON(AUTO_RULES_FILE, []);

    // Check custom auto-response rules first
    for (const rule of autoRules) {
      if (!rule.enabled) continue;
      // Rule can be scoped to account or global
      if (rule.account && rule.account !== accountId) continue;
      const matched = rule.keywords.some(kw => lower.includes(kw.toLowerCase()));
      if (matched) {
        console.log(`[${accountId}] Auto-rule "${rule.id}" triggered in "${chat.name || msg.from}"`);
        try {
          let response = rule.response;
          // Template variable replacement for Kartis ticket links
          if (response.includes('{nextEvent}') || response.includes('{ticketLink}') || response.includes('{eventList}') || response.includes('{eventName}')) {
            const events = await fetchEvents();
            const upcoming = getUpcoming(events);
            const heb = isHebrew(msg.body);
            const next = upcoming[0] || null;
            if (next) {
              const ticketUrl = next.ticketUrl || (next.slug ? `${KARTIS_URL}/en/event/${next.slug}` : `${KARTIS_URL}/events`);
              response = response
                .replace(/\{eventName\}/g, next.name || 'Upcoming Event')
                .replace(/\{ticketLink\}/g, ticketUrl)
                .replace(/\{nextEvent\}/g, formatEvent(next, heb))
                .replace(/\{eventList\}/g, upcoming.slice(0, 3).map(e => formatEvent(e, heb)).join('\n\n'));
            } else {
              response = response
                .replace(/\{eventName\}/g, '')
                .replace(/\{ticketLink\}/g, `${KARTIS_URL}/events`)
                .replace(/\{nextEvent\}/g, heb ? 'אין אירועים קרובים כרגע' : 'No upcoming events right now')
                .replace(/\{eventList\}/g, heb ? 'אין אירועים קרובים כרגע' : 'No upcoming events right now');
            }
          }
          await msg.reply(response);
          console.log(`[${accountId}] Auto-rule replied`);
        } catch (err) {
          console.error(`[${accountId}] Auto-rule reply failed:`, err.message);
        }
        return; // first matching rule wins
      }
    }

    // Default party keyword handler (existing behavior + smart intent detection)
    if (chat.isGroup) {
      const keywordMatch = PARTY_KEYWORDS.some(kw => lower.includes(kw.toLowerCase()));
      const intentMatch = isPartyIntent(msg.body);
      const isPartyQuery = keywordMatch || intentMatch;

      // Lead detection — runs on every group message
      const groupId = chat.id._serialized;
      const senderName = msg.author || msg.from;
      const lead = leads.detectLead(msg.body, senderName, msg.from, chat.name, groupId);
      if (lead.isLead) {
        leads.storeLead({ ...lead, groupId, groupName: chat.name, senderId: msg.from, senderName, account: accountId });
      }

      if (isPartyQuery) {
        console.log(`[${accountId}] Party ${intentMatch ? 'intent' : 'keyword'} in group "${chat.name}" from ${senderName}`);

        // CRM: Profile contact from group message
        const senderJid = msg.author || msg.from;
        const senderPhone = phoneFromJid(senderJid);
        if (senderPhone && !isBlocked(formatPhone(senderPhone))) {
          const contact = await msg.getContact().catch(() => null);
          const pushName = contact ? (contact.pushname || contact.name || null) : null;
          const groupSlug = (chat.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

          profileContactFromMessage(senderPhone, msg.body, pushName);
          upsertCrmContact(senderPhone, {
            source: { type: 'group_scrape', groupId, groupName: chat.name, firstSeen: new Date().toISOString() },
            tags: [groupSlug],
            lists: ['all-contacts', groupSlug],
          });

          // Auto-DM if enabled and cooldown passed for this contact
          const crmContact = getCrmContact(senderPhone);
          if (crmContact && canSendAutoDm(crmContact)) {
            try {
              const settings = getCrmSettings();
              const recommendation = await getRecommendation(msg.body);
              const dmMessage = settings.autoDmTemplate
                .replace('{name}', pushName || 'there')
                .replace('{events}', recommendation);
              const dmChat = await acc.client.getChatById(senderJid).catch(() => null);
              if (dmChat) {
                await dmChat.sendMessage(dmMessage);
                upsertCrmContact(senderPhone, {
                  profile: { dmSent: true, dmSentAt: new Date().toISOString() },
                });
                console.log(`[${accountId}] Auto-DM sent to ${senderPhone}`);
              }
            } catch (dmErr) {
              console.error(`[${accountId}] Auto-DM failed for ${senderPhone}:`, dmErr.message);
            }
          }
        }

        // Track stats
        updateGroupStats(groupId, chat.name, 'query');

        // Check quiet hours
        if (isQuietHours()) {
          console.log(`[${accountId}] Skipping response — quiet hours active`);
          addToFeed({
            timestamp: new Date().toISOString(), groupName: chat.name, groupId,
            senderName, message: msg.body.slice(0, 200), responded: false,
            responsePreview: null, account: accountId,
          });
          return;
        }

        // Check cooldown
        if (isCooldownActive(groupId)) {
          console.log(`[${accountId}] Skipping response — cooldown active for "${chat.name}"`);
          addToFeed({
            timestamp: new Date().toISOString(), groupName: chat.name, groupId,
            senderName, message: msg.body.slice(0, 200), responded: false,
            responsePreview: null, account: accountId,
          });
          return;
        }

        try {
          const recommendation = await getRecommendation(msg.body);
          await msg.reply(recommendation);
          setCooldown(groupId);
          updateGroupStats(groupId, chat.name, 'response');
          console.log(`[${accountId}] Replied with event recommendation`);
          addToFeed({
            timestamp: new Date().toISOString(), groupName: chat.name, groupId,
            senderName, message: msg.body.slice(0, 200), responded: true,
            responsePreview: recommendation.slice(0, 150), account: accountId,
          });
        } catch (err) {
          console.error(`[${accountId}] Failed to reply:`, err.message);
          await msg.reply(
            `🎉 *The Best Parties*\n\nCheck out our events ➡️ ${TBP_URL}/events`
          ).catch(() => {});
        }
      }
      return;
    }

    // In DMs: capture contact + CRM profiling + always respond with event info
    console.log(`[${accountId}] DM from ${msg.from}: ${msg.body.slice(0, 50)}...`);
    try {
      const contact = await msg.getContact().catch(() => null);
      const contactName = contact ? (contact.pushname || contact.name || null) : null;
      captureContact(msg.from, contactName, msg.body);

      // CRM: Profile DM contact and mark as responded if they were DM'd before
      const dmPhone = phoneFromJid(msg.from);
      if (dmPhone && !isBlocked(formatPhone(dmPhone))) {
        profileContactFromMessage(dmPhone, msg.body, contactName);
        const crmContact = getCrmContact(dmPhone);
        if (crmContact && crmContact.profile.dmSent && !crmContact.profile.responded) {
          upsertCrmContact(dmPhone, {
            profile: { responded: true, respondedAt: new Date().toISOString() },
            score: (crmContact.score || 0) + 20,
          });
          console.log(`[${accountId}] CRM: DM response from ${dmPhone}, +20 score`);
        }
      }
    } catch (e) {
      console.error(`[${accountId}] Contact capture failed:`, e.message);
    }
    try {
      const recommendation = await getRecommendation(msg.body);
      await msg.reply(recommendation);
    } catch (err) {
      console.error(`[${accountId}] DM reply failed:`, err.message);
      await msg.reply(
        `🎉 *The Best Parties*\n\nCheck out our events ➡️ ${TBP_URL}/events`
      ).catch(() => {});
    }
  });
}

async function initAccount(accountId, attempt = 1) {
  const acc = accounts.get(accountId);
  if (!acc) return;
  console.log(`[${accountId}] Initializing WhatsApp client (attempt ${attempt})...`);
  try {
    await acc.client.initialize();
  } catch (err) {
    console.error(`[${accountId}] Init failed (attempt ${attempt}):`, err.message);
    acc.status = 'error';
    if (attempt < 3) {
      console.log(`[${accountId}] Retrying in 10s...`);
      setTimeout(() => initAccount(accountId, attempt + 1), 10000);
    } else {
      console.error(`[${accountId}] All init attempts failed.`);
    }
  }
}

function registerAccount(id, name) {
  if (accounts.has(id)) return accounts.get(id);

  const client = createWhatsAppClient(id);
  const acc = { id, name, client, qr: null, ready: false, status: 'initializing' };
  accounts.set(id, acc);
  setupClientEvents(id, client);
  return acc;
}

function getAccount(req) {
  const id = req.query.account || req.body?.account || 'default';
  return { id, acc: accounts.get(id) };
}

// Load saved accounts and initialize them
function loadAndInitAccounts() {
  const saved = loadJSON(ACCOUNTS_FILE, []);
  // Always ensure "default" account exists
  if (!saved.find(a => a.id === 'default')) {
    saved.unshift({ id: 'default', name: 'Default' });
    saveJSON(ACCOUNTS_FILE, saved);
  }
  // Clean stale locks in the global auth dir
  cleanStaleLocks(AUTH_DIR);

  for (const { id, name } of saved) {
    registerAccount(id, name);
    initAccount(id);
  }
}

// ─── Broadcast History Helper ───────────────────────────────────────────

function logBroadcast(entry) {
  const history = loadJSON(HISTORY_FILE, []);
  history.unshift(entry); // newest first
  // Keep last 500
  if (history.length > 500) history.length = 500;
  saveJSON(HISTORY_FILE, history);
}

// ─── Template Variable Replacement ──────────────────────────────────────

function applyTemplate(templateMessage, variables = {}) {
  return templateMessage.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return variables[key] !== undefined ? variables[key] : match;
  });
}

// ─── Scheduled Broadcasts ───────────────────────────────────────────────

function checkScheduledBroadcasts() {
  const schedules = loadJSON(SCHEDULES_FILE, []);
  const now = Date.now();
  let changed = false;

  for (const sched of schedules) {
    if (sched.status !== 'pending') continue;
    const sendAt = new Date(sched.sendAt).getTime();
    if (sendAt <= now) {
      // Time to send
      sched.status = 'sending';
      changed = true;
      executeBroadcast(sched.account || 'default', sched.chatIds, sched.message, sched.id, sched.name)
        .then(result => {
          const scheds = loadJSON(SCHEDULES_FILE, []);
          const s = scheds.find(x => x.id === sched.id);
          if (s) {
            s.status = 'completed';
            s.result = result;
            saveJSON(SCHEDULES_FILE, scheds);
          }
        })
        .catch(err => {
          const scheds = loadJSON(SCHEDULES_FILE, []);
          const s = scheds.find(x => x.id === sched.id);
          if (s) {
            s.status = 'failed';
            s.error = err.message;
            saveJSON(SCHEDULES_FILE, scheds);
          }
        });
    }
  }

  if (changed) saveJSON(SCHEDULES_FILE, schedules);
}

async function executeBroadcast(accountId, chatIds, message, broadcastId, broadcastName) {
  const acc = accounts.get(accountId);
  if (!acc || (!acc.ready && acc.status !== 'authenticated')) throw new Error(`Account ${accountId} not ready (status: ${acc?.status})`);

  let sent = 0, failed = 0;
  const failures = [];
  for (const id of chatIds) {
    try {
      await acc.client.sendMessage(id, message);
      sent++;
      await new Promise(r => setTimeout(r, 1500)); // rate limit
    } catch (err) {
      failed++;
      failures.push({ chatId: id, error: err.message });
      console.error(`[${accountId}] Broadcast fail ${id}:`, err.message);
    }
  }

  const result = { sent, failed, total: chatIds.length, failures };

  // Log to history
  logBroadcast({
    id: broadcastId || crypto.randomUUID(),
    name: broadcastName || null,
    timestamp: new Date().toISOString(),
    account: accountId,
    chatIds,
    messagePreview: message.slice(0, 200),
    sent,
    failed,
    total: chatIds.length,
    failures,
  });

  return result;
}

// ─── Recurring Broadcasts (Cron-Based) ──────────────────────────────────

/**
 * Lightweight cron field matcher. Supports:
 *   * (any), specific values (5), lists (1,3,5), ranges (1-5), steps (star/10)
 */
function matchCronField(field, value, min, max) {
  if (field === '*') return true;
  // Step: */N or range/N
  if (field.includes('/')) {
    const [rangePart, stepStr] = field.split('/');
    const step = parseInt(stepStr, 10);
    if (isNaN(step) || step <= 0) return false;
    let start = min;
    let end = max;
    if (rangePart !== '*') {
      if (rangePart.includes('-')) {
        [start, end] = rangePart.split('-').map(Number);
      } else {
        start = parseInt(rangePart, 10);
      }
    }
    if (value < start || value > end) return false;
    return (value - start) % step === 0;
  }
  // List: 1,3,5
  if (field.includes(',')) {
    return field.split(',').some(v => matchCronField(v.trim(), value, min, max));
  }
  // Range: 1-5
  if (field.includes('-')) {
    const [lo, hi] = field.split('-').map(Number);
    return value >= lo && value <= hi;
  }
  // Exact
  return parseInt(field, 10) === value;
}

/**
 * Check if a cron expression matches the current time.
 * Format: "minute hour dayOfMonth month dayOfWeek"
 * e.g. "0 10 * * 1" = every Monday at 10:00
 *      "0 18 * * 4" = every Thursday at 18:00
 *      "30 9 * * 1-5" = weekdays at 9:30
 */
function cronMatchesNow(cronExpr) {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const now = new Date();
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  return (
    matchCronField(minute, now.getMinutes(), 0, 59) &&
    matchCronField(hour, now.getHours(), 0, 23) &&
    matchCronField(dayOfMonth, now.getDate(), 1, 31) &&
    matchCronField(month, now.getMonth() + 1, 1, 12) &&
    matchCronField(dayOfWeek, now.getDay(), 0, 6)
  );
}

/**
 * Get the next occurrence of a cron expression (approximate, for display).
 * Scans forward up to 7 days.
 */
function getNextCronRun(cronExpr) {
  const now = new Date();
  for (let m = 1; m <= 10080; m++) { // up to 7 days in minutes
    const check = new Date(now.getTime() + m * 60000);
    const parts = cronExpr.trim().split(/\s+/);
    if (parts.length !== 5) return null;
    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
    if (
      matchCronField(minute, check.getMinutes(), 0, 59) &&
      matchCronField(hour, check.getHours(), 0, 23) &&
      matchCronField(dayOfMonth, check.getDate(), 1, 31) &&
      matchCronField(month, check.getMonth() + 1, 1, 12) &&
      matchCronField(dayOfWeek, check.getDay(), 0, 6)
    ) {
      return check.toISOString();
    }
  }
  return null;
}

// Cron presets for convenience
const CRON_PRESETS = {
  'every-monday-10am': { cron: '0 10 * * 1', label: 'Every Monday at 10:00' },
  'every-thursday-6pm': { cron: '0 18 * * 4', label: 'Every Thursday at 18:00' },
  'every-friday-12pm': { cron: '0 12 * * 5', label: 'Every Friday at 12:00' },
  'every-friday-5pm': { cron: '0 17 * * 5', label: 'Every Friday at 17:00' },
  'weekdays-9am': { cron: '0 9 * * 1-5', label: 'Weekdays at 09:00' },
  'every-day-10am': { cron: '0 10 * * *', label: 'Every day at 10:00' },
  'every-saturday-2pm': { cron: '0 14 * * 6', label: 'Every Saturday at 14:00' },
  'twice-weekly-wed-fri': { cron: '0 10 * * 3,5', label: 'Wed & Fri at 10:00' },
};

function checkRecurringBroadcasts() {
  const recurrings = loadJSON(RECURRING_FILE, []);
  const now = Date.now();

  for (const rec of recurrings) {
    if (!rec.enabled) continue;

    // Check if cron matches current minute
    if (!cronMatchesNow(rec.cron)) continue;

    // Prevent double-fire: check lastFired is not within the same minute
    if (rec.lastFiredAt) {
      const lastFired = new Date(rec.lastFiredAt).getTime();
      if (now - lastFired < 60000) continue; // already fired this minute
    }

    // Check end date if set
    if (rec.endDate && new Date(rec.endDate).getTime() < now) {
      rec.enabled = false;
      continue;
    }

    // Resolve message — optionally fetch next Kartis event for dynamic content
    let message = rec.message;
    if (rec.includeNextEvent) {
      // This will be resolved asynchronously below
      resolveAndSendRecurring(rec, recurrings);
      continue;
    }

    // Fire the broadcast
    rec.lastFiredAt = new Date().toISOString();
    rec.fireCount = (rec.fireCount || 0) + 1;
    executeBroadcast(rec.account || 'default', rec.chatIds, message, crypto.randomUUID(), `Recurring: ${rec.name}`)
      .then(result => {
        console.log(`Recurring broadcast "${rec.name}" sent: ${result.sent}/${result.total}`);
        const recs = loadJSON(RECURRING_FILE, []);
        const r = recs.find(x => x.id === rec.id);
        if (r) {
          r.lastResult = { sent: result.sent, failed: result.failed, at: new Date().toISOString() };
          saveJSON(RECURRING_FILE, recs);
        }
      })
      .catch(err => {
        console.error(`Recurring broadcast "${rec.name}" failed:`, err.message);
        const recs = loadJSON(RECURRING_FILE, []);
        const r = recs.find(x => x.id === rec.id);
        if (r) {
          r.lastResult = { error: err.message, at: new Date().toISOString() };
          saveJSON(RECURRING_FILE, recs);
        }
      });
  }

  saveJSON(RECURRING_FILE, recurrings);
}

async function resolveAndSendRecurring(rec, recurrings) {
  try {
    const res = await fetch(KARTIS_EVENTS_URL);
    const events = await res.json();
    const upcoming = (Array.isArray(events) ? events : events.events || [])
      .filter(e => new Date(e.date || e.startDate).getTime() > Date.now())
      .sort((a, b) => new Date(a.date || a.startDate) - new Date(b.date || b.startDate));

    const nextEvent = upcoming[0];
    let message = rec.message;
    if (nextEvent) {
      const vars = {
        eventName: nextEvent.name || nextEvent.title || 'Upcoming Event',
        eventDate: new Date(nextEvent.date || nextEvent.startDate).toLocaleDateString('en-ZA', { weekday: 'long', month: 'long', day: 'numeric' }),
        eventVenue: nextEvent.venue || nextEvent.location || 'TBA',
        ticketLink: `${KARTIS_URL}/events/${nextEvent.slug || nextEvent.id}`,
      };
      message = message.replace(/\{\{(\w+)\}\}/g, (match, key) => vars[key] || match);
    }

    rec.lastFiredAt = new Date().toISOString();
    rec.fireCount = (rec.fireCount || 0) + 1;
    saveJSON(RECURRING_FILE, recurrings);

    const result = await executeBroadcast(rec.account || 'default', rec.chatIds, message, crypto.randomUUID(), `Recurring: ${rec.name}`);
    console.log(`Recurring broadcast "${rec.name}" (with event) sent: ${result.sent}/${result.total}`);

    const recs = loadJSON(RECURRING_FILE, []);
    const r = recs.find(x => x.id === rec.id);
    if (r) {
      r.lastResult = { sent: result.sent, failed: result.failed, at: new Date().toISOString(), event: nextEvent?.name };
      saveJSON(RECURRING_FILE, recs);
    }
  } catch (err) {
    console.error(`Recurring broadcast "${rec.name}" event fetch failed:`, err.message);
  }
}

// Check every 30 seconds (handles both one-time and recurring)
setInterval(() => {
  checkScheduledBroadcasts();
  checkRecurringBroadcasts();
}, 30000);

// ─── API Routes ──────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  const defaultAcc = accounts.get('default');
  res.json({
    status: 'ok',
    whatsapp: defaultAcc ? defaultAcc.status : 'no_accounts',
    webhook_registered: webhookRegistered,
  });
});

// ─── Account Management ─────────────────────────────────────────────────

app.post('/api/accounts', (req, res) => {
  let { id, name } = req.body;
  // Auto-generate ID if not provided (TBP frontend sends empty body)
  if (!id || typeof id !== 'string') {
    id = 'acct-' + crypto.randomUUID().slice(0, 8);
    if (!name) name = 'Account ' + (accounts.size + 1);
  }
  if (!/^[a-z0-9-]+$/.test(id)) return res.status(400).json({ error: 'id must be lowercase alphanumeric with hyphens' });
  if (accounts.has(id)) return res.status(409).json({ error: 'Account already exists' });

  registerAccount(id, name || id);
  initAccount(id);

  // Persist
  const saved = loadJSON(ACCOUNTS_FILE, []);
  saved.push({ id, name: name || id });
  saveJSON(ACCOUNTS_FILE, saved);

  res.json({ ok: true, id, name: name || id });
});

app.get('/api/accounts', (req, res) => {
  const list = [];
  for (const [id, acc] of accounts) {
    // Map status for TBP frontend compatibility:
    // TBP checks: 'ready', 'qr' (for dot color)
    let tbpStatus = acc.status;
    if (acc.ready) tbpStatus = 'ready';
    else if (acc.qr || acc.status === 'waiting_for_qr_scan') tbpStatus = 'qr';
    list.push({
      id,
      name: acc.pushname || acc.name || id,
      status: tbpStatus,
      ready: acc.ready,
      hasQr: !!acc.qr,
      phone: acc.phone || null,
      pushname: acc.pushname || null,
      platform: acc.platform || null,
    });
  }
  res.json({ accounts: list });
});

app.delete('/api/accounts/:id', async (req, res) => {
  const id = req.params.id;
  if (id === 'default') return res.status(400).json({ error: 'Cannot delete default account' });
  const acc = accounts.get(id);
  if (!acc) return res.status(404).json({ error: 'Account not found' });

  try {
    await acc.client.destroy().catch(() => {});
  } catch {}

  accounts.delete(id);

  // Remove session dir
  const sessionDir = path.join(AUTH_DIR, `session-${id}`);
  try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}

  // Remove from persistence
  const saved = loadJSON(ACCOUNTS_FILE, []).filter(a => a.id !== id);
  saveJSON(ACCOUNTS_FILE, saved);

  res.json({ ok: true, deleted: id });
});

// ─── WhatsApp Status / QR / Groups ──────────────────────────────────────

app.get('/api/whatsapp/status', (req, res) => {
  const { id, acc } = getAccount(req);
  if (!acc) return res.status(404).json({ error: `Account "${id}" not found`, status: 'not_found', ready: false });
  res.json({ status: acc.status, ready: acc.ready, hasQr: !!acc.qr, account: id });
});

app.get('/api/whatsapp/qr', async (req, res) => {
  const { id, acc } = getAccount(req);
  if (!acc) return res.status(404).json({ error: `Account "${id}" not found` });
  if (acc.ready) return res.json({ qr: null, status: 'ready', message: 'Already connected' });
  if (acc.status === 'authenticated') return res.json({ qr: null, status: 'authenticated', message: 'Authenticated, loading...' });
  if (!acc.qr) return res.json({ qr: null, status: acc.status, message: 'No QR yet, status: ' + acc.status });
  try {
    const qrDataUrl = await qrcode.toDataURL(acc.qr);
    res.json({ qr: qrDataUrl, qrDataUrl, status: acc.status });
  } catch { res.status(500).json({ error: 'QR generation failed' }); }
});

app.get('/api/whatsapp/groups', async (req, res) => {
  const { id, acc } = getAccount(req);
  if (!acc) return res.status(404).json({ error: `Account "${id}" not found`, groups: [] });
  // Allow if ready OR if status is authenticated/ready (whatsapp-web.js may have chats before ready event)
  if (!acc.ready && acc.status !== 'authenticated') {
    return res.status(503).json({ error: `Not connected (status: ${acc.status})`, groups: [] });
  }

  try {
    const chats = await Promise.race([
      acc.client.getChats(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('getChats timed out after 30s')), 30000))
    ]);
    let groups = chats.filter(c => c.isGroup).map(c => ({
      id: c.id._serialized, name: c.name,
      participantCount: c.participants ? c.participants.length : undefined,
    }));

    // Attach tags
    const allTags = loadJSON(GROUP_TAGS_FILE, {});
    groups = groups.map(g => ({ ...g, tags: allTags[g.id] || [] }));

    // Filter by tags if requested
    const filterTags = req.query.tags;
    if (filterTags) {
      const wanted = filterTags.split(',').map(t => t.trim().toLowerCase());
      groups = groups.filter(g => {
        const gTags = (g.tags || []).map(t => t.toLowerCase());
        return wanted.some(w => gTags.includes(w));
      });
    }

    res.json({ groups, account: id });
  } catch (err) { res.status(500).json({ error: err.message, groups: [] }); }
});

// ─── Broadcast ──────────────────────────────────────────────────────────

app.post('/api/whatsapp/broadcast', async (req, res) => {
  const accountId = req.body.account || 'default';
  const acc = accounts.get(accountId);
  if (!acc) return res.status(404).json({ error: `Account "${accountId}" not found` });
  if (!acc.ready && acc.status !== 'authenticated') return res.status(503).json({ error: `Not connected (status: ${acc.status})` });

  const chatIds = req.body.chatIds || req.body.groupIds;
  let { message, templateId, variables } = req.body;

  // If using a persona template (personaId + variant), resolve it
  const { personaId, variant } = req.body;
  if (personaId && variant && !message && !templateId) {
    const ptFile = path.join(PERSONA_TEMPLATES_DIR, `${personaId}.json`);
    const ptData = loadJSON(ptFile, null);
    if (!ptData) return res.status(404).json({ error: `Persona template "${personaId}" not found` });
    const ptVariant = ptData.variants && ptData.variants[variant];
    if (!ptVariant) return res.status(404).json({ error: `Variant "${variant}" not found for persona "${personaId}"` });
    message = formatPersonaTemplate(ptVariant.message, variables || {});
  }

  // If using a template, resolve it
  if (templateId) {
    const templates = loadJSON(TEMPLATES_FILE, []);
    const tpl = templates.find(t => t.id === templateId);
    if (!tpl) return res.status(404).json({ error: `Template "${templateId}" not found` });
    message = applyTemplate(tpl.message, variables || {});
  }

  if (!chatIds || !Array.isArray(chatIds) || chatIds.length === 0)
    return res.status(400).json({ error: 'chatIds/groupIds required' });
  if (!message || typeof message !== 'string')
    return res.status(400).json({ error: 'message required (or use templateId)' });
  if (chatIds.length > 50)
    return res.status(400).json({ error: 'Max 50 per broadcast' });

  const broadcastId = crypto.randomUUID();
  const result = await executeBroadcast(accountId, chatIds, message, broadcastId, req.body.name);
  res.json({ ...result, broadcastId });
});

// Auto-broadcast events (fetches from Kartis, sends to groups)
app.post('/api/whatsapp/broadcast-events', async (req, res) => {
  const accountId = req.body.account || 'default';
  const acc = accounts.get(accountId);
  if (!acc) return res.status(404).json({ error: `Account "${accountId}" not found` });
  if (!acc.ready && acc.status !== 'authenticated') return res.status(503).json({ error: `Not connected (status: ${acc.status})` });

  const chatIds = req.body.chatIds || req.body.groupIds;
  const maxEvents = req.body.maxEvents || 5;

  if (!chatIds || !Array.isArray(chatIds) || chatIds.length === 0)
    return res.status(400).json({ error: 'chatIds/groupIds required' });

  try {
    const message = await formatEventsForBroadcast(maxEvents);
    const broadcastId = crypto.randomUUID();
    const result = await executeBroadcast(accountId, chatIds, message, broadcastId, 'Event Broadcast');
    res.json({ ...result, message, broadcastId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Kartis Webhook Receiver ────────────────────────────────────────────

app.post('/api/webhooks/kartis', async (req, res) => {
  // Verify HMAC-SHA256 signature (X-Kartis-Signature header)
  if (!KARTIS_WEBHOOK_SECRET) {
    console.warn('Kartis webhook: KARTIS_WEBHOOK_SECRET not configured');
    return res.status(500).json({ error: 'Webhook secret not configured' });
  }

  const signature = req.headers['x-kartis-signature'];
  if (!signature) {
    // Fallback: also accept legacy x-webhook-secret for backward compat
    const legacySecret = req.headers['x-webhook-secret'];
    if (!legacySecret || legacySecret !== KARTIS_WEBHOOK_SECRET) {
      console.warn('Kartis webhook: missing signature header');
      return res.status(401).json({ error: 'Missing or invalid signature' });
    }
  } else {
    const rawBody = JSON.stringify(req.body);
    const expected = crypto.createHmac('sha256', KARTIS_WEBHOOK_SECRET).update(rawBody).digest('hex');
    const sigValue = signature.startsWith('sha256=') ? signature.slice(7) : signature;
    if (!crypto.timingSafeEqual(Buffer.from(sigValue, 'hex'), Buffer.from(expected, 'hex'))) {
      console.warn('Kartis webhook: signature mismatch');
      return res.status(401).json({ error: 'Invalid signature' });
    }
  }

  // Accept both payload formats:
  //   New: { type, timestamp, data: { event } }
  //   Legacy: { event, data }
  const payload = req.body;
  const eventType = payload.type || payload.event;
  const eventData = payload.data?.event || payload.data;

  console.log(`Kartis webhook received: ${eventType}`, eventData?.name || '');

  // Respond 200 immediately, process async
  res.json({ ok: true, received: eventType });

  if (eventType !== 'event.published') {
    console.log(`Kartis webhook: skipping unhandled event type "${eventType}"`);
    return;
  }

  // Find a ready account to broadcast from
  let accountId = 'default';
  let acc = accounts.get(accountId);
  if (!acc || !acc.ready) {
    for (const [id, a] of accounts) {
      if (a.ready) { accountId = id; acc = a; break; }
    }
  }
  if (!acc || !acc.ready) {
    console.warn('Kartis webhook: no ready WhatsApp account for broadcast');
    return;
  }

  try {
    // Get groups — prefer tagged groups (kartis/events), fallback to all
    const chats = await acc.client.getChats();
    const allGroupIds = chats.filter(c => c.isGroup).map(c => c.id._serialized);
    const groupTags = loadJSON(GROUP_TAGS_FILE, {});

    const taggedGroupIds = allGroupIds.filter(gid => {
      const tags = groupTags[gid] || [];
      return tags.includes('kartis') || tags.includes('events') || tags.includes('auto-announce');
    });

    const groupIds = taggedGroupIds.length > 0 ? taggedGroupIds : allGroupIds;
    const targetType = taggedGroupIds.length > 0 ? 'tagged' : 'all';

    if (groupIds.length === 0) {
      console.warn('Kartis webhook: no groups to broadcast to');
      return;
    }

    // Format message using existing event-announcement template if available
    const templates = loadJSON(TEMPLATES_FILE, []);
    const tpl = templates.find(t => t.id === 'event-announcement');
    let message;

    if (tpl && eventData) {
      // Build event object compatible with formatEventWithTemplate
      const ev = {
        name: eventData.name || 'New Event',
        date: eventData.date || new Date().toISOString(),
        time: eventData.time || '',
        venue: eventData.venue || '',
        location: eventData.location || '',
        price: eventData.price || '',
        ticketUrl: eventData.ticketUrl || eventData.slug
          ? `https://kartis-astro.vercel.app/en/event/${eventData.slug}`
          : `${KARTIS_URL}/events`,
      };
      message = formatEventWithTemplate(ev, tpl.message);
    } else {
      // Fallback inline format
      const d = eventData?.date ? new Date(eventData.date) : null;
      const dateStr = d ? d.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' }) : 'TBA';
      const ticketUrl = eventData?.slug
        ? `https://kartis-astro.vercel.app/en/event/${eventData.slug}`
        : eventData?.ticketUrl || '';
      message = `🎉 *${eventData?.name || 'New Event'}*\n\n` +
        `📅 ${dateStr}${eventData?.time ? ' | ' + eventData.time : ''}\n` +
        `${eventData?.venue ? '📍 ' + eventData.venue + '\n' : ''}` +
        `${ticketUrl ? '🎟️ Tickets: ' + ticketUrl + '\n' : ''}` +
        `\n_The Best Parties 🐙_`;
    }

    const broadcastId = crypto.randomUUID();
    const result = await executeBroadcast(accountId, groupIds, message, broadcastId, `Webhook: ${eventData?.name || 'New Event'}`);
    console.log(`Kartis webhook broadcast complete: target=${targetType} (${groupIds.length} groups), sent=${result.sent}, failed=${result.failed}`);

    // Track announced event
    const announced = loadJSON(ANNOUNCED_FILE, {});
    announced[eventData?.id || eventData?.name || broadcastId] = {
      announcedAt: new Date().toISOString(),
      type: 'webhook',
      source: 'kartis',
    };
    saveJSON(ANNOUNCED_FILE, announced);

    // ── Persona auto-broadcast: each persona DMs their own contact list ──
    try {
      const loadedPersonas = loadJSON(PERSONAS_FILE, []);
      for (const persona of loadedPersonas) {
        if (!persona.contacts || persona.contacts.length === 0) continue;
        const tplMsg = persona.templates?.eventAnnouncement;
        if (!tplMsg) continue;

        const evVars = {
          name: '{name}', // Will be replaced per-contact below
          eventName: eventData?.name || 'New Event',
          date: eventData?.date ? new Date(eventData.date).toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' }) : 'TBA',
          day: eventData?.date ? new Date(eventData.date).toLocaleDateString('en-US', { weekday: 'long' }) : '',
          venue: eventData?.venue || '',
          ticketUrl: eventData?.slug
            ? `https://kartis-astro.vercel.app/en/event/${eventData.slug}`
            : eventData?.ticketUrl || `${KARTIS_URL}/events`,
        };

        let personaSent = 0, personaFailed = 0;
        for (const phone of persona.contacts) {
          const phoneId = phone.replace(/[^0-9]/g, '');
          const crmContact = getCrmContact(phoneId);
          const contactName = crmContact ? (crmContact.name || crmContact.pushName || 'there') : 'there';

          const personalVars = { ...evVars, name: contactName };
          const personalMsg = formatPersonaTemplate(tplMsg, personalVars);

          try {
            await acc.client.sendMessage(phoneId + '@c.us', personalMsg);
            personaSent++;
            if (personaSent < persona.contacts.length) await new Promise(r => setTimeout(r, 3000));
          } catch (dmErr) {
            console.error(`Persona ${persona.name} webhook DM failed for ${phone}:`, dmErr.message);
            personaFailed++;
          }
        }
        console.log(`Persona ${persona.name} webhook broadcast: sent=${personaSent}, failed=${personaFailed}`);
      }
    } catch (personaErr) {
      console.error('Persona webhook broadcast error:', personaErr.message);
    }

  } catch (err) {
    console.error('Kartis webhook broadcast error:', err.message);
  }
});

// ─── Auto-Announce Endpoint ─────────────────────────────────────────────

app.post('/api/whatsapp/auto-announce', async (req, res) => {
  const accountId = req.body.account || 'default';
  const acc = accounts.get(accountId);
  if (!acc) return res.status(404).json({ error: `Account "${accountId}" not found` });
  if (!acc.ready && acc.status !== 'authenticated') return res.status(503).json({ error: `Not connected (status: ${acc.status})` });

  const templateName = req.body.template || 'event-announcement';
  const maxEvents = req.body.maxEvents || 3;
  let groupIds = req.body.groupIds;

  // Resolve template
  const templates = loadJSON(TEMPLATES_FILE, []);
  const tpl = templates.find(t => t.id === templateName);
  if (!tpl) return res.status(404).json({ error: `Template "${templateName}" not found` });

  try {
    // If no groupIds, use all groups
    if (!groupIds || !Array.isArray(groupIds) || groupIds.length === 0) {
      const chats = await acc.client.getChats();
      groupIds = chats.filter(c => c.isGroup).map(c => c.id._serialized);
    }

    if (groupIds.length === 0) return res.status(400).json({ error: 'No groups available' });

    // Fetch events and format with template
    const events = await fetchEvents();
    const upcoming = getUpcoming(events).slice(0, maxEvents);
    if (upcoming.length === 0) return res.json({ ok: true, sent: 0, message: 'No upcoming events' });

    const messages = upcoming.map(e => formatEventWithTemplate(e, tpl.message));
    const fullMessage = messages.join('\n\n───────────────\n\n');

    const broadcastId = crypto.randomUUID();
    const result = await executeBroadcast(accountId, groupIds, fullMessage, broadcastId, `Auto-Announce: ${tpl.name}`);

    // Track announced events
    const announced = loadJSON(ANNOUNCED_FILE, {});
    for (const e of upcoming) {
      announced[e.id || e.name] = { announcedAt: new Date().toISOString(), type: templateName };
    }
    saveJSON(ANNOUNCED_FILE, announced);

    res.json({ ...result, broadcastId, eventsAnnounced: upcoming.length, message: fullMessage });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Scheduled Broadcasts ───────────────────────────────────────────────

app.post('/api/whatsapp/schedule', (req, res) => {
  const { chatIds, message, sendAt, name, account, templateId, variables } = req.body;
  const accountId = account || 'default';

  if (!accounts.has(accountId)) return res.status(404).json({ error: `Account "${accountId}" not found` });

  let finalMessage = message;
  if (templateId) {
    const templates = loadJSON(TEMPLATES_FILE, []);
    const tpl = templates.find(t => t.id === templateId);
    if (!tpl) return res.status(404).json({ error: `Template "${templateId}" not found` });
    finalMessage = applyTemplate(tpl.message, variables || {});
  }

  if (!chatIds || !Array.isArray(chatIds) || chatIds.length === 0)
    return res.status(400).json({ error: 'chatIds required' });
  if (!finalMessage || typeof finalMessage !== 'string')
    return res.status(400).json({ error: 'message required (or use templateId)' });
  if (!sendAt) return res.status(400).json({ error: 'sendAt required (ISO 8601)' });

  const sendAtDate = new Date(sendAt);
  if (isNaN(sendAtDate.getTime())) return res.status(400).json({ error: 'Invalid sendAt date' });
  if (sendAtDate.getTime() <= Date.now()) return res.status(400).json({ error: 'sendAt must be in the future' });

  const id = crypto.randomUUID();
  const schedule = {
    id,
    name: name || null,
    account: accountId,
    chatIds,
    message: finalMessage,
    sendAt: sendAtDate.toISOString(),
    status: 'pending',
    createdAt: new Date().toISOString(),
  };

  const schedules = loadJSON(SCHEDULES_FILE, []);
  schedules.push(schedule);
  saveJSON(SCHEDULES_FILE, schedules);

  res.json({ ok: true, schedule });
});

app.get('/api/whatsapp/schedules', (req, res) => {
  const schedules = loadJSON(SCHEDULES_FILE, []);
  const pending = schedules.filter(s => s.status === 'pending');
  res.json({ schedules: pending });
});

app.delete('/api/whatsapp/schedules/:id', (req, res) => {
  const schedules = loadJSON(SCHEDULES_FILE, []);
  const idx = schedules.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Schedule not found' });
  if (schedules[idx].status !== 'pending') return res.status(400).json({ error: 'Can only cancel pending schedules' });
  schedules[idx].status = 'cancelled';
  saveJSON(SCHEDULES_FILE, schedules);
  res.json({ ok: true, cancelled: req.params.id });
});

// ─── Recurring Broadcast Schedules ──────────────────────────────────────

// GET /api/whatsapp/recurring — list all recurring schedules
app.get('/api/whatsapp/recurring', (req, res) => {
  const recurrings = loadJSON(RECURRING_FILE, []);
  const withNext = recurrings.map(r => ({
    ...r,
    nextRun: r.enabled ? getNextCronRun(r.cron) : null,
  }));
  res.json({ ok: true, schedules: withNext, presets: CRON_PRESETS });
});

// POST /api/whatsapp/recurring — create recurring schedule
app.post('/api/whatsapp/recurring', (req, res) => {
  const { name, cron, preset, chatIds, message, account, templateId, variables, includeNextEvent, endDate } = req.body;
  const accountId = account || 'default';

  if (!accounts.has(accountId)) return res.status(404).json({ error: `Account "${accountId}" not found` });

  // Resolve cron from preset or direct
  let cronExpr = cron;
  if (preset && CRON_PRESETS[preset]) {
    cronExpr = CRON_PRESETS[preset].cron;
  }
  if (!cronExpr || cronExpr.trim().split(/\s+/).length !== 5) {
    return res.status(400).json({ error: 'Valid cron expression required (5 fields: min hour dom month dow) or use a preset' });
  }

  // Resolve message from template if needed
  let finalMessage = message;
  if (templateId) {
    const templates = loadJSON(TEMPLATES_FILE, []);
    const tpl = templates.find(t => t.id === templateId);
    if (!tpl) return res.status(404).json({ error: `Template "${templateId}" not found` });
    finalMessage = applyTemplate(tpl.message, variables || {});
  }

  if (!chatIds || !Array.isArray(chatIds) || chatIds.length === 0)
    return res.status(400).json({ error: 'chatIds required' });
  if (!finalMessage || typeof finalMessage !== 'string')
    return res.status(400).json({ error: 'message required (or use templateId)' });

  const id = crypto.randomUUID();
  const recurring = {
    id,
    name: name || null,
    account: accountId,
    cron: cronExpr,
    cronLabel: preset ? CRON_PRESETS[preset].label : cronExpr,
    chatIds,
    message: finalMessage,
    includeNextEvent: !!includeNextEvent,
    enabled: true,
    endDate: endDate || null,
    fireCount: 0,
    lastFiredAt: null,
    lastResult: null,
    createdAt: new Date().toISOString(),
  };

  const recurrings = loadJSON(RECURRING_FILE, []);
  recurrings.push(recurring);
  saveJSON(RECURRING_FILE, recurrings);

  res.json({
    ok: true,
    schedule: { ...recurring, nextRun: getNextCronRun(cronExpr) },
  });
});

// PUT /api/whatsapp/recurring/:id — update recurring schedule
app.put('/api/whatsapp/recurring/:id', (req, res) => {
  const recurrings = loadJSON(RECURRING_FILE, []);
  const idx = recurrings.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Recurring schedule not found' });

  const allowed = ['name', 'cron', 'chatIds', 'message', 'enabled', 'includeNextEvent', 'endDate'];
  for (const key of allowed) {
    if (req.body[key] !== undefined) recurrings[idx][key] = req.body[key];
  }

  // Update label if cron changed
  if (req.body.cron) {
    const preset = Object.entries(CRON_PRESETS).find(([, v]) => v.cron === req.body.cron);
    recurrings[idx].cronLabel = preset ? preset[1].label : req.body.cron;
  }

  saveJSON(RECURRING_FILE, recurrings);
  res.json({
    ok: true,
    schedule: { ...recurrings[idx], nextRun: recurrings[idx].enabled ? getNextCronRun(recurrings[idx].cron) : null },
  });
});

// DELETE /api/whatsapp/recurring/:id — delete recurring schedule
app.delete('/api/whatsapp/recurring/:id', (req, res) => {
  const recurrings = loadJSON(RECURRING_FILE, []);
  const idx = recurrings.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Recurring schedule not found' });
  recurrings.splice(idx, 1);
  saveJSON(RECURRING_FILE, recurrings);
  res.json({ ok: true, deleted: req.params.id });
});

// POST /api/whatsapp/recurring/:id/trigger — manually trigger a recurring broadcast now
app.post('/api/whatsapp/recurring/:id/trigger', async (req, res) => {
  const recurrings = loadJSON(RECURRING_FILE, []);
  const rec = recurrings.find(r => r.id === req.params.id);
  if (!rec) return res.status(404).json({ error: 'Recurring schedule not found' });

  try {
    let message = rec.message;
    if (rec.includeNextEvent) {
      try {
        const evRes = await fetch(KARTIS_EVENTS_URL);
        const events = await evRes.json();
        const upcoming = (Array.isArray(events) ? events : events.events || [])
          .filter(e => new Date(e.date || e.startDate).getTime() > Date.now())
          .sort((a, b) => new Date(a.date || a.startDate) - new Date(b.date || b.startDate));
        const next = upcoming[0];
        if (next) {
          const vars = {
            eventName: next.name || next.title || 'Upcoming Event',
            eventDate: new Date(next.date || next.startDate).toLocaleDateString('en-ZA', { weekday: 'long', month: 'long', day: 'numeric' }),
            eventVenue: next.venue || next.location || 'TBA',
            ticketLink: `${KARTIS_URL}/events/${next.slug || next.id}`,
          };
          message = message.replace(/\{\{(\w+)\}\}/g, (match, key) => vars[key] || match);
        }
      } catch { /* use raw message */ }
    }

    const result = await executeBroadcast(rec.account || 'default', rec.chatIds, message, crypto.randomUUID(), `Manual: ${rec.name}`);
    rec.lastFiredAt = new Date().toISOString();
    rec.fireCount = (rec.fireCount || 0) + 1;
    rec.lastResult = { sent: result.sent, failed: result.failed, at: new Date().toISOString() };
    saveJSON(RECURRING_FILE, recurrings);

    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Alias routes
app.get('/api/recurring', (req, res, next) => { req.url = '/api/whatsapp/recurring'; next(); });
app.post('/api/recurring', (req, res, next) => { req.url = '/api/whatsapp/recurring'; next(); });

// ─── Message Templates ──────────────────────────────────────────────────

app.post('/api/whatsapp/templates', (req, res) => {
  const { id, name, message } = req.body;
  if (!id || typeof id !== 'string') return res.status(400).json({ error: 'id required' });
  if (!message || typeof message !== 'string') return res.status(400).json({ error: 'message required' });

  const templates = loadJSON(TEMPLATES_FILE, []);
  const existing = templates.findIndex(t => t.id === id);
  const tpl = { id, name: name || id, message, updatedAt: new Date().toISOString() };

  if (existing >= 0) {
    templates[existing] = tpl;
  } else {
    tpl.createdAt = new Date().toISOString();
    templates.push(tpl);
  }

  saveJSON(TEMPLATES_FILE, templates);
  res.json({ ok: true, template: tpl });
});

app.get('/api/whatsapp/templates', (req, res) => {
  const templates = loadJSON(TEMPLATES_FILE, []);
  res.json({ templates });
});

app.delete('/api/whatsapp/templates/:id', (req, res) => {
  const templates = loadJSON(TEMPLATES_FILE, []);
  const filtered = templates.filter(t => t.id !== req.params.id);
  if (filtered.length === templates.length) return res.status(404).json({ error: 'Template not found' });
  saveJSON(TEMPLATES_FILE, filtered);
  res.json({ ok: true, deleted: req.params.id });
});

// ─── Broadcast History ──────────────────────────────────────────────────

app.get('/api/whatsapp/history', (req, res) => {
  const history = loadJSON(HISTORY_FILE, []);
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  res.json({ history: history.slice(0, limit) });
});

app.get('/api/whatsapp/history/:id', (req, res) => {
  const history = loadJSON(HISTORY_FILE, []);
  const entry = history.find(h => h.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'Broadcast not found' });
  res.json({ broadcast: entry });
});

// ─── Group Labels/Tags ──────────────────────────────────────────────────

app.post('/api/whatsapp/groups/:groupId/tags', (req, res) => {
  const { groupId } = req.params;
  const { tags } = req.body;
  if (!tags || !Array.isArray(tags)) return res.status(400).json({ error: 'tags array required' });

  const allTags = loadJSON(GROUP_TAGS_FILE, {});
  allTags[groupId] = [...new Set(tags.map(t => t.trim().toLowerCase()))];
  saveJSON(GROUP_TAGS_FILE, allTags);

  res.json({ ok: true, groupId, tags: allTags[groupId] });
});

app.get('/api/whatsapp/groups/:groupId/tags', (req, res) => {
  const allTags = loadJSON(GROUP_TAGS_FILE, {});
  res.json({ groupId: req.params.groupId, tags: allTags[req.params.groupId] || [] });
});

// ─── Auto-Response Rules ────────────────────────────────────────────────

app.post('/api/whatsapp/auto-rules', (req, res) => {
  const { keywords, response, enabled, account } = req.body;
  if (!keywords || !Array.isArray(keywords) || keywords.length === 0)
    return res.status(400).json({ error: 'keywords array required' });
  if (!response || typeof response !== 'string')
    return res.status(400).json({ error: 'response required' });

  const rules = loadJSON(AUTO_RULES_FILE, []);
  const id = crypto.randomUUID();
  const rule = {
    id,
    keywords,
    response,
    enabled: enabled !== false,
    account: account || null,
    createdAt: new Date().toISOString(),
  };
  rules.push(rule);
  saveJSON(AUTO_RULES_FILE, rules);
  res.json({ ok: true, rule });
});

app.get('/api/whatsapp/auto-rules', (req, res) => {
  const rules = loadJSON(AUTO_RULES_FILE, []);
  res.json({ rules });
});

app.put('/api/whatsapp/auto-rules/:id', (req, res) => {
  const rules = loadJSON(AUTO_RULES_FILE, []);
  const idx = rules.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Rule not found' });

  const { keywords, response, enabled, account } = req.body;
  if (keywords !== undefined) rules[idx].keywords = keywords;
  if (response !== undefined) rules[idx].response = response;
  if (enabled !== undefined) rules[idx].enabled = enabled;
  if (account !== undefined) rules[idx].account = account;
  rules[idx].updatedAt = new Date().toISOString();

  saveJSON(AUTO_RULES_FILE, rules);
  res.json({ ok: true, rule: rules[idx] });
});

app.delete('/api/whatsapp/auto-rules/:id', (req, res) => {
  const rules = loadJSON(AUTO_RULES_FILE, []);
  const filtered = rules.filter(r => r.id !== req.params.id);
  if (filtered.length === rules.length) return res.status(404).json({ error: 'Rule not found' });
  saveJSON(AUTO_RULES_FILE, filtered);
  res.json({ ok: true, deleted: req.params.id });
});

// ─── Seed Ticket Auto-Rule ───────────────────────────────────────────────

app.post('/api/whatsapp/auto-rules/seed-tickets', (req, res) => {
  const rules = loadJSON(AUTO_RULES_FILE, []);
  // Don't duplicate if a ticket rule already exists
  const existing = rules.find(r => r.keywords && r.keywords.includes('tickets') && r.keywords.includes('rsvp'));
  if (existing) {
    return res.json({ ok: true, message: 'Ticket auto-rule already exists', rule: existing });
  }

  const id = crypto.randomUUID();
  const rule = {
    id,
    keywords: [
      'tickets', 'ticket', 'rsvp', 'link', 'buy tickets', 'get tickets',
      'where to buy', 'how to buy', 'ticket link', 'booking',
      'כרטיס', 'כרטיסים', 'טיקט', 'טיקטים', 'הזמנה', 'קישור', 'לינק',
      'איפה קונים', 'לקנות כרטיס',
    ],
    response: '🎟️ *Get Your Tickets Here!*\n\n{nextEvent}\n\n👉 Book now: {ticketLink}\n\n_The Best Parties 🐙_',
    enabled: true,
    account: null,
    createdAt: new Date().toISOString(),
    type: 'ticket-link',
  };
  rules.push(rule);
  saveJSON(AUTO_RULES_FILE, rules);
  console.log('Seeded default ticket auto-rule with Kartis link templates');
  res.json({ ok: true, rule });
});

// ─── Cooldown Endpoints ──────────────────────────────────────────────────

app.get('/api/whatsapp/cooldowns', (req, res) => {
  const cooldownMin = getCooldownMinutes();
  const active = [];
  for (const [groupId, ts] of groupCooldowns) {
    const elapsed = Date.now() - ts;
    const cooldownMs = cooldownMin * 60 * 1000;
    if (elapsed < cooldownMs) {
      active.push({
        groupId,
        lastResponseAt: new Date(ts).toISOString(),
        expiresAt: new Date(ts + cooldownMs).toISOString(),
        remainingSeconds: Math.round((cooldownMs - elapsed) / 1000),
      });
    }
  }
  res.json({ cooldowns: active, cooldownMinutes: cooldownMin });
});

app.post('/api/whatsapp/cooldowns/reset', (req, res) => {
  const count = groupCooldowns.size;
  groupCooldowns.clear();
  console.log(`Cooldowns reset (cleared ${count} entries)`);
  res.json({ ok: true, cleared: count });
});

// ─── Contact Endpoints ──────────────────────────────────────────────────

app.get('/api/whatsapp/contacts', (req, res) => {
  const contacts = loadJSON(CONTACTS_FILE, []);
  res.json({ contacts });
});

app.get('/api/whatsapp/contacts/export', (req, res) => {
  const contacts = loadJSON(CONTACTS_FILE, []);
  const header = 'phone,name,tags,firstMessage,capturedAt,lastMessageAt';
  const rows = contacts.map(c => {
    const escape = (s) => `"${(s || '').replace(/"/g, '""')}"`;
    return [escape(c.phone), escape(c.name), escape((c.tags || []).join(';')),
            escape(c.firstMessage), escape(c.capturedAt), escape(c.lastMessageAt)].join(',');
  });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=contacts.csv');
  res.send([header, ...rows].join('\n'));
});

app.delete('/api/whatsapp/contacts/:id', (req, res) => {
  const contacts = loadJSON(CONTACTS_FILE, []);
  const filtered = contacts.filter(c => c.id !== req.params.id);
  if (filtered.length === contacts.length) return res.status(404).json({ error: 'Contact not found' });
  saveJSON(CONTACTS_FILE, filtered);
  res.json({ ok: true, deleted: req.params.id });
});

// ─── Settings Endpoints (Quiet Hours, Cooldown, CRM) ────────────────────

app.get('/api/whatsapp/settings', (req, res) => {
  const settings = loadJSON(SETTINGS_FILE, {});
  const { start, end } = getQuietHours();
  const crmSettings = getCrmSettings();
  res.json({
    quietStart: start,
    quietEnd: end,
    cooldownMinutes: getCooldownMinutes(),
    isQuietNow: isQuietHours(),
    autoAnnounceEnabled: false,
    ...crmSettings,
    ...settings,
  });
});

app.put('/api/whatsapp/settings', (req, res) => {
  const settings = loadJSON(SETTINGS_FILE, {});
  const { quietStart, quietEnd, cooldownMinutes, autoDmEnabled, autoDmTemplate, autoDmCooldownHours, scrapeIntervalHours, autoAnnounceEnabled } = req.body;
  if (quietStart !== undefined) settings.quietStart = quietStart;
  if (quietEnd !== undefined) settings.quietEnd = quietEnd;
  if (cooldownMinutes !== undefined) settings.cooldownMinutes = Number(cooldownMinutes);
  if (autoDmEnabled !== undefined) settings.autoDmEnabled = Boolean(autoDmEnabled);
  if (autoDmTemplate !== undefined) settings.autoDmTemplate = String(autoDmTemplate);
  if (autoDmCooldownHours !== undefined) settings.autoDmCooldownHours = Number(autoDmCooldownHours);
  if (scrapeIntervalHours !== undefined) {
    settings.scrapeIntervalHours = Number(scrapeIntervalHours);
    startScrapeSchedule(); // Restart schedule with new interval
  }
  if (autoAnnounceEnabled !== undefined) settings.autoAnnounceEnabled = Boolean(autoAnnounceEnabled);
  saveJSON(SETTINGS_FILE, settings);
  res.json({ ok: true, settings });
});

// ─── Group Stats Endpoint ───────────────────────────────────────────────

app.get('/api/whatsapp/groups/stats', (req, res) => {
  const stats = loadJSON(GROUP_STATS_FILE, {});
  const sorted = Object.entries(stats)
    .map(([groupId, s]) => ({ groupId, ...s }))
    .sort((a, b) => {
      const aTime = a.lastQueryAt || a.lastResponseAt || '';
      const bTime = b.lastQueryAt || b.lastResponseAt || '';
      return bTime.localeCompare(aTime);
    });
  res.json({ stats: sorted });
});

// ─── Scanner Feed & Stats Endpoints ─────────────────────────────────────

app.get('/api/whatsapp/scanner/feed', (req, res) => {
  res.json({ feed: scannerFeed });
});

app.get('/api/whatsapp/scanner/stats', (req, res) => {
  const todayStr = new Date().toISOString().slice(0, 10);
  const todayEntries = scannerFeed.filter(e => e.timestamp.startsWith(todayStr));
  const totalQueries = todayEntries.length;
  const totalResponses = todayEntries.filter(e => e.responded).length;
  const activeGroups = new Set(todayEntries.map(e => e.groupId)).size;
  res.json({ totalQueriesToday: totalQueries, totalResponsesToday: totalResponses, activeGroupsToday: activeGroups });
});

// ─── Leads Monitor Endpoints ─────────────────────────────────────────────

app.get('/api/whatsapp/leads', (req, res) => {
  const filters = {
    status: req.query.status,
    group: req.query.group,
    account: req.query.account,
    minConfidence: req.query.minConfidence,
    category: req.query.category,
    language: req.query.language,
    limit: req.query.limit,
    offset: req.query.offset,
  };
  res.json(leads.getLeads(filters));
});

app.get('/api/whatsapp/leads/stats', (req, res) => {
  res.json(leads.getLeadStats());
});

app.get('/api/whatsapp/leads/export', (req, res) => {
  const csv = leads.exportLeadsCsv({
    status: req.query.status,
    group: req.query.group,
    account: req.query.account,
  });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=leads.csv');
  res.send(csv);
});

app.put('/api/whatsapp/leads/:id', (req, res) => {
  const { status, note } = req.body;
  if (!status) return res.status(400).json({ error: 'status required' });
  try {
    const lead = leads.updateLeadStatus(req.params.id, status, note);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    res.json({ ok: true, lead });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/whatsapp/keywords', (req, res) => {
  res.json(leads.getCustomKeywords());
});

app.post('/api/whatsapp/keywords', (req, res) => {
  const { keywords, category } = req.body;
  if (!keywords || !Array.isArray(keywords) || !category) {
    return res.status(400).json({ error: 'keywords[] and category required' });
  }
  try {
    const updated = leads.setCustomKeywords({ keywords, category });
    res.json({ ok: true, custom: updated });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/whatsapp/keywords/:keyword', (req, res) => {
  const keyword = decodeURIComponent(req.params.keyword);
  const removed = leads.removeCustomKeyword(keyword);
  if (!removed) return res.status(404).json({ error: 'Keyword not found in custom keywords' });
  res.json({ ok: true, deleted: keyword });
});

// ─── CRM Scrape Endpoints ───────────────────────────────────────────────

app.post('/api/whatsapp/scrape', async (req, res) => {
  try {
    const result = await scrapeAllGroups();
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/whatsapp/scrape/:groupId', async (req, res) => {
  const { groupId } = req.params;
  const accountId = req.body.account || 'default';
  const acc = accounts.get(accountId);
  if (!acc || (!acc.ready && acc.status !== 'authenticated')) return res.status(503).json({ error: `Account not ready (status: ${acc?.status})` });

  try {
    const chats = await acc.client.getChats();
    const group = chats.find(c => c.isGroup && c.id._serialized === groupId);
    if (!group) return res.status(404).json({ error: 'Group not found' });
    const result = await scrapeGroupParticipants(acc.client, group);
    saveCRM();
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── CRM Contact Endpoints ─────────────────────────────────────────────

app.get('/api/whatsapp/crm/contacts', (req, res) => {
  let contactList = Array.from(crmContacts.values()).map(c => {
    c.score = calculateScore(c);
    c.status = c.blocked ? 'blocked' : statusFromScore(c.score);
    return c;
  });

  // Filter by status
  if (req.query.status) {
    const statuses = req.query.status.split(',').map(s => s.trim());
    contactList = contactList.filter(c => statuses.includes(c.status));
  }

  // Filter by tags
  if (req.query.tags) {
    const tags = req.query.tags.split(',').map(t => t.trim().toLowerCase());
    contactList = contactList.filter(c => c.tags.some(t => tags.includes(t.toLowerCase())));
  }

  // Filter by list
  if (req.query.list) {
    contactList = contactList.filter(c => c.lists.includes(req.query.list));
  }

  // Search by name/phone
  if (req.query.q) {
    const q = req.query.q.toLowerCase();
    contactList = contactList.filter(c =>
      (c.name && c.name.toLowerCase().includes(q)) ||
      (c.pushName && c.pushName.toLowerCase().includes(q)) ||
      (c.phone && c.phone.includes(q)) ||
      (c.id && c.id.includes(q))
    );
  }

  // Sort
  const sort = req.query.sort || 'updatedAt';
  if (sort === 'score') {
    contactList.sort((a, b) => (b.score || 0) - (a.score || 0));
  } else if (sort === 'lastActive') {
    contactList.sort((a, b) => {
      const aTime = a.profile?.lastActive || a.updatedAt || '';
      const bTime = b.profile?.lastActive || b.updatedAt || '';
      return bTime.localeCompare(aTime);
    });
  } else {
    contactList.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }

  // Pagination
  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  const offset = parseInt(req.query.offset) || 0;
  const total = contactList.length;
  contactList = contactList.slice(offset, offset + limit);

  res.json({ contacts: contactList, total, limit, offset });
});

app.get('/api/whatsapp/crm/contacts/stats', (req, res) => {
  const all = Array.from(crmContacts.values());
  const byStatus = {};
  const bySource = {};
  for (const c of all) {
    const score = calculateScore(c);
    const status = c.blocked ? 'blocked' : statusFromScore(score);
    byStatus[status] = (byStatus[status] || 0) + 1;
    const groupName = c.source?.groupName || 'unknown';
    bySource[groupName] = (bySource[groupName] || 0) + 1;
  }
  res.json({ total: all.length, byStatus, bySource });
});

app.get('/api/whatsapp/crm/contacts/export', (req, res) => {
  const all = Array.from(crmContacts.values());
  const escape = (s) => `"${(s || '').toString().replace(/"/g, '""')}"`;
  const header = 'id,phone,name,pushName,status,score,tags,lists,language,messageCount,firstMessage,lastMessage,dmSent,responded,createdAt,updatedAt';
  const rows = all.map(c => [
    escape(c.id), escape(c.phone), escape(c.name), escape(c.pushName),
    escape(c.blocked ? 'blocked' : statusFromScore(calculateScore(c))),
    calculateScore(c),
    escape((c.tags || []).join(';')), escape((c.lists || []).join(';')),
    escape(c.profile?.language), c.profile?.messageCount || 0,
    escape(c.profile?.firstMessage), escape(c.profile?.lastMessage),
    c.profile?.dmSent || false, c.profile?.responded || false,
    escape(c.createdAt), escape(c.updatedAt),
  ].join(','));

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=crm-contacts.csv');
  res.send([header, ...rows].join('\n'));
});

app.get('/api/whatsapp/crm/contacts/:id', (req, res) => {
  const contact = getCrmContact(req.params.id);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  res.json({ contact });
});

app.put('/api/whatsapp/crm/contacts/:id', (req, res) => {
  const contact = getCrmContact(req.params.id);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });

  const { tags, status, name, notes, score } = req.body;
  const updates = {};
  if (tags) updates.tags = tags;
  if (name) updates.name = name;
  if (score !== undefined) updates.score = Number(score);
  if (status === 'customer' || status === 'vip') {
    if (status === 'customer') updates.score = 75;
    if (status === 'vip') updates.score = 90;
  }
  if (notes !== undefined) updates.profile = { ...updates.profile, notes };

  const updated = upsertCrmContact(req.params.id, updates);
  saveCRM();
  res.json({ ok: true, contact: updated });
});

app.delete('/api/whatsapp/crm/contacts/:id', (req, res) => {
  if (!crmContacts.has(req.params.id)) return res.status(404).json({ error: 'Contact not found' });
  crmContacts.delete(req.params.id);
  crmDirty = true;
  saveCRM();
  res.json({ ok: true, deleted: req.params.id });
});

app.post('/api/whatsapp/crm/contacts/:id/dm', async (req, res) => {
  const contact = getCrmContact(req.params.id);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  if (contact.blocked) return res.status(400).json({ error: 'Contact is blocked' });

  const { message, account } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });

  const accountId = account || 'default';
  const acc = accounts.get(accountId);
  if (!acc || (!acc.ready && acc.status !== 'authenticated')) return res.status(503).json({ error: `Account not ready (status: ${acc?.status})` });

  try {
    const jid = contact.id + '@c.us';
    await acc.client.sendMessage(jid, message);
    upsertCrmContact(contact.id, {
      profile: { dmSent: true, dmSentAt: new Date().toISOString() },
    });
    saveCRM();
    res.json({ ok: true, sent: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Contact Lists ──────────────────────────────────────────────────────

app.post('/api/whatsapp/lists', (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  const lists = loadJSON(LISTS_FILE, []);
  if (lists.find(l => l.id === id)) return res.status(409).json({ error: 'List already exists' });

  const list = { id, name, description: description || '', createdAt: new Date().toISOString() };
  lists.push(list);
  saveJSON(LISTS_FILE, lists);
  res.json({ ok: true, list });
});

app.get('/api/whatsapp/lists', (req, res) => {
  const lists = loadJSON(LISTS_FILE, []);
  const all = Array.from(crmContacts.values());
  const result = lists.map(l => ({
    ...l,
    contactCount: all.filter(c => c.lists.includes(l.id)).length,
  }));
  res.json({ lists: result });
});

app.get('/api/whatsapp/lists/:id', (req, res) => {
  const lists = loadJSON(LISTS_FILE, []);
  const list = lists.find(l => l.id === req.params.id);
  if (!list) return res.status(404).json({ error: 'List not found' });

  const contacts = Array.from(crmContacts.values())
    .filter(c => c.lists.includes(req.params.id))
    .map(c => { c.score = calculateScore(c); c.status = c.blocked ? 'blocked' : statusFromScore(c.score); return c; });

  res.json({ list, contacts });
});

app.post('/api/whatsapp/lists/:id/contacts', (req, res) => {
  const { contactIds } = req.body;
  if (!contactIds || !Array.isArray(contactIds)) return res.status(400).json({ error: 'contactIds array required' });

  const lists = loadJSON(LISTS_FILE, []);
  if (!lists.find(l => l.id === req.params.id)) return res.status(404).json({ error: 'List not found' });

  let added = 0;
  for (const cid of contactIds) {
    const contact = crmContacts.get(cid);
    if (contact && !contact.lists.includes(req.params.id)) {
      contact.lists.push(req.params.id);
      added++;
      crmDirty = true;
    }
  }
  saveCRM();
  res.json({ ok: true, added });
});

app.delete('/api/whatsapp/lists/:id/contacts', (req, res) => {
  const { contactIds } = req.body;
  if (!contactIds || !Array.isArray(contactIds)) return res.status(400).json({ error: 'contactIds array required' });

  let removed = 0;
  for (const cid of contactIds) {
    const contact = crmContacts.get(cid);
    if (contact) {
      const idx = contact.lists.indexOf(req.params.id);
      if (idx >= 0) {
        contact.lists.splice(idx, 1);
        removed++;
        crmDirty = true;
      }
    }
  }
  saveCRM();
  res.json({ ok: true, removed });
});

// ─── Bulk DM from List ──────────────────────────────────────────────────

app.post('/api/whatsapp/lists/:id/broadcast', async (req, res) => {
  const lists = loadJSON(LISTS_FILE, []);
  if (!lists.find(l => l.id === req.params.id)) return res.status(404).json({ error: 'List not found' });

  const { message, account } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });

  const accountId = account || 'default';
  const acc = accounts.get(accountId);
  if (!acc || (!acc.ready && acc.status !== 'authenticated')) return res.status(503).json({ error: `Account not ready (status: ${acc?.status})` });

  const contacts = Array.from(crmContacts.values()).filter(c => c.lists.includes(req.params.id));
  const settings = getCrmSettings();
  const cooldownMs = settings.autoDmCooldownHours * 60 * 60 * 1000;

  let sent = 0, skipped = 0, failed = 0;

  for (const contact of contacts) {
    if (contact.blocked || isBlocked(contact.phone)) { skipped++; continue; }
    if (contact.profile.dmSentAt && (Date.now() - new Date(contact.profile.dmSentAt).getTime()) < cooldownMs) {
      skipped++; continue;
    }

    try {
      const jid = contact.id + '@c.us';
      await acc.client.sendMessage(jid, message);
      upsertCrmContact(contact.id, {
        profile: { dmSent: true, dmSentAt: new Date().toISOString() },
      });
      sent++;
      await new Promise(r => setTimeout(r, 3000));
    } catch (err) {
      console.error(`Bulk DM failed for ${contact.id}:`, err.message);
      failed++;
    }
  }

  saveCRM();

  logBroadcast({
    id: crypto.randomUUID(),
    name: `List broadcast: ${req.params.id}`,
    timestamp: new Date().toISOString(),
    account: accountId,
    chatIds: contacts.map(c => c.id + '@c.us'),
    messagePreview: message.slice(0, 200),
    sent, failed, skipped,
    total: contacts.length,
  });

  res.json({ sent, skipped, failed, total: contacts.length });
});

// ─── Blocklist ──────────────────────────────────────────────────────────

app.get('/api/whatsapp/blocklist', (req, res) => {
  const blocklist = getBlocklist();
  res.json({ blocklist });
});

app.post('/api/whatsapp/blocklist', (req, res) => {
  const { phone, reason } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone required' });

  const blocklist = getBlocklist();
  if (blocklist.find(b => b.phone === phone)) return res.status(409).json({ error: 'Already blocked' });

  blocklist.push({ phone, reason: reason || null, blockedAt: new Date().toISOString() });
  saveJSON(BLOCKLIST_FILE, blocklist);

  const phoneId = phone.replace(/[^0-9]/g, '');
  const contact = crmContacts.get(phoneId);
  if (contact) {
    contact.blocked = true;
    contact.status = 'blocked';
    crmDirty = true;
    saveCRM();
  }

  res.json({ ok: true, blocked: phone });
});

app.delete('/api/whatsapp/blocklist/:phone', (req, res) => {
  const blocklist = getBlocklist();
  const filtered = blocklist.filter(b => b.phone !== req.params.phone);
  if (filtered.length === blocklist.length) return res.status(404).json({ error: 'Not found in blocklist' });
  saveJSON(BLOCKLIST_FILE, filtered);

  const phoneId = req.params.phone.replace(/[^0-9]/g, '');
  const contact = crmContacts.get(phoneId);
  if (contact) {
    contact.blocked = false;
    crmDirty = true;
    saveCRM();
  }

  res.json({ ok: true, unblocked: req.params.phone });
});

// ─── CSV Contact Import ─────────────────────────────────────────────────

app.post('/api/whatsapp/contacts/import', (req, res) => {
  const { csv, source } = req.body;
  if (!csv || typeof csv !== 'string') return res.status(400).json({ error: 'csv string required' });

  try {
    const result = importCSVContacts(csv, source || null);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/whatsapp/contacts/import-file', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'CSV file required (field name: "file")' });

  const csvText = req.file.buffer.toString('utf-8');
  const source = req.body.source || null;

  try {
    const result = importCSVContacts(csvText, source);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Internal Broadcast Lists ───────────────────────────────────────────

app.post('/api/whatsapp/broadcast-lists', (req, res) => {
  const { name, description, contacts, tags } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });

  const id = 'list_' + crypto.randomUUID().slice(0, 12);
  const phones = (contacts || []).map(p => normalizePhone(p)).filter(Boolean);
  const dedupedPhones = [...new Set(phones)];

  const list = {
    id,
    name,
    description: description || '',
    contacts: dedupedPhones,
    tags: tags || [],
    createdAt: new Date().toISOString(),
    lastBroadcastAt: null,
    broadcastCount: 0,
  };

  broadcastLists.push(list);
  broadcastListsDirty = true;
  saveBroadcastLists();

  res.json({ ok: true, list: { ...list, contactCount: list.contacts.length } });
});

app.get('/api/whatsapp/broadcast-lists', (req, res) => {
  const result = broadcastLists.map(l => ({
    id: l.id,
    name: l.name,
    description: l.description,
    tags: l.tags,
    contactCount: l.contacts.length,
    createdAt: l.createdAt,
    lastBroadcastAt: l.lastBroadcastAt,
    broadcastCount: l.broadcastCount,
  }));
  res.json({ lists: result });
});

// ─── List Building from Filters ─────────────────────────────────────────

app.post('/api/whatsapp/broadcast-lists/from-filter', (req, res) => {
  const { name, filters } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  if (!filters || typeof filters !== 'object') return res.status(400).json({ error: 'filters object required' });

  let contactList = Array.from(crmContacts.values()).map(c => {
    c.score = calculateScore(c);
    c.status = c.blocked ? 'blocked' : statusFromScore(c.score);
    return c;
  });

  // Filter by status
  if (filters.status) {
    const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
    contactList = contactList.filter(c => statuses.includes(c.status));
  }

  // Filter by tags (match any)
  if (filters.tags && Array.isArray(filters.tags) && filters.tags.length > 0) {
    const wantedTags = filters.tags.map(t => t.toLowerCase());
    contactList = contactList.filter(c =>
      c.tags.some(t => wantedTags.includes(t.toLowerCase()))
    );
  }

  // Filter by list membership
  if (filters.list) {
    contactList = contactList.filter(c => c.lists.includes(filters.list));
  }

  // Filter by source
  if (filters.source) {
    contactList = contactList.filter(c =>
      c.source && (c.source.type === filters.source || c.source.groupName === filters.source)
    );
  }

  // Filter by minimum score
  if (filters.minScore !== undefined) {
    contactList = contactList.filter(c => (c.score || 0) >= filters.minScore);
  }

  // Exclude blocked
  contactList = contactList.filter(c => !c.blocked);

  const phones = contactList.map(c => formatPhone(c.id));
  const dedupedPhones = [...new Set(phones)];

  const id = 'list_' + crypto.randomUUID().slice(0, 12);
  const list = {
    id,
    name,
    description: `Auto-created from filter: ${JSON.stringify(filters)}`,
    contacts: dedupedPhones,
    tags: filters.tags || [],
    createdAt: new Date().toISOString(),
    lastBroadcastAt: null,
    broadcastCount: 0,
  };

  broadcastLists.push(list);
  broadcastListsDirty = true;
  saveBroadcastLists();

  res.json({ ok: true, list: { ...list, contactCount: list.contacts.length } });
});

// ─── Merge Broadcast Lists ──────────────────────────────────────────────

app.post('/api/whatsapp/broadcast-lists/merge', (req, res) => {
  const { listIds, name } = req.body;
  if (!listIds || !Array.isArray(listIds) || listIds.length < 2) {
    return res.status(400).json({ error: 'listIds array with at least 2 IDs required' });
  }
  if (!name) return res.status(400).json({ error: 'name required' });

  const allPhones = new Set();
  const allTags = new Set();
  const missing = [];

  for (const lid of listIds) {
    const list = getBroadcastList(lid);
    if (!list) { missing.push(lid); continue; }
    for (const phone of list.contacts) allPhones.add(phone);
    for (const tag of (list.tags || [])) allTags.add(tag);
  }

  if (missing.length > 0) {
    return res.status(404).json({ error: `Lists not found: ${missing.join(', ')}` });
  }

  const id = 'list_' + crypto.randomUUID().slice(0, 12);
  const merged = {
    id,
    name,
    description: `Merged from: ${listIds.join(', ')}`,
    contacts: Array.from(allPhones),
    tags: Array.from(allTags),
    createdAt: new Date().toISOString(),
    lastBroadcastAt: null,
    broadcastCount: 0,
  };

  broadcastLists.push(merged);
  broadcastListsDirty = true;
  saveBroadcastLists();

  res.json({ ok: true, list: { ...merged, contactCount: merged.contacts.length } });
});

app.get('/api/whatsapp/broadcast-lists/:id', (req, res) => {
  const list = getBroadcastList(req.params.id);
  if (!list) return res.status(404).json({ error: 'Broadcast list not found' });

  // Enrich contacts with CRM data
  const enriched = list.contacts.map(phone => {
    const phoneId = phone.replace(/[^0-9]/g, '');
    const contact = getCrmContact(phoneId);
    return {
      phone,
      name: contact ? (contact.name || contact.pushName || null) : null,
      status: contact ? contact.status : 'unknown',
      score: contact ? contact.score : 0,
    };
  });

  res.json({ list: { ...list, contactCount: list.contacts.length }, contacts: enriched });
});

app.put('/api/whatsapp/broadcast-lists/:id', (req, res) => {
  const list = getBroadcastList(req.params.id);
  if (!list) return res.status(404).json({ error: 'Broadcast list not found' });

  const { name, description, tags } = req.body;
  if (name !== undefined) list.name = name;
  if (description !== undefined) list.description = description;
  if (tags !== undefined) list.tags = tags;

  broadcastListsDirty = true;
  saveBroadcastLists();
  res.json({ ok: true, list: { ...list, contactCount: list.contacts.length } });
});

app.delete('/api/whatsapp/broadcast-lists/:id', (req, res) => {
  const idx = broadcastLists.findIndex(l => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Broadcast list not found' });

  const deleted = broadcastLists.splice(idx, 1)[0];
  broadcastListsDirty = true;
  saveBroadcastLists();
  res.json({ ok: true, deleted: deleted.id });
});

app.post('/api/whatsapp/broadcast-lists/:id/contacts', (req, res) => {
  const list = getBroadcastList(req.params.id);
  if (!list) return res.status(404).json({ error: 'Broadcast list not found' });

  const { phones } = req.body;
  if (!phones || !Array.isArray(phones)) return res.status(400).json({ error: 'phones array required' });

  let added = 0;
  for (const raw of phones) {
    const phone = normalizePhone(raw);
    if (phone && !list.contacts.includes(phone)) {
      list.contacts.push(phone);
      added++;
    }
  }

  broadcastListsDirty = true;
  saveBroadcastLists();
  res.json({ ok: true, added, contactCount: list.contacts.length });
});

app.delete('/api/whatsapp/broadcast-lists/:id/contacts', (req, res) => {
  const list = getBroadcastList(req.params.id);
  if (!list) return res.status(404).json({ error: 'Broadcast list not found' });

  const { phones } = req.body;
  if (!phones || !Array.isArray(phones)) return res.status(400).json({ error: 'phones array required' });

  let removed = 0;
  for (const raw of phones) {
    const phone = normalizePhone(raw);
    if (!phone) continue;
    const idx = list.contacts.indexOf(phone);
    if (idx >= 0) {
      list.contacts.splice(idx, 1);
      removed++;
    }
  }

  broadcastListsDirty = true;
  saveBroadcastLists();
  res.json({ ok: true, removed, contactCount: list.contacts.length });
});

app.post('/api/whatsapp/broadcast-lists/:id/import', (req, res) => {
  const list = getBroadcastList(req.params.id);
  if (!list) return res.status(404).json({ error: 'Broadcast list not found' });

  const { csv, source } = req.body;
  if (!csv || typeof csv !== 'string') return res.status(400).json({ error: 'csv string required' });

  try {
    // First import into CRM
    const crmResult = importCSVContacts(csv, source || null);

    // Then add phones to broadcast list
    const { rows } = parseCSV(csv);
    let added = 0;
    for (const row of rows) {
      if (row.phone && !list.contacts.includes(row.phone)) {
        list.contacts.push(row.phone);
        added++;
      }
    }

    broadcastListsDirty = true;
    saveBroadcastLists();

    res.json({
      ...crmResult,
      addedToList: added,
      contactCount: list.contacts.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Bulk DM via Broadcast List ─────────────────────────────────────────

app.post('/api/whatsapp/broadcast-lists/:id/send', async (req, res) => {
  const list = getBroadcastList(req.params.id);
  if (!list) return res.status(404).json({ error: 'Broadcast list not found' });

  const { message, account } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });

  const accountId = account || 'default';
  const acc = accounts.get(accountId);
  if (!acc || (!acc.ready && acc.status !== 'authenticated')) return res.status(503).json({ error: `Account not ready (status: ${acc?.status})` });

  const settings = getCrmSettings();
  const cooldownMs = settings.autoDmCooldownHours * 60 * 60 * 1000;
  const blocklist = getBlocklist();

  let sent = 0, skipped = 0, failed = 0;
  const total = list.contacts.length;

  for (const phone of list.contacts) {
    // Check blocked
    if (blocklist.some(b => b.phone === phone)) { skipped++; continue; }

    const phoneId = phone.replace(/[^0-9]/g, '');
    const crmContact = getCrmContact(phoneId);

    // Check blocked in CRM
    if (crmContact && crmContact.blocked) { skipped++; continue; }

    // Check per-contact cooldown
    if (crmContact && crmContact.profile.dmSentAt) {
      if ((Date.now() - new Date(crmContact.profile.dmSentAt).getTime()) < cooldownMs) {
        skipped++; continue;
      }
    }

    // Build personalized message
    let personalMsg = message;
    const contactName = crmContact ? (crmContact.name || crmContact.pushName || 'there') : 'there';
    personalMsg = personalMsg.replace(/\{name\}/g, contactName);

    // Replace {events} if present
    if (personalMsg.includes('{events}')) {
      try {
        const recommendation = await getRecommendation('upcoming events');
        personalMsg = personalMsg.replace(/\{events\}/g, recommendation);
      } catch {
        personalMsg = personalMsg.replace(/\{events\}/g, `Check out events at ${TBP_URL}/events`);
      }
    }

    try {
      const jid = phoneId + '@c.us';
      await acc.client.sendMessage(jid, personalMsg);

      // Update CRM
      upsertCrmContact(phoneId, {
        profile: { dmSent: true, dmSentAt: new Date().toISOString() },
      });

      sent++;
      // 3-second delay between sends
      if (sent < total) await new Promise(r => setTimeout(r, 3000));
    } catch (err) {
      console.error(`Broadcast list DM failed for ${phone}:`, err.message);
      failed++;
    }
  }

  saveCRM();

  // Update list broadcast stats
  list.lastBroadcastAt = new Date().toISOString();
  list.broadcastCount = (list.broadcastCount || 0) + 1;
  broadcastListsDirty = true;
  saveBroadcastLists();

  // Log to broadcast history
  logBroadcast({
    id: crypto.randomUUID(),
    name: `Broadcast list: ${list.name}`,
    timestamp: new Date().toISOString(),
    account: accountId,
    chatIds: list.contacts.map(p => p.replace(/[^0-9]/g, '') + '@c.us'),
    messagePreview: message.slice(0, 200),
    sent, failed, skipped, total,
  });

  res.json({ sent, skipped, failed, total });
});

// ─── Persona Broadcast Management ────────────────────────────────────────

// GET /api/personas — list all personas
app.get('/api/personas', (req, res) => {
  const result = personas.map(p => ({
    id: p.id,
    name: p.name,
    role: p.role,
    tone: p.tone,
    contactCount: (p.contacts || []).length,
    templates: Object.keys(p.templates || {}),
    createdAt: p.createdAt,
  }));
  res.json({ personas: result });
});

// GET /api/personas/:id — get persona details
app.get('/api/personas/:id', (req, res) => {
  const persona = getPersona(req.params.id);
  if (!persona) return res.status(404).json({ error: 'Persona not found' });
  res.json({ persona });
});

// GET /api/personas/:id/contacts — list contacts for a persona
app.get('/api/personas/:id/contacts', (req, res) => {
  const persona = getPersona(req.params.id);
  if (!persona) return res.status(404).json({ error: 'Persona not found' });

  const members = (persona.contacts || []).map(phone => {
    const phoneId = phone.replace(/[^0-9]/g, '');
    const contact = getCrmContact(phoneId);
    const score = contact ? (contact.score || 0) : 0;
    return {
      phone,
      name: contact ? (contact.name || contact.pushName || null) : null,
      score,
    };
  });
  res.json({ contacts: members });
});

// POST /api/personas/:id/contacts — add contact(s) to persona
app.post('/api/personas/:id/contacts', (req, res) => {
  const persona = getPersona(req.params.id);
  if (!persona) return res.status(404).json({ error: 'Persona not found' });

  const { phones } = req.body;
  if (!phones || !Array.isArray(phones)) return res.status(400).json({ error: 'phones[] required' });

  let added = 0;
  for (const raw of phones) {
    const phone = formatPhone(raw.replace(/[^0-9]/g, ''));
    if (!persona.contacts.includes(phone)) {
      persona.contacts.push(phone);
      added++;
    }
  }
  personasDirty = true;
  savePersonas();
  res.json({ ok: true, added, total: persona.contacts.length });
});

// DELETE /api/personas/:id/contacts — remove contact from persona
app.delete('/api/personas/:id/contacts', (req, res) => {
  const persona = getPersona(req.params.id);
  if (!persona) return res.status(404).json({ error: 'Persona not found' });

  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone required' });

  const normalized = formatPhone(phone.replace(/[^0-9]/g, ''));
  const idx = persona.contacts.indexOf(normalized);
  if (idx >= 0) {
    persona.contacts.splice(idx, 1);
    personasDirty = true;
    savePersonas();
  }
  res.json({ ok: true, total: persona.contacts.length });
});

// POST /api/personas/:id/broadcast — send broadcast to persona's contact list
app.post('/api/personas/:id/broadcast', async (req, res) => {
  const persona = getPersona(req.params.id);
  if (!persona) return res.status(404).json({ error: 'Persona not found' });

  const { templateKey, message: customMessage, eventData } = req.body;

  // Resolve message: custom message, or template + eventData
  let baseMessage;
  if (customMessage) {
    baseMessage = customMessage;
  } else if (templateKey && persona.templates[templateKey]) {
    baseMessage = persona.templates[templateKey];
  } else {
    return res.status(400).json({ error: 'Provide message or templateKey' });
  }

  if (!persona.contacts || persona.contacts.length === 0) {
    return res.status(400).json({ error: 'Persona has no contacts' });
  }

  // Find a connected account
  let acc = null;
  for (const [, a] of accounts) {
    if (a.ready) { acc = a; break; }
  }
  if (!acc) return res.status(503).json({ error: 'No connected account' });

  let sent = 0, failed = 0;
  const total = persona.contacts.length;

  for (const phone of persona.contacts) {
    const phoneId = phone.replace(/[^0-9]/g, '');
    const crmContact = getCrmContact(phoneId);
    const contactName = crmContact ? (crmContact.name || crmContact.pushName || 'there') : 'there';

    const vars = {
      name: contactName,
      eventName: eventData?.name || '',
      date: eventData?.date || '',
      day: eventData?.date ? new Date(eventData.date).toLocaleDateString('en-US', { weekday: 'long' }) : '',
      venue: eventData?.venue || '',
      ticketUrl: eventData?.ticketUrl || eventData?.slug
        ? `https://kartis-astro.vercel.app/en/event/${eventData.slug}`
        : '',
    };

    const personalMsg = formatPersonaTemplate(baseMessage, vars);

    try {
      const jid = phoneId + '@c.us';
      await acc.client.sendMessage(jid, personalMsg);
      sent++;
      if (sent < total) await new Promise(r => setTimeout(r, 3000));
    } catch (err) {
      console.error(`Persona ${persona.name} broadcast DM failed for ${phone}:`, err.message);
      failed++;
    }
  }

  res.json({ ok: true, persona: persona.id, sent, failed, total });
});

// PUT /api/personas/:id/templates — update persona templates
app.put('/api/personas/:id/templates', (req, res) => {
  const persona = getPersona(req.params.id);
  if (!persona) return res.status(404).json({ error: 'Persona not found' });

  const { templates } = req.body;
  if (!templates || typeof templates !== 'object') return res.status(400).json({ error: 'templates object required' });

  persona.templates = { ...persona.templates, ...templates };
  personasDirty = true;
  savePersonas();
  res.json({ ok: true, templates: persona.templates });
});

// ─── Persona Template Files (templates/ directory) ──────────────────────

function loadPersonaTemplates() {
  try {
    if (!fs.existsSync(PERSONA_TEMPLATES_DIR)) return [];
    const files = fs.readdirSync(PERSONA_TEMPLATES_DIR).filter(f => f.endsWith('.json'));
    return files.map(f => {
      const data = loadJSON(path.join(PERSONA_TEMPLATES_DIR, f), null);
      if (data) data._file = f;
      return data;
    }).filter(Boolean);
  } catch (e) {
    console.error('Failed to load persona templates:', e.message);
    return [];
  }
}

// GET /api/persona-templates — list all persona template files
app.get('/api/persona-templates', (req, res) => {
  const templates = loadPersonaTemplates();
  res.json(templates);
});

// GET /api/persona-templates/:persona — get template for specific persona
app.get('/api/persona-templates/:persona', (req, res) => {
  const filePath = path.join(PERSONA_TEMPLATES_DIR, `${req.params.persona}.json`);
  const data = loadJSON(filePath, null);
  if (!data) return res.status(404).json({ error: `Persona template "${req.params.persona}" not found` });
  res.json(data);
});

// GET /api/persona-templates/:persona/:variant — get specific variant message
app.get('/api/persona-templates/:persona/:variant', (req, res) => {
  const filePath = path.join(PERSONA_TEMPLATES_DIR, `${req.params.persona}.json`);
  const data = loadJSON(filePath, null);
  if (!data) return res.status(404).json({ error: `Persona template "${req.params.persona}" not found` });
  const variant = data.variants && data.variants[req.params.variant];
  if (!variant) return res.status(404).json({ error: `Variant "${req.params.variant}" not found` });
  res.json(variant);
});

// POST /api/persona-templates/:persona/render — render a variant with variables
app.post('/api/persona-templates/:persona/render', (req, res) => {
  const filePath = path.join(PERSONA_TEMPLATES_DIR, `${req.params.persona}.json`);
  const data = loadJSON(filePath, null);
  if (!data) return res.status(404).json({ error: `Persona template "${req.params.persona}" not found` });
  const { variant, variables } = req.body;
  if (!variant) return res.status(400).json({ error: 'variant required' });
  const tpl = data.variants && data.variants[variant];
  if (!tpl) return res.status(404).json({ error: `Variant "${variant}" not found` });
  const rendered = formatPersonaTemplate(tpl.message, variables || {});
  res.json({ persona: data.persona, variant, rendered });
});

// ─── Campaign Analytics Dashboard ────────────────────────────────────────

app.get('/api/analytics', (req, res) => {
  const history = loadJSON(HISTORY_FILE, []);
  const contacts = loadJSON(CONTACTS_FILE, []);
  const groupStats = loadJSON(GROUP_STATS_FILE, {});
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;

  // Time-bucketed stats
  const periods = { '7d': 7, '30d': 30, '90d': 90 };
  const buckets = {};
  for (const [label, days] of Object.entries(periods)) {
    const cutoff = new Date(now - days * day).toISOString();
    const filtered = history.filter(h => h.timestamp >= cutoff);
    buckets[label] = {
      broadcasts: filtered.length,
      messagesSent: filtered.reduce((s, h) => s + (h.sent || 0), 0),
      messagesFailed: filtered.reduce((s, h) => s + (h.failed || 0), 0),
      uniqueGroups: new Set(filtered.flatMap(h => h.chatIds || [])).size,
    };
  }

  // Delivery rate
  const totalSent = history.reduce((s, h) => s + (h.sent || 0), 0);
  const totalFailed = history.reduce((s, h) => s + (h.failed || 0), 0);
  const deliveryRate = totalSent + totalFailed > 0
    ? ((totalSent / (totalSent + totalFailed)) * 100).toFixed(1)
    : '0.0';

  // Daily volume for last 14 days (for chart)
  const dailyVolume = [];
  for (let i = 13; i >= 0; i--) {
    const date = new Date(now - i * day);
    const dateStr = date.toISOString().slice(0, 10);
    const dayBroadcasts = history.filter(h => (h.timestamp || '').startsWith(dateStr));
    dailyVolume.push({
      date: dateStr,
      broadcasts: dayBroadcasts.length,
      sent: dayBroadcasts.reduce((s, h) => s + (h.sent || 0), 0),
      failed: dayBroadcasts.reduce((s, h) => s + (h.failed || 0), 0),
    });
  }

  // Top groups by broadcast frequency
  const groupFreq = {};
  history.forEach(h => {
    (h.chatIds || []).forEach(id => {
      groupFreq[id] = (groupFreq[id] || 0) + 1;
    });
  });
  const topGroups = Object.entries(groupFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([groupId, count]) => ({ groupId, broadcastCount: count }));

  // Recent broadcasts (last 10)
  const recent = history.slice(0, 10).map(h => ({
    id: h.id,
    name: h.name || h.messagePreview?.slice(0, 50) || 'Untitled',
    timestamp: h.timestamp,
    sent: h.sent || 0,
    failed: h.failed || 0,
    total: h.total || 0,
    groups: (h.chatIds || []).length,
  }));

  res.json({
    overview: {
      totalBroadcasts: history.length,
      totalMessagesSent: totalSent,
      totalMessagesFailed: totalFailed,
      deliveryRate: parseFloat(deliveryRate),
      totalContacts: contacts.length,
      totalGroups: Object.keys(groupStats).length,
      broadcastLists: broadcastLists.length,
    },
    periods: buckets,
    dailyVolume,
    topGroups,
    recentBroadcasts: recent,
  });
});

app.get('/analytics', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'analytics.html'));
});

// ─── SPA Fallback ────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Kartis Webhook Registration ─────────────────────────────────────────

async function registerKartisWebhook() {
  if (!KARTIS_URL || !KARTIS_WEBHOOK_SECRET) {
    console.log('Kartis webhook: skipping registration (KARTIS_URL or KARTIS_WEBHOOK_SECRET not set)');
    return;
  }

  const webhookUrl = `${WBPRO_URL}/api/webhooks/kartis`;
  console.log(`Kartis webhook: registering ${webhookUrl} with ${KARTIS_URL}...`);

  try {
    const resp = await fetch(`${KARTIS_URL}/api/webhooks/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: webhookUrl,
        events: ['event.published'],
        secret: KARTIS_WEBHOOK_SECRET,
      }),
    });

    if (resp.ok) {
      webhookRegistered = true;
      console.log('Kartis webhook: registered successfully');
    } else {
      const body = await resp.text();
      console.warn(`Kartis webhook: registration failed (${resp.status}): ${body}`);
    }
  } catch (err) {
    console.warn('Kartis webhook: registration failed:', err.message);
  }
}

// ─── Health Check ────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  const checks = {};

  // Check WhatsApp client status
  const waStatus = typeof client !== 'undefined' && client.info ? 'ok' : 'error';
  checks.whatsapp = { status: waStatus };
  if (waStatus === 'error') checks.whatsapp.error = 'Client not connected';

  // Check Kartis connectivity config
  checks.kartisApi = KARTIS_EVENTS_URL ? { status: 'ok' } : { status: 'error', error: 'KARTIS_EVENTS_URL not configured' };

  // Check JWT secret
  checks.auth = JWT_SECRET ? { status: 'ok' } : { status: 'error', error: 'JWT_SECRET not configured' };

  const overall = Object.values(checks).every(c => c.status === 'ok') ? 'healthy' : 'degraded';

  res.status(overall === 'healthy' ? 200 : 503).json({
    service: 'wbpro',
    status: overall,
    timestamp: new Date().toISOString(),
    checks,
  });
});

// ─── Start ───────────────────────────────────────────────────────────────

if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`WhatsApp Multi-Account server on 0.0.0.0:${PORT}`);
    console.log(`Events API: ${KARTIS_EVENTS_URL}`);
    console.log(`TBP URL: ${TBP_URL}`);
    leads.initLeads(DATA_DIR);
    loadCRM();
    loadBroadcastLists();
    loadPersonas();
    seedDefaultTemplates();
    loadAndInitAccounts();
    startScrapeSchedule();
    startAutoAnnounceSchedule();
    // Initial scrape 60s after startup (give clients time to connect)
    setTimeout(() => scrapeAllGroups(), 60000);
    // Register Kartis webhook after startup
    registerKartisWebhook();
  });
}

module.exports = app;
