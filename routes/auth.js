const crypto = require('node:crypto');
const { hashSecret } = require('../db');

function parseCookies(header = '') {
  const list = {};
  header.split(';').forEach(cookie => {
    let [name, ...rest] = cookie.split('=');
    name = name?.trim();
    if (!name) return;
    const value = rest.join('=').trim();
    list[name] = decodeURIComponent(value);
  });
  return list;
}

function handleAuth(req, res, pathname, db, sessions) {
  const getSetting = (key, fallback = '') => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : fallback;
  };
  const setSetting = (key, value) => {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
  };

  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies.muse_session;
  const session = sessionId ? sessions.get(sessionId) : null;

  // GET /api/auth/state
  if (req.method === 'GET' && pathname === '/api/auth/state') {
    const cafeName = getSetting('cafe_name', 'Muse Bread & Brew');
    const lockMinutes = Number(getSetting('lock_minutes', '15'));
    const adminHash = getSetting('admin_password_hash');
    const hasAdmin = Boolean(adminHash);
    const hasBiometrics = Boolean(getSetting('webauthn_credential_id'));

    if (session && session.user) {
      return res.json({
        loggedIn: true,
        hasAdmin: true,
        hasBiometrics,
        user: { username: session.user.username },
        cafeName,
        lockMinutes
      });
    }

    return res.json({
      loggedIn: false,
      hasAdmin,
      hasBiometrics,
      cafeName
    });
  }

  // POST /api/auth/setup
  if (req.method === 'POST' && pathname === '/api/auth/setup') {
    const { username, password, code } = req.body || {};
    const expectedCode = getSetting('setup_code', 'MUSE2026');

    if (code && code.trim().toUpperCase() !== expectedCode.toUpperCase()) {
      return res.status(400).json({ error: 'Invalid setup code.' });
    }

    if (!username || !password || password.length < 4) {
      return res.status(400).json({ error: 'Username and password (min 4 chars) are required.' });
    }

    setSetting('admin_username', username.trim());
    setSetting('admin_password_hash', hashSecret(password));

    // Create session
    const newSessionId = crypto.randomBytes(24).toString('hex');
    sessions.set(newSessionId, { user: { username: username.trim() }, createdAt: Date.now() });

    res.setHeader('Set-Cookie', `muse_session=${newSessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
    return res.json({ ok: true });
  }

  // POST /api/auth/login
  if (req.method === 'POST' && pathname === '/api/auth/login') {
    const { username, password } = req.body || {};
    const storedUsername = getSetting('admin_username', 'admin');
    const storedHash = getSetting('admin_password_hash');

    if (!username || !password) {
      return res.status(400).json({ error: 'Please enter both username and password.' });
    }

    const inputHash = hashSecret(password);
    if (username.trim() !== storedUsername || inputHash !== storedHash) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    const newSessionId = crypto.randomBytes(24).toString('hex');
    sessions.set(newSessionId, { user: { username: storedUsername }, createdAt: Date.now() });

    res.setHeader('Set-Cookie', `muse_session=${newSessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
    return res.json({ ok: true });
  }

  // POST /api/auth/unlock
  if (req.method === 'POST' && pathname === '/api/auth/unlock') {
    const { password } = req.body || {};
    const storedHash = getSetting('admin_password_hash');

    if (!password || hashSecret(password) !== storedHash) {
      return res.status(400).json({ error: 'Incorrect password.' });
    }

    // Refresh session if needed
    if (session) {
      session.unlockedAt = Date.now();
    } else {
      const storedUsername = getSetting('admin_username', 'admin');
      const newSessionId = crypto.randomBytes(24).toString('hex');
      sessions.set(newSessionId, { user: { username: storedUsername }, createdAt: Date.now() });
      res.setHeader('Set-Cookie', `muse_session=${newSessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
    }

    return res.json({ ok: true });
  }

  // POST /api/auth/logout
  if (req.method === 'POST' && pathname === '/api/auth/logout') {
    if (sessionId) {
      sessions.delete(sessionId);
    }
    res.setHeader('Set-Cookie', 'muse_session=; Path=/; HttpOnly; Max-Age=0');
    return res.json({ ok: true });
  }

  // WEBAUTHN / BIOMETRIC AUTH
  // 1. Register Biometrics
  if (req.method === 'POST' && pathname === '/api/auth/webauthn/register') {
    if (!session || !session.user) {
      return res.status(401).json({ error: 'Must be logged in to register biometrics.' });
    }
    const { credential_id, credential_name } = req.body || {};
    if (!credential_id) {
      return res.status(400).json({ error: 'Credential ID is required.' });
    }
    setSetting('webauthn_credential_id', credential_id);
    setSetting('webauthn_username', session.user.username);
    setSetting('webauthn_name', credential_name || 'Device Biometrics');
    return res.json({ ok: true, message: 'Biometric login successfully registered.' });
  }

  // 2. Login with Biometrics
  if (req.method === 'POST' && pathname === '/api/auth/webauthn/login') {
    const { credential_id } = req.body || {};
    const storedCredId = getSetting('webauthn_credential_id');
    const storedUsername = getSetting('webauthn_username', getSetting('admin_username', 'admin'));

    if (!storedCredId) {
      return res.status(400).json({ error: 'No biometrics registered on this system. Please log in with password first.' });
    }
    if (!credential_id || credential_id !== storedCredId) {
      return res.status(401).json({ error: 'Biometric verification failed. Please try again or use password.' });
    }

    const newSessionId = crypto.randomBytes(24).toString('hex');
    sessions.set(newSessionId, { user: { username: storedUsername }, createdAt: Date.now() });

    res.setHeader('Set-Cookie', `muse_session=${newSessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
    return res.json({ ok: true, user: { username: storedUsername } });
  }

  // 3. Remove Biometrics
  if (req.method === 'POST' && pathname === '/api/auth/webauthn/remove') {
    if (!session || !session.user) {
      return res.status(401).json({ error: 'Must be logged in.' });
    }
    setSetting('webauthn_credential_id', '');
    setSetting('webauthn_name', '');
    return res.json({ ok: true, message: 'Biometric login removed.' });
  }

  return false; // Not handled
}

module.exports = {
  handleAuth,
  parseCookies
};

