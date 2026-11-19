'use strict';
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');
const express = require('express');
const { Server } = require('socket.io');
const { Game, GameError } = require('./game');
const store = require('./store');
const { apiRouter } = require('./api');

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server);

const rooms = new Map();
const cleanupTimers = new Map();

const userRoom = (code, uid) => `g:${code}:u:${uid}`;
const isConnected = (code, uid) => (io.sockets.adapter.rooms.get(userRoom(code, uid)) || { size: 0 }).size > 0;

function broadcast(game) {
  for (const p of game.players) io.to(userRoom(game.code, p.id)).emit('state', game.getView(p.id));
}

app.get('/healthz', (req, res) => res.json({ ok: true }));

// The public Cloudflare link, read from the tunnel's log (start-remi.bat sets the path),
// so the waiting room can show friends a link that works outside this PC.
const TUNNEL_LOG = process.env.REMI_TUNNEL_LOG || path.join(os.tmpdir(), 'remi-tunnel.log');
function publicUrl() {
  try {
    const all = fs.readFileSync(TUNNEL_LOG, 'utf8').match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g);
    return all ? all[all.length - 1] : null;
  } catch {
    return null;
  }
}
app.get('/api/public-url', (req, res) => res.json({ url: publicUrl() }));
app.use('/api', apiRouter({
  onProfileChange: uid => { for (const g of rooms.values()) if (g.hasPlayer(uid)) broadcast(g); }
}));
app.use('/avatars', express.static(store.AVATAR_DIR, { maxAge: '30d' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

function newCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    code = Array.from({ length: 5 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function newGame() {
  const code = newCode();
  const game = new Game(code, {
    profile: uid => store.publicProfile(store.getUser(uid)),
    connected: uid => isConnected(code, uid),
    changed: () => broadcast(game), // the turn timer made a move: show it to everyone
    // every finished round counts toward each account's lifetime score
    roundEnd: result => {
      for (const r of result.results) store.recordRound(r.id, r.delta, r.id === result.winnerId);
    }
  });
  rooms.set(code, game);
  return game;
}

// Optional overrides for the turn timer (seconds), e.g. for quick testing.
const R = require('../public/rules.js');
if (process.env.REMI_DRAW_SECONDS) R.RULES.drawSeconds = Number(process.env.REMI_DRAW_SECONDS);
if (process.env.REMI_PLAY_SECONDS) R.RULES.playSeconds = Number(process.env.REMI_PLAY_SECONDS);

if (process.env.REMI_DEMO === '1') {
  require('./demo')(app, { newGame, broadcast });
  console.log('ATENȚIE: modul demo este activ (doar pentru test).');
}

// Sockets must carry a valid login token.
io.use((socket, next) => {
  const u = store.userForToken(socket.handshake.auth && socket.handshake.auth.token);
  if (!u) return next(new Error('unauthorized'));
  socket.data.userId = u.id;
  next();
});

function leaveCurrent(socket) {
  const code = socket.data.code;
  if (!code) return;
  socket.leave(`g:${code}`);
  socket.leave(userRoom(code, socket.data.userId));
  socket.data.code = null;
  const game = rooms.get(code);
  if (!game) return;
  afterLeave(game, socket.data.userId);
}

function afterLeave(game, uid) {
  if (!isConnected(game.code, uid) && game.phase === 'lobby') game.removePlayer(uid);
  broadcast(game);
  if (game.players.every(p => !isConnected(game.code, p.id))) {
    // Keep abandoned rooms for an hour so people can reconnect.
    clearTimeout(cleanupTimers.get(game.code));
    game.pauseTimer(); // nobody's here: the turn timer waits
    cleanupTimers.set(game.code, setTimeout(() => { game.stopTimer(); rooms.delete(game.code); }, 60 * 60 * 1000));
  }
}

function enter(socket, game) {
  if (socket.data.code && socket.data.code !== game.code) leaveCurrent(socket);
  game.addPlayer(socket.data.userId);
  socket.join(`g:${game.code}`);
  socket.join(userRoom(game.code, socket.data.userId));
  socket.data.code = game.code;
  clearTimeout(cleanupTimers.get(game.code));
  cleanupTimers.delete(game.code);
  game.resumeTimer();
  broadcast(game);
}

io.on('connection', socket => {
  const uid = socket.data.userId;
  const reply = cb => (typeof cb === 'function' ? cb : () => {});
  const errMsg = e => (e instanceof GameError ? e.message : (console.error(e), 'Eroare pe server.'));

  socket.on('create', (_msg, cb) => {
    const game = newGame();
    try {
      enter(socket, game);
      reply(cb)({ ok: true, code: game.code });
    } catch (e) {
      reply(cb)({ ok: false, error: errMsg(e) });
    }
  });

  socket.on('join', (msg, cb) => {
    const code = String((msg && msg.code) || '').trim().toUpperCase();
    const game = rooms.get(code);
    if (!game) return reply(cb)({ ok: false, error: 'Camera nu există.' });
    try {
      enter(socket, game);
      reply(cb)({ ok: true, code });
    } catch (e) {
      reply(cb)({ ok: false, error: errMsg(e) });
    }
  });

  socket.on('leave', (_msg, cb) => {
    leaveCurrent(socket);
    reply(cb)({ ok: true });
  });

  socket.on('action', (a, cb) => {
    const game = rooms.get(socket.data.code);
    if (!game || !a) return reply(cb)({ ok: false, error: 'Nu ești într-o cameră.' });
    try {
      switch (a.type) {
        case 'start': game.start(uid); break;
        case 'nextRound': game.nextRound(uid); break;
        case 'draw': game.draw(uid, a.source, a.index); break;
        case 'undoTake': game.undoTake(uid); break;
        case 'lay': game.lay(uid, a); break;
        case 'layKey': game.layKey(uid, a); break;
        case 'swapJoker': game.swapJoker(uid, a.formationId, a.tileId); break;
        case 'discard': game.discardTile(uid, a.tileId); break;
        default: throw new GameError('Acțiune necunoscută.');
      }
      broadcast(game);
      reply(cb)({ ok: true });
    } catch (e) {
      reply(cb)({ ok: false, error: errMsg(e) });
    }
  });

  socket.on('disconnect', () => {
    const game = rooms.get(socket.data.code);
    if (game) afterLeave(game, uid);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Remi rulează pe http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) console.log(`  în rețeaua locală: http://${i.address}:${PORT}`);
    }
  }
});
