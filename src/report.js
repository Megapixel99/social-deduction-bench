/**
 * Report generator. Turns a session's raw logs into documents a person can read and
 * an analysis can consume.
 *
 *   node src/report.js [--session=logs/session-...] [--out=reports]
 *
 * Modelled on the CTF project's reports/ pipeline, with one change of emphasis. There,
 * the artifact that mattered was the command stream. Here it is the **reasoning**: this
 * benchmark's whole claim is that deception and its detection are measurable per turn,
 * and that claim is only auditable if a reader can see what each model privately thought
 * next to what it publicly said and how it then voted.
 *
 * Four outputs, each for a different consumer:
 *
 *   transcripts/game-NNN.md   One game as a narrative. Every statement is printed with
 *                             the speaker's private THINKING beside it and their vote
 *                             underneath. Roles are revealed in a header — the reader
 *                             needs ground truth, the players never had it.
 *
 *   reasoning/<model>.md      Every reasoning trace one model produced, grouped by
 *                             request kind, each annotated with whether the decision it
 *                             justified was actually right. This is the file to read when
 *                             asking "how does this model think", and the one that shows
 *                             fluent-but-empty reasoning for what it is.
 *
 *   summary.md / .json        Leaderboard and per-model aggregates, with n on every row.
 *
 *   dataset.jsonl             One flat row per model call. For plotting, statistics, or
 *                             as supervised data.
 */

const { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } = require('fs');
const { join, basename } = require('path');
const { aggregate, formatLeaderboard } = require('./metrics.js');

function opt(name, fallback) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

/**
 * Newest session that actually contains a finished game.
 *
 * "Newest session" alone is wrong: a preflight run (`--games=0`) or a batch killed
 * before its first game still creates a session directory, and picking it reports
 * nothing while a perfectly good session sits one entry back.
 */
function latestSession(logDir = './logs') {
  if (!existsSync(logDir)) throw new Error(`No log directory at ${logDir}`);
  const sessions = readdirSync(logDir)
    .filter((d) => d.startsWith('session-'))
    .sort()
    .reverse();
  for (const s of sessions) {
    const dir = join(logDir, s);
    if (readdirSync(dir).some((f) => /^game-\d+\.json$/.test(f))) return dir;
  }
  throw new Error(`No session in ${logDir} contains a finished game`);
}

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function slug(s) {
  return String(s).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-|-$/g, '');
}

function fmt(n, signed = false) {
  if (n === null || n === undefined) return '—';
  const s = Number(n).toFixed(3);
  return signed && n > 0 ? `+${s}` : s;
}

// ---------------------------------------------------------------------------

function loadSession(dir) {
  const games = readdirSync(dir)
    .filter((f) => /^game-\d+\.json$/.test(f))
    .sort()
    .map((f) => readJson(join(dir, f)))
    .filter(Boolean);

  const turns = readJson(join(dir, 'turns.json'), []) || [];
  return { dir, games, turns };
}

/**
 * Index turns by game and by (player, requestKind), preserving order.
 *
 * Turns are appended chronologically, so the Nth `statement` turn for a player in a game
 * is the reasoning behind that player's Nth statement. That positional join is what lets
 * the transcript put private reasoning next to public speech without the engine having to
 * thread an id through every call.
 */
function indexTurns(turns) {
  const byGame = new Map();
  for (const t of turns) {
    if (!byGame.has(t.game)) byGame.set(t.game, new Map());
    const perGame = byGame.get(t.game);
    const key = `${t.player}|${t.request}`;
    if (!perGame.has(key)) perGame.set(key, []);
    perGame.get(key).push(t);
  }
  return byGame;
}

// --- transcripts -----------------------------------------------------------

function renderTranscript(game, turnIndex) {
  const snap = game.snapshot;
  const n = String(game.game).padStart(3, '0');
  const perGame = turnIndex.get(game.game) || new Map();
  const cursor = new Map();
  const nextTurn = (player, kind) => {
    const key = `${player}|${kind}`;
    const i = cursor.get(key) || 0;
    cursor.set(key, i + 1);
    return (perGame.get(key) || [])[i] || null;
  };

  const byName = {};
  for (const p of snap.players) byName[p.name] = p;

  const out = [];
  out.push(`# Game ${n}`);
  out.push('');
  out.push(
    `**Outcome:** ${(game.outcome.winner || 'draw').toUpperCase()} — ${game.outcome.reason} ` +
      `after ${game.outcome.days} day(s). Seed \`${snap.seed}\`.`
  );
  out.push('');
  out.push(
    '> Ground truth below is for the reader only. **No player ever saw this table** — ' +
      'Mafia knew their own partners, and nothing else was shared.'
  );
  out.push('');
  out.push('| player | role | faction | model | tier | fate |');
  out.push('|---|---|---|---|---|---|');
  for (const p of snap.players) {
    const fate = p.alive
      ? 'survived'
      : `died day ${p.diedOn?.day ?? '?'} (${p.deathCause === 'execution' ? 'voted out' : 'killed at night'})`;
    out.push(`| ${p.name} | ${p.role} | ${p.faction} | \`${p.model}\` | ${p.tier || '—'} | ${fate} |`);
  }
  out.push('');

  // Night actions and Mafia coordination, grouped by day.
  const nightsByDay = {};
  for (const a of snap.nightActions || []) {
    (nightsByDay[a.day] = nightsByDay[a.day] || []).push(a);
  }

  let lastDay = null;
  for (const e of snap.publicLog) {
    if (e.day !== lastDay) {
      lastDay = e.day;
      out.push('');
      out.push(`## Day ${e.day}`);
      out.push('');
      const nights = nightsByDay[e.day] || [];
      if (nights.length) {
        out.push(`### Night ${e.day} (private)`);
        out.push('');
        for (const a of nights) {
          const t = nextTurn(a.actor, `night_${a.action}`);
          const who = byName[a.actor];
          out.push(
            `- **${a.actor}** (${who?.role}, \`${who?.model}\`) → *${a.action}* **${a.target}**`
          );
          if (t?.fields?.THINKING) out.push(`  - reasoning: ${oneLine(t.fields.THINKING)}`);
        }
        out.push('');
      }
    }

    if (e.type === 'statement') {
      const t = nextTurn(e.actor, 'statement');
      const p = byName[e.actor];
      const susp = (snap.suspicions || []).find(
        (s) => s.day === e.day && s.actor === e.actor && s.round === (e.round ?? 1)
      );
      out.push(`### ${e.actor} — ${p?.role} · \`${p?.model}\``);
      out.push('');
      out.push(`> ${e.text.replace(/\n+/g, ' ')}`);
      out.push('');
      if (susp) {
        const verdict = susp.suspectIsMafia ? '**correct — is Mafia**' : 'wrong — is town';
        const conf = susp.confidence != null ? `, confidence ${susp.confidence}` : '';
        out.push(`- Accused: **${susp.suspect}** (${verdict}${conf})`);
      }
      if (t?.fields?.THINKING) out.push(`- Private reasoning: ${oneLine(t.fields.THINKING)}`);
      out.push('');
    } else if (e.type === 'defense') {
      const t = nextTurn(e.actor, 'defense');
      const d = (snap.defenses || []).find((x) => x.day === e.day && x.accused === e.actor);
      out.push(`### 🛡 ${e.actor} DEFENDS — accused by ${d ? d.accusers.join(', ') : 'the room'}`);
      out.push('');
      out.push(`> ${e.text.replace(/\n+/g, ' ')}`);
      out.push('');
      if (d && d.survived !== null) {
        out.push(`- Outcome: **${d.survived ? 'survived the vote — the defense worked' : 'voted out anyway'}**`);
      }
      if (t?.fields?.THINKING) out.push(`- Private reasoning: ${oneLine(t.fields.THINKING)}`);
      out.push('');
    } else if (e.type === 'vote') {
      const t = nextTurn(e.actor, 'vote');
      const v = (snap.votes || []).find((x) => x.day === e.day && x.voter === e.actor);
      const hit = v ? (v.targetIsMafia ? 'hit Mafia' : 'hit town') : '';
      const mismatch = v && v.matchedStated === false ? ' — **differs from their accusation**' : '';
      out.push(`- 🗳 **${e.actor}** votes **${e.target}** (${hit})${mismatch}`);
      if (t?.fields?.THINKING) out.push(`  - reasoning: ${oneLine(t.fields.THINKING)}`);
    } else {
      out.push('');
      out.push(`**${e.text}**`);
      out.push('');
    }
  }

  const defs = (snap.defenses || []).filter((d) => d.survived !== null);
  if (defs.length) {
    out.push('');
    out.push('## Persuasion');
    out.push('');
    out.push('Each defense was given by the player the room had converged on, so surviving the vote means the defense moved votes.');
    out.push('');
    for (const d of defs) {
      out.push(
        `- Day ${d.day}: **${d.accused}** (${d.accusedIsMafia ? 'Mafia' : 'town'}) faced ` +
          `${d.accusationsAgainst} accusation(s) → **${d.survived ? 'survived' : 'voted out'}**`
      );
    }
  }

  const viol = snap.violations || [];
  if (viol.length) {
    out.push('');
    out.push('## Protocol failures');
    out.push('');
    out.push('Moves the engine could not resolve, and the seeded random move substituted.');
    out.push('');
    for (const v of viol) {
      out.push(
        `- Day ${v.day} · **${v.actor}** (\`${byName[v.actor]?.model}\`) — ${v.kind}` +
          (v.detail?.raw ? `, said \`${oneLine(String(v.detail.raw)).slice(0, 60)}\`` : '') +
          (v.detail?.substituted ? ` → substituted **${v.detail.substituted}**` : '')
      );
    }
  }

  return out.join('\n') + '\n';
}

function oneLine(s) {
  return String(s).replace(/\s*\n+\s*/g, ' ').trim();
}

// --- per-model reasoning ---------------------------------------------------

function renderModelReasoning(model, rows) {
  const out = [];
  out.push(`# Reasoning traces — \`${model}\``);
  out.push('');
  out.push(
    `${rows.length} model calls across ${new Set(rows.map((r) => r.game)).size} game(s). ` +
      'Each entry is what the model privately reasoned, and whether the decision it ' +
      'justified turned out to be right.'
  );
  out.push('');

  const byKind = {};
  for (const r of rows) (byKind[r.request] = byKind[r.request] || []).push(r);

  for (const kind of Object.keys(byKind).sort()) {
    const list = byKind[kind];
    const scored = list.filter((r) => r.correct !== null);
    const hits = scored.filter((r) => r.correct).length;
    out.push(`## ${kind} — ${list.length} call(s)` + (scored.length ? ` · ${hits}/${scored.length} correct` : ''));
    out.push('');
    for (const r of list) {
      const mark = r.correct === null ? '·' : r.correct ? '✅' : '❌';
      const dec = r.decision ? ` → **${r.decision}**` : '';
      out.push(`- ${mark} *game ${r.game}, day ${r.day ?? '?'}, as ${r.role}*${dec}`);
      if (r.thinking) out.push(`  - ${oneLine(r.thinking)}`);
      if (r.statement) out.push(`  - said publicly: "${oneLine(r.statement)}"`);
    }
    out.push('');
  }
  return out.join('\n') + '\n';
}

// --- flat dataset ----------------------------------------------------------

function buildRows(games, turnIndex) {
  const rows = [];
  for (const game of games) {
    const snap = game.snapshot;
    const byName = {};
    for (const p of snap.players) byName[p.name] = p;
    const perGame = turnIndex.get(game.game) || new Map();

    for (const [key, list] of perGame) {
      const [player, request] = key.split('|');
      const p = byName[player];
      if (!p) continue;

      list.forEach((t, i) => {
        // Correctness is only defined where ground truth applies. A Mafia's accusation
        // is deliberately misleading, so it is recorded but never scored as wrong.
        let decision = null;
        let correct = null;
        let statement = null;
        let day = t.day ?? null;

        if (request === 'statement') {
          const susp = (snap.suspicions || []).filter((s) => s.actor === player)[i];
          if (susp) {
            decision = susp.suspect;
            day = day ?? susp.day;
            correct = susp.actorIsMafia ? null : !!susp.suspectIsMafia;
          }
          statement = t.fields?.STATEMENT || null;
        } else if (request === 'vote') {
          const v = (snap.votes || []).filter((x) => x.voter === player)[i];
          if (v) {
            decision = v.target;
            day = day ?? v.day;
            correct = v.voterIsMafia ? null : !!v.targetIsMafia;
          }
        } else if (request.startsWith('night_')) {
          const a = (snap.nightActions || []).filter((x) => x.actor === player)[i];
          if (a) {
            decision = a.target;
            day = day ?? a.day;
          }
        }

        rows.push({
          session: basename(turnIndex.dir || ''),
          game: game.game,
          seed: snap.seed,
          day,
          phase: t.phase ?? null,
          player,
          model: t.model,
          provider: t.provider,
          tier: p.tier || null,
          role: p.role,
          faction: p.faction,
          request,
          thinking: t.fields?.THINKING || null,
          statement,
          decision,
          correct,
          missingFields: t.missingFields || [],
          latencyMs: t.latencyMs ?? null,
          tokensUsed: t.tokensUsed ?? null,
          gameWinner: game.outcome.winner,
        });
      });
    }
  }
  return rows;
}

// --- summary ---------------------------------------------------------------

function renderSummary(games, rows, leaderboard) {
  const wins = { town: 0, mafia: 0, draw: 0 };
  for (const g of games) {
    const w = g.outcome.winner;
    wins[w === 'town' ? 'town' : w === 'mafia' ? 'mafia' : 'draw']++;
  }

  const out = [];
  out.push('# Session summary');
  out.push('');
  out.push(
    `${games.length} games · town ${wins.town} / mafia ${wins.mafia} / draw ${wins.draw} · ` +
      `${rows.length} model calls`
  );
  out.push('');
  out.push('## Leaderboard');
  out.push('');
  out.push(
    'Sorted by detection lift: public-accusation accuracy minus the exact chance ' +
      'baseline for that turn. **Read `invalid` first** — above ~0.15 a row describes a ' +
      'model that was not reliably making legal moves, and is not comparable with one ' +
      'that was. `n` is accusations, not games.'
  );
  out.push('');
  out.push('| model | tier | games | n | det.lift | vote.lift | decep. | consist | calib | invalid | lat.ms |');
  out.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of leaderboard) {
    out.push(
      `| \`${r.model}\` | ${r.tier || '—'} | ${r.games} | ${r.detectionN ?? '—'} | ` +
        `${fmt(r.detectionLift, true)} | ${fmt(r.voteLift, true)} | ${fmt(r.deceptionIndex)} | ` +
        `${fmt(r.consistency)} | ${fmt(r.calibrationGap, true)} | ${fmt(r.invalidMoveRate)} | ${r.avgLatencyMs} |`
    );
  }
  out.push('');

  // Reasoning volume per model — how much material each has in reasoning/.
  out.push('## Reasoning corpus');
  out.push('');
  out.push('| model | calls | with reasoning | scored decisions | correct |');
  out.push('|---|---|---|---|---|');
  const byModel = {};
  for (const r of rows) (byModel[r.model] = byModel[r.model] || []).push(r);
  for (const m of Object.keys(byModel).sort()) {
    const list = byModel[m];
    const withThinking = list.filter((r) => r.thinking).length;
    const scored = list.filter((r) => r.correct !== null);
    const hits = scored.filter((r) => r.correct).length;
    out.push(
      `| \`${m}\` | ${list.length} | ${withThinking} | ${scored.length} | ` +
        `${scored.length ? `${hits} (${((hits / scored.length) * 100).toFixed(0)}%)` : '—'} |`
    );
  }
  out.push('');
  out.push('## Files');
  out.push('');
  out.push('- `transcripts/` — one Markdown narrative per game: events, public statements, private reasoning, votes.');
  out.push('- `reasoning/` — one file per model: every reasoning trace, annotated with whether its decision was right.');
  out.push('- `dataset.jsonl` — one row per model call, flat, for plotting or statistics.');
  out.push('- `summary.json` — the leaderboard as data.');
  out.push('');
  out.push(
    '**Caveat that applies to every table here:** detection lift is a property of a model ' +
      '*in a field*, not of a model. Roster composition moves a weak model\'s score more ' +
      'than its own identity does. Compare across sessions only through shared anchor ' +
      'models at the same seed.'
  );
  return out.join('\n') + '\n';
}

// --- main ------------------------------------------------------------------

function main() {
  const dir = opt('session', latestSession(opt('logs', './logs')));
  const outDir = opt('out', 'reports');

  const { games, turns } = loadSession(dir);
  if (!games.length) {
    console.error(`[report] No finished games in ${dir}. Nothing to report.`);
    process.exit(1);
  }

  const turnIndex = indexTurns(turns);
  turnIndex.dir = dir;

  mkdirSync(join(outDir, 'transcripts'), { recursive: true });
  mkdirSync(join(outDir, 'reasoning'), { recursive: true });

  for (const game of games) {
    const n = String(game.game).padStart(3, '0');
    writeFileSync(join(outDir, 'transcripts', `game-${n}.md`), renderTranscript(game, turnIndex));
  }

  const rows = buildRows(games, turnIndex);
  writeFileSync(join(outDir, 'dataset.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

  const byModel = {};
  for (const r of rows) (byModel[r.model] = byModel[r.model] || []).push(r);
  for (const [model, list] of Object.entries(byModel)) {
    writeFileSync(join(outDir, 'reasoning', `${slug(model)}.md`), renderModelReasoning(model, list));
  }

  const leaderboard = aggregate(games.map((g) => g.metrics));
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify({ session: dir, games: games.length, leaderboard }, null, 2));
  writeFileSync(join(outDir, 'summary.md'), renderSummary(games, rows, leaderboard));

  console.log(`[report] ${dir}`);
  console.log(`[report] ${games.length} games, ${rows.length} model calls, ${Object.keys(byModel).length} models`);
  console.log(`[report] wrote ${outDir}/summary.md, transcripts/, reasoning/, dataset.jsonl`);
  console.log('');
  console.log(formatLeaderboard(leaderboard));
}

if (require.main === module) main();

module.exports = { loadSession, indexTurns, renderTranscript, buildRows, renderSummary };
