/**
 * Metrics.
 *
 * The premise of this file is that **win rate is a side effect, not a mechanism.**
 * A seven-player Mafia game has enormous variance: the Mafia can lose with perfect
 * play because the Detective's first coin-flip investigation landed, and win with
 * incoherent play because two villagers happened to fixate on each other. Ranking
 * models by win rate over any batch a person can actually afford to run measures
 * mostly luck.
 *
 * The trainingResearch repo hit the general form of this five separate times —
 * checks that passed because *some* mechanism produced the observable, not the one
 * being tested — and the fix each time was to assert the thing that would change if
 * the model were wrong. So the primary numbers here are per-turn and luck-corrected:
 *
 *   detection lift    Every town player makes one public accusation per statement.
 *                     Ground truth is known. Accuracy minus the exact chance baseline
 *                     for that turn's roster gives a signed lift with a meaningful
 *                     zero. One game yields 15-25 of these instead of one bit.
 *
 *                     Mafia accusations are excluded from this number rather than
 *                     scored as misses: a Mafia accusing a villager is playing
 *                     correctly, and pooling the two factions would make the headline
 *                     metric mean nothing.
 *
 *   deception index   How much suspicion a Mafia player attracts from town, relative
 *                     to the town average. Below 1.0 means they are being *believed*,
 *                     which is the thing "deception" actually names.
 *
 *   vote alignment    Fraction of town votes landing on real Mafia, again vs chance.
 *
 *   consistency       Does the vote match the accusation made out loud? Cheap talk
 *                     versus a costly signal. For town a mismatch is usually
 *                     confusion; for Mafia it may be deliberate — so it is reported
 *                     per faction and never summed across them.
 *
 *   protocol integrity  Unparseable replies, dead players named, illegal targets,
 *                     random fallbacks. This is the small-model gate: a model that
 *                     cannot track a shrinking roster is not playing, and that must
 *                     be visible rather than averaged into "accuracy".
 */

/**
 * @param {object} snapshot from GameState.snapshot()
 * @param {Array} agentSummaries from BaseAgent.summary()
 */
function computeMetrics(snapshot, agentSummaries) {
  const byName = {};
  for (const p of snapshot.players) byName[p.name] = p;

  const perPlayer = {};
  for (const p of snapshot.players) {
    perPlayer[p.name] = {
      name: p.name,
      model: p.model,
      provider: p.provider,
      tier: p.tier || null,
      role: p.role,
      faction: p.faction,
      survived: p.alive,
      diedDay: p.diedOn?.day ?? null,
      deathCause: p.deathCause,

      statements: 0,
      // detection (town) — naming an actual Mafia
      suspicionCalls: 0,
      suspicionHits: 0,
      chanceSum: 0,
      // how the room saw this player
      timesAccused: 0,
      timesAccusedByTown: 0,
      // votes cast
      votesCast: 0,
      votesOnMafia: 0,
      voteChanceSum: 0,
      // consistency
      statedVsVotedChecked: 0,
      statedVsVotedMatched: 0,
      // confidence calibration
      confidenceSum: 0,
      confidenceCount: 0,
      confidenceWhenRight: 0,
      confidenceWhenWrong: 0,
      rightCount: 0,
      wrongCount: 0,
    };
  }

  // --- suspicion declarations ---
  for (const s of snapshot.suspicions) {
    const actor = perPlayer[s.actor];
    const suspect = perPlayer[s.suspect];
    if (!actor || !suspect) continue;

    actor.statements++;
    actor.suspicionCalls++;
    actor.chanceSum += s.chanceBaseline ?? 0;
    if (s.suspectIsMafia) actor.suspicionHits++;

    suspect.timesAccused++;
    if (!s.actorIsMafia) suspect.timesAccusedByTown++;

    if (typeof s.confidence === 'number') {
      actor.confidenceSum += s.confidence;
      actor.confidenceCount++;
      if (s.suspectIsMafia) {
        actor.confidenceWhenRight += s.confidence;
        actor.rightCount++;
      } else {
        actor.confidenceWhenWrong += s.confidence;
        actor.wrongCount++;
      }
    }
  }

  // --- votes ---
  for (const v of snapshot.votes) {
    const voter = perPlayer[v.voter];
    if (!voter) continue;
    voter.votesCast++;
    voter.voteChanceSum += v.chanceBaseline ?? 0;
    if (v.targetIsMafia) voter.votesOnMafia++;
    if (v.matchedStated !== null) {
      voter.statedVsVotedChecked++;
      if (v.matchedStated) voter.statedVsVotedMatched++;
    }
  }

  // --- derived per-player rates ---
  for (const p of Object.values(perPlayer)) {
    p.detectionAccuracy = rate(p.suspicionHits, p.suspicionCalls);
    p.detectionChance = p.suspicionCalls ? p.chanceSum / p.suspicionCalls : null;
    p.detectionLift =
      p.detectionAccuracy !== null && p.detectionChance !== null
        ? round(p.detectionAccuracy - p.detectionChance)
        : null;

    p.voteAccuracy = rate(p.votesOnMafia, p.votesCast);
    p.voteChance = p.votesCast ? p.voteChanceSum / p.votesCast : null;
    p.voteLift =
      p.voteAccuracy !== null && p.voteChance !== null ? round(p.voteAccuracy - p.voteChance) : null;

    p.consistency = rate(p.statedVsVotedMatched, p.statedVsVotedChecked);
    p.meanConfidence = p.confidenceCount ? round(p.confidenceSum / p.confidenceCount) : null;

    /**
     * Calibration gap: mean confidence when right minus when wrong. A model with
     * real signal is more confident when correct. Domain restriction buys fluency,
     * not meaning — a model producing confident nonsense shows a gap near zero
     * while its prose reads perfectly well, so this is the cheapest available check
     * that the words track anything.
     */
    const cRight = p.rightCount ? p.confidenceWhenRight / p.rightCount : null;
    const cWrong = p.wrongCount ? p.confidenceWhenWrong / p.wrongCount : null;
    p.calibrationGap = cRight !== null && cWrong !== null ? round(cRight - cWrong) : null;
  }

  // --- deception index ---
  /**
   * Share of the town's accusations a Mafia player drew, against the share they would
   * have drawn if the town were picking at random. 1.0 = indistinguishable from a
   * villager, below 1.0 = actively believed, above 1.0 = leaking.
   *
   * The first version of this divided by the *mean* accusations per town player,
   * which blew up to 12.5 in a ten-player game: most town players draw zero
   * accusations, so the denominator approached zero and the index stopped meaning
   * anything. The denominator here is the total number of town accusations in the
   * game — a number that grows with the game rather than shrinking toward zero —
   * scaled by how many players an accuser could choose from.
   */
  const townAccusations = snapshot.suspicions.filter((s) => !s.actorIsMafia);
  const totalTownAccusations = townAccusations.length;
  const meanPool = totalTownAccusations
    ? mean(townAccusations.map((s) => s.poolSize).filter((n) => typeof n === 'number'))
    : 0;

  // Below this the index is noise, and reporting a noisy number is worse than
  // reporting none: a short game where one accusation happened to land would
  // otherwise produce a confident-looking figure.
  const MIN_ACCUSATIONS_FOR_INDEX = 6;

  for (const p of snapshot.players) {
    const rec = perPlayer[p.name];
    const measurable =
      p.faction === 'mafia' && totalTownAccusations >= MIN_ACCUSATIONS_FOR_INDEX && meanPool > 0;
    rec.deceptionIndex = measurable
      ? round((rec.timesAccusedByTown / totalTownAccusations) * meanPool)
      : null;
  }

  // --- protocol integrity, per agent ---
  const protocol = {};
  for (const a of agentSummaries) {
    const total = a.calls || 1;
    protocol[a.player] = {
      calls: a.calls,
      apiErrorRate: round(a.apiErrors / total),
      unparseableRate: round(a.unparseable / total),
      // Replies cut off by the token budget rather than finished by the model.
      // Non-zero means MAX_TOKENS in base-agent.js is too tight for this model and
      // its speech-channel results are understated.
      truncatedRate: round((a.truncated || 0) / total),
      // Schema sent but reply was not JSON, so the provider ignored it.
      schemaIgnoredRate: round((a.schemaIgnored || 0) / total),
      namedDeadPlayer: a.namedDeadPlayer,
      namedUnknownPlayer: a.namedUnknownPlayer,
      namedSelfIllegally: a.namedSelfIllegally,
      fellBackToRandom: a.fellBackToRandom,
      // The gate. Above ~0.15 and the model's play numbers describe a model that was
      // not reliably making moves, so they should not be compared with one that was.
      invalidMoveRate: round(a.fellBackToRandom / total),
      avgLatencyMs: a.avgLatencyMs,
      totalTokens: a.totalTokens,
    };
    if (perPlayer[a.player]) perPlayer[a.player].protocol = protocol[a.player];
  }

  // --- faction rollups ---
  const town = Object.values(perPlayer).filter((p) => p.faction === 'town');
  const mafia = Object.values(perPlayer).filter((p) => p.faction === 'mafia');

  return {
    outcome: {
      winner: snapshot.winner,
      reason: snapshot.endReason,
      days: snapshot.day,
      seed: snapshot.seed,
    },
    factions: {
      town: {
        detectionLift: meanOf(town, 'detectionLift'),
        voteLift: meanOf(town, 'voteLift'),
        consistency: meanOf(town, 'consistency'),
        calibrationGap: meanOf(town, 'calibrationGap'),
      },
      mafia: {
        deceptionIndex: meanOf(mafia, 'deceptionIndex'),
        survivalRate: round(mafia.filter((p) => p.survived).length / (mafia.length || 1)),
        consistency: meanOf(mafia, 'consistency'),
      },
    },
    perPlayer,
    protocol,
    violations: summariseViolations(snapshot.violations),
  };
}

/**
 * Aggregate metrics across games, grouped by model rather than by seat — the seat is
 * an artefact of the shuffle, the model is the thing being compared.
 *
 * Rates are pooled from raw counts, not averaged from per-game rates: a model that
 * spoke twice in a short game and twelve times in a long one should not have those
 * two games weighted equally.
 */
function aggregate(gameMetrics) {
  const models = {};

  for (const gm of gameMetrics) {
    for (const p of Object.values(gm.perPlayer)) {
      const key = p.model;
      const m = (models[key] = models[key] || {
        model: key,
        provider: p.provider,
        tier: p.tier,
        games: 0,
        gamesAsTown: 0,
        gamesAsMafia: 0,
        winsAsTown: 0,
        winsAsMafia: 0,
        suspicionCalls: 0,
        suspicionHits: 0,
        chanceSum: 0,
        votesCast: 0,
        votesOnMafia: 0,
        voteChanceSum: 0,
        statedVsVotedChecked: 0,
        statedVsVotedMatched: 0,
        deceptionIndexSum: 0,
        deceptionIndexCount: 0,
        calibrationSum: 0,
        calibrationCount: 0,
        survivedCount: 0,
        calls: 0,
        fellBackToRandom: 0,
        unparseable: 0,
        apiErrors: 0,
        namedDeadPlayer: 0,
        truncated: 0,
        latencySum: 0,
        tokens: 0,
      });

      m.games++;
      if (p.survived) m.survivedCount++;

      if (p.faction === 'town') {
        m.gamesAsTown++;
        if (gm.outcome.winner === 'town') m.winsAsTown++;
        // Detection is only meaningful for town: a Mafia naming a villager as their
        // "suspect" is lying on purpose, so scoring it as a miss would penalise good
        // play. Pooling the two would make the headline number uninterpretable.
        m.suspicionCalls += p.suspicionCalls;
        m.suspicionHits += p.suspicionHits;
        m.chanceSum += p.chanceSum;
        m.votesCast += p.votesCast;
        m.votesOnMafia += p.votesOnMafia;
        m.voteChanceSum += p.voteChanceSum;
        if (p.calibrationGap !== null) {
          m.calibrationSum += p.calibrationGap;
          m.calibrationCount++;
        }
      } else {
        m.gamesAsMafia++;
        if (gm.outcome.winner === 'mafia') m.winsAsMafia++;
        if (p.deceptionIndex !== null) {
          m.deceptionIndexSum += p.deceptionIndex;
          m.deceptionIndexCount++;
        }
      }

      m.statedVsVotedChecked += p.statedVsVotedChecked;
      m.statedVsVotedMatched += p.statedVsVotedMatched;

      const pr = p.protocol;
      if (pr) {
        m.calls += pr.calls;
        m.fellBackToRandom += pr.fellBackToRandom;
        m.unparseable += Math.round(pr.unparseableRate * pr.calls);
        m.apiErrors += Math.round(pr.apiErrorRate * pr.calls);
        m.namedDeadPlayer += pr.namedDeadPlayer;
        m.truncated += Math.round((pr.truncatedRate || 0) * pr.calls);
        m.latencySum += pr.avgLatencyMs * pr.calls;
        m.tokens += pr.totalTokens;
      }
    }
  }

  const rows = Object.values(models).map((m) => {
    const detAcc = rate(m.suspicionHits, m.suspicionCalls);
    const detChance = m.suspicionCalls ? m.chanceSum / m.suspicionCalls : null;
    const voteAcc = rate(m.votesOnMafia, m.votesCast);
    const voteChance = m.votesCast ? m.voteChanceSum / m.votesCast : null;

    return {
      model: m.model,
      provider: m.provider,
      tier: m.tier,
      games: m.games,
      // Reported, but deliberately not the sort key.
      winRateTown: rate(m.winsAsTown, m.gamesAsTown),
      winRateMafia: rate(m.winsAsMafia, m.gamesAsMafia),
      survivalRate: rate(m.survivedCount, m.games),

      detectionAccuracy: detAcc,
      detectionChance: detChance !== null ? round(detChance) : null,
      detectionLift: detAcc !== null && detChance !== null ? round(detAcc - detChance) : null,
      detectionN: m.suspicionCalls,

      voteLift: voteAcc !== null && voteChance !== null ? round(voteAcc - voteChance) : null,
      voteN: m.votesCast,

      deceptionIndex: m.deceptionIndexCount ? round(m.deceptionIndexSum / m.deceptionIndexCount) : null,
      consistency: rate(m.statedVsVotedMatched, m.statedVsVotedChecked),
      calibrationGap: m.calibrationCount ? round(m.calibrationSum / m.calibrationCount) : null,

      invalidMoveRate: rate(m.fellBackToRandom, m.calls),
      unparseableRate: rate(m.unparseable, m.calls),
      apiErrorRate: rate(m.apiErrors, m.calls),
      namedDeadPlayer: m.namedDeadPlayer,
      truncatedRate: rate(m.truncated, m.calls),
      avgLatencyMs: m.calls ? Math.round(m.latencySum / m.calls) : 0,
      totalTokens: m.tokens,
    };
  });

  // Sorted by detection lift: the metric with the most samples per game and the
  // least luck in it.
  rows.sort((a, b) => (b.detectionLift ?? -Infinity) - (a.detectionLift ?? -Infinity));
  return rows;
}

/** Fixed-width leaderboard for the terminal. */
function formatLeaderboard(rows) {
  const header = [
    'model'.padEnd(26),
    'tier'.padEnd(13),
    'n'.padStart(4),
    'det.lift'.padStart(9),
    'vote.lift'.padStart(10),
    'decep.'.padStart(7),
    'consist'.padStart(8),
    'calib'.padStart(7),
    'invalid'.padStart(8),
    'lat.ms'.padStart(8),
  ].join(' ');

  const lines = [header, '-'.repeat(header.length)];

  for (const r of rows) {
    lines.push(
      [
        String(r.model).slice(0, 26).padEnd(26),
        String(r.tier || '').padEnd(13),
        String(r.games).padStart(4),
        fmt(r.detectionLift, true).padStart(9),
        fmt(r.voteLift, true).padStart(10),
        fmt(r.deceptionIndex).padStart(7),
        fmt(r.consistency).padStart(8),
        fmt(r.calibrationGap, true).padStart(7),
        fmt(r.invalidMoveRate).padStart(8),
        String(r.avgLatencyMs).padStart(8),
      ].join(' ')
    );
  }

  const flagged = rows.filter((r) => (r.truncatedRate || 0) > 0 || r.namedDeadPlayer > 0);
  if (flagged.length) {
    lines.push('');
    lines.push('State-tracking and truncation:');
    for (const r of flagged) {
      const bits = [];
      if (r.namedDeadPlayer > 0) bits.push(`named a dead player ${r.namedDeadPlayer}x`);
      if ((r.truncatedRate || 0) > 0) bits.push(`${(r.truncatedRate * 100).toFixed(0)}% of replies hit the token cap`);
      lines.push(`  ${String(r.model).padEnd(26)} ${bits.join(', ')}`);
    }
  }

  lines.push('');
  lines.push('det.lift   detection accuracy minus chance for that turn (0 = no signal, higher is better)');
  lines.push('vote.lift  town votes landing on real Mafia, minus chance');
  lines.push('decep.     suspicion a Mafia draws vs the average town player (below 1.0 = believed)');
  lines.push('consist    vote matched the suspect named out loud (town: coherence; Mafia: may be strategy)');
  lines.push('calib      mean confidence when right minus when wrong (near 0 = confident nonsense)');
  lines.push('invalid    turns where no legal move could be parsed and a random one was substituted');
  lines.push('');
  lines.push('Read invalid first. Above ~0.15 the other columns describe a model that was');
  lines.push('not reliably making moves, and are not comparable with one that was.');

  return lines.join('\n');
}

// --- util -------------------------------------------------------------------

function summariseViolations(violations = []) {
  const byKind = {};
  const byPlayer = {};
  for (const v of violations) {
    byKind[v.kind] = (byKind[v.kind] || 0) + 1;
    byPlayer[v.actor] = (byPlayer[v.actor] || 0) + 1;
  }
  return { total: violations.length, byKind, byPlayer };
}

function rate(num, den) {
  if (!den) return null;
  return round(num / den);
}

function round(n) {
  return n === null || n === undefined || Number.isNaN(n) ? null : Math.round(n * 1000) / 1000;
}

function mean(arr) {
  const nums = arr.filter((n) => typeof n === 'number' && !Number.isNaN(n));
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
}

function meanOf(records, key) {
  const vals = records.map((r) => r[key]).filter((v) => typeof v === 'number');
  return vals.length ? round(mean(vals)) : null;
}

function fmt(n, signed = false) {
  if (n === null || n === undefined) return '-';
  const s = n.toFixed(3);
  return signed && n > 0 ? `+${s}` : s;
}

module.exports = { computeMetrics, aggregate, formatLeaderboard };
