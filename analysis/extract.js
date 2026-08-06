/**
 * Extract a flat analysis dataset from every finished game in logs/.
 *
 * Why not reuse report.js: that one summarises the NEWEST session. These charts need
 * every game across every batch at once, and per-GAME values rather than batch means —
 * a batch mean cannot show the spread that the whole argument rests on.
 */
const fs = require('fs');
const path = require('path');

// Repo-relative: this script lives in analysis/, so logs/ is one level up.
const ROOT = path.join(__dirname, '..', 'logs');

const sessions = fs.readdirSync(ROOT).filter((d) => d.startsWith('session-')).sort();

const games = [];      // one row per game
const seatGames = [];  // one row per (game, seat)
const townTurns = [];  // one row per town accusation
const defenses = [];   // one row per defense, resolved against the execution

for (const s of sessions) {
  const dir = path.join(ROOT, s);
  const files = fs.readdirSync(dir).filter((f) => /^game-\d+\.json$/.test(f)).sort();
  if (!files.length) continue;

  for (const f of files) {
    let g;
    try { g = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    if (!g.metrics || !g.snapshot) continue;

    const players = g.snapshot.players || [];
    const defenseEntries = (g.snapshot.publicLog || []).filter((e) => String(e.type) === 'defense');
    const roster = [...new Set(players.map((p) => p.model))].sort().join('|');

    games.push({
      session: s,
      game: g.game,
      seed: g.metrics.outcome?.seed,
      winner: g.outcome?.winner,
      reason: g.outcome?.reason,
      days: g.outcome?.days,
      seats: players.length,
      roster,
      defenseOn: defenseEntries.length > 0,
      defenses: g.metrics.defenses || null,
      townDetectionLift: g.metrics.factions?.town?.detectionLift ?? null,
      townVoteLift: g.metrics.factions?.town?.voteLift ?? null,
      townCalib: g.metrics.factions?.town?.calibrationGap ?? null,
      mafiaDeception: g.metrics.factions?.mafia?.deceptionIndex ?? null,
    });

    for (const [name, p] of Object.entries(g.metrics.perPlayer || {})) {
      const proto = g.metrics.protocol?.[name] || {};
      seatGames.push({
        session: s,
        game: g.game,
        seats: players.length,
        roster,
        defenseOn: defenseEntries.length > 0,
        name,
        model: p.model,
        tier: p.tier,
        provider: p.provider,
        faction: p.faction,
        role: p.role,
        survived: p.survived,
        // town-only quantities; null for mafia seats by design
        detectionLift: p.faction === 'town' ? p.detectionLift : null,
        voteLift: p.faction === 'town' ? p.voteLift : null,
        suspicionCalls: p.suspicionCalls,
        calibrationGap: p.calibrationGap,
        consistency: p.consistency,
        deceptionIndex: p.faction === 'mafia' ? p.deceptionIndex : null,
        invalidMoveRate: proto.invalidMoveRate ?? null,
        calls: proto.calls ?? 0,
        namedDeadPlayer: proto.namedDeadPlayer ?? 0,
        truncatedRate: proto.truncatedRate ?? 0,
        avgLatencyMs: proto.avgLatencyMs ?? 0,
      });
    }

    const byName = Object.fromEntries(players.map((p) => [p.name, p]));

    /**
     * One row per DEFENSE, resolved against that day's execution.
     *
     * metrics.defenses carries per-game RATES, and a rate cannot be weighted by the
     * game's total defense count without conflating the mafia-only denominator with the
     * all-defenders one — my first pass did exactly that and produced 7.3 mafia
     * survivals out of 5 total, which is how the error announced itself. Counted from
     * the primitives instead: who stood up, and who the room then voted out.
     */
    for (const e of defenseEntries) {
      const exec = (g.snapshot.publicLog || []).find(
        (x) => x.type === 'announcement' && x.day === e.day && /votes out/.test(x.text || '')
      );
      const executed = exec ? (exec.text.match(/votes out (\w+)/) || [])[1] : null;
      const p = byName[e.actor];
      defenses.push({
        session: s, game: g.game, day: e.day, seats: players.length,
        defender: e.actor, model: p?.model || null, faction: p?.faction || null,
        executed, survived: executed !== null && executed !== e.actor,
        tie: !exec, words: String(e.text || '').split(/\s+/).length,
      });
    }

    // Per-turn town accusations: the only place a per-DAY breakdown is available.
    for (const s2 of g.snapshot.suspicions || []) {
      if (s2.actorIsMafia) continue; // det.lift is town-only, deliberately
      townTurns.push({
        session: s,
        game: g.game,
        day: s2.day,
        poolSize: s2.poolSize,
        model: byName[s2.actor]?.model || null,
        hit: s2.suspectIsMafia ? 1 : 0,
        chance: s2.chanceBaseline,
        confidence: s2.confidence,
      });
    }
  }
}

const out = { games, seatGames, townTurns, defenses };
fs.writeFileSync(path.join(__dirname, 'dataset.json'), JSON.stringify(out));
console.log('games', games.length, 'seatGames', seatGames.length, 'townTurns', townTurns.length);
console.log('models', [...new Set(seatGames.map((r) => r.model))].length);
console.log('winners', JSON.stringify(games.reduce((a, g) => ((a[g.winner] = (a[g.winner] || 0) + 1), a), {})));
console.log('defense games', games.filter((g) => g.defenseOn).length, 'defenses', defenses.length);
