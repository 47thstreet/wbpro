# WBpro (WhatsApp Broadcast Pro)

**WhatsApp broadcast, CRM, lead capture, and automation platform for nightlife promoters.**

WBpro connects to WhatsApp via whatsapp-web.js and provides a full web dashboard for broadcasting to groups, managing contacts and CRM data, capturing leads from keyword detection, scheduling messages, building automation flows, managing personas with templates, and analytics -- all integrated with the Kartis event platform.

Built with Express, Puppeteer, whatsapp-web.js, and deployed on Render with persistent storage.

---

## Features

### WhatsApp Broadcasting

- Broadcast messages to multiple WhatsApp groups simultaneously
- Template-based message composition with variable substitution
- Auto-announce events fetched from Kartis
- Cooldown system to prevent spam (configurable per-group delays)
- Quiet hours enforcement (skip sending during off-hours)
- Message scheduling with date/time targeting
- Recurring scheduled broadcasts
- Broadcast history with delivery tracking

### Lead Capture

- Real-time keyword detection across WhatsApp groups
- Multi-language keyword dictionaries (English + Hebrew)
- Categories: party, event, club, DJ, VIP, guestlist, tickets, nightlife, celebration, venue
- Custom keyword management
- Lead stats and analytics
- Lead dismissal and reply workflows
- CSV export

### CRM & Contacts

- Contact management with search, tags, and notes
- Contact detail view with interaction history
- Tag-based filtering and organization
- Contact import (JSON and CSV file upload)
- Contact export
- Contact deletion with confirmation

### Broadcast Lists

- Create and manage targeted broadcast lists
- Filter-based list creation (build lists from contact filters)
- List merge (combine multiple lists)
- Per-list member management (add/remove contacts)
- CSV import into lists
- Send broadcasts to specific lists

### Personas

- Multiple brand personas for different contexts
- Per-persona contact lists
- Persona-specific message templates with variants
- Template rendering with variable substitution
- Per-persona broadcasting

### Automation

- Auto-rules engine (trigger-based responses)
- Visual flow builder for multi-step automations
- Flow execution with branching logic
- Rule management (create, update, delete)

### Scanner

- Real-time group message scanner feed (ring buffer, last 100)
- Scanner stats (messages scanned, leads detected)
- Group stats tracking (queries detected, responses sent)

### Blocklist

- Phone number blocklist
- Block/unblock management

### Settings

- Configurable cooldown minutes
- Quiet hours (start/end times)
- General platform settings

### Analytics Dashboard

- Broadcast performance metrics
- Group activity stats
- Lead detection analytics
- Message delivery tracking

### Kartis Integration

- Event data sync from Kartis public events API
- Webhook receiver for Kartis event updates
- Auto-register webhook on startup
- Event-based broadcast triggers

### Security

- Password-based authentication (WBPRO_PASSWORD required)
- Session cookies with HMAC signing
- JWT support for external API auth
- Kartis webhook signature verification

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Server | [Express](https://expressjs.com) |
| WhatsApp | [whatsapp-web.js](https://wwebjs.dev) with Puppeteer |
| Storage | JSON file persistence (portable, no database required) |
| QR Codes | [qrcode](https://www.npmjs.com/package/qrcode) |
| File Upload | [multer](https://www.npmjs.com/package/multer) |
| Testing | [Vitest](https://vitest.dev) (210 tests across 14 suites) |
| Deployment | [Render](https://render.com) with persistent disk |
| Frontend | Static HTML/JS (5 pages) |

---

## API Reference (90+ routes)

### Authentication

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/login` | Login with password |
| POST | `/api/logout` | End session |
| GET | `/login` | Login page |

### WhatsApp Session

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/status` | WhatsApp connection status |
| GET | `/api/qr` | QR code for WhatsApp pairing |
| GET | `/api/groups` | List WhatsApp groups |
| GET | `/api/groups/stats` | Group activity statistics |

### Broadcasting

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/broadcast` | Send broadcast to groups |
| POST | `/api/auto-announce` | Auto-announce Kartis events |
| GET | `/api/history` | Broadcast history |

### Scheduling

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/schedules` | List scheduled broadcasts |
| POST | `/api/schedules` | Create scheduled broadcast |
| DELETE | `/api/schedules/:id` | Delete scheduled broadcast |

### Templates

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/templates` | List message templates |
| POST | `/api/templates` | Create template |
| DELETE | `/api/templates/:id` | Delete template |

### Leads

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/leads` | List captured leads |
| GET | `/api/leads/stats` | Lead capture statistics |
| GET | `/api/leads/export` | Export leads as CSV |
| POST | `/api/leads/dismiss` | Dismiss a lead |
| POST | `/api/leads/dismiss-all` | Dismiss all leads |
| POST | `/api/leads/reply` | Reply to a lead via WhatsApp |

### Keywords

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/keywords` | Get keyword dictionaries |
| PUT | `/api/keywords` | Update keyword dictionaries |

### Contacts & CRM

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/contacts` | List contacts (search, filter, paginate) |
| GET | `/api/contacts/stats` | Contact statistics |
| GET | `/api/contacts/detail` | Contact detail with history |
| GET | `/api/contacts/export` | Export contacts |
| POST | `/api/contacts/import` | Import contacts (JSON) |
| POST | `/api/contacts/tag` | Add tag to contact |
| DELETE | `/api/contacts/tag` | Remove tag from contact |
| PUT | `/api/contacts/notes` | Update contact notes |
| POST | `/api/contacts/delete` | Delete contacts |

### Broadcast Lists

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/lists` | List broadcast lists |
| POST | `/api/lists` | Create broadcast list |
| DELETE | `/api/lists` | Delete broadcast list |
| GET | `/api/lists/members` | List members |
| GET | `/api/broadcast-lists` | List all broadcast lists |
| POST | `/api/broadcast-lists` | Create broadcast list |
| POST | `/api/broadcast-lists/from-filter` | Create list from filter |
| POST | `/api/broadcast-lists/merge` | Merge lists |
| GET | `/api/broadcast-lists/:id` | Get list details |
| PUT | `/api/broadcast-lists/:id` | Update list |
| DELETE | `/api/broadcast-lists/:id` | Delete list |
| POST | `/api/broadcast-lists/:id/contacts` | Add contacts to list |
| DELETE | `/api/broadcast-lists/:id/contacts` | Remove contacts from list |
| POST | `/api/broadcast-lists/:id/import` | Import contacts to list (CSV) |
| POST | `/api/broadcast-lists/:id/send` | Send broadcast to list |

### Auto-Rules

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/auto-rules` | List automation rules |
| POST | `/api/auto-rules` | Create rule |
| PUT | `/api/auto-rules/:id` | Update rule |
| DELETE | `/api/auto-rules/:id` | Delete rule |

### Flows

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/flows` | List automation flows |
| POST | `/api/flows` | Create flow |
| GET | `/api/flows/:id` | Get flow details |
| PUT | `/api/flows/:id` | Update flow |
| DELETE | `/api/flows/:id` | Delete flow |

### Personas

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/personas` | List personas |
| GET | `/api/personas/:id` | Get persona |
| GET | `/api/personas/:id/contacts` | Persona contacts |
| POST | `/api/personas/:id/contacts` | Add contacts to persona |
| DELETE | `/api/personas/:id/contacts` | Remove contacts from persona |
| POST | `/api/personas/:id/broadcast` | Broadcast as persona |
| PUT | `/api/personas/:id/templates` | Update persona templates |

### Persona Templates

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/persona-templates` | List all persona templates |
| GET | `/api/persona-templates/:persona` | Templates for a persona |
| GET | `/api/persona-templates/:persona/:variant` | Specific variant |
| POST | `/api/persona-templates/:persona/render` | Render template |

### Scanner

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/scanner/feed` | Real-time scanner feed |
| GET | `/api/scanner/stats` | Scanner statistics |

### Settings & Cooldowns

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/settings` | Get settings |
| PUT | `/api/settings` | Update settings |
| GET | `/api/cooldowns` | Get group cooldown states |
| POST | `/api/cooldowns/reset` | Reset cooldowns |

### Blocklist

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/blocklist` | Get blocklist |
| POST | `/api/blocklist` | Add to blocklist |
| DELETE | `/api/blocklist/:phone` | Remove from blocklist |

### Analytics

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/analytics` | Full analytics dashboard data |

### System

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Health check |
| DELETE | `/api/accounts` | Delete WhatsApp session |
| POST | `/api/webhooks/kartis` | Kartis webhook receiver |

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `WBPRO_PASSWORD` | Yes | Login password (required to start) |
| `PORT` | No | Server port (default: 8080) |
| `JWT_SECRET` | No | Secret for external API JWT auth |
| `KARTIS_EVENTS_URL` | No | Kartis events API URL |
| `KARTIS_URL` | No | Kartis base URL |
| `KARTIS_WEBHOOK_SECRET` | No | Webhook signature verification secret |
| `WBPRO_URL` | No | WBpro public URL (for webhook registration) |
| `TBP_URL` | No | TBP website URL |
| `COOLDOWN_MINUTES` | No | Group cooldown (default: 30) |
| `QUIET_START` | No | Quiet hours start (default: 02:00) |
| `QUIET_END` | No | Quiet hours end (default: 10:00) |

---

## Getting Started

### Prerequisites

- Node.js >= 18
- Chromium/Chrome (for Puppeteer/whatsapp-web.js)

### Install

```bash
git clone https://github.com/47thstreet/wbpro.git
cd wbpro
npm install
```

### Run

```bash
export WBPRO_PASSWORD="your-password"
npm start
# Open http://localhost:8080
# Scan the QR code with WhatsApp
```

### Testing

```bash
# 210 tests across 14 suites
npm test
```

### Deploy (Render)

Uses `render.yaml` for configuration. Requires a persistent disk mounted at `/data` for session and data storage.

---

## Data Storage

All data is stored as JSON files (no database required):

| File | Description |
|------|-------------|
| `accounts.json` | WhatsApp account sessions |
| `templates.json` | Message templates |
| `auto-rules.json` | Automation rules |
| `flows.json` | Automation flows |
| `contacts.json` | CRM contacts |
| `crm.json` | CRM metadata |
| `blocklist.json` | Blocked phone numbers |
| `broadcast-lists.json` | Broadcast list definitions |
| `personas.json` | Brand personas |
| `settings.json` | Platform settings |
| `group-tags.json` | Group tag assignments |
| `wwebjs_auth/` | WhatsApp session data |

---

## Project Structure

```
server.js               # Express app (all routes, WhatsApp client, ~5000 lines)
leads.js                # Lead capture module (keyword detection, storage)
public/
  index.html            # Main dashboard
  login.html            # Login page
  analytics.html        # Analytics dashboard
  flows.html            # Flow builder
  import.html           # Contact import
templates/              # Persona-specific message templates
tests/                  # 14 test suites, 210 tests
render.yaml             # Render deployment config
Dockerfile              # Container build
```

---

## License

Private. All rights reserved.
