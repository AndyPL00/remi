const test = require('node:test');
const assert = require('node:assert');
const { Game, GameError } = require('../server/game');
const R = require('../public/rules.js');

function setup() {
  const g = new Game('TEST');
  g.addPlayer('ana');
  g.addPlayer('bogdan');
  g.start('ana');
  return g;
}
const T = (id, color, n) => ({ id, color, n });

test('106 tiles with unique ids', () => {
  const tiles = R.createTiles();
  assert.equal(tiles.length, 106);
  assert.equal(new Set(tiles.map(t => t.id)).size, 106);
});

test('deal and first turn', () => {
  const g = setup();
  const starter = g.cur();
  assert.equal(starter.rack.length, 15);
  assert.equal(g.players.find(p => p !== starter).rack.length, 14);
  assert.equal(g.phase, 'play');
  assert.equal(g.pile.length, 106 - 29);
});

test('turn flow: the first discarded tile can never be taken', () => {
  const g = setup();
  const p1 = g.cur();
  g.discardTile(p1.id, p1.rack[0].id);
  const p2 = g.cur();
  assert.notEqual(p1.id, p2.id);
  assert.equal(g.phase, 'draw');
  assert.throws(() => g.draw(p1.id, 'pile'), /rândul/);
  assert.throws(() => g.draw(p2.id, 'discard'), /Prima piesă/);
  assert.throws(() => g.draw(p2.id, 'discard', 0), /Prima piesă/);
  g.draw(p2.id, 'pile');
  g.discardTile(p2.id, p2.rack[0].id);
  // now the chain has 2 tiles: the second one can be taken, the first still can't
  assert.throws(() => g.draw(p1.id, 'discard', 0), /Prima piesă/);
  const rackBefore = p1.rack.length;
  g.draw(p1.id, 'discard');
  assert.equal(g.discard.length, 1);
  assert.equal(p1.rack.length, rackBefore, 'the broken-at tile does not go onto the rack');
  assert.throws(() => g.discardTile(p1.id, p1.rack[0].id), /Pune înapoi/);
  g.undoTake(p1.id);
  assert.equal(g.discard.length, 2);
  g.draw(p1.id, 'pile');
  assert.equal(g.phase, 'play');
});

test('breaking the chain: the broken-at tile is laid at once, then the rest joins the rack', () => {
  const g = setup();
  const p = g.cur();
  g.phase = 'draw';
  g.discard = [T('a', 'red', 2), T('b', 'red', 9), T('c', 'blue', 4), T('d', 'black', 11)];
  p.rack = [T('x', 'red', 10), T('y', 'red', 11), T('z', 'blue', 1)];
  p.opened = true; p.openedTurn = 0;
  g.draw(p.id, 'discard', 1);
  assert.deepEqual(g.discard.map(t => t.id), ['a']);
  assert.deepEqual(p.rack.map(t => t.id), ['x', 'y', 'z'], 'nothing joins the rack yet');
  assert.equal(g.getView(p.id).taken.keyTile.id, 'b');
  // until the broken-at tile is laid: no laying, no sticking on, no joker swaps, no discarding
  g.formations.push({ id: 50, owner: 'x', type: 'run', tiles: [T('q', 'red', 6), T('w', 'red', 7), { id: 'J1', joker: true }] });
  assert.throws(() => g.lay(p.id, { additions: [{ formationId: 50, tileIds: ['x'] }] }), /Mai întâi/);
  assert.throws(() => g.swapJoker(p.id, 50, 'x'), /Mai întâi/);
  assert.throws(() => g.discardTile(p.id, 'z'), /Pune înapoi/);
  // a non-matching pair is refused and changes nothing
  assert.throws(() => g.layKey(p.id, { withTiles: ['x', 'z'] }), /invalidă/);
  assert.deepEqual(p.rack.map(t => t.id), ['x', 'y', 'z']);
  // the right pair: 9 red goes down with 10-11 red immediately, then 4 blue and 11 black arrive
  g.layKey(p.id, { withTiles: ['x', 'y'] });
  assert.ok(g.formations.some(f => f.owner === p.id && f.tiles.some(t => t.id === 'b')));
  assert.deepEqual(p.rack.map(t => t.id).sort(), ['c', 'd', 'z']);
  assert.equal(g.placedBy.b, p.id);
  g.discardTile(p.id, 'z');
  assert.equal(g.phase, 'draw');
});

test('breaking the chain before opening: other rack formations can complete the 45', () => {
  const g = setup();
  const p = g.cur();
  g.phase = 'draw';
  g.discard = [T('a', 'red', 2), T('k9', 'blue', 9), T('e', 'blue', 3)];
  p.rack = [
    T('b10', 'blue', 10), T('b11', 'blue', 11),                      // pair: 9-10-11 blue = 25
    T('r13', 'red', 13), T('y13', 'yellow', 13), T('k13', 'black', 13), // group: 30
    T('z', 'red', 5)
  ];
  g.draw(p.id, 'discard', 1);
  assert.throws(() => g.layKey(p.id, { withTiles: ['b10', 'b11'] }), /ai 25/, 'not enough to open alone');
  g.layKey(p.id, { withTiles: ['b10', 'b11'], melds: [['r13', 'y13', 'k13']] }); // 55
  assert.ok(p.opened);
  assert.deepEqual(p.rack.map(t => t.id).sort(), ['e', 'z']);
});

test('undo puts the whole broken chain back in order', () => {
  const g = setup();
  const p = g.cur();
  g.phase = 'draw';
  g.discard = [T('a', 'red', 2), T('b', 'red', 9), T('c', 'blue', 4), T('d', 'blue', 6)];
  g.draw(p.id, 'discard', 1);
  assert.deepEqual(g.discard.map(t => t.id), ['a']);
  g.undoTake(p.id);
  assert.deepEqual(g.discard.map(t => t.id), ['a', 'b', 'c', 'd']);
  assert.equal(g.phase, 'draw');
});

test('tile counts are hidden except at the last tile', () => {
  const g = setup();
  const p = g.cur();
  const v = g.getView('ana');
  assert.ok(v.players.every(x => x.count === undefined));
  assert.ok(v.players.every(x => x.lastTile === false));
  p.rack = p.rack.slice(0, 2);
  g.discardTile(p.id, p.rack[0].id);
  assert.equal(g.getView('ana').players.find(x => x.id === p.id).lastTile, true);
});

test('opening, adding to the table, closing and scoring', () => {
  const g = setup();
  const p = g.cur();
  const other = g.players.find(x => x !== p);
  p.rack = [
    T('A', 'red', 13), T('B', 'blue', 13), T('C', 'yellow', 13), // group: 30
    T('D', 'black', 3), T('E', 'black', 4), T('F', 'black', 5),  // run: 15
    T('G', 'black', 6), T('H', 'blue', 2)
  ];
  assert.throws(() => g.lay(p.id, { melds: [['A', 'B', 'C']] }), /ai 30/);
  assert.throws(() => g.lay(p.id, { melds: [['A', 'B', 'D']] }), /invalidă/);
  g.lay(p.id, { melds: [['A', 'B', 'C'], ['D', 'E', 'F']] }); // exactly 45
  assert.ok(p.opened);
  const run = g.formations.find(f => f.tiles.some(t => t.id === 'D'));
  assert.equal(run.owner, p.id);
  // sticking tiles on is only allowed from the next turn after opening
  assert.throws(() => g.lay(p.id, { additions: [{ formationId: run.id, tileIds: ['G'] }] }), /tura următoare/);
  assert.equal(g.getView(p.id).me.canAdd, false);
  g.turnNo++; // a later turn
  assert.equal(g.getView(p.id).me.canAdd, true);
  g.lay(p.id, { additions: [{ formationId: run.id, tileIds: ['G'] }] });
  assert.equal(run.tiles.length, 4);
  other.rack = [T('X', 'red', 5), T('Y', 'red', 1)];
  g.atuBonus = {};
  g.multiplier = 1;
  g.discardTile(p.id, 'H');
  assert.equal(g.phase, 'roundOver');
  const res = g.lastResult.results;
  const mine = res.find(r => r.id === p.id);
  // laid: 13,13,13 (30) + 3,4,5,6 (20) = 50; nothing in hand; closing +50
  assert.deepEqual(mine.breakdown, { laid: 50, hand: 0, close: 50, atu: 0, notOpened: false, mult: 1 });
  assert.equal(mine.delta, 100);
  assert.equal(res.find(r => r.id === other.id).delta, -100, 'other never opened');
});

test('round score: laid points minus hand; added tiles count for whoever added them', () => {
  const g = setup();
  const a = g.cur();
  const b = g.players.find(x => x !== a);
  g.atuBonus = {};
  g.multiplier = 1;
  a.opened = true; a.openedTurn = 0;
  b.opened = true; b.openedTurn = 0;
  // a's run 9-10-11 (5+10+10 = 25); b stuck 12 and 13 onto it (+20 for b)
  g.formations.push({ id: 1, owner: a.id, type: 'run', tiles: [T('r9', 'red', 9), T('r10', 'red', 10), T('r11', 'red', 11)] });
  ['r9', 'r10', 'r11'].forEach(id => { g.placedBy[id] = a.id; });
  g.formations.push({ id: 2, owner: b.id, type: 'group', tiles: [T('k1', 'black', 1), T('b1', 'blue', 1), { id: 'J1', joker: true }] });
  ['k1', 'b1', 'J1'].forEach(id => { g.placedBy[id] = b.id; }); // 25 + 25 + joker 50 = 100
  a.rack = [T('X', 'yellow', 4)];
  b.rack = [T('r12', 'red', 12), T('r13', 'red', 13), T('Y', 'blue', 10), T('Z', 'black', 7)];
  g.turn = g.players.indexOf(b);
  g.phase = 'play';
  g.lay(b.id, { additions: [{ formationId: 1, tileIds: ['r12', 'r13'] }] });
  g.discardTile(b.id, 'Z'); // b keeps a 10 in hand; turn passes to a
  g.phase = 'play';
  g.discardTile(a.id, 'X'); // a closes
  const res = g.lastResult.results;
  const ra = res.find(r => r.id === a.id);
  const rb = res.find(r => r.id === b.id);
  assert.equal(ra.breakdown.laid, 25);
  assert.equal(ra.delta, 25 + 50, 'laid 25 + closing 50');
  assert.equal(rb.breakdown.laid, 120, '100 own + 20 stuck on');
  assert.equal(rb.breakdown.hand, 10);
  assert.equal(rb.delta, 110);
});

test('the tile you break the chain at must be laid with your own pair', () => {
  const g = setup();
  const p = g.cur();
  g.phase = 'draw';
  g.discard = [T('a', 'red', 2), T('b', 'red', 9), T('c', 'red', 10), T('d', 'red', 11), T('e', 'blue', 3)];
  p.rack = [T('x', 'red', 8), T('y', 'red', 7), T('z', 'blue', 1)];
  p.opened = true;
  g.draw(p.id, 'discard', 1); // takes 9,10,11 red + 3 blue; key = 9 red
  // the chain tiles aren't on the rack yet, so they can't be the pair
  assert.throws(() => g.layKey(p.id, { withTiles: ['c', 'd'] }), /Piesă invalidă/, 'all from the chain');
  assert.throws(() => g.layKey(p.id, { withTiles: ['x'] }), /perechea ta/, 'only one own tile');
  g.layKey(p.id, { withTiles: ['y', 'x'] }); // 7-8 from hand + the 9 from the chain
  assert.equal(g.ts.keyUsed, true);
  g.discardTile(p.id, 'z');
  assert.equal(g.phase, 'draw');
});

test('joker swap is also only allowed from the next turn after opening', () => {
  const g = setup();
  const p = g.cur();
  p.rack = [
    T('A', 'red', 13), T('B', 'blue', 13), T('C', 'yellow', 13), T('D', 'black', 13), // 40
    T('E', 'red', 2), T('F', 'red', 3), T('G', 'red', 4), T('H', 'blue', 5), T('Z', 'black', 9)
  ];
  g.formations.push({ id: 70, owner: 'x', type: 'run', tiles: [T('Q', 'blue', 4), { id: 'J2', joker: true }, T('W', 'blue', 6)] });
  g.lay(p.id, { melds: [['A', 'B', 'C', 'D'], ['E', 'F', 'G']] });
  assert.throws(() => g.swapJoker(p.id, 70, 'H'), /tura următoare/);
  g.turnNo++;
  g.swapJoker(p.id, 70, 'H');
  assert.equal(g.placedBy.H, p.id);
});

test('additions are refused before opening', () => {
  const g = setup();
  const p = g.cur();
  p.rack = [T('A', 'red', 5), T('B', 'red', 6)];
  g.formations.push({ id: 99, owner: 'x', type: 'run', tiles: [T('Q', 'red', 2), T('W', 'red', 3), T('E', 'red', 4)] });
  assert.throws(() => g.lay(p.id, { additions: [{ formationId: 99, tileIds: ['A'] }] }), /Prima dată/);
});

test('cannot lay down your last tile', () => {
  const g = setup();
  const p = g.cur();
  p.rack = [T('A', 'red', 1), T('B', 'blue', 1), T('C', 'yellow', 1), T('D', 'black', 1)];
  assert.throws(() => g.lay(p.id, { melds: [['A', 'B', 'C', 'D']] }), /rămână/);
});

test('atu: bottom tile of the pile, never a joker, drawn last', () => {
  for (let k = 0; k < 30; k++) {
    const g = setup();
    assert.ok(g.atu && !g.atu.joker);
    assert.equal(g.pile[0], g.atu, 'atu sits at the bottom');
    assert.equal(g.multiplier, g.atu.n === 1 ? 2 : 1);
    const v = g.getView('ana');
    assert.equal(v.atu.id, g.atu.id);
    assert.equal(v.atuInPile, true);
  }
});

test('atu bonus goes to whoever holds its twin at the start', () => {
  const g = setup();
  const p = g.cur();
  const other = g.players.find(x => x !== p);
  g.pile[0] = T('ATU', 'blue', 7);
  p.rack = [T('A', 'red', 2), T('B', 'blue', 7)];
  other.rack = [T('C', 'blue', 8)];
  g.turnAtu();
  assert.equal(g.atu.id, 'ATU');
  assert.deepEqual(g.atuBonus, { [p.id]: 50 });
  assert.equal(g.getView('ana').players.find(x => x.id === p.id).atuBonus, 50);
});

test('atu 1 doubles every point of the round, bonus included', () => {
  const g = setup();
  const p = g.cur();
  const other = g.players.find(x => x !== p);
  g.pile[0] = T('ATU', 'red', 1);
  p.rack = [
    T('A', 'red', 13), T('B', 'blue', 13), T('C', 'yellow', 13), T('D', 'black', 13), // 40
    T('E', 'red', 2), T('F', 'red', 3), T('G', 'red', 4),                              // 15
    T('Z', 'red', 1)
  ];
  other.rack = [T('X', 'blue', 5)];
  g.turnAtu();
  assert.equal(g.multiplier, 2);
  assert.equal(g.atuBonus[p.id], 50);
  g.lay(p.id, { melds: [['A', 'B', 'C', 'D'], ['E', 'F', 'G']] }); // 55 points
  other.opened = true;
  g.discardTile(p.id, 'Z');
  const res = g.lastResult.results;
  assert.equal(res.find(r => r.id === p.id).delta, (55 + 50 + 50) * 2, 'laid 55 + closing 50 + atu 50, doubled');
  assert.equal(res.find(r => r.id === other.id).delta, -5 * 2, 'a 5 left in hand costs 5, doubled');
  assert.equal(g.lastResult.multiplier, 2);
});

test('swap a joker off the table', () => {
  const g = setup();
  const p = g.cur();
  p.opened = true;
  p.rack = [T('A', 'red', 5), T('Z', 'blue', 9)];
  g.formations.push({ id: 7, owner: 'x', type: 'run', tiles: [T('Q', 'red', 4), { id: 'J1', joker: true }, T('E', 'red', 6)] });
  assert.throws(() => g.swapJoker(p.id, 7, 'Z'), GameError);
  g.swapJoker(p.id, 7, 'A');
  assert.ok(p.rack.some(t => t.id === 'J1'));
  assert.ok(g.formations[0].tiles.every(t => !t.joker));
});
