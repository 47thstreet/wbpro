import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Must set env before importing leads
import './setup.js';

const leads = require('../leads');

describe('Leads Module', () => {
  let tmpDir;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbpro-leads-'));
    leads.initLeads(tmpDir);
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('detectLead', () => {
    it('should detect English party keywords', () => {
      const result = leads.detectLead('Any parties tonight?', 'John', '123@c.us', 'Test Group', 'g1');
      expect(result.isLead).toBe(true);
      expect(result.matchedKeywords).toContain('parties');
      expect(result.categories).toContain('party');
    });

    it('should detect Hebrew keywords', () => {
      const result = leads.detectLead('מה יש הלילה? איפה יוצאים', 'Yossi', '456@c.us', 'TLV Group', 'g2');
      expect(result.isLead).toBe(true);
      expect(result.language).toBe('he');
    });

    it('should return isLead=false for no keywords', () => {
      const result = leads.detectLead('Hello everyone good morning', 'Jane', '789@c.us', 'Work Group', 'g3');
      expect(result.isLead).toBe(false);
    });

    it('should return isLead=false for empty message', () => {
      expect(leads.detectLead('', 'X', '1', 'G', 'g1').isLead).toBe(false);
      expect(leads.detectLead(null, 'X', '1', 'G', 'g1').isLead).toBe(false);
      expect(leads.detectLead(undefined, 'X', '1', 'G', 'g1').isLead).toBe(false);
    });

    it('should have higher confidence with multiple keywords', () => {
      const single = leads.detectLead('party tonight', 'A', '1@c.us', 'G', 'g1');
      const multi = leads.detectLead('party tickets club vip guestlist', 'B', '2@c.us', 'G', 'g1');
      expect(multi.confidence).toBeGreaterThan(single.confidence);
    });

    it('should give Hebrew party bonus', () => {
      const enResult = leads.detectLead('party', 'A', '1@c.us', 'G', 'g1');
      const heResult = leads.detectLead('מסיבה', 'B', '2@c.us', 'G', 'g1');
      expect(heResult.confidence).toBeGreaterThan(enResult.confidence);
    });

    it('should give question mark bonus', () => {
      const noQ = leads.detectLead('party tonight', 'A', '1@c.us', 'G', 'g1');
      const withQ = leads.detectLead('party tonight?', 'A', '1@c.us', 'G', 'g1');
      expect(withQ.confidence).toBeGreaterThan(noQ.confidence);
    });

    it('should cap confidence at 1.0', () => {
      const result = leads.detectLead('מסיבה party tickets club vip guestlist tonight? festival', 'A', '1@c.us', 'G', 'g1');
      expect(result.confidence).toBeLessThanOrEqual(1.0);
    });

    it('should highlight matched keywords', () => {
      const result = leads.detectLead('Any parties this weekend?', 'A', '1@c.us', 'G', 'g1');
      expect(result.highlightedMessage).toContain('<mark>');
    });

    it('should detect ticket keywords', () => {
      const result = leads.detectLead('Where can I buy tickets?', 'A', '1@c.us', 'G', 'g1');
      expect(result.isLead).toBe(true);
      expect(result.categories).toContain('tickets');
    });

    it('should detect VIP/bottle service keywords', () => {
      const result = leads.detectLead('How much for bottle service?', 'A', '1@c.us', 'G', 'g1');
      expect(result.isLead).toBe(true);
      expect(result.categories).toContain('vip');
    });

    it('should detect nightlife keywords', () => {
      const result = leads.detectLead("Let's go out tonight!", 'A', '1@c.us', 'G', 'g1');
      expect(result.isLead).toBe(true);
      expect(result.categories).toContain('nightlife');
    });

    it('should detect venue keywords', () => {
      const result = leads.detectLead('rooftop party at the best venue', 'A', '1@c.us', 'G', 'g1');
      expect(result.isLead).toBe(true);
      expect(result.categories).toContain('venue');
    });
  });

  describe('storeLead', () => {
    it('should store a lead and return it with id', () => {
      const stored = leads.storeLead({
        groupId: 'g1',
        groupName: 'Test Group',
        senderId: '972501234567@c.us',
        senderName: 'Test User',
        message: 'Looking for parties',
        matchedKeywords: ['parties'],
        categories: ['party'],
        confidence: 0.7,
      });

      expect(stored.id).toMatch(/^lead_/);
      expect(stored.status).toBe('new');
      expect(stored.senderPhone).toBe('+972501234567');
      expect(stored.timestamp).toBeDefined();
    });

    it('should increment stats on store', () => {
      const statsBefore = leads.getLeadStats();
      const todayBefore = statsBefore.leadsToday;

      leads.storeLead({
        groupId: 'g1',
        message: 'test',
        matchedKeywords: ['party'],
        categories: ['party'],
        confidence: 0.5,
      });

      const statsAfter = leads.getLeadStats();
      expect(statsAfter.leadsToday).toBe(todayBefore + 1);
    });
  });

  describe('getLeads', () => {
    it('should return all leads', () => {
      const result = leads.getLeads({});
      expect(result.leads).toBeDefined();
      expect(Array.isArray(result.leads)).toBe(true);
    });

    it('should filter by status', () => {
      const result = leads.getLeads({ status: 'new' });
      for (const lead of result.leads) {
        expect(lead.status).toBe('new');
      }
    });
  });

  describe('updateLeadStatus', () => {
    it('should update lead status', () => {
      const stored = leads.storeLead({
        groupId: 'g1',
        message: 'test update',
        matchedKeywords: ['party'],
        categories: ['party'],
        confidence: 0.5,
      });

      const updated = leads.updateLeadStatus(stored.id, 'dismissed');
      expect(updated.status).toBe('dismissed');
    });

    it('should return null for non-existent lead', () => {
      const result = leads.updateLeadStatus('nonexistent-id', 'dismissed');
      expect(result).toBeNull();
    });
  });

  describe('getLeadStats', () => {
    it('should return stats object', () => {
      const stats = leads.getLeadStats();
      expect(stats).toHaveProperty('leadsToday');
      expect(stats).toHaveProperty('leadsThisWeek');
      expect(stats).toHaveProperty('topGroups');
      expect(stats).toHaveProperty('topKeywords');
    });
  });

  describe('custom keywords', () => {
    it('should set and get custom keywords', () => {
      leads.setCustomKeywords({ category: 'custom_cat', keywords: ['myword', 'anotherword'] });
      const kw = leads.getCustomKeywords();
      expect(kw.custom.custom_cat).toEqual(['myword', 'anotherword']);
    });

    it('should detect custom keywords in messages', () => {
      leads.setCustomKeywords({ category: 'promo', keywords: ['specialdeal'] });
      const result = leads.detectLead('Check out this specialdeal now', 'A', '1@c.us', 'G', 'g1');
      expect(result.isLead).toBe(true);
      expect(result.matchedKeywords).toContain('specialdeal');
    });

    it('should remove custom keyword', () => {
      leads.setCustomKeywords({ category: 'promo2', keywords: ['word1', 'word2'] });
      leads.removeCustomKeyword('word1');
      const kw = leads.getCustomKeywords();
      const allCustomWords = Object.values(kw.custom).flat();
      expect(allCustomWords).not.toContain('word1');
    });
  });

  describe('exportLeadsCsv', () => {
    it('should return CSV string', () => {
      leads.storeLead({
        groupId: 'g-export',
        groupName: 'Export Group',
        senderId: '972509999999@c.us',
        senderName: 'CSV Test',
        message: 'party tonight',
        matchedKeywords: ['party'],
        categories: ['party'],
        confidence: 0.7,
      });

      const csv = leads.exportLeadsCsv({});
      expect(csv).toContain('id,');
      expect(csv).toContain('party');
    });
  });
});
