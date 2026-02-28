// ════════════════════════════════════════════════════════════════
//  Naa's Luxe Glam — Order Backend
//  Stack: Express + whatsapp-web.js
//  Orders are silently sent to the owner's WhatsApp.
//  The customer never leaves the website.
// ════════════════════════════════════════════════════════════════

require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const fs         = require('fs');
const QRCode     = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');

// ── Config ───────────────────────────────────────────────────────
const PORT               = process.env.PORT || 3000;
const OWNER_NUMBER       = process.env.OWNER_WHATSAPP_NUMBER || '233534329262';
const ADMIN_SECRET       = process.env.ADMIN_SECRET || 'naas2025luxe';

// ── WhatsApp Client State ────────────────────────────────────────
let waStatus   = 'initializing';   // initializing | qr_ready | authenticated | ready | disconnected
let currentQR  = null;             // base64 PNG of the QR code
let orderQueue = [];               // holds orders while WA is not ready

// ── WhatsApp Client ──────────────────────────────────────────────
// Resolve Chrome executable — handles Render's Puppeteer cache path
const chromePath = (() => {
  // 1. Check Render's known Puppeteer cache location
  const renderCacheBase = '/opt/render/.cache/puppeteer/chrome';
  if (fs.existsSync(renderCacheBase)) {
    try {
      const versions = fs.readdirSync(renderCacheBase);
      for (const version of versions) {
        const candidates = [
          path.join(renderCacheBase, version, 'chrome-linux64', 'chrome'),
          path.join(renderCacheBase, version, 'chrome-linux', 'chrome'),
        ];
        for (const c of candidates) {
          if (fs.existsSync(c)) {
            console.log('✔  Chrome found at:', c);
            return c;
          }
        }
      }
    } catch (e) {
      console.warn('Chrome scan error:', e.message);
    }
  }

  // 2. Try Puppeteer's built-in executablePath()
  try {
    const { executablePath } = require('puppeteer');
    const p = executablePath();
    if (p && fs.existsSync(p)) {
      console.log('✔  Chrome via puppeteer.executablePath():', p);
      return p;
    }
  } catch { /* puppeteer not available */ }

  // 3. Fallback — let Chromium find itself
  console.warn('⚠️  Chrome not found via known paths — falling back to system default');
  return undefined;
})();

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: '.wwebjs_auth' }),
  puppeteer: {
    headless: true,
    executablePath: chromePath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-extensions',
    ],
  },
});

// QR code generated — convert to base64 PNG for the admin panel
client.on('qr', async (qr) => {
  console.log('\n⚡  WhatsApp QR ready — visit http://localhost:' + PORT + '/admin to scan\n');
  waStatus  = 'qr_ready';
  currentQR = await QRCode.toDataURL(qr, { margin: 2, width: 256 });
});

client.on('authenticated', () => {
  console.log('✅  WhatsApp authenticated!');
  waStatus  = 'authenticated';
  currentQR = null;
});

client.on('ready', async () => {
  console.log('🚀  WhatsApp client is READY — orders will be delivered instantly.');
  waStatus = 'ready';

  // Flush any orders that came in before WA was ready
  if (orderQueue.length > 0) {
    console.log(`📬  Flushing ${orderQueue.length} queued order(s)…`);
    for (const payload of orderQueue) {
      await sendWhatsAppOrder(payload);
    }
    orderQueue = [];
  }
});

client.on('auth_failure', (msg) => {
  console.error('❌  WhatsApp auth failure:', msg);
  waStatus = 'disconnected';
});

client.on('disconnected', (reason) => {
  console.warn('⚠️  WhatsApp disconnected:', reason);
  waStatus = 'disconnected';
  // Attempt to re-initialise after 10 s
  setTimeout(() => {
    console.log('🔄  Attempting to reconnect WhatsApp…');
    client.initialize().catch(console.error);
  }, 10_000);
});

// Boot WhatsApp
client.initialize().catch((err) => {
  console.error('WhatsApp init error:', err.message);
});

// ── Helpers ───────────────────────────────────────────────────────

/**
 * Format the order object into a WhatsApp message string.
 */
function buildOrderMessage(order) {
  const ts = new Date().toLocaleString('en-GH', {
    timeZone: 'Africa/Accra',
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  const divider = '━━━━━━━━━━━━━━━━━━━━━━';

  const lines = [
    `🛍️ *NEW ORDER — Naa's Luxe Glam*`,
    `🕐 ${ts}`,
    divider,
    ``,
    `👤 *CUSTOMER DETAILS*`,
    `• Name:     ${order.name}`,
    `• Phone:    ${order.phone}`,
    order.email ? `• Email:    ${order.email}` : null,
    `• Address:  ${order.location}`,
    ``,
    `🛒 *ORDER DETAILS*`,
    `• Category: ${order.category}`,
    `• Product:  ${order.product}`,
    `• Qty:      ${order.quantity}`,
    order.sizecolor ? `• Size/Clr: ${order.sizecolor}` : null,
    ``,
    order.notes ? `📝 *Notes:* ${order.notes}` : null,
    order.notes ? `` : null,
    `💳 *Payment:* ${order.payment}`,
    `📣 *Found us via:* ${order.referral}`,
    ``,
    divider,
    `✦ Reply to this message to confirm the order.`,
  ];

  return lines.filter(l => l !== null).join('\n');
}

/**
 * Actually send the WhatsApp message.
 */
async function sendWhatsAppOrder(order) {
  try {
    const chatId  = `${OWNER_NUMBER}@c.us`;
    const message = buildOrderMessage(order);
    await client.sendMessage(chatId, message);
    console.log(`📩  Order from "${order.name}" sent to WhatsApp ✓`);
    return true;
  } catch (err) {
    console.error('WhatsApp send error:', err.message);
    return false;
  }
}

// ── Express App ──────────────────────────────────────────────────
const app = express();

app.use(cors());
app.use(express.json());

// Serve the frontend (index.html + assets)
app.use(express.static(path.join(__dirname, 'public')));

// ── API: Receive an order ────────────────────────────────────────
app.post('/send-order', async (req, res) => {
  const { name, phone, email, location, category, product, quantity, sizecolor, notes, payment, referral } = req.body;

  // Basic validation
  if (!name || !phone || !location || !category || !product || !quantity) {
    return res.status(400).json({ success: false, error: 'Missing required fields.' });
  }

  const order = { name, phone, email, location, category, product, quantity, sizecolor, notes, payment, referral };

  if (waStatus === 'ready') {
    const sent = await sendWhatsAppOrder(order);
    if (sent) {
      return res.json({ success: true });
    } else {
      // WhatsApp send failed — queue it and still tell customer it worked
      orderQueue.push(order);
      return res.json({ success: true });
    }
  } else {
    // WA not ready yet — queue the order so it goes out as soon as it connects
    console.log(`⏳  WA not ready (${waStatus}) — order from "${name}" queued`);
    orderQueue.push(order);
    return res.json({ success: true });
  }
});

// ── API: WhatsApp status (used by admin panel) ───────────────────
app.get('/api/wa-status', (req, res) => {
  res.json({
    status: waStatus,
    qr: waStatus === 'qr_ready' ? currentQR : null,
    queue: orderQueue.length,
  });
});

// ── Admin Panel ──────────────────────────────────────────────────
app.get('/admin', (req, res) => {
  // Simple secret-key guard via query param: /admin?key=naas2025luxe
  if (req.query.key !== ADMIN_SECRET) {
    return res.status(401).send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Admin – Naa's Luxe Glam</title>
        <style>
          * { margin:0; padding:0; box-sizing:border-box; }
          body { font-family: 'Segoe UI', sans-serif; background:#fdf6f0; display:flex; align-items:center; justify-content:center; min-height:100vh; padding:1.5rem; }
          .card { background:#fff; border-radius:20px; padding:2.5rem 2rem; max-width:380px; width:100%; text-align:center; box-shadow:0 8px 40px rgba(0,0,0,0.08); border:1px solid #f7dde4; }
          h2 { font-size:1.4rem; color:#2a1a1f; margin-bottom:0.5rem; }
          p { font-size:0.85rem; color:#7a4f5a; margin-bottom:1.5rem; }
          input { width:100%; padding:0.75rem 1rem; border:1.5px solid #e8a4b0; border-radius:10px; font-size:0.9rem; outline:none; margin-bottom:1rem; }
          button { width:100%; padding:0.8rem; background:linear-gradient(135deg,#c4637a,#b85a71); color:#fff; border:none; border-radius:10px; font-size:0.9rem; cursor:pointer; }
        </style>
      </head>
      <body>
        <div class="card">
          <h2>🔒 Admin Access</h2>
          <p>Enter your admin secret key to access the WhatsApp setup panel.</p>
          <form onsubmit="event.preventDefault(); window.location='/admin?key='+document.getElementById('k').value">
            <input id="k" type="password" placeholder="Secret key…" autocomplete="off">
            <button type="submit">Enter Admin Panel</button>
          </form>
        </div>
      </body>
      </html>`);
  }

  // Admin HTML page
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin – Naa's Luxe Glam</title>
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,300;1,400&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">
  <style>
    :root {
      --rose:#e8a4b0; --blush:#f7dde4; --deep-rose:#c4637a;
      --gold:#c9a96e; --cream:#fdf6f0; --dark:#2a1a1f; --mid:#7a4f5a;
    }
    * { margin:0; padding:0; box-sizing:border-box; }
    body {
      font-family:'DM Sans',sans-serif;
      background:var(--cream);
      min-height:100vh;
      display:flex; flex-direction:column; align-items:center;
      padding:1.5rem 1rem 4rem;
    }
    .admin-header {
      width:100%; max-width:520px;
      display:flex; align-items:center; justify-content:space-between;
      padding:1.2rem 0; margin-bottom:1.5rem;
      border-bottom:1px solid var(--blush);
    }
    .brand {
      font-family:'Cormorant Garamond',serif;
      font-size:1.3rem; font-weight:600;
      background:linear-gradient(135deg,var(--deep-rose),var(--gold));
      -webkit-background-clip:text; -webkit-text-fill-color:transparent;
    }
    .admin-tag {
      font-size:0.7rem; font-weight:600; letter-spacing:0.15em;
      text-transform:uppercase; color:var(--mid);
      background:var(--blush); padding:0.3rem 0.8rem; border-radius:50px;
    }
    .card {
      width:100%; max-width:520px;
      background:#fff; border-radius:24px;
      border:1px solid var(--blush);
      box-shadow:0 8px 48px rgba(196,99,122,0.1);
      overflow:hidden; margin-bottom:1.5rem;
    }
    .card-header {
      padding:1.6rem 2rem;
      background:linear-gradient(135deg,#fff5f7,#fffbf5);
      border-bottom:1px solid var(--blush);
      display:flex; align-items:center; gap:1rem;
    }
    .card-header .icon { font-size:2rem; }
    .card-header h2 {
      font-family:'Cormorant Garamond',serif;
      font-size:1.4rem; font-weight:600; color:var(--dark);
    }
    .card-header p { font-size:0.8rem; color:var(--mid); margin-top:0.2rem; }
    .card-body { padding:2rem; }
    .status-row {
      display:flex; align-items:center; justify-content:space-between;
      background:#f9f4f5; border-radius:14px; padding:1rem 1.2rem;
      margin-bottom:1.5rem; flex-wrap:wrap; gap:0.5rem;
    }
    .status-label { font-size:0.8rem; color:var(--mid); font-weight:500; }
    .status-pill {
      font-size:0.78rem; font-weight:700; letter-spacing:0.08em;
      padding:0.3rem 1rem; border-radius:50px; text-transform:uppercase;
    }
    .pill-init    { background:#f0f0f0; color:#666; }
    .pill-qr      { background:#fff3cd; color:#856404; }
    .pill-auth    { background:#d4edda; color:#155724; }
    .pill-ready   { background:#d1fae5; color:#065f46; }
    .pill-disc    { background:#fde8e8; color:#9b1c1c; }
    #qr-img {
      width:200px; height:200px; border-radius:12px;
      border:3px solid var(--rose);
      margin:1rem auto; display:block;
      box-shadow:0 4px 20px rgba(196,99,122,0.2);
    }
    .qr-hint { font-size:0.8rem; color:var(--mid); line-height:1.6; margin-top:0.8rem; }
    .steps { list-style:none; display:flex; flex-direction:column; gap:0.8rem; margin-bottom:1.5rem; }
    .steps li { display:flex; align-items:flex-start; gap:0.8rem; font-size:0.83rem; color:var(--mid); line-height:1.5; }
    .step-num {
      min-width:24px; height:24px; border-radius:50%;
      background:linear-gradient(135deg,var(--deep-rose),#b85a71);
      color:#fff; font-size:0.7rem; font-weight:700;
      display:flex; align-items:center; justify-content:center;
      flex-shrink:0; margin-top:1px;
    }
    .queue-info {
      background:linear-gradient(135deg,#fff5f7,#fffbf5);
      border:1px solid var(--blush); border-radius:12px;
      padding:0.8rem 1rem; font-size:0.82rem; color:var(--mid);
      display:flex; align-items:center; gap:0.6rem; margin-top:1rem;
    }
    .queue-info strong { color:var(--dark); }
    .connected-banner { text-align:center; padding:2rem 1rem; }
    .connected-icon { font-size:4rem; }
    .connected-banner h3 {
      font-family:'Cormorant Garamond',serif;
      font-size:1.6rem; font-weight:600; color:var(--dark);
      margin:0.6rem 0 0.3rem;
    }
    .connected-banner p { font-size:0.85rem; color:var(--mid); line-height:1.6; }
    .num-badge {
      display:inline-block; margin-top:0.8rem;
      background:linear-gradient(135deg,var(--deep-rose),var(--gold));
      -webkit-background-clip:text; -webkit-text-fill-color:transparent;
      font-family:'Cormorant Garamond',serif; font-size:1.1rem; font-weight:600;
    }
    .btn-row { display:flex; gap:0.8rem; margin-top:1.5rem; flex-wrap:wrap; }
    .btn { flex:1; min-width:120px; padding:0.75rem 1rem; border-radius:50px; font-size:0.82rem; font-weight:500; cursor:pointer; border:none; transition:all 0.2s; text-align:center; }
    .btn-primary { background:linear-gradient(135deg,var(--deep-rose),#b85a71); color:#fff; box-shadow:0 4px 16px rgba(196,99,122,0.3); }
    .btn-primary:hover { transform:translateY(-2px); }
    .btn-outline { background:transparent; color:var(--deep-rose); border:1.5px solid var(--rose); }
    .btn-outline:hover { background:var(--blush); }
    .footnote { font-size:0.72rem; color:rgba(122,79,90,0.5); text-align:center; max-width:520px; margin-top:0.5rem; }
    @keyframes spin { to { transform:rotate(360deg); } }
    .spinner { width:28px; height:28px; border:3px solid var(--blush); border-top-color:var(--deep-rose); border-radius:50%; animation:spin 0.8s linear infinite; margin:1.5rem auto; }
    @media (max-width:520px) { .card-body { padding:1.5rem 1.2rem; } .card-header { padding:1.2rem; } }
  </style>
</head>
<body>

<div class="admin-header">
  <span class="brand">Naa's Luxe Glam</span>
  <span class="admin-tag">⚙️ Admin</span>
</div>

<div class="card">
  <div class="card-header">
    <span class="icon">📱</span>
    <div>
      <h2>WhatsApp Setup</h2>
      <p>Connect once — orders arrive silently, forever.</p>
    </div>
  </div>
  <div class="card-body">
    <div class="status-row">
      <span class="status-label">Connection Status</span>
      <span class="status-pill pill-init" id="statusPill">Initialising…</span>
    </div>
    <div id="mainContent"><div class="spinner"></div></div>
    <div class="queue-info" id="queueInfo" style="display:none">
      📬 <span><strong id="queueCount">0</strong> order(s) queued — will be sent automatically when WhatsApp connects.</span>
    </div>
  </div>
</div>

<div class="footnote">
  This page auto-refreshes every 4 seconds. Keep this tab open while setting up.<br>
  Once connected, you can close this tab — the server stays connected.
</div>

<script>
  const POLL_INTERVAL = 4000;
  const pilClass = {
    initializing: ['pill-init', 'Initialising…'],
    qr_ready:     ['pill-qr',   'Scan QR Code'],
    authenticated:['pill-auth', 'Authenticating…'],
    ready:        ['pill-ready','✓ Connected'],
    disconnected: ['pill-disc', 'Disconnected'],
  };

  async function poll() {
    try {
      const res  = await fetch('/api/wa-status');
      const data = await res.json();
      const { status, qr, queue } = data;
      const [cls, label] = pilClass[status] || ['pill-init', status];
      const pill = document.getElementById('statusPill');
      pill.className = 'status-pill ' + cls;
      pill.textContent = label;
      const queueInfo = document.getElementById('queueInfo');
      if (queue > 0) { queueInfo.style.display = 'flex'; document.getElementById('queueCount').textContent = queue; }
      else { queueInfo.style.display = 'none'; }
      const main = document.getElementById('mainContent');
      if (status === 'ready') {
        main.innerHTML = \`<div class="connected-banner"><div class="connected-icon">✅</div><h3>WhatsApp Connected!</h3><p>Orders from your website will be sent directly to your WhatsApp — no redirects, no fuss.</p><div class="num-badge">📲 +${OWNER_NUMBER}</div><div class="btn-row" style="justify-content:center"><button class="btn btn-outline" onclick="location.reload()">🔄 Refresh Status</button></div></div>\`;
        return;
      }
      if (status === 'qr_ready' && qr) {
        main.innerHTML = \`<div id="qr-section" style="text-align:center"><p style="font-size:0.83rem;color:var(--mid);margin-bottom:0.5rem">Scan with WhatsApp on your phone:</p><img id="qr-img" src="\${qr}" alt="WhatsApp QR Code"><p class="qr-hint">Open WhatsApp → tap <strong>⋮ More options</strong> (or <strong>Settings</strong> on iPhone) → <strong>Linked Devices</strong> → <strong>Link a Device</strong> → scan this QR code.</p></div><ul class="steps" style="margin-top:1.5rem"><li><span class="step-num">1</span>Open WhatsApp on your phone</li><li><span class="step-num">2</span>Tap the 3-dot menu → <em>Linked Devices</em></li><li><span class="step-num">3</span>Tap <em>Link a Device</em> and scan the QR above</li><li><span class="step-num">4</span>Done — orders will arrive on your WhatsApp automatically!</li></ul>\`;
      } else if (status === 'authenticated') {
        main.innerHTML = \`<div style="text-align:center;padding:2rem;color:var(--mid)"><div class="spinner" style="margin:0 auto 1rem"></div><p>Authenticated! Finishing setup…</p></div>\`;
      } else if (status === 'disconnected') {
        main.innerHTML = \`<div style="text-align:center;padding:2rem"><p style="font-size:2rem;margin-bottom:0.5rem">⚠️</p><p style="color:var(--mid);font-size:0.85rem;margin-bottom:1rem">WhatsApp disconnected. The server is trying to reconnect automatically.</p><div class="btn-row" style="justify-content:center"><button class="btn btn-primary" onclick="location.reload()">🔄 Refresh</button></div></div>\`;
      } else {
        main.innerHTML = \`<div style="text-align:center;padding:2rem;color:var(--mid)"><div class="spinner" style="margin:0 auto 1rem"></div><p style="font-size:0.85rem">Starting up WhatsApp… this can take 20–30 seconds on first run.</p></div>\`;
      }
    } catch(e) { console.error('Poll error', e); }
    setTimeout(poll, POLL_INTERVAL);
  }
  poll();
</script>
</body>
</html>`);
});

// ── Fallback: serve index.html for any unknown route ────────────
app.get('/{*path}', (req, res) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) {
      res.status(200).send(`
        <html><body style="font-family:sans-serif;text-align:center;padding:3rem">
          <h2>✅ Naa's Luxe Glam Backend is Running</h2>
          <p>API is live. Frontend not found in <code>/public</code>.</p>
          <p>Add your <code>index.html</code> to the <code>public/</code> folder and redeploy.</p>
          <p><a href="/admin?key=${ADMIN_SECRET}">Go to Admin Panel →</a></p>
        </body></html>
      `);
    }
  });
});

// ── Start server ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✨  Naa's Luxe Glam backend running on http://localhost:${PORT}`);
  console.log(`🔑  Admin panel: http://localhost:${PORT}/admin?key=${ADMIN_SECRET}`);
  console.log(`📦  Serving frontend from /public\n`);
});
