const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'blocksyncer-dev-secret-change-in-production';

// ─── Middleware ───────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public'))); // serves your frontend

// ─── Database ────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'blocksyncer.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    x_handle TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS blocklists (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    description TEXT,
    category TEXT DEFAULT 'general',
    is_public INTEGER DEFAULT 1,
    account_count INTEGER DEFAULT 0,
    follower_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS blocked_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    blocklist_id TEXT NOT NULL REFERENCES blocklists(id) ON DELETE CASCADE,
    username TEXT NOT NULL,
    added_at TEXT DEFAULT (datetime('now')),
    UNIQUE(blocklist_id, username)
  );

  CREATE TABLE IF NOT EXISTS follows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id),
    blocklist_id TEXT NOT NULL REFERENCES blocklists(id) ON DELETE CASCADE,
    last_synced_at TEXT DEFAULT (datetime('now')),
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, blocklist_id)
  );

  CREATE INDEX IF NOT EXISTS idx_blocked_list ON blocked_accounts(blocklist_id);
  CREATE INDEX IF NOT EXISTS idx_follows_user ON follows(user_id);
  CREATE INDEX IF NOT EXISTS idx_follows_list ON follows(blocklist_id);
`);

// ─── Auth middleware ─────────────────────────────────────────
function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
  try {
    req.userId = jwt.verify(h.slice(7), JWT_SECRET).userId;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function optionalAuth(req, res, next) {
  const h = req.headers.authorization;
  if (h && h.startsWith('Bearer ')) {
    try { req.userId = jwt.verify(h.slice(7), JWT_SECRET).userId; } catch {}
  }
  next();
}

// ─── Helpers ─────────────────────────────────────────────────
function parseUsernames(raw) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(
    raw.map(u => String(u).trim().toLowerCase())
       .map(u => u.replace(/^@/, ''))
       .map(u => u.replace(/^https?:\/\/(www\.)?(twitter|x)\.com\//, ''))
       .map(u => u.split('/')[0].split('?')[0])
       .filter(u => /^[a-z0-9_]{1,15}$/.test(u))
  )];
}

// ─── AUTH ROUTES ─────────────────────────────────────────────

app.post('/api/auth/register', (req, res) => {
  const { username, email, password, x_handle } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: 'All fields required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be 6+ chars' });

  const exists = db.prepare('SELECT id FROM users WHERE email = ? OR username = ?').get(email, username);
  if (exists) return res.status(409).json({ error: 'Username or email already taken' });

  const id = uuidv4();
  db.prepare('INSERT INTO users (id, username, email, password_hash, x_handle) VALUES (?,?,?,?,?)')
    .run(id, username, email, bcrypt.hashSync(password, 10), x_handle || null);

  const token = jwt.sign({ userId: id }, JWT_SECRET, { expiresIn: '30d' });
  res.status(201).json({ token, user: { id, username, email, x_handle } });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, username: user.username, email: user.email, x_handle: user.x_handle } });
});

// ─── BLOCKLIST ROUTES ────────────────────────────────────────

// Create a new blocklist
app.post('/api/blocklists', auth, (req, res) => {
  const { name, description, category, accounts } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  const id = uuidv4();
  db.prepare('INSERT INTO blocklists (id, owner_id, name, description, category) VALUES (?,?,?,?,?)')
    .run(id, req.userId, name, description || '', category || 'general');

  if (accounts && accounts.length) {
    const parsed = parseUsernames(accounts);
    const ins = db.prepare('INSERT OR IGNORE INTO blocked_accounts (blocklist_id, username) VALUES (?,?)');
    db.transaction(() => { for (const u of parsed) ins.run(id, u); })();
    db.prepare('UPDATE blocklists SET account_count = ?, updated_at = datetime("now") WHERE id = ?')
      .run(parsed.length, id);
  }

  res.status(201).json(db.prepare('SELECT * FROM blocklists WHERE id = ?').get(id));
});

// Browse all public blocklists
app.get('/api/blocklists', optionalAuth, (req, res) => {
  const { search, category, sort } = req.query;
  let q = `SELECT b.*, u.username as owner_name, u.x_handle as owner_x
           FROM blocklists b JOIN users u ON b.owner_id = u.id
           WHERE b.is_public = 1`;
  const p = [];

  if (search) { q += ' AND (b.name LIKE ? OR b.description LIKE ?)'; p.push(`%${search}%`, `%${search}%`); }
  if (category && category !== 'all') { q += ' AND b.category = ?'; p.push(category); }

  if (sort === 'followers') q += ' ORDER BY b.follower_count DESC';
  else if (sort === 'accounts') q += ' ORDER BY b.account_count DESC';
  else q += ' ORDER BY b.updated_at DESC';

  const lists = db.prepare(q).all(...p);

  if (req.userId) {
    const followed = new Set(
      db.prepare('SELECT blocklist_id FROM follows WHERE user_id = ?').all(req.userId).map(f => f.blocklist_id)
    );
    lists.forEach(l => l.is_following = followed.has(l.id));
  }

  res.json(lists);
});

// Get single blocklist + accounts
app.get('/api/blocklists/:id', optionalAuth, (req, res) => {
  const list = db.prepare(
    `SELECT b.*, u.username as owner_name, u.x_handle as owner_x
     FROM blocklists b JOIN users u ON b.owner_id = u.id WHERE b.id = ?`
  ).get(req.params.id);
  if (!list) return res.status(404).json({ error: 'Not found' });

  list.accounts = db.prepare(
    'SELECT username, added_at FROM blocked_accounts WHERE blocklist_id = ? ORDER BY added_at DESC'
  ).all(req.params.id);

  if (req.userId) {
    const f = db.prepare('SELECT * FROM follows WHERE user_id = ? AND blocklist_id = ?').get(req.userId, req.params.id);
    list.is_following = !!f;
    list.last_synced_at = f?.last_synced_at || null;
  }

  res.json(list);
});

// Sync accounts to a blocklist (bookmarklet POSTs here)
app.post('/api/blocklists/:id/sync', auth, (req, res) => {
  const list = db.prepare('SELECT * FROM blocklists WHERE id = ? AND owner_id = ?').get(req.params.id, req.userId);
  if (!list) return res.status(404).json({ error: 'Not found or not yours' });

  const { accounts } = req.body;
  if (!accounts || !Array.isArray(accounts)) return res.status(400).json({ error: 'accounts array required' });

  const parsed = parseUsernames(accounts);
  const ins = db.prepare('INSERT OR IGNORE INTO blocked_accounts (blocklist_id, username) VALUES (?,?)');

  let added = 0;
  db.transaction(() => {
    for (const u of parsed) { if (ins.run(req.params.id, u).changes) added++; }
  })();

  const total = db.prepare('SELECT COUNT(*) as c FROM blocked_accounts WHERE blocklist_id = ?').get(req.params.id).c;
  db.prepare('UPDATE blocklists SET account_count = ?, updated_at = datetime("now") WHERE id = ?').run(total, req.params.id);

  res.json({ newly_added: added, total_accounts: total, duplicates_skipped: parsed.length - added });
});

// Follow / unfollow
app.post('/api/blocklists/:id/follow', auth, (req, res) => {
  if (!db.prepare('SELECT id FROM blocklists WHERE id = ?').get(req.params.id)) {
    return res.status(404).json({ error: 'Not found' });
  }
  try {
    db.prepare('INSERT INTO follows (user_id, blocklist_id) VALUES (?,?)').run(req.userId, req.params.id);
    db.prepare('UPDATE blocklists SET follower_count = follower_count + 1 WHERE id = ?').run(req.params.id);
    res.json({ message: 'Followed' });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Already following' });
    throw e;
  }
});

app.delete('/api/blocklists/:id/follow', auth, (req, res) => {
  const r = db.prepare('DELETE FROM follows WHERE user_id = ? AND blocklist_id = ?').run(req.userId, req.params.id);
  if (r.changes) db.prepare('UPDATE blocklists SET follower_count = MAX(0, follower_count - 1) WHERE id = ?').run(req.params.id);
  res.json({ message: 'Unfollowed' });
});

// ─── FOLLOWING ROUTES ────────────────────────────────────────

// Lists I follow (with count of new accounts since last sync)
app.get('/api/me/following', auth, (req, res) => {
  res.json(db.prepare(`
    SELECT b.*, u.username as owner_name, f.last_synced_at,
      (SELECT COUNT(*) FROM blocked_accounts ba
       WHERE ba.blocklist_id = b.id AND ba.added_at > f.last_synced_at) as new_accounts
    FROM follows f
    JOIN blocklists b ON f.blocklist_id = b.id
    JOIN users u ON b.owner_id = u.id
    WHERE f.user_id = ?
    ORDER BY new_accounts DESC
  `).all(req.userId));
});

// Get new accounts since my last sync
app.get('/api/me/following/:id/new', auth, (req, res) => {
  const f = db.prepare('SELECT * FROM follows WHERE user_id = ? AND blocklist_id = ?').get(req.userId, req.params.id);
  if (!f) return res.status(404).json({ error: 'Not following' });
  res.json({
    new_accounts: db.prepare(
      'SELECT username, added_at FROM blocked_accounts WHERE blocklist_id = ? AND added_at > ? ORDER BY added_at DESC'
    ).all(req.params.id, f.last_synced_at),
    since: f.last_synced_at
  });
});

// Mark as synced
app.post('/api/me/following/:id/ack', auth, (req, res) => {
  db.prepare('UPDATE follows SET last_synced_at = datetime("now") WHERE user_id = ? AND blocklist_id = ?')
    .run(req.userId, req.params.id);
  res.json({ message: 'Acknowledged' });
});

// ─── BLOCK SCRIPT GENERATOR ─────────────────────────────────
// Returns a JS script that blocks all accounts on a list
app.get('/api/blocklists/:id/script', (req, res) => {
  const list = db.prepare('SELECT * FROM blocklists WHERE id = ?').get(req.params.id);
  if (!list) return res.status(404).json({ error: 'Not found' });

  const accounts = db.prepare('SELECT username FROM blocked_accounts WHERE blocklist_id = ?')
    .all(req.params.id).map(a => a.username);

  const script = `// BlockSyncer — "${list.name}" (${accounts.length} accounts)
// Paste this in your browser console on any x.com page
(async()=>{
const users=${JSON.stringify(accounts)};
let done=0,fail=0;
for(const u of users){
  try{
    const r=await fetch("https://x.com/i/api/1.1/blocks/create.json",{
      method:"POST",
      headers:{"content-type":"application/x-www-form-urlencoded",
        "authorization":document.cookie.match(/ct0=([^;]+)/)?.[1]?
          "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA":"",
        "x-csrf-token":document.cookie.match(/ct0=([^;]+)/)?.[1]||""},
      body:"screen_name="+u,
      credentials:"include"
    });
    if(r.ok)done++;else fail++;
  }catch{fail++}
  await new Promise(r=>setTimeout(r,600));
  console.log(\`[\${done+fail}/\${users.length}] blocked @\${u}\`);
}
alert("Done! Blocked "+done+"/"+users.length+(fail?" ("+fail+" failed)":""));
})();`;

  res.type('text/javascript').send(script);
});

// ─── HEALTH CHECK ────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    users: db.prepare('SELECT COUNT(*) as c FROM users').get().c,
    blocklists: db.prepare('SELECT COUNT(*) as c FROM blocklists').get().c,
    blocked_accounts: db.prepare('SELECT COUNT(*) as c FROM blocked_accounts').get().c,
  });
});

// ─── Catch-all: serve frontend for any non-API route ─────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── START ───────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  ⬛ BlockSyncer API → http://localhost:${PORT}`);
  console.log(`  📋 Health check  → http://localhost:${PORT}/api/health\n`);
});
