const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const { initDb, db } = require('./db');
const { handleAuth, parseCookies } = require('./routes/auth');
const { handleAdmin } = require('./routes/admin');
const { handleCustomer } = require('./routes/customer');
const { getLanIp } = require('./utils');

// Initialize SQLite database
initDb();

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// In-memory sessions store
const sessions = new Map();

// Content-Type map
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.audio': 'audio/mpeg'
};

function serveFile(res, filePath) {
  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain');
      return res.end('Not Found');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.statusCode = 200;
    res.setHeader('Content-Type', contentType);
    fs.createReadStream(filePath).pipe(res);
  });
}

async function handleRequest(req, res) {
  // Setup res helper methods
  res.status = function(code) {
    res.statusCode = code;
    return res;
  };
  res.json = function(data) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(data));
  };

  const fullUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = fullUrl.pathname;
  const query = fullUrl.searchParams;

  // Read request body if present
  let body = null;
  if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
    const buffers = [];
    for await (const chunk of req) {
      buffers.push(chunk);
    }
    const raw = Buffer.concat(buffers).toString('utf-8');
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
  }
  req.body = body;

  // 1. Static Files
  if (pathname.startsWith('/assets/')) {
    const assetPath = path.join(PUBLIC_DIR, pathname);
    return serveFile(res, assetPath);
  }

  if (['/hero.webp', '/logo-256.webp', '/logo-96.webp', '/custom-logo.png', '/customer.js', '/custom-sound.audio'].includes(pathname)) {
    if (pathname === '/logo-256.webp' || pathname === '/logo-96.webp' || pathname === '/custom-logo.png') {
      const customLogoPath = path.join(PUBLIC_DIR, 'custom-logo.png');
      if (fs.existsSync(customLogoPath)) {
        return serveFile(res, customLogoPath);
      }
    }
    const filePath = path.join(PUBLIC_DIR, pathname.startsWith('/custom-logo') ? 'logo-256.webp' : pathname);
    return serveFile(res, filePath);
  }

  // 2. API Routes
  if (pathname.startsWith('/api/auth/')) {
    const handled = handleAuth(req, res, pathname, db, sessions);
    if (handled !== false) return;
  }

  if (pathname.startsWith('/api/admin/')) {
    // Pulse is a lightweight revision number check, allow it to wake up the dashboard
    if (pathname === '/api/admin/pulse') {
      const handled = handleAdmin(req, res, pathname, query, db);
      if (handled !== false) return;
    }

    // Check authentication for admin endpoints
    const cookies = parseCookies(req.headers.cookie);
    const sessionId = cookies.muse_session;
    const session = sessionId ? sessions.get(sessionId) : null;

    if (!session || !session.user) {
      return res.status(401).json({ error: 'Sign in to continue.' });
    }

    const handled = handleAdmin(req, res, pathname, query, db);
    if (handled !== false) return;
  }

  if (pathname.startsWith('/api/customer/')) {
    const handled = handleCustomer(req, res, pathname, query, db);
    if (handled !== false) return;
  }

  // 3. Frontend Page Routes
  // Admin SPA
  if (pathname === '/admin' || pathname.startsWith('/admin/')) {
    return serveFile(res, path.join(PUBLIC_DIR, 'admin.html'));
  }

  // Customer QR Menu & Ordering Page
  if (pathname.startsWith('/t/') || pathname === '/menu') {
    return serveFile(res, path.join(PUBLIC_DIR, 'customer.html'));
  }

  // Root Switcher / Hub
  if (pathname === '/') {
    return serveFile(res, path.join(PUBLIC_DIR, 'index.html'));
  }

  // Default 404
  res.status(404).json({ error: 'Endpoint not found' });
}

const LAN_IP = getLanIp();

const server = http.createServer(handleRequest);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n======================================================`);
  console.log(`☕ Muse QR Ordering System is LIVE!`);
  console.log(`======================================================`);
  console.log(`🏠 Local (This PC):    http://localhost:${PORT}`);
  console.log(`📶 Network (Phones):   http://${LAN_IP}:${PORT}`);
  console.log(`👑 Admin Dashboard:    http://${LAN_IP}:${PORT}/admin`);
  console.log(`📱 Customer Tables:    http://${LAN_IP}:${PORT}/t/tbl-1-8838c445`);
  console.log(`======================================================\n`);
});

// Also bind standard HTTP port 80 so mobile devices opening http://172.16.81.207 directly without :3000 connect!
if (Number(PORT) !== 80) {
  try {
    const server80 = http.createServer(handleRequest);
    server80.listen(80, '0.0.0.0', () => {
      console.log(`🌐 Standard HTTP Port 80 is also ACTIVE (http://${LAN_IP}/) for direct mobile scanning!`);
    }).on('error', (err) => {
      console.log(`ℹ️ Port 80 not bound (${err.message}) - running on primary port ${PORT}.`);
    });
  } catch {}
}

