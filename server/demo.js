'use strict';
// Demo mode (only loaded when REMI_DEMO=1): builds a 4-player game in the middle of a round,
// so the table can be previewed without playing dozens of turns. Never enable it on the real server.
const crypto = require('crypto');
const R = require('../public/rules.js');
const store = require('./store');

const PEOPLE = [
  ['demo-andrei', 'Andrei'],
  ['demo-bogdan', 'Bogdan'],
  ['demo-cristi', 'Cristi'],
  ['demo-diana', 'Diana']
];

function demoUser(username, displayName) {
  const existing = store.listUsers().find(u => u.username === username);
  if (existing) return store.getUser(existing.id);
  return store.createUser({ username, displayName, password: crypto.randomBytes(12).toString('hex') });
}

module.exports = function installDemo(app, { newGame, broadcast }) {
  app.post('/demo/setup', (req, res) => {
    const users = PEOPLE.map(([u, n]) => demoUser(u, n));
    const game = newGame();
    users.forEach(u => game.addPlayer(u.id));
    game.startRound();

    // Re-deal by hand from a fresh set of tiles.
    const all = R.createTiles();
    const take = (color, n) => {
      const i = all.findIndex(t => (color === 'J' ? t.joker : t.color === color && t.n === n));
      if (i < 0) throw new Error(`demo: no ${color} ${n} left`);
      return all.splice(i, 1)[0];
    };
    const [me, bogdan, cristi, diana] = game.players;
    let fid = 1;
    const form = (owner, type, tiles) => game.formations.push({ id: fid++, owner, type, tiles });

    form(me.id, 'group', [take('red', 7), take('blue', 7), take('black', 7)]);
    form(me.id, 'run', [take('yellow', 9), take('yellow', 10), take('yellow', 11), take('yellow', 12)]);
    me.opened = true;
    me.rack = [
      take('yellow', 3), take('yellow', 4), take('yellow', 5),
      take('red', 10), take('blue', 10), take('black', 10),
      take('red', 2), take('blue', 6), take('black', 12), take('red', 13), take('J')
    ];

    form(bogdan.id, 'run', [take('blue', 9), take('blue', 10), take('blue', 11), take('blue', 12)]);
    form(bogdan.id, 'group', [take('red', 13), take('yellow', 13), take('black', 13)]);
    bogdan.opened = true;
    bogdan.rack = [take('red', 4), take('black', 5), take('yellow', 8), take('blue', 2), take('red', 9), take('black', 1)];

    form(diana.id, 'run', [take('red', 4), take('J'), take('red', 6)]);
    form(diana.id, 'group', [take('red', 1), take('blue', 1), take('yellow', 1)]);
    form(diana.id, 'run', [take('black', 2), take('black', 3), take('black', 4), take('black', 5)]);
    diana.opened = true;
    diana.rack = [take('blue', 8)];

    game.discard = [
      take('yellow', 2), take('blue', 13), take('red', 8), take('black', 9),
      take('yellow', 6), take('blue', 4), take('red', 11), take('yellow', 7), take('black', 6)
    ];
    // Cristi gets random tiles, but only after all the specific ones above are placed,
    // and never the other 12 black (it becomes the atu).
    cristi.opened = false;
    const pool = all.filter(t => !(t.color === 'black' && t.n === 12));
    cristi.rack = Array.from({ length: 14 }, () => pool.splice(crypto.randomInt(pool.length), 1)[0]);
    for (const t of cristi.rack) all.splice(all.indexOf(t), 1);
    game.pile = all.sort(() => Math.random() - 0.5);
    // Turn 12 black as the atu — its twin is in Andrei's rack, so he gets the bonus.
    const ai = game.pile.findIndex(t => t.color === 'black' && t.n === 12);
    [game.pile[0], game.pile[ai]] = [game.pile[ai], game.pile[0]];
    game.turnAtu();
    game.nextFid = fid;
    // every tile on the table scores for the player who laid it; everyone opened in an earlier turn
    game.placedBy = {};
    for (const f of game.formations) for (const t of f.tiles) game.placedBy[t.id] = f.owner;
    for (const p of game.players) p.openedTurn = p.opened ? 0 : null;
    game.turnNo = 9;
    game.turn = 0;
    game.resetTurnState();
    game.enterDraw(); // starts Andrei's 30 seconds
    game.players.forEach((p, i) => { p.score = [120, -35, -100, 60][i]; });
    game.round = 3;
    game.log = [
      '— Runda 3 — începe Andrei.',
      'Atu: 12 negru.',
      'Andrei are atuul în mână: +50 de puncte.',
      'Bogdan s-a etalat cu 82 de puncte.',
      'Diana a adăugat 5 negru la Diana.',
      'Diana a aruncat 7 galben.',
      'Diana este la ultima piesă!',
      'Cristi a tras din grămadă.',
      'Cristi a aruncat 6 negru.'
    ];
    broadcast(game);
    res.json({ code: game.code, tokens: users.map(u => store.createSession(u.id)) });
  });
};
