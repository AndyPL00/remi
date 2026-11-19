'use strict';
const crypto = require('crypto');
const R = require('../public/rules.js');

class GameError extends Error {}
const fail = msg => { throw new GameError(msg); };

const COLOR_RO = { red: 'roșu', yellow: 'galben', blue: 'albastru', black: 'negru' };
const label = t => (t.joker ? 'Joker' : `${t.n} ${COLOR_RO[t.color]}`);

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Players are identified by their account (user) id.
// Phases: 'lobby' -> ('draw' <-> 'play')* -> 'roundOver' -> ...
class Game {
  constructor(code, hooks = {}) {
    this.code = code;
    this.hooks = {
      profile: hooks.profile || (id => ({ id, name: id, avatar: null })),
      connected: hooks.connected || (() => true),
      roundEnd: hooks.roundEnd || null, // called with the round result (lifetime stats)
      changed: hooks.changed || null    // called after an automatic move (timer), to broadcast
    };
    this.players = [];
    this.hostId = null;
    this.phase = 'lobby';
    this.round = 0;
    this.dealer = -1;
    this.pile = [];
    this.discard = []; // the chain of discarded tiles, oldest first
    this.formations = [];
    this.turn = 0;
    this.ts = null;
    this.log = [];
    this.lastResult = null;
    this.nextFid = 1;
  }

  name(id) {
    return this.hooks.profile(id).name;
  }

  addLog(msg) {
    this.log.push(msg);
    if (this.log.length > 60) this.log.shift();
  }

  hasPlayer(id) {
    return this.players.some(p => p.id === id);
  }

  addPlayer(id) {
    if (this.hasPlayer(id)) return;
    if (this.phase !== 'lobby') fail('Jocul a început deja în această cameră.');
    if (this.players.length >= R.RULES.maxPlayers) fail('Camera este plină.');
    this.players.push({ id, rack: [], opened: false, score: 0 });
    if (!this.hostId) this.hostId = id;
    this.addLog(`${this.name(id)} a intrat în cameră.`);
  }

  // Only used in the lobby (before the game starts).
  removePlayer(id) {
    const i = this.players.findIndex(p => p.id === id);
    if (i < 0 || this.phase !== 'lobby') return;
    this.players.splice(i, 1);
    this.addLog(`${this.name(id)} a ieșit.`);
    if (this.hostId === id) this.hostId = this.players[0] ? this.players[0].id : null;
  }

  start(pid) {
    if (pid !== this.hostId) fail('Doar gazda poate porni jocul.');
    if (this.phase !== 'lobby') fail('Jocul a început deja.');
    if (this.players.length < R.RULES.minPlayers) fail(`Este nevoie de cel puțin ${R.RULES.minPlayers} jucători.`);
    this.startRound();
  }

  nextRound(pid) {
    if (pid !== this.hostId) fail('Doar gazda poate porni runda următoare.');
    if (this.phase !== 'roundOver') fail('Runda nu s-a terminat.');
    this.startRound();
  }

  startRound() {
    this.round++;
    const n = this.players.length;
    this.dealer = (this.dealer + 1) % n;
    this.pile = shuffle(R.createTiles());
    this.discard = [];
    this.formations = [];
    this.lastResult = null;
    for (const p of this.players) {
      p.rack = this.pile.splice(0, R.RULES.tilesPerPlayer);
      p.opened = false;
      p.openedTurn = null;
    }
    this.placedBy = {}; // tile id -> player who put it on the table (for scoring)
    this.turnNo = 1;    // counts turns in the round
    this.turn = (this.dealer + 1) % n;
    this.cur().rack.push(this.pile.pop());
    this.phase = 'play'; // the starting player skips the draw and discards first
    this.resetTurnState();
    this.addLog(`— Runda ${this.round} — începe ${this.name(this.cur().id)}.`);
    this.turnAtu();
    this.enterPlay(); // the starting player has the play time to discard
  }

  // ---------- turn timers ----------
  // draw phase: drawSeconds to take a tile; play phase: playSeconds to play and discard.
  // The play deadline is set once per turn, so taking from the chain and putting it back
  // ("Pune înapoi") never buys extra time.
  setDeadline(at) {
    clearTimeout(this.timer);
    this.deadline = at;
    const ms = Math.max(0, at - Date.now());
    this.timer = setTimeout(() => this.onTimeout(), ms);
    if (this.timer.unref) this.timer.unref();
  }

  stopTimer() {
    clearTimeout(this.timer);
    this.timer = null;
    this.deadline = null;
  }

  // Nobody connected: don't let the timer play the game on its own.
  pauseTimer() {
    if (this.phase !== 'draw' && this.phase !== 'play') return;
    clearTimeout(this.timer);
    this.timer = null;
    this.paused = true;
  }

  // Someone is back: the current player gets fresh time for the phase they're in.
  resumeTimer() {
    if (!this.paused) return;
    this.paused = false;
    if (this.phase === 'draw') {
      if (this.ts.playDeadline) this.ts.playDeadline = Date.now() + R.RULES.playSeconds * 1000;
      this.setDeadline(this.ts.playDeadline || Date.now() + R.RULES.drawSeconds * 1000);
    } else if (this.phase === 'play') {
      this.ts.playDeadline = Date.now() + R.RULES.playSeconds * 1000;
      this.setDeadline(this.ts.playDeadline);
    }
  }

  enterDraw() {
    this.phase = 'draw';
    this.setDeadline(this.ts.playDeadline || Date.now() + R.RULES.drawSeconds * 1000);
  }

  enterPlay() {
    this.phase = 'play';
    if (!this.ts.playDeadline) this.ts.playDeadline = Date.now() + R.RULES.playSeconds * 1000;
    this.setDeadline(this.ts.playDeadline);
  }

  onTimeout() {
    if (this.phase !== 'draw' && this.phase !== 'play') return;
    try {
      const p = this.cur();
      if (this.phase === 'draw') {
        this.addLog(`${this.name(p.id)} n-a tras la timp — a primit automat o piesă din grămadă.`);
        this.draw(p.id, 'pile');
      }
      // play time over (or already over after "Pune înapoi"): finish the turn automatically
      if (this.phase === 'play' && Date.now() >= this.ts.playDeadline - 50) this.autoFinish(p);
    } catch (e) {
      console.error(e);
    }
    if (this.hooks.changed) this.hooks.changed();
  }

  // Time's up in the play phase: give back an unplaced chain break (and draw from the pile instead),
  // then discard the tile drawn this turn, or else the most expensive tile (never a joker if possible).
  autoFinish(p) {
    const t = this.ts.taken;
    if (t && !this.ts.keyUsed) {
      this.discard.push(t.keyTile, ...t.rest);
      this.ts.taken = null;
      if (this.pile.length) {
        const tile = this.pile.pop();
        p.rack.push(tile);
        this.ts.drawnId = tile.id;
      }
    }
    let pick = p.rack.find(x => x.id === this.ts.drawnId);
    if (!pick) {
      const real = p.rack.filter(x => !x.joker);
      const pool = real.length ? real : p.rack;
      pick = pool.reduce((a, b) => (R.tilePenalty(b) > R.tilePenalty(a) ? b : a));
    }
    this.addLog(`Timpul lui ${this.name(p.id)} a expirat — a aruncat automat ${label(pick)}.`);
    this.discardTile(p.id, pick.id);
  }

  // The bottom tile of the pile is turned face up (atu). It is drawn last.
  // Whoever holds its twin at the start gets a bonus; a 1 doubles the whole round.
  turnAtu() {
    let i = this.pile.findIndex(t => !t.joker);
    [this.pile[0], this.pile[i]] = [this.pile[i], this.pile[0]]; // the atu is never a joker
    this.atu = this.pile[0];
    this.multiplier = R.RULES.aceAtuDoubles && this.atu.n === 1 ? 2 : 1;
    this.atuBonus = {};
    this.addLog(`Atu: ${label(this.atu)}.`);
    if (this.multiplier === 2) this.addLog('Atuul este 1 — toate punctele rundei se dublează!');
    for (const p of this.players) {
      if (p.rack.some(t => !t.joker && t.color === this.atu.color && t.n === this.atu.n)) {
        this.atuBonus[p.id] = R.RULES.atuBonus;
        this.addLog(`${this.name(p.id)} are atuul în mână: +${R.RULES.atuBonus} de puncte.`);
      }
    }
  }

  resetTurnState() {
    // taken: the chain was broken this turn. keyTile (the one you broke at) is held aside until
    // it is laid down with your own pair; rest (the tiles after it) join the rack only then.
    // drawnId: tile drawn from the pile this turn; playDeadline: when this turn's play time ends.
    this.ts = { taken: null, keyUsed: false, drawnId: null, playDeadline: null };
  }

  cur() {
    return this.players[this.turn];
  }

  pendingKey() {
    return this.ts.taken && !this.ts.keyUsed ? this.ts.taken.keyId : null;
  }

  assertTurn(pid, phase) {
    if (this.phase !== 'draw' && this.phase !== 'play') fail('Nu se joacă acum.');
    if (this.cur().id !== pid) fail('Nu este rândul tău.');
    if (phase && this.phase !== phase) {
      fail(phase === 'draw' ? 'Ai tras deja o piesă tura asta.' : 'Trebuie să tragi întâi o piesă.');
    }
    return this.cur();
  }

  // source: 'pile', or 'discard' with index = position in the chain to break it at.
  draw(pid, source, index) {
    const p = this.assertTurn(pid, 'draw');
    if (source === 'discard') {
      // The first tile of the chain lies sideways and can never be taken.
      if (this.discard.length < 2) fail('Prima piesă din lanț nu se poate lua.');
      const i = index === undefined || index === null ? this.discard.length - 1 : Number(index);
      if (i === 0) fail('Prima piesă din lanț nu se poate lua.');
      if (!Number.isInteger(i) || i < 1 || i >= this.discard.length) fail('Poziție invalidă în aruncate.');
      const taken = this.discard.splice(i);
      // Nothing goes to the rack yet: the broken-at tile must be laid down first.
      this.ts.taken = { keyId: taken[0].id, keyTile: taken[0], rest: taken.slice(1), ids: taken.map(t => t.id) };
      this.ts.keyUsed = false;
      this.addLog(taken.length === 1
        ? `${this.name(p.id)} a luat ${label(taken[0])} din aruncate.`
        : `${this.name(p.id)} a rupt lanțul de la ${label(taken[0])} și a luat ${taken.length} piese.`);
    } else {
      if (this.pile.length === 0) {
        this.addLog('Grămada s-a terminat — runda se încheie fără câștigător.');
        this.endRound(null);
        return;
      }
      const tile = this.pile.pop();
      p.rack.push(tile);
      this.ts.drawnId = tile.id;
      this.addLog(`${this.name(p.id)} a tras din grămadă.`);
    }
    this.enterPlay();
  }

  // Put the tiles taken from the chain back (only before the broken-at tile is laid).
  undoTake(pid) {
    this.assertTurn(pid, 'play');
    const t = this.ts.taken;
    if (!t || this.ts.keyUsed) fail('Nu ai piese de pus înapoi.');
    this.discard.push(t.keyTile, ...t.rest);
    this.ts.taken = null;
    this.ts.keyUsed = false;
    this.enterDraw(); // keeps this turn's play deadline: no extra time
    this.addLog(`${this.name(pid)} a pus piesele înapoi în aruncate.`);
  }

  // Lay the tile you broke the chain at, together with your own pair (withTiles, from the rack).
  // It goes down on the table immediately; then the rest of the chain joins your rack.
  // If you haven't opened yet, `melds` can add your other formations to reach the opening minimum.
  layKey(pid, { withTiles, melds } = {}) {
    const p = this.assertTurn(pid, 'play');
    const t = this.ts.taken;
    if (!t || this.ts.keyUsed) fail('Nu ai nicio piesă luată din lanț de pus.');
    withTiles = Array.isArray(withTiles) ? withTiles : [];
    if (withTiles.length < 2) {
      fail('Piesa de la care ai rupt lanțul trebuie etalată împreună cu perechea ta din mână (minim 2 piese pe care le aveai deja).');
    }
    const extra = Array.isArray(melds) ? melds : [];
    const before = p.rack;
    p.rack = [...before, t.keyTile];
    try {
      this.layInternal(p, [[...withTiles, t.keyId], ...extra], [], t.rest.length);
    } catch (e) {
      p.rack = before; // validation failed before anything was applied: just take the key back out
      throw e;
    }
    this.ts.keyUsed = true;
    p.rack.push(...t.rest);
  }

  lay(pid, { melds, additions } = {}) {
    const p = this.assertTurn(pid, 'play');
    if (this.pendingKey()) fail('Mai întâi trage piesa de la care ai rupt lanțul peste perechea ta de pe tablă.');
    this.layInternal(p, melds, additions);
  }

  layInternal(p, melds, additions, incoming = 0) {
    melds = Array.isArray(melds) ? melds : [];
    additions = Array.isArray(additions) ? additions : [];
    if (!melds.length && !additions.length) fail('Nu ai pus nicio piesă.');

    const rackMap = new Map(p.rack.map(t => [t.id, t]));
    const used = new Set();
    const take = id => {
      if (typeof id !== 'string' || !rackMap.has(id)) fail('Piesă invalidă.');
      if (used.has(id)) fail('Ai folosit aceeași piesă de două ori.');
      used.add(id);
      return rackMap.get(id);
    };

    const newForms = [];
    let total = 0;
    for (const m of melds) {
      if (!Array.isArray(m)) fail('Formație invalidă.');
      const tiles = m.map(take);
      const r = R.analyze(tiles);
      if (!r) fail(`Formație invalidă: ${tiles.map(label).join(', ')}.`);
      newForms.push(r);
      total += r.value;
    }
    if (!p.opened) {
      if (additions.length) fail(`Prima dată te etalezi doar cu formațiile tale (minim ${R.RULES.openingMin} de puncte). Poți lipi piese abia din tura următoare.`);
      if (total < R.RULES.openingMin) fail(`Pentru etalare ai nevoie de minim ${R.RULES.openingMin} de puncte (ai ${total}).`);
    } else if (additions.length && p.openedTurn === this.turnNo) {
      fail('Poți lipi piese la formații abia din tura următoare după ce te-ai etalat.');
    }

    const byForm = new Map();
    for (const a of additions) {
      const f = this.formations.find(x => x.id === Number(a && a.formationId));
      if (!f) fail('Formația nu mai există.');
      if (!Array.isArray(a.tileIds) || !a.tileIds.length) continue;
      const list = byForm.get(f) || [];
      list.push(...a.tileIds.map(take));
      byForm.set(f, list);
    }
    const updates = [];
    for (const [f, list] of byForm) {
      const r = R.combine(f.tiles, list);
      if (!r) fail(`${list.map(label).join(', ')} nu se potrivește în formația aceea.`);
      updates.push([f, r]);
    }

    // (incoming = chain tiles that join the rack right after the broken-at tile is laid)
    if (p.rack.length - used.size + incoming < 1) fail('Trebuie să-ți rămână o piesă ca să închizi aruncând-o.');

    // Everything valid — apply.
    p.rack = p.rack.filter(t => !used.has(t.id));
    for (const r of newForms) {
      this.formations.push({ id: this.nextFid++, owner: p.id, type: r.type, tiles: r.arranged.map(a => a.tile) });
    }
    for (const [f, r] of updates) {
      f.tiles = r.arranged.map(a => a.tile);
      f.type = r.type;
    }
    const who = this.name(p.id);
    if (!p.opened) this.addLog(`${who} s-a etalat cu ${total} de puncte.`);
    else if (newForms.length) this.addLog(`${who} a etalat ${newForms.length === 1 ? 'o formație nouă' : `${newForms.length} formații noi`}.`);
    for (const [f, list] of byForm) this.addLog(`${who} a adăugat ${list.map(label).join(', ')} la ${this.name(f.owner)}.`);
    for (const id of used) this.placedBy[id] = p.id; // these tiles score for this player
    if (!p.opened) p.openedTurn = this.turnNo;
    p.opened = true;
  }

  swapJoker(pid, formationId, tileId) {
    const p = this.assertTurn(pid, 'play');
    if (!p.opened) fail('Trebuie să fii etalat ca să iei un joker de pe masă.');
    if (p.openedTurn === this.turnNo) fail('Poți lipi piese (și lua jokeri) abia din tura următoare după ce te-ai etalat.');
    if (this.pendingKey()) fail('Mai întâi trage piesa de la care ai rupt lanțul peste perechea ta de pe tablă.');
    const f = this.formations.find(x => x.id === Number(formationId));
    if (!f) fail('Formația nu mai există.');
    const tile = p.rack.find(t => t.id === tileId);
    if (!tile || tile.joker) fail('Piesă invalidă.');
    const res = R.replaceJoker(f.tiles, tile);
    if (!res) fail(`${label(tile)} nu poate înlocui jokerul din această formație.`);
    p.rack = p.rack.filter(t => t.id !== tileId);
    p.rack.push(res.joker);
    this.placedBy[tileId] = p.id;      // the real tile now scores for the player who placed it
    delete this.placedBy[res.joker.id]; // the joker is back in a hand
    f.tiles = res.result.arranged.map(a => a.tile);
    f.type = res.result.type;
    this.addLog(`${this.name(p.id)} a luat un joker de pe masă, înlocuindu-l cu ${label(tile)}.`);
  }

  discardTile(pid, tileId) {
    const p = this.assertTurn(pid, 'play');
    const idx = p.rack.findIndex(t => t.id === tileId);
    if (idx < 0) fail('Piesă invalidă.');
    if (this.pendingKey()) {
      fail(`Trebuie să etalezi ${label(this.ts.taken.keyTile)} (piesa de la care ai rupt lanțul) cu perechea ta, sau apasă „Pune înapoi”.`);
    }
    const [t] = p.rack.splice(idx, 1);
    this.discard.push(t);
    this.addLog(`${this.name(p.id)} a aruncat ${label(t)}.`);
    if (p.rack.length === 0) {
      this.addLog(`${this.name(p.id)} a închis!`);
      this.endRound(p);
      return;
    }
    if (p.rack.length === 1) this.addLog(`${this.name(p.id)} este la ultima piesă!`);
    this.turn = (this.turn + 1) % this.players.length;
    this.turnNo++;
    this.resetTurnState();
    this.enterDraw();
  }

  // Points each player has on the table: every tile counts for whoever placed it,
  // valued inside its formation (so a 1 is 25 / 5 / 10 depending on where it sits).
  laidPoints() {
    const laid = {};
    for (const f of this.formations) {
      for (const a of R.describe(f).arranged) {
        const who = this.placedBy[a.tile.id];
        if (who) laid[who] = (laid[who] || 0) + a.pts;
      }
    }
    return laid;
  }

  // Round score = points laid on the table − tiles left in hand
  //   + closing bonus (for whoever closed) + atu bonus, all × 2 if the atu is a 1.
  // A player who never laid down loses a flat penalty instead.
  endRound(winner) {
    this.phase = 'roundOver';
    this.stopTimer();
    const mult = this.multiplier || 1;
    const laidAll = this.laidPoints();
    const results = this.players.map(p => {
      const laid = laidAll[p.id] || 0;
      const hand = p.rack.reduce((s, t) => s + R.tilePenalty(t), 0);
      const close = winner && p.id === winner.id ? R.RULES.closeBonus : 0;
      const atu = (this.atuBonus && this.atuBonus[p.id]) || 0;
      const base = p.opened ? laid - hand + close : -R.RULES.notOpenedPenalty;
      const delta = (base + atu) * mult;
      p.score += delta;
      return {
        id: p.id, delta, score: p.score, rack: p.rack.slice(), opened: p.opened,
        breakdown: { laid, hand, close, atu, notOpened: !p.opened, mult }
      };
    });
    this.lastResult = { winnerId: winner ? winner.id : null, results, multiplier: mult, atu: this.atu };
    try { this.hooks.roundEnd && this.hooks.roundEnd(this.lastResult); } catch (e) { console.error(e); }
  }

  getView(pid) {
    const me = this.players.find(p => p.id === pid);
    const playing = this.phase === 'draw' || this.phase === 'play';
    const myTurn = playing && this.cur().id === pid;
    const laid = playing ? this.laidPoints() : {};
    return {
      code: this.code,
      phase: this.phase,
      round: this.round,
      hostId: this.hostId,
      myId: pid,
      players: this.players.map((p, i) => ({
        ...this.hooks.profile(p.id),
        id: p.id,
        opened: p.opened,
        score: p.score,
        connected: this.hooks.connected(p.id),
        isTurn: playing && i === this.turn,
        lastTile: playing && p.rack.length === 1, // tile counts stay hidden otherwise
        atuBonus: (this.atuBonus && this.atuBonus[p.id]) || 0,
        laid: laid[p.id] || 0 // points this player has on the table so far
      })),
      deadline: playing ? this.deadline : null, // when the current player's time runs out (server ms)
      now: Date.now(),                           // lets the browser correct for clock differences
      atu: this.atu || null,
      atuInPile: !!this.atu && this.pile[0] === this.atu,
      multiplier: this.multiplier || 1,
      me: me ? {
        rack: me.rack,
        opened: me.opened,
        canAdd: me.opened && me.openedTurn !== this.turnNo // may stick tiles onto formations
      } : null,
      formations: this.formations.map(f => {
        const d = R.describe(f);
        return { id: f.id, owner: f.owner, arranged: d.arranged.map(a => ({ tile: a.tile, n: a.n, color: a.color })) };
      }),
      pileCount: this.pile.length,
      discard: this.discard,
      myTurn,
      taken: myTurn && this.ts.taken ? { ...this.ts.taken, keyUsed: this.ts.keyUsed } : null,
      log: this.log.slice(-40),
      lastResult: this.lastResult && {
        ...this.lastResult,
        results: this.lastResult.results.map(r => ({ ...r, ...this.hooks.profile(r.id), id: r.id }))
      },
      rules: R.RULES
    };
  }
}

module.exports = { Game, GameError };
