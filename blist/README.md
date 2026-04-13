# ⬛ BlockSyncer

Community blocklist platform for X. Users scrape their blocked accounts via a bookmarklet and share them as followable lists.

## How it works

**List creators:**
1. Sign up → create a blocklist
2. Visit `x.com/settings/blocked/all`
3. Click the BlockSyncer bookmarklet → auto-scrapes and syncs
4. Re-run anytime to add new blocks

**List followers:**
1. Browse community blocklists
2. Follow lists you want
3. Check back for new additions → one-click block script

## Setup

```bash
npm install
npm start        # http://localhost:3001
npm run dev      # auto-reload on changes
```

## API endpoints

### Auth
```
POST /api/auth/register   { username, email, password, x_handle }
POST /api/auth/login      { email, password }
```
Both return `{ token, user }`. Send token as `Authorization: Bearer <token>`.

### Blocklists
```
GET    /api/blocklists              Browse (query: ?search=&category=&sort=)
POST   /api/blocklists              Create { name, description, category, accounts[] }
GET    /api/blocklists/:id          Single list + all accounts
POST   /api/blocklists/:id/sync     Add accounts { accounts[] } (bookmarklet)
POST   /api/blocklists/:id/follow   Follow
DELETE /api/blocklists/:id/follow   Unfollow
GET    /api/blocklists/:id/script   Get runnable block script
```

### My follows
```
GET    /api/me/following            Lists I follow + new account count
GET    /api/me/following/:id/new    New accounts since last sync
POST   /api/me/following/:id/ack    Mark synced
```

### Health
```
GET    /api/health
```

## File structure
```
blocksyncer/
├── server.js          ← Express API (all routes + SQLite DB)
├── bookmarklet.js     ← Scraper script (readable version)
├── package.json
├── public/            ← Put your frontend HTML here
│   └── index.html
└── blocksyncer.db     ← Created automatically on first run
```

## Deploying

**Railway / Render (easiest, free tier):**
1. Push to GitHub
2. Connect repo → auto-deploys
3. Set env var: `JWT_SECRET=something-long-and-random`

**Vercel:**
Needs refactoring to serverless + hosted DB (Turso or Supabase).

## Env vars
| Variable | Default | Notes |
|----------|---------|-------|
| `PORT` | `3001` | Server port |
| `JWT_SECRET` | dev default | **Change in production** |

## Notes
- Database is SQLite (zero config). For production scale, swap to Turso (hosted SQLite) or Postgres.
- The bookmarklet reads X's DOM directly — no API key or paid access needed.
- X can change their page structure which may break the scraper. The bookmarklet has two scraping methods as fallback.
