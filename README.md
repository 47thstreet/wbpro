# WBpro (WhatsApp Broadcast Pro)

**WhatsApp broadcast, CRM, AI chatbot, lead scoring, automation, and ticket sales platform for nightlife promoters.**

WBpro connects to WhatsApp via whatsapp-web.js and provides a full web dashboard for broadcasting to groups, AI-powered chatbot responses, intelligent lead scoring, automated follow-up sequences, smart group management, WhatsApp-to-Kartis ticket purchase flows, conversation flows with branching logic, persona templates, scheduling, contact import, and analytics -- all integrated with the Kartis event platform.

Built with Express, Puppeteer, whatsapp-web.js, and NVIDIA NIM (Llama 3.3 70B). Deployed on Render with persistent storage.

---

## Features

### AI-Powered Chatbot (NVIDIA NIM / Llama 3.3 70B)

- AI response nodes in conversation flows -- call NVIDIA NIM to generate contextual replies
- Per-conversation rate limiting (10 requests/minute with sliding window)
- Conversation history tracking (last 10 messages per sender)
- Configurable system prompts, temperature, max tokens per flow node
- Exit keywords to break out of AI conversation loops
- Automatic history cleanup when flow sessions end
- Status endpoint for checking AI configuration

### Lead Scoring Engine

- Multi-signal weighted scoring: message frequency (25%), event attendance (25%), ticket purchases (30%), response rate (20%)
- Time-decay normalization (activity older than 90 days decays)
- Tier classification: hot (70+), warm (40-69), cool (15-39), cold (0-14)
- Manual score boost endpoint for back-filling historical data
- Score summary with tier distribution and averages
- Dashboard integration showing confidence badges and ranked lead cards
- Sorted, paginated, filterable score API

### Automated Follow-Up Sequences

- Trigger-based enrollment: auto-enroll contacts when lead score hits 70+
- Multi-step timed message sequences (e.g., Day 1 welcome, Day 3 event rec, Day 7 VIP offer)
- Variable substitution in messages ({name}, {nextEvent}, {eventUrl})
- Sequence CRUD with enable/disable toggle
- Per-contact pause/resume controls
- Re-enrollment prevention via contact tagging
- Background processor running on 60-second check interval
- Default "Hot Lead Welcome Sequence" seeded on first load

### Smart Group Management

- Group profiles with city, category, tags, invite link, capacity, tier
- Intelligent group-to-contact matching: city (30pts), interests (25pts), lead tier (20pts), group health (15pts), invite link (10pts)
- Automatic disqualification for full-capacity groups
- Group health scoring (0-100): activity (40pts), members (30pts), recency (20pts), profile completeness (10pts)
- Optimal posting times analysis (hourly/daily message distribution, top 3 best hours/days)
- Live group activity tracking wired into message handler
- Health dashboard with summary stats (healthy/moderate/needs-attention counts)
- Activity seeding endpoint for testing

### WhatsApp-to-Kartis Ticket Purchase Flow

- `ticket_purchase` node type in the conversation flow engine
- Triggers on "buy tickets", "tickets for [event]", Hebrew variants
- Fetches events from Kartis API, matches by keyword (name, venue, description)
- Presents numbered ticket cards with dates, venues, prices, and checkout links
- Users reply with a number to get a direct Kartis purchase link
- Bilingual support (English + Hebrew)
- CRM auto-tags contacts with "ticket-interest" on selection
- Simulate endpoint for testing conversations without WhatsApp
- Seed endpoint to create the default ticket flow

### WhatsApp Broadcasting

- Broadcast messages to multiple WhatsApp groups simultaneously
- Template-based message composition with variable substitution
- Auto-announce events fetched from Kartis
- Cooldown system to prevent spam (configurable per-group delays)
- Quiet hours enforcement (skip sending during off-hours)
- Message scheduling with date/time targeting
- Recurring scheduled broadcasts
- Broadcast history with delivery tracking

### Conversation Flow Engine

- Visual flow builder UI with drag-and-drop nodes
- Three node types: `message` (static), `ai_response` (LLM-powered), `ticket_purchase` (event lookup)
- Branching logic with option matching (by number, text, or keywords)
- Data collection nodes (store user input for later use)
- Variable substitution throughout flow messages
- Trigger types: exact match, contains, starts with
- Scope filtering: DM-only, group-only, or all
- 30-minute session TTL with automatic cleanup
- Flow completion logging and analytics

### Lead Capture

- Real-time keyword detection across WhatsApp groups
- Multi-language keyword dictionaries (English + Hebrew)
- Categories: party, event, club, DJ, VIP, guestlist, tickets, nightlife, celebration, venue
- Smart intent detection beyond simple keywords
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
- CRM scraping from WhatsApp group participants

### Broadcast Lists

- Create and manage targeted broadcast lists
- Filter-based list creation (build lists from contact filters)
- List merge (combine multiple lists)
- Per-list member management (add/remove contacts)
- CSV import into lists
- Send broadcasts to specific lists

### Personas

- Multiple brand personas for different contexts (Hype Master, Elegant Host, Music Curator, Social Butterfly, Energy Bomb)
- Per-persona contact lists
- Persona-specific message templates with variants (eventAnnouncement, lastChance, welcome, etc.)
- Template rendering with variable substitution
- Per-persona broadcasting

### Automation Rules

- Auto-rules engine (keyword trigger-based responses)
- Template variable support ({nextEvent}, {ticketLink}, {eventList}, {eventName})
- Per-account or global rule scoping
- Rule management (create, update, delete, enable/disable)

### Scanner

- Real-time group message scanner feed (ring buffer, last 100)
- Scanner stats (messages scanned, leads detected)
- Group stats tracking (queries detected, responses sent)

### Analytics Dashboard

- Broadcast performance metrics
- Group activity stats
- Lead detection analytics
- Message delivery tracking
- Lead score distribution and tier summary
- Top scored leads panel

### Kartis Integration

- Event data sync from Kartis public events API (cached with TTL)
- Ticket purchase flow with checkout links
- Webhook receiver for Kartis event updates
- Auto-register webhook on startup
- Event-based broadcast triggers
- Event recommendation engine (by day, keyword, intent)

### Multi-Account Support

- Multiple WhatsApp accounts with independent sessions
- Per-account QR code pairing
- Account status monitoring
- Stale session lock cleanup

### Security

- Password-based authentication (WBPRO_PASSWORD required)
- Session cookies with HMAC signing
- JWT support for external API auth
- Kartis webhook signature verification

### Blocklist

- Phone number blocklist
- Block/unblock management
- Respected across all features (import, broadcast, scoring)

### Settings

- Configurable cooldown minutes
- Quiet hours (start/end times)
- Auto-announce toggle
- General platform settings

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Server | [Express](https://expressjs.com) |
| WhatsApp | [whatsapp-web.js](https://wwebjs.dev) with Puppeteer |
| AI | [NVIDIA NIM](https://build.nvidia.com) (Llama 3.3 70B Instruct) |
| Storage | JSON file persistence (portable, no database required) |
| QR Codes | [qrcode](https://www.npmjs.com/package/qrcode) |
| File Upload | [multer](https://www.npmjs.com/package/multer) |
| Testing | [Vitest](https://vitest.dev) (307 tests across 19 suites) |
| Deployment | [Render](https://render.com) with persistent disk |
| Frontend | Static HTML/JS (5 pages) |

---

## API Reference (120+ routes)

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

### AI Chatbot

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/whatsapp/ai/chat` | Send message to AI chatbot |
| GET | `/api/whatsapp/ai/status` | AI configuration status |

### Lead Scoring

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/leads/score` | Score all contacts (sorted, paginated, filterable) |
| GET | `/api/leads/score/:id` | Score a specific contact |
| POST | `/api/leads/score/:id/boost` | Boost contact scoring signals |
| GET | `/api/leads/score-summary` | Tier distribution and averages |

### Auto Follow-Up Sequences

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/leads/auto-follow-up` | List all sequences |
| POST | `/api/leads/auto-follow-up` | Create sequence |
| GET | `/api/leads/auto-follow-up/:id` | Get sequence details |
| PUT | `/api/leads/auto-follow-up/:id` | Update sequence |
| DELETE | `/api/leads/auto-follow-up/:id` | Delete sequence |
| GET | `/api/leads/auto-follow-up-queue` | View active follow-up queue |
| POST | `/api/leads/auto-follow-up-enroll` | Manually enroll a contact |
| POST | `/api/leads/auto-follow-up-cancel` | Cancel a contact's follow-up |
| POST | `/api/leads/auto-follow-up-pause` | Pause/resume a follow-up |
| GET | `/api/leads/auto-follow-up-status` | Follow-up system status |

### Smart Group Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/groups/profiles` | List group profiles with health |
| GET | `/api/groups/profiles/:groupId` | Single profile with health + optimal times |
| POST | `/api/groups/profiles` | Create/update group profile |
| PUT | `/api/groups/profiles/:groupId` | Update group profile |
| DELETE | `/api/groups/profiles/:groupId` | Delete group profile |
| POST | `/api/groups/smart-join` | Get ranked group recommendations for a contact |
| GET | `/api/groups/health` | Group health dashboard with summary |
| POST | `/api/groups/activity` | Report group activity (testing/seeding) |

### Ticket Purchase Flow

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/tickets/seed-flow` | Seed the default ticket purchase flow |
| GET | `/api/tickets/lookup` | Search events with ticket URLs |
| POST | `/api/tickets/simulate` | Simulate a ticket purchase conversation |
| GET | `/api/tickets/flow-status` | Check ticket flow status |

### Leads

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/leads` | List captured leads |
| GET | `/api/leads/stats` | Lead capture statistics |
| GET | `/api/leads/export` | Export leads as CSV |
| PUT | `/api/leads/:id` | Update lead status |

### Keywords

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/keywords` | Get keyword dictionaries |
| POST | `/api/keywords` | Add custom keywords |
| DELETE | `/api/keywords/:keyword` | Remove custom keyword |

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
| POST | `/api/lists/broadcast` | Send broadcast to list |
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

### CRM Scraping

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/whatsapp/scrape` | Scrape all group participants |
| POST | `/api/whatsapp/scrape/:groupId` | Scrape specific group |

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

> All `/api/whatsapp/*` routes have short aliases under `/api/*` for frontend compatibility.

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `WBPRO_PASSWORD` | Yes | Login password (required to start) |
| `PORT` | No | Server port (default: 8080) |
| `NVIDIA_NIM_API_KEY` | No | NVIDIA NIM API key for AI chatbot |
| `NVIDIA_NIM_MODEL` | No | LLM model (default: meta/llama-3.3-70b-instruct) |
| `NVIDIA_NIM_URL` | No | NIM API endpoint URL |
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

### AI Chatbot Setup

```bash
export NVIDIA_NIM_API_KEY="your-nvidia-api-key"
# Then seed the ticket purchase flow:
# POST /api/tickets/seed-flow
```

### Testing

```bash
# 307 tests across 19 suites
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
| `flows.json` | Automation flows (including AI + ticket purchase flows) |
| `contacts.json` | CRM contacts |
| `crm.json` | CRM metadata |
| `blocklist.json` | Blocked phone numbers |
| `broadcast-lists.json` | Broadcast list definitions |
| `personas.json` | Brand personas |
| `settings.json` | Platform settings |
| `group-tags.json` | Group tag assignments |
| `group-profiles.json` | Smart group profiles (city, category, tier, invite links) |
| `follow-up-sequences.json` | Auto follow-up sequence definitions |
| `follow-up-queue.json` | Active follow-up queue state |
| `wwebjs_auth/` | WhatsApp session data |

---

## Project Structure

```
server.js               # Express app (all routes, WhatsApp client, AI, scoring, ~6600 lines)
leads.js                # Lead capture module (keyword detection, storage)
public/
  index.html            # Main dashboard (leads, contacts, scoring, groups)
  login.html            # Login page
  analytics.html        # Analytics dashboard
  flows.html            # Flow builder (message, AI, ticket nodes)
  import.html           # Contact import
templates/              # Persona-specific message templates
tests/                  # 19 test suites, 307 tests
  ai-response.test.js   # AI chatbot flow tests (10 tests)
  lead-scoring.test.js  # Lead scoring engine tests (20 tests)
  auto-follow-up.test.js # Follow-up sequence tests (25 tests)
  smart-groups.test.js  # Smart group management tests (21 tests)
  ticket-purchase.test.js # Ticket purchase flow tests (21 tests)
  flows.test.js         # Conversation flow tests
  broadcast.test.js     # Broadcasting tests
  contacts-crm.test.js  # CRM tests
  leads.test.js         # Lead capture tests
  ...                   # 10 more test suites
render.yaml             # Render deployment config
Dockerfile              # Container build
```

---

## License

Private. All rights reserved.
