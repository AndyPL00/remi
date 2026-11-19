const test = require('node:test');
const assert = require('node:assert');
const { Game } = require('../server/game');

const T = (id, color, n) => ({ id, color, n });

function setup() {
  let changed = 0;
  const g = new Game('TIME', { changed: () => { changed++; } });
  g.addPlayer('ana');
  g.addPlayer('bogdan');
  g.start('ana');
  g.atuBonus = {};
  g.multiplier = 1;
  return { g, changes: () => changed };
}

// Move the game to the start of the next player's draw phase.
function toDraw(g) {
  const p = g.cur();
  g.discardTile(p.id, p.rack[0].id);
  return g.cur();
}

test('each phase gets its own deadline: 30s to draw, 60s to play', () => {
  const { g } = setup();
  const t0 = Date.now();
  assert.equal(g.phase, 'play', 'the starting player discards first');
  assert.ok(Math.abs(g.deadline - (t0 + 60000)) < 1000);
  const p = toDraw(g);
  assert.equal(g.phase, 'draw');
  assert.ok(Math.abs(g.deadline - (Date.now() + 30000)) < 1000);
  g.draw(p.id, 'pile');
  assert.ok(Math.abs(g.deadline - (Date.now() + 60000)) < 1000);
  assert.ok(g.getView(p.id).deadline > Date.now());
  g.stopTimer();
});

test('draw time over: a tile from the pile is given automatically', () => {
  const { g, changes } = setup();
  const p = toDraw(g);
  const before = p.rack.length;
  g.onTimeout();
  assert.equal(p.rack.length, before + 1);
  assert.equal(g.phase, 'play', 'the player still gets the play time');
  assert.equal(g.cur(), p);
  assert.match(g.log.join('\n'), /n-a tras la timp/);
  assert.equal(changes(), 1, 'everyone is told');
  g.stopTimer();
});

test('play time over: the drawn tile is discarded and the turn passes', () => {
  const { g } = setup();
  const p = toDraw(g);
  g.draw(p.id, 'pile');
  const drawn = g.ts.drawnId;
  g.ts.playDeadline = Date.now() - 1; // time's up
  g.onTimeout();
  assert.ok(!p.rack.some(t => t.id === drawn));
  assert.equal(g.discard[g.discard.length - 1].id, drawn);
  assert.notEqual(g.cur(), p);
  assert.equal(g.phase, 'draw');
  g.stopTimer();
});

test('play time over without a drawn tile: the most expensive non-joker goes', () => {
  const { g } = setup();
  const p = g.cur(); // starting player, play phase, no draw this turn
  p.rack = [{ id: 'J1', joker: true }, T('a', 'red', 4), T('b', 'blue', 1), T('c', 'black', 12)];
  g.ts.playDeadline = Date.now() - 1;
  g.onTimeout();
  assert.equal(g.discard[g.discard.length - 1].id, 'b', 'the 1 costs 25 in hand');
  assert.ok(p.rack.some(t => t.joker), 'never the joker');
  g.stopTimer();
});

test('play time over with an unplaced chain break: chain goes back, pile tile instead', () => {
  const { g } = setup();
  const p = toDraw(g);
  g.discard = [T('d0', 'red', 2), T('d1', 'red', 9), T('d2', 'blue', 4)];
  const before = p.rack.length;
  g.draw(p.id, 'discard', 1);
  g.ts.playDeadline = Date.now() - 1;
  g.onTimeout();
  assert.deepEqual(g.discard.slice(0, 3).map(t => t.id), ['d0', 'd1', 'd2'], 'chain restored in order');
  assert.equal(g.discard.length, 4, 'plus the auto-discarded tile');
  assert.equal(p.rack.length, before, 'drew one from the pile, discarded it');
  assert.notEqual(g.cur(), p);
  g.stopTimer();
});

test('"Pune înapoi" never buys extra time', () => {
  const { g } = setup();
  const p = toDraw(g);
  g.discard.push(T('x1', 'red', 9), T('x2', 'blue', 4));
  g.draw(p.id, 'discard', 1);
  const playDeadline = g.deadline;
  g.undoTake(p.id);
  assert.equal(g.phase, 'draw');
  assert.equal(g.deadline, playDeadline, 'same deadline as before');
  g.draw(p.id, 'pile');
  assert.equal(g.deadline, playDeadline, 'still the same after drawing again');
  g.stopTimer();
});

test('timers pause when nobody is connected and give fresh time on return', () => {
  const { g } = setup();
  const p = toDraw(g);
  g.pauseTimer();
  assert.equal(g.timer, null);
  g.deadline = Date.now() - 5000; // would have run out meanwhile
  g.resumeTimer();
  assert.ok(Math.abs(g.deadline - (Date.now() + 30000)) < 1000);
  assert.equal(g.cur(), p, 'nothing was played while paused');
  g.stopTimer();
});

test('the timer stops when the round ends', () => {
  const { g } = setup();
  const p = g.cur();
  p.rack = [T('z', 'red', 5)];
  g.discardTile(p.id, 'z'); // closes
  assert.equal(g.phase, 'roundOver');
  assert.equal(g.deadline, null);
  assert.equal(g.getView(p.id).deadline, null);
});
