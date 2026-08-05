const { CONFIG, missingKeys, flag } = require('./config.js');
const { GameState } = require('./engine/state.js');
const { GameEngine } = require('./engine/engine.js');
const { Rng, makeSeed } = require('./engine/rng.js');
const { buildAgents } = require('./agents/factory.js');
const { computeMetrics, aggregate, formatLeaderboard } = require('./metrics.js');
const {
  initSession,
  startGame,
  logGameResult,
  flushAll,
  getSessionDir,
} = require('./logger.js');
const { checkHealth, pullModel, warmModel } = require('./agents/providers/ollama.js');

function banner() {
  const seats = CONFIG.seats.map((s) => `${s.name}=${s.key}`).join('  ') || '(none)';
  return `
+---------------------------------------------------------------+
|                        AI  vs  AI   MAFIA                     |
|   Social deduction as a benchmark: deception and detection     |
|   measured per turn, separately from win rate.                 |
+---------------------------------------------------------------+
  Seats:   ${seats}
  Context: ${CONFIG.game.contextMode}   Output: ${CONFIG.game.outputMode}${CONFIG.game.strictTargets ? ' (strict targets)' : ''}   Rounds/day: ${CONFIG.game.discussionRounds}   Games: ${CONFIG.game.games}
`;
}

async function preflight() {
  const missing = missingKeys();
  if (missing.length) {
    console.error('[ERROR] Missing API key(s) for the current roster:');
    for (const m of missing) console.error(`  - ${m}`);
    console.error('\nCopy .env.example to .env and fill them in, or run a roster that does');
    console.error('not need them:  npm run test-game   (rule-based players, no keys)');
    process.exit(1);
  }

  // Local Ollama seats: make sure the daemon is up and the models are resident
  // before the clock starts, so turn one is not a cold-start outlier.
  const localModels = [...new Set(CONFIG.seats.filter((s) => s.provider === 'ollama').map((s) => s.model))];
  if (localModels.length) {
    if (!(await checkHealth())) {
      console.error(`[ERROR] Ollama is not reachable at ${CONFIG.api.ollama.baseUrl}.`);
      console.error('Start it with:  ollama serve');
      process.exit(1);
    }
    for (const m of localModels) await pullModel(m);
    console.log(`[Ollama] Warming ${localModels.length} model(s)...`);
    for (const m of localModels) await warmModel(m);
  }

  const swiftletSeats = CONFIG.seats.filter((s) => s.provider === 'openai-compatible');
  if (swiftletSeats.length) {
    const url = swiftletSeats[0].baseUrl;
    console.log(`[Local server] Expecting an OpenAI-compatible server at ${url}`);
    console.log('  (Swiftlet:  swiftlet-server --model ~/models/qwen3.6-35b.qpack --port 8080)');
  }
}

async function playOneGame(gameNumber, seedValue) {
  startGame(gameNumber);

  const rng = new Rng(seedValue);
  const state = new GameState(CONFIG.seats, {
    rng,
    revealRoleOnDeath: CONFIG.game.revealRoleOnDeath,
    maxDays: CONFIG.game.maxDays,
  });

  const agents = buildAgents(state, {
    contextMode: CONFIG.game.contextMode,
    outputMode: CONFIG.game.outputMode,
    strictTargets: CONFIG.game.strictTargets,
    rng,
  });
  const engine = new GameEngine(state, agents, CONFIG.game);

  console.log(`\n########## GAME ${gameNumber} (seed ${seedValue}) ##########`);

  const outcome = await engine.run();

  const snapshot = state.snapshot();
  const agentSummaries = [...agents.values()].map((a) => a.summary());
  const metrics = computeMetrics(snapshot, agentSummaries);

  logGameResult({ snapshot, outcome, metrics, agentSummaries });

  // Per-game protocol report. Printed every game rather than only in the summary,
  // because a model failing to produce legal moves invalidates that game's play
  // numbers and it is better to see that immediately than after a long batch.
  const shaky = Object.entries(metrics.protocol).filter(([, p]) => p.invalidMoveRate > 0.15);
  if (shaky.length) {
    console.log('  Protocol warnings (invalid-move rate > 0.15):');
    for (const [player, p] of shaky) {
      const model = snapshot.players.find((x) => x.name === player)?.model;
      console.log(
        `    ${player} (${model}): ${(p.invalidMoveRate * 100).toFixed(0)}% random fallbacks, ` +
          `${p.namedDeadPlayer} dead-player references, ${(p.unparseableRate * 100).toFixed(0)}% unparseable`
      );
    }
  }

  return metrics;
}

async function main() {
  // Help is answered before anything that can fail, since a mistyped roster is the
  // most likely reason someone is asking for it.
  if (flag('help') || flag('h')) {
    printHelp();
    return;
  }

  if (CONFIG.configError) {
    console.error(`[ERROR] ${CONFIG.configError}`);
    console.error('\nRun with --help to see the available rosters and models.');
    process.exit(1);
  }

  console.log(banner());
  await preflight();
  initSession();

  const baseSeed = makeSeed(CONFIG.game.seed);
  const results = [];
  let gameNumber = 0;

  do {
    for (let i = 0; i < CONFIG.game.games; i++) {
      gameNumber++;
      // Derive each game's seed from the base so a whole batch is reproducible from
      // one number, and any single game inside it can be replayed on its own.
      const seed = (baseSeed + gameNumber * 0x9e3779b1) >>> 0;
      try {
        results.push(await playOneGame(gameNumber, seed));
      } catch (err) {
        if (err.isRateLimitExhausted) {
          console.error('\n[ERROR] Provider rate limit exhausted — stopping the batch here.');
          console.error('Results so far are saved; rerun later to add more games.');
          break;
        }
        console.error(`\n[ERROR] Game ${gameNumber} failed: ${err.message}`);
        console.error(err.stack);
      }
      report(results, baseSeed);
    }
  } while (CONFIG.game.loop && results.length);

  flushAll();
  console.log(`\nLogs: ${getSessionDir()}`);
}

function report(results, baseSeed) {
  if (!results.length) return;

  const wins = { town: 0, mafia: 0, draw: 0 };
  for (const r of results) {
    const w = r.outcome.winner;
    wins[w === 'town' ? 'town' : w === 'mafia' ? 'mafia' : 'draw']++;
  }

  console.log('\n' + '='.repeat(96));
  console.log(
    `AFTER ${results.length} GAME(S) — base seed ${baseSeed} — ` +
      `town ${wins.town} / mafia ${wins.mafia} / draw ${wins.draw}`
  );
  console.log('='.repeat(96));
  console.log(formatLeaderboard(aggregate(results)));
}

function printHelp() {
  console.log(`Usage: node src/index.js [options]

Rosters (choose one; default "test"):
  --test                 seven rule-based players. No API keys, no GPU, runs in seconds.
  --api                  frontier hosted APIs (OpenAI, Anthropic, Google, xAI, Perplexity)
  --cloud                large open models via Ollama Cloud
  --local                small models via a local Ollama
  --mixed                the headline experiment: small local models seated among larger ones
  --swiftlet             large local MoE models via a Swiftlet server, plus small local models
  --roster=NAME          any roster by name
  --models=a,b,c         explicit seat list; length sets the player count (5-10)

Game options:
  --context=ledger|full  how much record each agent sees (default ledger)
  --output=json|text     json constrains decoding to a schema (default; required for
                         reasoning models). text uses the KEY: value contract.
  --strict-targets       enum-constrain targets to living players. Guarantees legal
                         moves but zeroes the state-tracking metrics.
  --rounds=N             statements per player per day (default 1)
  --games=N              games to play in this session (default 1)
  --loop                 keep starting new batches until interrupted
  --seed=N               fixed base seed for a reproducible batch
  --max-days=N           draw the game after N days (default 12)
  --no-reveal            do not reveal an eliminated player's role

Available models: ${Object.keys(CONFIG.MODELS).join(', ')}
Available rosters: ${Object.keys(CONFIG.ROSTERS).join(', ')}

Examples:
  npm run test-game
  node src/index.js --local --games=20 --seed=42
  node src/index.js --mixed --games=10 --context=ledger
  node src/index.js --models=qwen,qwen,claude,claude,scripted,scripted,scripted
`);
}

main().catch((err) => {
  console.error('\n[FATAL]', err.message);
  console.error(err.stack);
  flushAll();
  process.exit(1);
});
