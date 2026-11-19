'use strict';
const express = require('express');
const store = require('./store');

// Very small brute-force guard for the login endpoint.
const attempts = new Map();
function loginLimiter(req, res, next) {
  const key = req.ip;
  const now = Date.now();
  const a = attempts.get(key);
  if (a && a.until > now && a.count >= 10) {
    return res.status(429).json({ error: 'Prea multe încercări. Mai încearcă peste câteva minute.' });
  }
  next();
}
function recordFailure(ip) {
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a || a.until < now) attempts.set(ip, { count: 1, until: now + 10 * 60 * 1000 });
  else a.count++;
}

function apiRouter({ onProfileChange = () => {} } = {}) {
  const r = express.Router();
  r.use(express.json({ limit: '400kb' }));

  const wrap = fn => (req, res) => {
    try {
      const out = fn(req, res);
      if (out !== undefined) res.json(out);
    } catch (e) {
      if (e instanceof store.StoreError) res.status(400).json({ error: e.message });
      else { console.error(e); res.status(500).json({ error: 'Eroare pe server.' }); }
    }
  };
  const auth = (req, res, next) => {
    const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const u = store.userForToken(token);
    if (!u) return res.status(401).json({ error: 'Nu ești autentificat.' });
    req.user = u;
    req.token = token;
    next();
  };
  const admin = (req, res, next) =>
    req.user.isAdmin ? next() : res.status(403).json({ error: 'Doar administratorul poate face asta.' });

  // The admin account can only be created directly on the host PC, never through the
  // public tunnel (cloudflared also connects from localhost, but adds forwarding headers).
  const isDirectLocal = req => {
    const ip = req.socket.remoteAddress || '';
    const loopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    return loopback && !req.get('cf-connecting-ip') && !req.get('x-forwarded-for') && !req.get('cf-ray');
  };

  r.get('/status', wrap(req => ({ needsSetup: !store.hasUsers(), setupAllowedHere: isDirectLocal(req) })));

  // First run only: creates the administrator account.
  r.post('/setup', wrap(req => {
    if (store.hasUsers()) throw new store.StoreError('Contul de administrator există deja.');
    if (!isDirectLocal(req)) throw new store.StoreError('Contul de administrator se creează doar de pe calculatorul care rulează serverul (http://localhost:3000).');
    const { username, password, displayName } = req.body || {};
    const u = store.createUser({ username, password, displayName, isAdmin: true });
    return { token: store.createSession(u.id), user: store.selfView(u) };
  }));

  r.post('/login', loginLimiter, wrap(req => {
    const { username, password } = req.body || {};
    const u = store.verifyLogin(username, password);
    if (!u) {
      recordFailure(req.ip);
      throw new store.StoreError('Nume de utilizator sau parolă greșită.');
    }
    return { token: store.createSession(u.id), user: store.selfView(u) };
  }));

  r.post('/logout', auth, wrap(req => { store.deleteSession(req.token); return { ok: true }; }));
  r.get('/me', auth, wrap(req => ({ user: store.selfView(req.user) })));
  r.get('/leaderboard', auth, wrap(() => ({ players: store.leaderboard() })));

  r.post('/profile', auth, wrap(req => {
    const { displayName, avatar, removeAvatar } = req.body || {};
    if (displayName !== undefined) store.updateProfile(req.user.id, { displayName });
    if (avatar) store.setAvatar(req.user.id, avatar);
    else if (removeAvatar) store.removeAvatar(req.user.id);
    onProfileChange(req.user.id);
    return { user: store.selfView(store.getUser(req.user.id)) };
  }));

  r.post('/password', auth, wrap(req => {
    const { current, next } = req.body || {};
    if (!store.verifyLogin(req.user.username, current)) throw new store.StoreError('Parola actuală este greșită.');
    store.setPassword(req.user.id, next);
    return { token: store.createSession(req.user.id) };
  }));

  r.get('/admin/users', auth, admin, wrap(() => ({ users: store.listUsers() })));
  r.post('/admin/users', auth, admin, wrap(req => {
    const { username, password, displayName } = req.body || {};
    return { user: store.selfView(store.createUser({ username, password, displayName })) };
  }));
  r.post('/admin/users/:id/password', auth, admin, wrap(req => {
    store.setPassword(req.params.id, (req.body || {}).password);
    return { ok: true };
  }));
  r.delete('/admin/users/:id', auth, admin, wrap(req => {
    if (req.params.id === req.user.id) throw new store.StoreError('Nu îți poți șterge propriul cont.');
    store.deleteUser(req.params.id);
    return { ok: true };
  }));

  return r;
}

module.exports = { apiRouter };
