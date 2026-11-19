'use strict';
const R = window.RemiRules;
const $ = id => document.getElementById(id);

// Columns on the rack: computed from the window width so the tiles use (almost) all the wood.
let ROW = 18;
const minSlots = () => ROW * 2;
const COLOR_RO = { red: 'roșu', yellow: 'galben', blue: 'albastru', black: 'negru' };

let me = null;          // logged-in user
let token = null;
let socket = null;
let view = null;        // latest game state from the server
let slots = new Array(36).fill(null); // rack layout (client-only), ROW columns per shelf
let pendingSlot = null;  // where a tile dragged from the pile should land
let rackRound = null;
const skipped = new Set(); // formations on the rack the player chose not to lay down
let dragging = null;
let modalKind = null;   // 'results' | 'profile' | 'admin' | null
let inRoom = false;
let clockOffset = 0;    // server time minus local time

// ---------- turn countdown ----------
// Every element with data-deadline shows the seconds left; red in the last 10 seconds.
function secondsLeft(deadline) {
  return Math.max(0, Math.ceil((deadline - (Date.now() + clockOffset)) / 1000));
}
function tickTimers() {
  for (const e of document.querySelectorAll('[data-deadline]')) {
    const s = secondsLeft(Number(e.dataset.deadline));
    e.textContent = `⏱ ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    e.classList.toggle('low', s <= 10);
  }
}
setInterval(tickTimers, 250);

// ---------- storage ----------
// The login token lives in localStorage (stay logged in); sessionStorage takes precedence
// so two tabs can be two different accounts while testing.
function safe(fn, fallback = null) { try { return fn(); } catch { return fallback; } }
const getToken = () => safe(() => sessionStorage.getItem('remi-token')) || safe(() => localStorage.getItem('remi-token'));
function setToken(t) {
  token = t;
  safe(() => sessionStorage.setItem('remi-token', t));
  safe(() => localStorage.setItem('remi-token', t));
}
function clearToken() {
  token = null;
  safe(() => sessionStorage.removeItem('remi-token'));
  safe(() => localStorage.removeItem('remi-token'));
}
const getRoom = () => safe(() => sessionStorage.getItem('remi-room')) || new URLSearchParams(location.search).get('room');
function setRoom(code) {
  safe(() => (code ? sessionStorage.setItem('remi-room', code) : sessionStorage.removeItem('remi-room')));
  history.replaceState(null, '', code ? `?room=${code}` : location.pathname);
}

// ---------- helpers ----------
function toast(msg, err = true) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toast.h);
  toast.h = setTimeout(() => { t.className = ''; }, 3500);
}
function show(screen) {
  for (const s of ['login', 'home', 'waiting', 'game']) $(s).classList.toggle('hidden', s !== screen);
}
function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of children) if (c) e.append(c);
  return e;
}
async function api(method, url, body) {
  let res;
  try {
    res = await fetch('/api' + url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch {
    throw new Error('Nu mă pot conecta la server. Verifică dacă serverul Remi e pornit.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Eroare.');
  return data;
}
function act(type, payload = {}, onOk, onErr) {
  if (!socket) return;
  socket.emit('action', { type, ...payload }, res => {
    if (!res || !res.ok) { toast((res && res.error) || 'Eroare.'); if (onErr) onErr(); }
    else if (onOk) onOk();
  });
}
const rackMap = () => new Map((view && view.me ? view.me.rack : []).map(t => [t.id, t]));
const isPlaying = () => view && (view.phase === 'draw' || view.phase === 'play');
const player = id => (view && view.players.find(p => p.id === id)) || { name: '?', id };

function hashHue(s) {
  let h = 0;
  for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 360;
}
function avatarEl(p, size = 36) {
  if (p.avatar) {
    const img = el('img', { class: 'avatar', src: p.avatar, alt: '' });
    img.style.width = img.style.height = size + 'px';
    return img;
  }
  const initials = String(p.name || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  const d = el('div', { class: 'avatar', text: initials });
  d.style.width = d.style.height = size + 'px';
  d.style.fontSize = Math.round(size * 0.42) + 'px';
  d.style.background = `hsl(${hashHue(p.id || p.name)} 45% 42%)`;
  return d;
}

// ---------- login / setup ----------
let needsSetup = false;
async function showLogin() {
  const st = await api('GET', '/status').catch(() => ({ needsSetup: false }));
  needsSetup = st.needsSetup;
  if (needsSetup && !st.setupAllowedHere) {
    // Nobody can claim the admin account through the public link.
    $('loginSub').textContent = 'Serverul nu e configurat încă. Administratorul trebuie să-și creeze contul de pe calculatorul care rulează serverul.';
    $('loginForm').querySelectorAll('label, button').forEach(e => e.classList.add('hidden'));
    show('login');
    return;
  }
  $('loginForm').querySelectorAll('label:not(#lNameRow), button').forEach(e => e.classList.remove('hidden'));
  $('loginSub').textContent = needsSetup
    ? 'Prima pornire: creează contul de administrator (al tău).'
    : 'Intră în cont';
  $('lNameRow').classList.toggle('hidden', !needsSetup);
  $('loginBtn').textContent = needsSetup ? 'Creează contul' : 'Intră';
  $('lPass').autocomplete = needsSetup ? 'new-password' : 'current-password';
  show('login');
}
$('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  $('loginError').textContent = '';
  try {
    const body = { username: $('lUser').value, password: $('lPass').value, displayName: $('lName').value || undefined };
    const res = await api('POST', needsSetup ? '/setup' : '/login', body);
    setToken(res.token);
    $('lPass').value = '';
    loggedIn(res.user);
  } catch (err) {
    $('loginError').textContent = err.message;
  }
});

function loggedIn(user) {
  me = user;
  renderHome();
  connectSocket();
}

async function logout() {
  await api('POST', '/logout').catch(() => {});
  clearToken();
  if (socket) { socket.disconnect(); socket = null; }
  inRoom = false;
  view = null;
  me = null;
  setRoom(null);
  closeModal();
  showLogin();
}

// ---------- home ----------
function renderHome() {
  const a = $('homeAvatar');
  a.replaceChildren(avatarEl(me, 64));
  $('homeName').textContent = me.name;
  $('homeUser').textContent = '@' + me.username + (me.isAdmin ? ' · administrator' : '');
  $('adminBtn').classList.toggle('hidden', !me.isAdmin);
}
// Lifetime leaderboard: points, rounds and wins kept on each account.
async function loadLeaderboard() {
  const box = $('leaderboard');
  try {
    const { players } = await api('GET', '/leaderboard');
    const played = players.filter(p => p.stats.rounds > 0);
    if (!played.length) { box.textContent = 'Nimeni n-a terminat încă o rundă.'; return; }
    const table = el('table', { class: 'board' },
      el('tr', {}, el('th', { text: '' }), el('th', { text: 'Jucător' }),
        el('th', { class: 'num', text: 'Puncte' }), el('th', { class: 'num', text: 'Runde' }),
        el('th', { class: 'num', text: 'Câștigate' }), el('th', { class: 'num', text: 'Record' })));
    played.forEach((p, i) => table.append(el('tr', { class: p.id === me.id ? 'me' : '' },
      el('td', { class: 'rank', text: String(i + 1) }),
      el('td', {}, el('div', { class: 'who' }, avatarEl(p, 24), el('span', { text: p.name }))),
      el('td', { class: 'num', text: String(p.stats.points) }),
      el('td', { class: 'num', text: String(p.stats.rounds) }),
      el('td', { class: 'num', text: String(p.stats.wins) }),
      el('td', { class: 'num', text: p.stats.best === null ? '–' : String(p.stats.best) }))));
    box.replaceChildren(table);
  } catch (e) {
    box.textContent = e.message;
  }
}

function showHome() {
  view = null;
  renderHome();
  show('home');
  loadLeaderboard();
}
$('logoutBtn').onclick = logout;
$('profileBtn').onclick = openProfile;
$('gProfileBtn').onclick = openProfile;
$('adminBtn').onclick = openAdmin;
$('createBtn').onclick = () => {
  if (!socket) return;
  inRoom = true;
  socket.emit('create', {}, res => {
    if (!res.ok) { inRoom = false; return ($('homeError').textContent = res.error); }
    setRoom(res.code);
  });
};
$('joinBtn').onclick = () => {
  const code = $('codeInput').value.trim().toUpperCase();
  if (!code) return ($('homeError').textContent = 'Scrie codul camerei.');
  inRoom = true;
  socket.emit('join', { code }, res => {
    if (!res.ok) { inRoom = false; return ($('homeError').textContent = res.error); }
    setRoom(res.code);
  });
};
$('codeInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('joinBtn').click(); });
function leaveRoom() {
  inRoom = false;
  if (socket) socket.emit('leave', {});
  setRoom(null);
  closeModal();
  showHome();
}
$('leaveBtn').onclick = leaveRoom;
$('gLeaveBtn').onclick = () => {
  if (isPlaying() && !confirm('Ieși la meniu? Te poți întoarce oricând cu codul camerei.')) return;
  leaveRoom();
};
$('copyBtn').onclick = () => {
  $('shareLink').select();
  navigator.clipboard.writeText($('shareLink').value).then(() => toast('Link copiat!', false), () => {});
};
$('startBtn').onclick = () => act('start');

// ---------- socket ----------
function connectSocket() {
  if (socket) socket.disconnect();
  socket = io({ auth: { token } });
  socket.on('connect', () => {
    const code = getRoom();
    if (!code) return showHome();
    inRoom = true;
    socket.emit('join', { code }, res => {
      if (!res.ok) { inRoom = false; setRoom(null); toast(res.error); showHome(); } else setRoom(res.code);
    });
  });
  socket.on('connect_error', err => {
    if (err && err.message === 'unauthorized') { clearToken(); showLogin(); }
  });
  socket.on('disconnect', reason => {
    if (reason !== 'io client disconnect') toast('Conexiune pierdută — se reconectează…');
  });
  socket.on('state', v => {
    if (!inRoom) return; // we already left
    clockOffset = v.now - Date.now(); // server clock minus ours, for the turn countdown
    view = v;
    render();
  });
}

// ---------- modals ----------
function openModal(kind) {
  modalKind = kind;
  $('modal').classList.remove('hidden');
  const card = $('modalCard');
  card.replaceChildren();
  return card;
}
function closeModal() {
  modalKind = null;
  $('modal').classList.add('hidden');
  if (view) render();
}

async function fileToAvatar(file) {
  const img = await createImageBitmap(file);
  const size = Math.min(img.width, img.height);
  const c = document.createElement('canvas');
  c.width = c.height = 192;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff'; // JPEG has no transparency: give cut-out photos a white background
  g.fillRect(0, 0, 192, 192);
  g.drawImage(img, (img.width - size) / 2, (img.height - size) / 2, size, size, 0, 0, 192, 192);
  return c.toDataURL('image/jpeg', 0.85);
}

function openProfile() {
  const card = openModal('profile');
  let newAvatar = null;
  let removeAvatar = false;
  const preview = el('div');
  const setPreview = src => preview.replaceChildren(avatarEl({ ...me, avatar: src }, 88));
  setPreview(me.avatar);

  const file = el('input', { type: 'file', accept: 'image/*', class: 'hidden' });
  file.addEventListener('change', async () => {
    if (!file.files[0]) return;
    try {
      newAvatar = await fileToAvatar(file.files[0]);
      removeAvatar = false;
      setPreview(newAvatar);
    } catch { toast('Nu am putut citi imaginea.'); }
  });
  const nameIn = el('input', { maxlength: '20' });
  nameIn.value = me.name;
  const err = el('p', { class: 'error' });

  const save = el('button', {
    class: 'primary', text: 'Salvează profilul',
    onclick: async () => {
      err.textContent = '';
      try {
        const body = { displayName: nameIn.value };
        if (newAvatar) body.avatar = newAvatar;
        else if (removeAvatar) body.removeAvatar = true;
        const res = await api('POST', '/profile', body);
        me = res.user;
        renderHome();
        toast('Profil salvat.', false);
        closeModal();
      } catch (e) { err.textContent = e.message; }
    }
  });

  const cur = el('input', { type: 'password', autocomplete: 'current-password' });
  const nxt = el('input', { type: 'password', autocomplete: 'new-password' });
  const perr = el('p', { class: 'error' });
  const pwBtn = el('button', {
    text: 'Schimbă parola',
    onclick: async () => {
      perr.textContent = '';
      try {
        const res = await api('POST', '/password', { current: cur.value, next: nxt.value });
        setToken(res.token);
        cur.value = nxt.value = '';
        toast('Parola a fost schimbată.', false);
      } catch (e) { perr.textContent = e.message; }
    }
  });

  card.append(
    el('h2', { text: 'Profilul meu' }),
    el('div', { class: 'profile-row' }, preview,
      el('div', { class: 'row' },
        el('button', { text: 'Alege o poză', onclick: () => file.click() }),
        el('button', { text: 'Fără poză', onclick: () => { newAvatar = null; removeAvatar = true; setPreview(null); } }),
        file)),
    el('label', {}, 'Numele afișat', nameIn),
    save, err,
    el('hr'),
    el('h3', { text: 'Parola' }),
    el('label', {}, 'Parola actuală', cur),
    el('label', {}, 'Parola nouă (minim 6 caractere)', nxt),
    pwBtn, perr,
    el('button', { class: 'link', text: 'Închide', onclick: closeModal })
  );
}

async function openAdmin() {
  const card = openModal('admin');
  const uIn = el('input', { placeholder: 'utilizator (ex: mihai)', autocomplete: 'off' });
  const nIn = el('input', { placeholder: 'Nume afișat', maxlength: '20', autocomplete: 'off' });
  const pIn = el('input', { placeholder: 'Parolă (minim 6)', autocomplete: 'new-password' });
  const err = el('p', { class: 'error' });
  const table = el('table', { class: 'users' });

  async function refresh() {
    try {
      const { users } = await api('GET', '/admin/users');
      table.replaceChildren();
      for (const u of users) {
        const actions = el('td', {},
          el('button', {
            class: 'small', text: 'Parolă nouă',
            onclick: async () => {
              const pw = prompt(`Parola nouă pentru ${u.username} (minim 6 caractere):`);
              if (!pw) return;
              try { await api('POST', `/admin/users/${u.id}/password`, { password: pw }); toast('Parola a fost resetată.', false); }
              catch (e) { toast(e.message); }
            }
          }),
          u.id === me.id ? null : el('button', {
            class: 'small danger', text: 'Șterge',
            onclick: async () => {
              if (!confirm(`Ștergi contul ${u.username}? Nu se poate anula.`)) return;
              try { await api('DELETE', `/admin/users/${u.id}`); refresh(); }
              catch (e) { toast(e.message); }
            }
          }));
        table.append(el('tr', {},
          el('td', {}, avatarEl(u, 30)),
          el('td', {}, el('b', { text: u.name }), el('br'), el('span', { class: 'sub', text: '@' + u.username + (u.isAdmin ? ' · admin' : '') })),
          actions));
      }
    } catch (e) { err.textContent = e.message; }
  }

  card.append(
    el('h2', { text: 'Conturi prieteni' }),
    el('p', { class: 'sub', text: 'Creează un cont și trimite-i prietenului utilizatorul și parola. Își poate schimba apoi numele, poza și parola din profil.' }),
    uIn, nIn, pIn,
    el('button', {
      class: 'primary', text: 'Creează cont',
      onclick: async () => {
        err.textContent = '';
        try {
          await api('POST', '/admin/users', { username: uIn.value, displayName: nIn.value || undefined, password: pIn.value });
          toast(`Contul ${uIn.value.trim().toLowerCase()} a fost creat.`, false);
          uIn.value = nIn.value = pIn.value = '';
          refresh();
        } catch (e) { err.textContent = e.message; }
      }
    }),
    err,
    el('hr'),
    table,
    el('button', { class: 'link', text: 'Închide', onclick: closeModal })
  );
  refresh();
}

// ---------- rack layout ----------
// Size the tiles from the window height (so two shelves fit) and fit as many columns as the
// window width allows. Tiles keep their row/column when the column count changes.
function fitRack() {
  const tw = Math.max(40, Math.min(60, Math.round(window.innerHeight * 0.064)));
  $('tray').style.setProperty('--tw', tw + 'px');
  $('tray').style.setProperty('--th', Math.round(tw * 1.38) + 'px');
  const gap = 3;
  const usable = window.innerWidth - 2 * 22; // rack padding on both sides
  const cols = Math.max(12, Math.min(32, Math.floor((usable + gap) / (tw + gap))));
  if (cols === ROW) return false;
  const old = ROW;
  const rows = Math.max(2, Math.ceil(slots.length / old));
  const items = [];
  slots.forEach((id, i) => { if (id) items.push({ id, r: Math.floor(i / old), c: i % old }); });
  ROW = cols;
  slots = new Array(rows * ROW).fill(null);
  const overflow = [];
  for (const it of items) {
    if (it.c < ROW) slots[it.r * ROW + it.c] = it.id;
    else overflow.push(it.id);
  }
  overflow.forEach(id => placeTiles([id]));
  return true;
}
window.addEventListener('resize', () => { if (fitRack() && view && isPlaying()) render(); });

function ensureRows(n) {
  while (slots.length < n * ROW) slots.push(...new Array(ROW).fill(null));
}
// Put tiles side by side in a free spot with empty neighbours, so they don't
// accidentally merge with an existing formation on the rack.
function placeTiles(ids) {
  if (!ids.length) return;
  const k = ids.length;
  const rows = slots.length / ROW;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c + k <= ROW; c++) {
      const s = r * ROW + c;
      let ok = (c === 0 || slots[s - 1] === null) && (c + k === ROW || slots[s + k] === null);
      for (let i = 0; i < k && ok; i++) if (slots[s + i] !== null) ok = false;
      if (ok) { ids.forEach((id, i) => { slots[s + i] = id; }); return; }
    }
  }
  if (k > 1) { ids.forEach(id => placeTiles([id])); return; }
  let i = slots.indexOf(null);
  if (i < 0) { ensureRows(rows + 1); i = rows * ROW; }
  slots[i] = ids[0];
}

function syncRack() {
  fitRack();
  if (view.round !== rackRound) {
    rackRound = view.round;
    slots = new Array(minSlots()).fill(null);
    skipped.clear();
    pendingSlot = null;
  }
  const rack = rackMap();
  slots = slots.map(id => (id && rack.has(id) ? id : null));
  // drop empty extra rows
  while (slots.length > minSlots() && slots.slice(-ROW).every(x => x === null)) slots.length -= ROW;
  const placed = new Set(slots.filter(Boolean));
  const missing = [...rack.keys()].filter(id => !placed.has(id));
  // a tile dragged from the pile lands exactly where it was dropped
  // (kept until the drawn tile actually arrives — redraws can happen before the server answers)
  if (pendingSlot !== null && missing.length === 1) {
    if (slots[pendingSlot] === null) slots[pendingSlot] = missing.pop();
    pendingSlot = null;
  }
  placeTiles(missing);
}

// Every run of adjacent tiles on a rack row (3+) that forms a valid group or run.
function rackSequences() {
  const rack = rackMap();
  const out = [];
  const rows = slots.length / ROW;
  for (let r = 0; r < rows; r++) {
    let c = 0;
    while (c < ROW) {
      if (!slots[r * ROW + c]) { c++; continue; }
      const start = c;
      while (c < ROW && slots[r * ROW + c]) c++;
      const idxs = [];
      for (let i = start; i < c; i++) idxs.push(r * ROW + i);
      if (idxs.length < 3) continue;
      const tiles = idxs.map(i => rack.get(slots[i]));
      const res = R.analyze(tiles);
      if (!res) continue;
      const sig = tiles.map(t => t.id).join(',');
      out.push({
        idxs, sig, value: res.value, skip: skipped.has(sig),
        ids: res.arranged.map(a => a.tile.id),
        repr: new Map(res.arranged.filter(a => a.tile.joker).map(a => [a.tile.id, a]))
      });
    }
  }
  return out;
}

function sortRack(mode) {
  const tiles = [...rackMap().values()];
  const ci = t => R.COLORS.indexOf(t.color);
  const jokers = tiles.filter(t => t.joker);
  const real = tiles.filter(t => !t.joker);
  const chunks = [];
  if (mode === 'color') {
    for (const color of R.COLORS) {
      const list = real.filter(t => t.color === color).sort((a, b) => a.n - b.n);
      let cur = [];
      for (const t of list) {
        if (cur.length && t.n !== cur[cur.length - 1].n + 1) { chunks.push(cur); cur = []; }
        cur.push(t);
      }
      if (cur.length) chunks.push(cur);
    }
  } else {
    for (let n = 1; n <= 13; n++) {
      const list = real.filter(t => t.n === n).sort((a, b) => ci(a) - ci(b));
      const first = [];
      const dupes = [];
      for (const t of list) (first.some(x => x.color === t.color) ? dupes : first).push(t);
      if (first.length) chunks.push(first);
      if (dupes.length) chunks.push(dupes);
    }
  }
  const big = chunks.filter(c => c.length >= 3);
  const rest = chunks.filter(c => c.length < 3).flat().concat(jokers);

  slots = new Array(minSlots()).fill(null);
  let r = 0;
  let c = 0;
  const put = t => { ensureRows(r + 1); slots[r * ROW + c] = t.id; c++; if (c >= ROW) { r++; c = 0; } };
  for (const chunk of big) {
    if (c > 0 && c + chunk.length > ROW) { r++; c = 0; }
    chunk.forEach(put);
    if (c > 0) c++; // gap after each formation
    if (c >= ROW) { r++; c = 0; }
  }
  rest.forEach(put);
  render();
}
$('sortColor').onclick = () => sortRack('color');
$('sortNum').onclick = () => sortRack('num');

// ---------- drag & drop ----------
function tileEl(tile, { draggable = false, repr = null } = {}) {
  const d = el('div', { class: 'tile ' + (tile.joker ? 'joker' : 'c-' + tile.color) });
  d.dataset.id = tile.id;
  d.append(el('span', { text: tile.joker ? '☺' : String(tile.n) }));
  if (tile.joker && repr) {
    const s = el('small', { text: String(repr.n) });
    s.style.color = `var(--${repr.color})`;
    d.append(s);
    d.title = `Joker = ${repr.n} ${COLOR_RO[repr.color]}`;
  }
  if (draggable) {
    d.draggable = true;
    d.addEventListener('dragstart', e => {
      dragging = { id: tile.id };
      e.dataTransfer.setData('text/plain', tile.id);
      e.dataTransfer.effectAllowed = 'move';
      requestAnimationFrame(() => { if (dragging && dragging.id === tile.id) d.classList.add('dragging'); });
    });
    d.addEventListener('dragend', () => { d.classList.remove('dragging'); dragging = null; });
  }
  return d;
}
// acceptPile: this target also takes the tile dragged from the draw pile (rack slots only).
// acceptKey: this target also takes the broken-at tile from the chain (rack slots only).
function dropTarget(target, onDrop, { acceptPile = false, acceptKey = false } = {}) {
  const accepts = () => dragging && (dragging.pile ? acceptPile : dragging.key ? acceptKey : true);
  target.addEventListener('dragover', e => {
    if (!accepts()) return;
    e.preventDefault();
    e.stopPropagation();
    target.classList.add('over');
  });
  target.addEventListener('dragleave', () => target.classList.remove('over'));
  target.addEventListener('drop', e => {
    if (!accepts()) return;
    e.preventDefault();
    e.stopPropagation();
    target.classList.remove('over');
    const d = dragging;
    dragging = null;
    onDrop(d.id, d);
  });
}

// ---------- game controls ----------
// Drawing: drag the top tile of the pile onto the rack, wherever you want it.
const pileTile = $('pile').querySelector('.tile');
pileTile.addEventListener('dragstart', e => {
  if (!(view && view.myTurn && view.phase === 'draw')) { e.preventDefault(); return; }
  dragging = { pile: true };
  e.dataTransfer.setData('text/plain', 'pile');
  e.dataTransfer.effectAllowed = 'move';
});
pileTile.addEventListener('dragend', () => { dragging = null; });
$('pile').onclick = () => {
  if (view && view.myTurn && view.phase === 'draw') toast('Trage piesa din grămadă pe tablă, unde vrei s-o pui.', false);
};
dropTarget($('chainBar'), id => act('discard', { tileId: id }));
$('undoTakeBtn').onclick = () => act('undoTake');
$('layBtn').onclick = () => {
  const melds = rackSequences().filter(s => !s.skip).map(s => s.ids);
  if (!melds.length) return toast('Așază formațiile pe tablă: piese lipite una de alta, despărțite de un spațiu gol.');
  act('lay', { melds });
};

// ---------- rendering ----------
function render() {
  if (!view) return;
  if (view.phase === 'lobby') {
    if (modalKind === 'results') closeModal();
    renderWaiting();
    show('waiting');
    return;
  }
  show('game');
  syncRack();
  $('gCode').textContent = view.code;
  $('gRound').textContent = view.round;
  renderOpponents();
  renderMine();
  renderCenter();
  renderControls();
  renderRack();
  renderResults();
}

// On the host PC the page is opened as localhost, which means nothing to friends:
// share the public Cloudflare link instead.
const isLocalHost = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
let publicBase = isLocalHost ? null : location.origin;
let publicCheckedAt = 0;
async function refreshPublicBase() {
  if (!isLocalHost || Date.now() - publicCheckedAt < 5000) return;
  publicCheckedAt = Date.now();
  const res = await fetch('/api/public-url').then(r => r.json()).catch(() => ({}));
  if (res.url !== publicBase) { publicBase = res.url || null; if (view && view.phase === 'lobby') renderWaiting(); }
}

function renderWaiting() {
  $('wCode').textContent = view.code;
  refreshPublicBase();
  $('shareLink').value = publicBase ? `${publicBase}/?room=${view.code}` : '';
  $('copyBtn').disabled = !publicBase;
  $('shareNote').classList.toggle('hidden', !!publicBase);
  $('shareNote').textContent = 'Linkul public nu este pornit, așa că prietenii din afara rețelei tale nu pot intra. Pornește Remi cu start-remi.bat.';
  $('wPlayers').replaceChildren(el('div', { class: 'plist' }, ...view.players.map(p =>
    el('div', { class: 'item' }, avatarEl(p, 32),
      el('span', { text: p.name + (p.id === view.hostId ? ' (gazdă)' : '') + (p.id === view.myId ? ' — tu' : '') })))));
  const isHost = view.hostId === view.myId;
  $('startBtn').classList.toggle('hidden', !isHost);
  $('startBtn').disabled = view.players.length < view.rules.minPlayers;
  $('wHint').textContent = isHost
    ? (view.players.length < view.rules.minPlayers ? 'Așteptăm cel puțin încă un jucător…' : `${view.players.length} jucători — poți porni jocul.`)
    : 'Așteptăm ca gazda să pornească jocul…';
}

// Compact player chip: avatar (gold ring = their turn), name, score, status badges.
function seatChip(p) {
  const badges = [];
  if (p.lastTile) badges.push(el('span', { class: 'badge last', text: 'ultima piesă!' }));
  if (!p.connected) badges.push(el('span', { class: 'badge', text: 'deconectat' }));
  if (p.isTurn && view.deadline) badges.push(el('span', { class: 'badge timer', 'data-deadline': String(view.deadline) }));
  if (p.atuBonus && isPlaying()) badges.push(el('span', { class: 'badge atu', text: `atu +${p.atuBonus}`, title: 'A avut atuul în mână la începutul rundei' }));
  return el('div', { class: 'seat-chip' + (p.isTurn ? ' turn' : '') + (p.connected ? '' : ' offline') },
    avatarEl(p, 36),
    el('div', {},
      el('div', { class: 'pname', text: p.name + (p.id === view.myId ? ' (tu)' : '') }),
      el('div', { class: 'pmeta', text: `${p.score} puncte${p.opened ? ` · pe masă ${p.laid}` : ''}${p.isTurn ? ' · la mutare' : ''}` })),
    ...badges);
}

function renderFormations(container, ownerId) {
  const list = view.formations.filter(f => f.owner === ownerId);
  container.replaceChildren();
  if (!list.length) {
    container.append(el('span', { class: 'empty', text: player(ownerId).opened ? '' : 'Nu s-a etalat încă.' }));
    return;
  }
  for (const f of list) {
    const m = el('div', { class: 'meld', title: 'Trage o piesă aici ca s-o adaugi' });
    for (const a of f.arranged) {
      const t = tileEl(a.tile, { repr: a.tile.joker ? a : null });
      if (a.tile.joker) {
        t.title += ' — trage piesa corectă peste joker ca să-l iei';
        dropTarget(t, id => act('swapJoker', { formationId: f.id, tileId: id }));
      }
      m.append(t);
    }
    dropTarget(m, id => act('lay', { additions: [{ formationId: f.id, tileIds: [id] }] }));
    container.append(m);
  }
}

function fillSeat(seat, p) {
  if (!p) { seat.replaceChildren(); return; }
  const forms = el('div', { class: 'formations' });
  renderFormations(forms, p.id);
  seat.replaceChildren(seatChip(p), forms);
}

// Seat opponents around the table in turn order: next player on the right,
// then across (top), then on the left.
function renderOpponents() {
  const i = view.players.findIndex(p => p.id === view.myId);
  const order = view.players.slice(i + 1).concat(view.players.slice(0, Math.max(i, 0)));
  const seats = { left: null, top: null, right: null };
  if (order.length === 1) seats.top = order[0];
  else if (order.length === 2) { seats.right = order[0]; seats.left = order[1]; }
  else { seats.right = order[0]; seats.top = order[1]; seats.left = order[2]; }
  fillSeat($('seatLeft'), seats.left);
  fillSeat($('seatTop'), seats.top);
  fillSeat($('seatRight'), seats.right);
  $('table').className = `opp-${order.length}`;
}

function renderMine() {
  fillSeat($('seatMe'), player(view.myId));
}

function renderCenter() {
  $('pileCount').textContent = String(view.pileCount);
  const canDraw = view.myTurn && view.phase === 'draw';
  $('pile').classList.toggle('active', canDraw);
  pileTile.draggable = canDraw;
  pileTile.title = canDraw ? 'Trage piesa pe tablă' : '';

  // The atu: turned face up at the bottom of the pile.
  const atuBox = $('atuBox');
  atuBox.replaceChildren();
  if (view.atu) {
    const lbl = el('div', { class: 'lbl' }, 'Atu');
    if (view.multiplier > 1) lbl.append(el('b', { text: `×${view.multiplier}`, title: 'Atuul e 1: punctele rundei se dublează' }));
    const t = tileEl(view.atu);
    if (!view.atuInPile) { t.classList.add('gone'); t.title = 'Atuul a fost tras din grămadă'; }
    atuBox.append(lbl, t);
  }

  const chain = $('discardChain');
  chain.replaceChildren();
  const canTake = view.myTurn && view.phase === 'draw';
  chain.classList.toggle('can-take', canTake);
  $('chainBar').classList.toggle('active', view.myTurn);
  const tiles = view.discard.map((t, i) => {
    const e = tileEl(t);
    if (i === 0) {
      // the first tile of the chain lies sideways and can never be taken
      e.classList.add('first');
      e.title = 'Prima piesă din lanț — nu se poate lua';
      return e;
    }
    if (canTake) {
      const n = view.discard.length - i;
      e.title = n === 1 ? 'Ia această piesă' : `Rupe lanțul aici: iei ${n} piese`;
      e.onmouseenter = () => tiles.forEach((x, j) => x.classList.toggle('take-hl', j >= i && j > 0));
      e.onmouseleave = () => tiles.forEach(x => x.classList.remove('take-hl'));
      e.onclick = () => act('draw', { source: 'discard', index: i });
    }
    return e;
  });
  chain.append(...tiles);
  if (!tiles.length) chain.append(el('span', { class: 'placeholder', text: 'Aruncate' }));
  $('discardHint').textContent = canTake && view.discard.length > 1
    ? 'Click pe o piesă din lanț ca să rupi de acolo'
    : view.myTurn && view.phase === 'play' ? 'Trage o piesă pe lemn ca s-o arunci' : '';

  renderHeld();
  $('lastAction').textContent = view.log.length ? view.log[view.log.length - 1] : '';
  $('logPanel').replaceChildren(...view.log.slice().reverse().map(l => el('div', { text: l })));
}
$('logBtn').onclick = e => {
  e.stopPropagation();
  $('logPanel').classList.toggle('hidden');
};
document.addEventListener('click', e => {
  if (!$('logPanel').contains(e.target)) $('logPanel').classList.add('hidden');
});

function renderControls() {
  const p = player(view.myId);
  const cur = view.players.find(x => x.isTurn);
  const seqs = rackSequences().filter(s => !s.skip);
  const total = seqs.reduce((s, x) => s + x.value, 0);
  const key = view.taken && !view.taken.keyUsed ? view.taken.keyTile : null;

  $('layBtn').disabled = !(view.myTurn && view.phase === 'play' && seqs.length && !key);
  $('undoTakeBtn').classList.toggle('hidden', !key);
  $('rackInfo').textContent = seqs.length
    ? `Pe tablă: ${seqs.length} ${seqs.length === 1 ? 'formație' : 'formații'} · ${total}${p.opened ? '' : ' / ' + view.rules.openingMin} pct`
    : '';

  // my own countdown, big, next to the controls
  const tt = $('turnTimer');
  const mine = view.myTurn && view.deadline;
  tt.classList.toggle('hidden', !mine);
  if (mine) { tt.dataset.deadline = String(view.deadline); tt.title = view.phase === 'draw' ? 'Timp să tragi o piesă' : 'Timp să joci și să arunci'; }
  else delete tt.dataset.deadline;
  tickTimers();

  const st = $('status');
  st.replaceChildren();
  if (!isPlaying()) return;
  if (!view.myTurn) st.append('Este rândul lui ', el('b', { text: cur ? cur.name : '' }), cur && cur.name.endsWith('.') ? '' : '.');
  else if (view.phase === 'draw') st.append(el('b', { text: 'E rândul tău. ' }), 'Trage o piesă din grămadă pe tablă, sau rupe lanțul de aruncate.');
  else if (key) st.append(el('b', { text: 'Trage ' + (key.joker ? 'jokerul' : `${key.n} ${COLOR_RO[key.color]}`) + ' peste perechea ta de pe tablă' }), ' — se etalează imediat, apoi vin și celelalte piese din lanț.');
  else if (!p.opened) st.append(el('b', { text: 'E rândul tău. ' }), `Etalează-te (minim ${view.rules.openingMin} pct) sau aruncă o piesă.`);
  else if (!view.me.canAdd) st.append(el('b', { text: 'Te-ai etalat! ' }), 'Poți lipi piese la formații din tura următoare. Acum aruncă o piesă.');
  else st.append(el('b', { text: 'E rândul tău. ' }), 'Etalează sau lipește piese la formații, apoi aruncă o piesă.');
}

// The tiles touching each other on the shelf where the broken-at tile was dropped:
// dropped on a tile -> that whole group; dropped on an empty spot -> the groups on its left and right.
function pairAt(i) {
  const start = Math.floor(i / ROW) * ROW;
  const c = i % ROW;
  const ids = [];
  if (slots[i]) {
    let a = c;
    let b = c;
    while (a > 0 && slots[start + a - 1]) a--;
    while (b < ROW - 1 && slots[start + b + 1]) b++;
    for (let k = a; k <= b; k++) ids.push(slots[start + k]);
  } else {
    let a = c;
    while (a > 0 && slots[start + a - 1]) a--;
    for (let k = a; k < c; k++) ids.push(slots[start + k]);
    for (let k = c + 1; k < ROW && slots[start + k]; k++) ids.push(slots[start + k]);
  }
  return ids;
}

function layKeyAt(i) {
  const withTiles = pairAt(i);
  if (withTiles.length < 2) {
    toast('Las-o peste perechea ta: cel puțin 2 piese lipite una de alta pe tablă.');
    return;
  }
  // not opened yet: the other ready formations on the rack go down too, to reach the opening minimum
  const melds = player(view.myId).opened ? [] : rackSequences()
    .filter(s => !s.skip && !s.ids.some(id => withTiles.includes(id)))
    .map(s => s.ids);
  act('layKey', { withTiles, melds });
}

function renderHeld() {
  const box = $('heldBox');
  const t = view.myTurn && view.taken && !view.taken.keyUsed ? view.taken : null;
  box.classList.toggle('hidden', !t);
  if (!t) { box.replaceChildren(); return; }
  const key = tileEl(t.keyTile);
  key.classList.add('held');
  key.draggable = true;
  key.title = 'Trage piesa peste perechea ta de pe tablă';
  key.addEventListener('dragstart', e => {
    dragging = { key: true, id: t.keyTile.id };
    e.dataTransfer.setData('text/plain', t.keyTile.id);
    e.dataTransfer.effectAllowed = 'move';
  });
  key.addEventListener('dragend', () => { dragging = null; });
  const rest = el('div', { class: 'rest' }, ...t.rest.map(x => { const e = tileEl(x); e.classList.add('small'); return e; }));
  box.replaceChildren(
    el('div', { class: 'lbl', text: 'Ai rupt de la' }), key,
    t.rest.length ? el('div', { class: 'lbl', text: 'vin după' }) : null,
    t.rest.length ? rest : null);
}

function renderRack() {
  const rack = rackMap();
  const seqs = rackSequences();
  const seqAt = new Map();
  for (const s of seqs) for (const i of s.idxs) seqAt.set(i, s);
  const box = $('rack');
  const shelves = [];
  for (let r = 0; r < slots.length / ROW; r++) shelves.push(el('div', { class: 'shelf' }));
  box.replaceChildren(...shelves);
  const takenIds = new Set(view.taken ? view.taken.ids : []);

  slots.forEach((id, i) => {
    const s = el('div', { class: 'slot' });
    dropTarget(s, (did, d) => {
      if (d.key) { layKeyAt(i); return; }
      if (d.pile) {
        // drawing from the pile: make room here, the new tile lands in this slot
        if (slots[i]) { const occupant = slots[i]; slots[i] = null; placeTiles([occupant]); }
        pendingSlot = i;
        act('draw', { source: 'pile' }, null, () => { pendingSlot = null; });
        render();
        return;
      }
      const from = slots.indexOf(did);
      if (from < 0) return;
      const occupant = slots[i];
      slots[from] = occupant;
      slots[i] = did;
      render();
    }, { acceptPile: true, acceptKey: true });
    const t = id && rack.get(id);
    const seq = seqAt.get(i);
    if (t) {
      const te = tileEl(t, { draggable: true, repr: seq && t.joker ? seq.repr.get(t.id) : null });
      if (takenIds.has(id)) te.classList.add('taken'); // came from the chain this turn
      s.append(te);
    }
    if (seq) {
      s.classList.add(seq.skip ? 'seq-skip' : 'seq');
      if (seq.idxs[0] === i) {
        const b = el('span', {
          class: 'seq-badge' + (seq.skip ? ' skip' : ''),
          text: seq.skip ? 'păstrată' : `✓ ${seq.value}`,
          title: seq.skip ? 'Click: o etalezi și pe asta' : 'Click: păstreaz-o pe tablă (nu o etala acum)'
        });
        b.onclick = () => { if (seq.skip) skipped.delete(seq.sig); else skipped.add(seq.sig); render(); };
        s.append(b);
      }
    }
    shelves[Math.floor(i / ROW)].append(s);
  });
}

function renderResults() {
  if (view.phase !== 'roundOver' || !view.lastResult) {
    if (modalKind === 'results') closeModal();
    return;
  }
  if (modalKind === 'profile' || modalKind === 'admin') return;
  const card = openModal('results');
  const res = view.lastResult;
  card.append(el('h2', { text: res.winnerId ? `${player(res.winnerId).name} a închis!` : 'Runda s-a terminat fără câștigător' }));
  if (res.atu) {
    const line = el('div', { class: 'row' }, el('span', { class: 'sub', text: 'Atu:' }), (() => { const t = tileEl(res.atu); t.classList.add('small'); return t; })());
    if (res.multiplier > 1) line.append(el('b', { text: `Atuul a fost 1 — toate punctele s-au dublat (×${res.multiplier}).` }));
    card.append(line);
  }
  const table = el('table', { class: 'results' },
    el('tr', {}, el('th', { text: 'Jucător' }), el('th', { text: 'Piese rămase' }), el('th', { text: 'Calcul' }), el('th', { text: 'Runda' }), el('th', { text: 'Total' })));
  for (const r of res.results) {
    const mini = el('div', { class: 'mini' }, ...r.rack.map(t => { const e = tileEl(t); e.classList.add('small'); return e; }));
    // how the round score was made: laid on the table − left in hand + closing + atu, × multiplier
    const b = r.breakdown || {};
    const parts = [];
    if (b.notOpened) parts.push(`neetalat −${view.rules.notOpenedPenalty}`);
    else {
      parts.push(`pe masă +${b.laid}`);
      if (b.hand) parts.push(`în mână −${b.hand}`);
      if (b.close) parts.push(`închidere +${b.close}`);
    }
    if (b.atu) parts.push(`atu +${b.atu}`);
    if (b.mult > 1) parts.push(`× ${b.mult}`);
    table.append(el('tr', {},
      el('td', {}, el('div', { class: 'row' }, avatarEl(r, 26),
        el('span', { text: r.name }))),
      el('td', {}, mini),
      el('td', { class: 'calc', text: parts.join(' · ') }),
      el('td', { class: r.delta > 0 ? 'pos' : r.delta < 0 ? 'neg' : '', text: (r.delta > 0 ? '+' : '') + r.delta }),
      el('td', { text: String(r.score) })));
  }
  card.append(table);
  card.append(view.hostId === view.myId
    ? el('button', { class: 'primary', text: 'Runda următoare', onclick: () => act('nextRound') })
    : el('p', { class: 'sub', text: 'Așteptăm ca gazda să pornească runda următoare…' }));
}

// ---------- boot ----------
(async function boot() {
  token = getToken();
  if (token) {
    try {
      const { user } = await api('GET', '/me');
      return loggedIn(user);
    } catch {
      clearToken();
    }
  }
  showLogin();
})();
