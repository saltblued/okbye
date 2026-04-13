// ══════════════════════════════════════════════════════════════
// BlockSyncer Bookmarklet — scrapes X blocked page → sends to API
// ══════════════════════════════════════════════════════════════
//
// Your website generates a personalized bookmarklet per user:
//   javascript:void((()=>{const T='USER_TOKEN';const L='LIST_ID';const A='https://yoursite.com';...})())
//
// This is the full readable version. Minify it for the bookmarklet.

const API_BASE = 'https://yoursite.com';  // ← replace with your domain
const AUTH_TOKEN = 'USER_TOKEN_HERE';      // ← injected per user
const BLOCKLIST_ID = 'LIST_ID_HERE';       // ← which list to sync to

(async () => {
  // Check we're on the right page
  if (!location.href.includes('/settings/blocked')) {
    alert('⬛ BlockSyncer\n\nGo to x.com/settings/blocked/all first,\nthen click this bookmark again.');
    return;
  }

  // Show banner
  const banner = document.createElement('div');
  Object.assign(banner.style, {
    position:'fixed', top:'0', left:'0', right:'0', zIndex:'99999',
    background:'#000', color:'#fff', padding:'14px 20px',
    fontFamily:'-apple-system,sans-serif', fontSize:'14px',
    display:'flex', alignItems:'center', justifyContent:'space-between',
    boxShadow:'0 4px 20px rgba(0,0,0,0.4)'
  });
  banner.innerHTML = '<div><b>⬛ BlockSyncer</b> <span id="bs-s" style="opacity:.6;margin-left:8px">Scanning…</span></div><div id="bs-c" style="background:#333;padding:4px 12px;border-radius:99px;font-size:13px">0</div>';
  document.body.appendChild(banner);
  const st = document.getElementById('bs-s');
  const ct = document.getElementById('bs-c');

  // Scrape
  const found = new Set();
  let stale = 0;

  function scrape() {
    let n = 0;
    // Method 1: UserCell test IDs (most reliable)
    document.querySelectorAll('[data-testid="UserCell"]').forEach(cell => {
      cell.querySelectorAll('span').forEach(s => {
        const t = s.textContent.trim();
        if (t.startsWith('@') && /^@[A-Za-z0-9_]{1,15}$/.test(t)) {
          const u = t.slice(1).toLowerCase();
          if (!found.has(u)) { found.add(u); n++; }
        }
      });
    });
    // Method 2: profile links (fallback)
    document.querySelectorAll('a[role="link"][href^="/"]').forEach(a => {
      const m = a.getAttribute('href').match(/^\/([A-Za-z0-9_]{1,15})$/);
      if (m) {
        const u = m[1].toLowerCase();
        const skip = ['home','explore','search','notifications','messages','settings','compose','i','tos','privacy'];
        if (!skip.includes(u) && !found.has(u)) { found.add(u); n++; }
      }
    });
    return n;
  }

  scrape();
  ct.textContent = found.size;

  // Auto-scroll
  for (let i = 0; i < 300; i++) {
    window.scrollTo(0, document.body.scrollHeight);
    await new Promise(r => setTimeout(r, 700));
    const before = found.size;
    scrape();
    ct.textContent = found.size;
    st.textContent = 'Scrolling… (' + (i+1) + ')';
    if (found.size === before) { stale++; if (stale >= 5) break; } else { stale = 0; }
  }

  // Send to API
  const accounts = [...found];
  st.textContent = 'Syncing ' + accounts.length + ' accounts…';

  try {
    const r = await fetch(API_BASE + '/api/blocklists/' + BLOCKLIST_ID + '/sync', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'Authorization':'Bearer ' + AUTH_TOKEN },
      body: JSON.stringify({ accounts })
    });
    if (!r.ok) throw new Error(r.status);
    const d = await r.json();
    st.textContent = '✓ Synced!';
    ct.textContent = d.newly_added + ' new / ' + d.total_accounts + ' total';
    ct.style.background = '#22c55e'; ct.style.color = '#000';
  } catch (e) {
    st.textContent = '⚠ Sync failed — copying to clipboard';
    ct.style.background = '#ef4444';
    try { await navigator.clipboard.writeText(accounts.join('\n')); st.textContent += ' ✓'; }
    catch { console.log('BlockSyncer list:\n' + accounts.join('\n')); }
  }

  setTimeout(() => { banner.style.transition='opacity .5s'; banner.style.opacity='0'; setTimeout(()=>banner.remove(),600); }, 8000);
})();
