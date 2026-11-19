const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Use a throwaway data folder so tests never touch real accounts.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-test-'));
const store = require('../server/store');

test('accounts, login, sessions, profile', () => {
  assert.equal(store.hasUsers(), false);
  const admin = store.createUser({ username: 'Andrei', password: 'secret1', displayName: 'Andrei', isAdmin: true });
  assert.equal(admin.username, 'andrei');
  assert.throws(() => store.createUser({ username: 'andrei', password: 'secret1' }), /Există deja/);
  assert.throws(() => store.createUser({ username: 'x', password: 'secret1' }), /3–20/);
  assert.throws(() => store.createUser({ username: 'mihai', password: '123' }), /6/);

  assert.equal(store.verifyLogin('andrei', 'wrong!!'), null);
  assert.equal(store.verifyLogin('ANDREI', 'secret1').id, admin.id);

  const token = store.createSession(admin.id);
  assert.equal(store.userForToken(token).id, admin.id);
  assert.equal(store.userForToken('nope'), null);

  store.updateProfile(admin.id, { displayName: '  Andy  ' });
  assert.equal(store.publicProfile(store.getUser(admin.id)).name, 'Andy');

  // changing the password logs out old sessions
  store.setPassword(admin.id, 'newpass1');
  assert.equal(store.userForToken(token), null);
  assert.ok(store.verifyLogin('andrei', 'newpass1'));
});

test('lifetime score adds up across rounds', () => {
  const a = store.createUser({ username: 'ioana', password: 'secret1' });
  const b = store.createUser({ username: 'radu', password: 'secret1' });
  store.recordRound(a.id, 120, true);
  store.recordRound(a.id, -30, false);
  store.recordRound(b.id, 40, false);
  assert.deepEqual(store.selfView(store.getUser(a.id)).stats, { points: 90, rounds: 2, wins: 1, best: 120 });
  const board = store.leaderboard().filter(x => x.id === a.id || x.id === b.id);
  assert.deepEqual(board.map(x => x.name), ['ioana', 'radu']);
});

test('avatars must be real JPEGs', () => {
  const u = store.createUser({ username: 'mihai', password: 'secret1' });
  assert.throws(() => store.setAvatar(u.id, 'data:image/png;base64,AAAA'), /JPEG/);
  assert.throws(() => store.setAvatar(u.id, 'data:image/jpeg;base64,' + Buffer.from('hello').toString('base64')), /invalid/);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100)]);
  store.setAvatar(u.id, 'data:image/jpeg;base64,' + jpeg.toString('base64'));
  assert.match(store.publicProfile(store.getUser(u.id)).avatar, /^\/avatars\/.+\.jpg\?v=\d+$/);
});
