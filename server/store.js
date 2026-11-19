'use strict';
// Tiny JSON-file user store: accounts, login sessions and avatars.
// Fine for a group of friends; data lives in ./data (or $DATA_DIR).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const AVATAR_DIR = path.join(DATA_DIR, 'avatars');
fs.mkdirSync(AVATAR_DIR, { recursive: true });

class StoreError extends Error {}
const fail = msg => { throw new StoreError(msg); };

let db = { users: [], sessions: {} };
try {
  db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}
db.users = db.users || [];
db.sessions = db.sessions || {};

function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}

function checkUsername(u) {
  u = String(u || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,20}$/.test(u)) fail('Numele de utilizator: 3–20 caractere (litere, cifre, . _ -).');
  return u;
}
function checkPassword(p) {
  if (typeof p !== 'string' || p.length < 6) fail('Parola trebuie să aibă minim 6 caractere.');
  if (p.length > 200) fail('Parola este prea lungă.');
  return p;
}
function checkDisplayName(n) {
  n = String(n || '').trim().replace(/\s+/g, ' ');
  if (n.length < 1 || n.length > 20) fail('Numele afișat: 1–20 caractere.');
  return n;
}

const hasUsers = () => db.users.length > 0;
const getUser = id => db.users.find(u => u.id === id) || null;

function createUser({ username, password, displayName, isAdmin = false }) {
  username = checkUsername(username);
  checkPassword(password);
  displayName = checkDisplayName(displayName || username);
  if (db.users.some(u => u.username === username)) fail('Există deja un cont cu acest nume de utilizator.');
  const { salt, hash } = hashPassword(password);
  const user = {
    id: crypto.randomUUID(), username, displayName, salt, hash,
    isAdmin: !!isAdmin, avatarVersion: 0, createdAt: Date.now()
  };
  db.users.push(user);
  save();
  return user;
}

function verifyLogin(username, password) {
  const u = db.users.find(x => x.username === String(username || '').trim().toLowerCase());
  if (!u || typeof password !== 'string') return null;
  const { hash } = hashPassword(password, u.salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(u.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? u : null;
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions[token] = { userId, created: Date.now() };
  save();
  return token;
}
function userForToken(token) {
  const s = typeof token === 'string' && db.sessions[token];
  return s ? getUser(s.userId) : null;
}
function deleteSession(token) {
  if (db.sessions[token]) { delete db.sessions[token]; save(); }
}

function updateProfile(id, { displayName }) {
  const u = getUser(id) || fail('Cont inexistent.');
  if (displayName !== undefined) u.displayName = checkDisplayName(displayName);
  save();
  return u;
}

function setAvatar(id, dataUrl) {
  const u = getUser(id) || fail('Cont inexistent.');
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) fail('Poza trebuie să fie o imagine JPEG.');
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length > 200 * 1024) fail('Poza este prea mare.');
  if (buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) fail('Fișier de imagine invalid.');
  fs.writeFileSync(path.join(AVATAR_DIR, `${u.id}.jpg`), buf);
  u.avatarVersion = Date.now();
  save();
  return u;
}

function removeAvatar(id) {
  const u = getUser(id) || fail('Cont inexistent.');
  fs.rmSync(path.join(AVATAR_DIR, `${u.id}.jpg`), { force: true });
  u.avatarVersion = 0;
  save();
  return u;
}

function setPassword(id, password) {
  const u = getUser(id) || fail('Cont inexistent.');
  checkPassword(password);
  Object.assign(u, hashPassword(password));
  // Log out every other session of this user.
  for (const [t, s] of Object.entries(db.sessions)) if (s.userId === id) delete db.sessions[t];
  save();
  return u;
}

function deleteUser(id) {
  const i = db.users.findIndex(u => u.id === id);
  if (i < 0) fail('Cont inexistent.');
  db.users.splice(i, 1);
  for (const [t, s] of Object.entries(db.sessions)) if (s.userId === id) delete db.sessions[t];
  fs.rmSync(path.join(AVATAR_DIR, `${id}.jpg`), { force: true });
  save();
}

// Lifetime score, kept on the account and updated after every round.
const emptyStats = () => ({ points: 0, rounds: 0, wins: 0, best: null });
function recordRound(id, delta, won) {
  const u = getUser(id);
  if (!u) return;
  const s = u.stats || (u.stats = emptyStats());
  s.points += delta;
  s.rounds += 1;
  if (won) s.wins += 1;
  if (s.best === null || delta > s.best) s.best = delta;
  save();
}
const statsOf = u => ({ ...emptyStats(), ...(u.stats || {}) });

const avatarUrl = u => (u.avatarVersion ? `/avatars/${u.id}.jpg?v=${u.avatarVersion}` : null);
const publicProfile = u => (u ? { id: u.id, name: u.displayName, avatar: avatarUrl(u) } : { name: 'Cont șters', avatar: null });
const selfView = u => ({ ...publicProfile(u), username: u.username, isAdmin: u.isAdmin, stats: statsOf(u) });
const listUsers = () => db.users.map(u => ({ ...selfView(u), createdAt: u.createdAt }));
const leaderboard = () => db.users
  .map(u => ({ ...publicProfile(u), stats: statsOf(u) }))
  .sort((a, b) => b.stats.points - a.stats.points || b.stats.wins - a.stats.wins);

module.exports = {
  AVATAR_DIR, StoreError, hasUsers, getUser, createUser, verifyLogin, createSession,
  userForToken, deleteSession, updateProfile, setAvatar, removeAvatar, setPassword,
  deleteUser, publicProfile, selfView, listUsers, recordRound, leaderboard
};
