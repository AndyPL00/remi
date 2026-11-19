// Remi pe tablă — rules engine.
// Shared between the server (authoritative validation) and the browser (live previews).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RemiRules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const COLORS = ['red', 'yellow', 'blue', 'black'];

  // ---- House rules: change these to match how your group plays ----
  const RULES = {
    minPlayers: 2,
    maxPlayers: 4,
    tilesPerPlayer: 14,   // the starting player gets one extra and begins by discarding
    openingMin: 45,       // points needed for the first lay-down (etalare)
    aceAfterKing: true,   // allow 12-13-1 runs
    valueLow: 5,          // tiles 2–9
    valueHigh: 10,        // tiles 10–13
    valueAce: 25,         // the 1 in a group (1-1-1) or left in hand
    aceLowRun: 5,         // the 1 at the start of a run (1-2-3)
    aceHighRun: 10,       // the 1 after 13 (12-13-1)
    jokerValue: 50,       // a joker is worth 50 everywhere: in formations and left in hand
    closeBonus: 50,       // points for the player who closes
    notOpenedPenalty: 100, // penalty for a player who never laid down in the round
    drawSeconds: 30,      // time to take a tile from the pile or the chain
    playSeconds: 60,      // time to play your turn and discard
    atuBonus: 50,         // holding the twin of the turned tile (atu) when the round starts
    aceAtuDoubles: true   // if the atu is a 1, every point of the round is doubled
  };

  function createTiles() {
    const tiles = [];
    const code = { red: 'r', yellow: 'y', blue: 'b', black: 'k' };
    for (const color of COLORS) {
      for (let n = 1; n <= 13; n++) {
        tiles.push({ id: `${code[color]}${n}a`, color, n });
        tiles.push({ id: `${code[color]}${n}b`, color, n });
      }
    }
    tiles.push({ id: 'J1', joker: true }, { id: 'J2', joker: true });
    return tiles;
  }

  const maxRunEnd = () => (RULES.aceAfterKing ? 14 : 13);
  // Point value of a tile by its number: 2–9 = 5, 10–13 = 10, 1 = 25 (groups / in hand).
  const pointValue = n => (n === 1 ? RULES.valueAce : n >= 10 ? RULES.valueHigh : RULES.valueLow);
  // In runs the 1 is worth less: 5 in 1-2-3, 10 after 13. Positions are 1..14 (14 = 1 after 13).
  const runValue = v => (v === 1 ? RULES.aceLowRun : v === 14 ? RULES.aceHighRun : pointValue(v));
  const groupValue = n => pointValue(n);

  // Same number, different colors, 3-4 tiles. Jokers take the missing colors.
  function asGroup(tiles) {
    if (tiles.length < 3 || tiles.length > 4) return null;
    const real = tiles.filter(t => !t.joker);
    if (real.length === 0) return null;
    const n = real[0].n;
    if (!real.every(t => t.n === n)) return null;
    const used = new Set(real.map(t => t.color));
    if (used.size !== real.length) return null;
    const missing = COLORS.filter(c => !used.has(c));
    let mi = 0;
    // pts = what each tile is worth inside this formation
    const arranged = tiles.map(t => ({
      tile: t, n, color: t.joker ? missing[mi++] : t.color,
      pts: t.joker ? RULES.jokerValue : groupValue(n)
    }));
    const value = arranged.reduce((s, a) => s + a.pts, 0);
    return { type: 'group', arranged, value };
  }

  // Same color, consecutive, in exactly the given order (jokers fill their position).
  // Positions are 1..14, where 14 is an ace placed after 13.
  function asRunOrdered(tiles) {
    if (tiles.length < 3) return null;
    const real = tiles.filter(t => !t.joker);
    if (real.length === 0) return null;
    const color = real[0].color;
    if (!real.every(t => t.color === color)) return null;
    const idx = tiles.findIndex(t => !t.joker);
    const first = tiles[idx];
    const candidates = first.n === 1 ? [1, 14] : [first.n];
    for (const fv of candidates) {
      const start = fv - idx;
      const end = start + tiles.length - 1;
      if (start < 1 || end > maxRunEnd()) continue;
      if (start === 1 && end === 14) continue; // cannot contain the ace twice
      let ok = true;
      let value = 0;
      const arranged = tiles.map((t, i) => {
        const v = start + i;
        if (!t.joker) {
          const tv = t.n === 1 && v === 14 ? 14 : t.n;
          if (tv !== v) ok = false;
        }
        const pts = t.joker ? RULES.jokerValue : runValue(v);
        value += pts;
        return { tile: t, color, n: v === 14 ? 1 : v, v, pts };
      });
      if (ok) return { type: 'run', arranged, value };
    }
    return null;
  }

  // Same color run, any order: sorts the tiles and places jokers in gaps, then at the ends.
  function asRunAuto(tiles) {
    if (tiles.length < 3) return null;
    const real = tiles.filter(t => !t.joker);
    const jokers = tiles.filter(t => t.joker);
    if (real.length === 0) return null;
    const color = real[0].color;
    if (!real.every(t => t.color === color)) return null;
    const hasAce = real.some(t => t.n === 1);
    const modes = hasAce && RULES.aceAfterKing ? [false, true] : [false];
    for (const high of modes) {
      const byVal = new Map();
      let dup = false;
      for (const t of real) {
        const v = t.n === 1 && high ? 14 : t.n;
        if (byVal.has(v)) dup = true;
        byVal.set(v, t);
      }
      if (dup) continue;
      const vals = [...byVal.keys()].sort((a, b) => a - b);
      const min = vals[0];
      const max = vals[vals.length - 1];
      const gaps = max - min + 1 - real.length;
      if (gaps > jokers.length) continue;
      const extra = jokers.length - gaps;
      const upper = hasAce && !high ? 13 : maxRunEnd();
      const lower = high ? 2 : 1;
      const after = Math.max(0, Math.min(extra, upper - max));
      const start = min - (extra - after);
      const end = max + after;
      if (start < lower) continue;
      if (start === 1 && end === 14) continue;
      const ordered = [];
      let j = 0;
      for (let v = start; v <= end; v++) ordered.push(byVal.get(v) || jokers[j++]);
      const r = asRunOrdered(ordered);
      if (r) return r;
    }
    return null;
  }

  // Validate a new formation. Returns { type, arranged, value } or null.
  function analyze(tiles) {
    return asGroup(tiles) || asRunOrdered(tiles) || asRunAuto(tiles);
  }

  // Describe a formation already on the table (keeps its stored order and type).
  function describe(formation) {
    const r = formation.type === 'group' ? asGroup(formation.tiles) : asRunOrdered(formation.tiles);
    return r || analyze(formation.tiles);
  }

  // Add tiles to an existing formation. Prefers keeping existing joker meanings.
  function combine(existing, added) {
    const all = [...existing, ...added];
    return asGroup(all) || asRunOrdered(all) || asRunOrdered([...added, ...existing]) || asRunAuto(all);
  }

  // Swap a real tile for a joker in a formation. Returns { result, joker } or null.
  function replaceJoker(formationTiles, tile) {
    if (tile.joker) return null;
    for (let i = 0; i < formationTiles.length; i++) {
      if (!formationTiles[i].joker) continue;
      const copy = formationTiles.slice();
      copy[i] = tile;
      const r = asGroup(copy) || asRunOrdered(copy);
      if (r) return { result: r, joker: formationTiles[i] };
    }
    return null;
  }

  function tilePenalty(t) {
    if (t.joker) return RULES.jokerValue;
    return pointValue(t.n);
  }

  return { COLORS, RULES, createTiles, analyze, describe, combine, replaceJoker, tilePenalty, pointValue };
});
