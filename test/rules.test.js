const test = require('node:test');
const assert = require('node:assert');
const R = require('../public/rules.js');

const t = (color, n, c = 'a') => ({ id: `${color[0]}${n}${c}`, color, n });
const J = (id = 'J1') => ({ id, joker: true });

test('tile point values: 2–9 = 5, 10–13 = 10, 1 = 25', () => {
  assert.equal(R.pointValue(2), 5);
  assert.equal(R.pointValue(9), 5);
  assert.equal(R.pointValue(10), 10);
  assert.equal(R.pointValue(13), 10);
  assert.equal(R.pointValue(1), 25);
  assert.equal(R.tilePenalty(J()), 50);
});

test('groups', () => {
  assert.equal(R.analyze([t('red', 7), t('blue', 7), t('black', 7)]).type, 'group');
  assert.equal(R.analyze([t('red', 7), t('blue', 7), t('black', 7)]).value, 15);
  assert.equal(R.analyze([t('red', 12), t('blue', 12), t('black', 12), t('yellow', 12)]).value, 40);
  assert.equal(R.analyze([t('red', 7), t('red', 7, 'b'), t('black', 7)]), null, 'duplicate color');
  assert.equal(R.analyze([t('red', 7), t('blue', 7), t('black', 7), t('yellow', 7), J()]), null, 'max 4');
  assert.equal(R.analyze([t('red', 7), J(), t('black', 7)]).value, 60, 'joker counts 50 in a group');
  assert.equal(R.analyze([t('red', 1), t('blue', 1), t('black', 1)]).value, 75, '1 in 1-1-1 counts 25');
});

test('runs', () => {
  const r = R.analyze([t('red', 3), t('red', 4), t('red', 5)]);
  assert.equal(r.type, 'run');
  assert.equal(r.value, 15, '3-4-5 = 5+5+5');
  assert.equal(R.analyze([t('red', 5), t('red', 3), t('red', 4)]).type, 'run', 'any order');
  assert.equal(R.analyze([t('red', 3), t('blue', 4), t('red', 5)]), null, 'mixed colors');
  assert.equal(R.analyze([t('red', 3), t('red', 5), t('red', 6)]), null, 'gap');
  assert.equal(R.analyze([t('red', 9), t('red', 10), t('red', 11)]).value, 25, '5+10+10');
  assert.equal(R.analyze([t('red', 1), t('red', 2), t('red', 3)]).value, 15, '1 in 1-2-3 counts 5');
  assert.equal(R.analyze([t('red', 12), t('red', 13), t('red', 1)]).value, 30, '1 after 13 counts 10');
  assert.equal(R.analyze([t('red', 10), t('red', 11), t('red', 12), t('red', 13), t('red', 1)]).value, 50);
  assert.equal(R.analyze([t('red', 13), t('red', 1), t('red', 2)]), null, 'no wrap');
});

test('runs with jokers', () => {
  const r = R.analyze([t('blue', 5), J(), t('blue', 7)]);
  assert.equal(r.arranged[1].n, 6);
  assert.equal(r.value, 60, '5 + joker 50 + 5');
  const ordered = R.analyze([J(), t('blue', 6), t('blue', 7)]);
  assert.equal(ordered.arranged[0].n, 5, 'joker keeps the position the player gave it');
  const end = R.analyze([t('blue', 12), t('blue', 13), J()]);
  assert.equal(end.arranged[2].n, 1);
  assert.equal(end.value, 70, 'joker counts 50 even as the 1 after 13');
  assert.equal(R.analyze([J(), t('blue', 2), t('blue', 3)]).value, 60);
  assert.equal(R.analyze([t('red', 1), t('blue', 1), J()]).value, 100, 'joker counts 50 in 1-1-1');
});

test('combine and replace joker', () => {
  const run = [t('red', 4), t('red', 5), t('red', 6)];
  assert.ok(R.combine(run, [t('red', 7)]));
  assert.ok(R.combine(run, [t('red', 3)]));
  assert.equal(R.combine(run, [t('red', 9)]), null);
  const grp = [t('red', 9), t('blue', 9), t('black', 9)];
  assert.ok(R.combine(grp, [t('yellow', 9)]));
  assert.equal(R.combine(grp, [t('red', 9, 'b')]), null);

  const withJ = [t('red', 4), J(), t('red', 6)];
  const sw = R.replaceJoker(withJ, t('red', 5));
  assert.ok(sw);
  assert.equal(sw.joker.id, 'J1');
  assert.equal(R.replaceJoker(withJ, t('red', 7)), null);
});
