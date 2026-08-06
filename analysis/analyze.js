/**
 * Aggregate the extracted dataset into the numbers the charts plot.
 *
 * Two deliberate choices:
 *
 * 1. Confidence intervals are a CLUSTER bootstrap over games, not over seat-games.
 *    Seats inside one game are not independent — they accuse each other, so one seat's
 *    hit is another's miss. Resampling seats would understate the interval, which is
 *    the direction that manufactures findings.
 * 2. A model's rows are kept per-ROSTER as well as pooled, because det.lift is a
 *    property of a model in a field (RESULTS 010). The pooled row is only defensible
 *    for the control, whose policy is byte-identical everywhere.
 */
const fs = require('fs');
const path = require('path');

const D = JSON.parse(fs.readFileSync(path.join(__dirname, 'dataset.json'), 'utf8'));

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

// ---- deterministic PRNG so the intervals are reproducible ----
let _s = 20260806;
const rnd = () => {
  _s = (_s * 1664525 + 1013904223) % 4294967296;
  return _s / 4294967296;
};

/** Cluster bootstrap: resample GAME keys, average the model's town seats inside them. */
function bootCI(byGame, iters = 2000) {
  const keys = Object.keys(byGame);
  if (keys.length < 2) return [null, null];
  const means = [];
  for (let i = 0; i < iters; i++) {
    const vals = [];
    for (let k = 0; k < keys.length; k++) {
      vals.push(...byGame[keys[Math.floor(rnd() * keys.length)]]);
    }
    if (vals.length) means.push(mean(vals));
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(means.length * 0.025)], means[Math.floor(means.length * 0.975)]];
}

// ---------- 1. per-model pooled rows ----------
const models = [...new Set(D.seatGames.map((r) => r.model))];
const rows = [];

for (const m of models) {
  const seats = D.seatGames.filter((r) => r.model === m);
  const town = seats.filter((r) => r.faction === 'town' && r.detectionLift !== null && r.suspicionCalls > 0);
  const byGame = {};
  for (const r of town) {
    const k = r.session + '#' + r.game;
    (byGame[k] = byGame[k] || []).push(r.detectionLift);
  }
  const lifts = town.map((r) => r.detectionLift);
  const [lo, hi] = bootCI(byGame);

  const calib = seats.map((r) => r.calibrationGap).filter((v) => v !== null && v !== undefined);
  const invalidWeighted =
    seats.reduce((a, r) => a + (r.invalidMoveRate || 0) * (r.calls || 0), 0) /
    Math.max(1, seats.reduce((a, r) => a + (r.calls || 0), 0));

  rows.push({
    model: m,
    tier: seats[0].tier,
    isControl: m === 'rule-based-v1',
    nTownSeats: town.length,
    nGames: Object.keys(byGame).length,
    nRosters: new Set(seats.map((r) => r.roster)).size,
    detLift: mean(lifts),
    ciLo: lo,
    ciHi: hi,
    perGameLifts: Object.values(byGame).map((v) => mean(v)),
    calib: mean(calib),
    invalid: invalidWeighted,
    calls: seats.reduce((a, r) => a + (r.calls || 0), 0),
    namedDead: seats.reduce((a, r) => a + (r.namedDeadPlayer || 0), 0),
    avgLatency: mean(seats.filter((r) => r.avgLatencyMs > 0).map((r) => r.avgLatencyMs)),
  });
}
rows.sort((a, b) => (b.detLift ?? -9) - (a.detLift ?? -9));

// ---------- 2. the control, batch by batch (the variance argument) ----------
const ctlBySession = {};
for (const r of D.seatGames.filter((r) => r.model === 'rule-based-v1' && r.detectionLift !== null && r.suspicionCalls > 0)) {
  const k = r.session;
  (ctlBySession[k] = ctlBySession[k] || []).push(r.detectionLift);
}
const controlBatches = Object.entries(ctlBySession)
  .map(([s, v]) => ({ session: s, label: s.slice(8, 24), n: v.length, lift: mean(v), games: new Set(D.seatGames.filter(r=>r.session===s).map(r=>r.game)).size }))
  .filter((b) => b.n >= 6)
  .sort((a, b) => a.lift - b.lift);

// ---------- 3. outcomes ----------
const bySeats = {};
for (const g of D.games) {
  const k = g.seats;
  (bySeats[k] = bySeats[k] || { seats: g.seats, n: 0, town: 0, days: [] });
  bySeats[k].n++;
  if (g.winner === 'town') bySeats[k].town++;
  bySeats[k].days.push(g.days);
}
const outcomes = Object.values(bySeats).map((o) => ({
  seats: o.seats, n: o.n, townWins: o.town, townRate: o.town / o.n, meanDays: mean(o.days),
})).sort((a, b) => a.seats - b.seats);

// ---------- 4. detection by day and by pool size ----------
const byDay = {};
for (const t of D.townTurns) {
  const k = t.day;
  (byDay[k] = byDay[k] || { day: t.day, n: 0, hits: 0, chance: 0 });
  byDay[k].n++;
  byDay[k].hits += t.hit;
  byDay[k].chance += t.chance;
}
const dayRows = Object.values(byDay)
  .filter((d) => d.n >= 30)
  .map((d) => ({ day: d.day, n: d.n, acc: d.hits / d.n, chance: d.chance / d.n, lift: d.hits / d.n - d.chance / d.n }))
  .sort((a, b) => a.day - b.day);

const byPool = {};
for (const t of D.townTurns) {
  const k = t.poolSize;
  (byPool[k] = byPool[k] || { pool: k, n: 0, hits: 0, chance: 0 });
  byPool[k].n++; byPool[k].hits += t.hit; byPool[k].chance += t.chance;
}
const poolRows = Object.values(byPool)
  .filter((d) => d.n >= 30)
  .map((d) => ({ pool: d.pool, n: d.n, acc: d.hits / d.n, chance: d.chance / d.n, lift: d.hits / d.n - d.chance / d.n }))
  .sort((a, b) => a.pool - b.pool);

// ---------- 5. defense phase, counted per defense ----------
const dRows = D.defenses;
const defBy = (f) => {
  const v = dRows.filter(f);
  return { n: v.length, survived: v.filter((d) => d.survived).length,
           rate: v.length ? v.filter((d) => d.survived).length / v.length : null };
};
const defense = {
  games: new Set(dRows.map((d) => d.session + '#' + d.game)).size,
  all: defBy(() => true),
  mafia: defBy((d) => d.faction === 'mafia'),
  town: defBy((d) => d.faction === 'town'),
  scripted: defBy((d) => d.model === 'rule-based-v1'),
  model: defBy((d) => d.model !== 'rule-based-v1'),
  meanWords: mean(dRows.map((d) => d.words)),
};

// ---------- 6. confidence vs correctness (calibration, per turn) ----------
const confBuckets = [];
for (let b = 0; b < 5; b++) {
  const lo = b * 0.2, hi = lo + 0.2;
  const ts = D.townTurns.filter((t) => t.confidence >= lo && t.confidence < (b === 4 ? 1.01 : hi));
  if (ts.length >= 30) {
    confBuckets.push({
      lo, hi, n: ts.length,
      acc: mean(ts.map((t) => t.hit)),
      chance: mean(ts.map((t) => t.chance)),
      lift: mean(ts.map((t) => t.hit - t.chance)),
    });
  }
}

const summary = { rows, controlBatches, outcomes, dayRows, poolRows, defense, confBuckets,
  totals: { games: D.games.length, seatGames: D.seatGames.length, townTurns: D.townTurns.length,
            sessions: new Set(D.games.map(g=>g.session)).size } };

fs.writeFileSync(path.join(__dirname, 'summary.json'), JSON.stringify(summary, null, 1));

// ---- console report ----
console.log('TOTALS', JSON.stringify(summary.totals));
console.log('\nMODEL ROWS (det.lift, cluster-bootstrap 95% CI over games)');
for (const r of rows) {
  console.log(
    (r.model + (r.isControl ? ' *' : '')).padEnd(24),
    'n=' + String(r.nTownSeats).padStart(4),
    'g=' + String(r.nGames).padStart(3),
    'rosters=' + r.nRosters,
    'lift=' + (r.detLift === null ? '  n/a ' : (r.detLift >= 0 ? '+' : '') + r.detLift.toFixed(3)),
    r.ciLo === null ? '' : '[' + (r.ciLo >= 0 ? '+' : '') + r.ciLo.toFixed(3) + ',' + (r.ciHi >= 0 ? '+' : '') + r.ciHi.toFixed(3) + ']',
    'inv=' + r.invalid.toFixed(3),
    'calib=' + (r.calib === null ? 'n/a' : (r.calib >= 0 ? '+' : '') + r.calib.toFixed(3))
  );
}
console.log('\nCONTROL BY BATCH');
for (const b of controlBatches) console.log(' ', b.label, 'seats=' + b.n, 'games=' + b.games, 'lift=' + (b.lift >= 0 ? '+' : '') + b.lift.toFixed(3));
console.log('\nOUTCOMES'); console.log(JSON.stringify(outcomes, null, 1));
console.log('\nBY DAY'); for (const d of dayRows) console.log('  day', d.day, 'n=' + d.n, 'acc=' + d.acc.toFixed(3), 'chance=' + d.chance.toFixed(3), 'lift=' + (d.lift>=0?'+':'') + d.lift.toFixed(3));
console.log('\nBY POOL'); for (const d of poolRows) console.log('  pool', d.pool, 'n=' + d.n, 'lift=' + (d.lift>=0?'+':'') + d.lift.toFixed(3));
console.log('\nDEFENSE'); console.log(JSON.stringify(defense,null,1));
console.log('\nCONFIDENCE BUCKETS'); for (const c of confBuckets) console.log('  ', c.lo.toFixed(1)+'-'+c.hi.toFixed(1), 'n='+c.n, 'acc='+c.acc.toFixed(3), 'chance='+c.chance.toFixed(3), 'lift='+(c.lift>=0?'+':'')+c.lift.toFixed(3));
