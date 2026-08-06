require('dotenv/config');

/**
 * Configuration: which model sits in which seat, and how much of the record each
 * seat is shown.
 *
 * This departs from the CTF project's config on purpose. There, a "player" was a
 * container plus a model and the roster was five fixed entries per mode. Here the
 * seat count varies with the role setup and the interesting experiments are *mixed*
 * rosters — a 2B local model at one seat and a frontier model at the next — so the
 * model list is a registry of short names and a roster is just a list of those
 * names. Adding an arm to an experiment is a one-line roster, not a new mode.
 */

const args = process.argv.slice(2);

function flag(name) {
  return args.includes(`--${name}`);
}

function opt(name, fallback) {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  return fallback;
}

/**
 * Model registry. `provider` selects the adapter; `model` is passed through to it.
 *
 * The `tier` field is only used for reporting — it is how the leaderboard groups
 * results, and it is the axis the whole small-model question lives on.
 */
const MODELS = {
  // --- frontier / hosted APIs ---
  /**
   * Frontier tier. The Claude IDs are current as of 2026-08; the others are
   * env-overridable because I could not verify their current IDs, and a stale ID is a
   * 404 rather than a quiet degradation — one env var beats a wrong default.
   */
  claude:     { provider: 'claude',     model: process.env.CLAUDE_MODEL || 'claude-opus-5',   tier: 'frontier' },
  'claude-sonnet': { provider: 'claude', model: 'claude-sonnet-5',                            tier: 'frontier' },
  gpt:        { provider: 'openai',     model: process.env.OPENAI_MODEL || 'gpt-4o',          tier: 'frontier' },
  gemini:     { provider: 'gemini',     model: process.env.GEMINI_MODEL || 'gemini-2.5-pro',  tier: 'frontier' },
  grok:       { provider: 'grok',       model: process.env.GROK_MODEL || 'grok-3',            tier: 'frontier' },
  perplexity: { provider: 'perplexity', model: process.env.PERPLEXITY_MODEL || 'sonar-pro',   tier: 'frontier' },

  /**
   * Hosted open models via Ollama Cloud. Probed 2026-08-05 on this account:
   * gpt-oss:120b and nemotron-3-super answer; glm-5.1 requires a paid subscription;
   * gemini-3-flash-preview (retired 2026-07-15) and rnj-1:8b (retired 2026-06-30) are
   * gone. The dead entries are kept, marked, and OUT of every roster — a retired model
   * in a roster is a batch that fails an hour in, and deleting the entry loses the
   * record of why it is not there.
   */
  'gpt-oss-120b': { provider: 'ollama-cloud', model: process.env.CLOUD_MODEL_1 || 'gpt-oss:120b',          tier: 'large-open' },
  nemotron:       { provider: 'ollama-cloud', model: process.env.CLOUD_MODEL_4 || 'nemotron-3-super:cloud', tier: 'large-open' }, // ~168 s/call — too slow for a long batch
  /**
   * Probed against the live cloud catalogue 2026-08-06 (not the stale five inherited from
   * the CTF config). Cloud seats cost NO local memory and calls are sequential, so a
   * roster can be entirely hosted regardless of what the machine has free.
   *
   * gemma4 and minimax-m3 wrap their JSON in a ```json fence; `tryParseJson` strips
   * fences, so they parse fine — an early probe that used a bare JSON.parse reported them
   * as broken, which was the probe's fault and not the models'.
   */
  'gemma4-cloud':    { provider: 'ollama-cloud', model: 'gemma4',           tier: 'large-open' },
  'minimax-m3':      { provider: 'ollama-cloud', model: 'minimax-m3',       tier: 'large-open' },
  'nemotron-ultra':  { provider: 'ollama-cloud', model: 'nemotron-3-ultra', tier: 'large-open' },

  // Unavailable on this account — do not put these in a roster.
  glm:      { provider: 'ollama-cloud', model: 'glm-5.1:cloud',                  tier: 'large-open', unavailable: 'requires a paid Ollama subscription' },
  'glm-5.2':  { provider: 'ollama-cloud', model: 'glm-5.2',            tier: 'large-open', unavailable: 'requires a paid Ollama subscription' },
  'kimi-k3':  { provider: 'ollama-cloud', model: 'kimi-k3',            tier: 'large-open', unavailable: 'requires a paid Ollama subscription' },
  'kimi-k2.6': { provider: 'ollama-cloud', model: 'kimi-k2.6',         tier: 'large-open', unavailable: 'requires a paid Ollama subscription' },
  'qwen3.5-cloud': { provider: 'ollama-cloud', model: 'qwen3.5',       tier: 'large-open', unavailable: 'requires a paid Ollama subscription' },
  'minimax-m2.7': { provider: 'ollama-cloud', model: 'minimax-m2.7',   tier: 'large-open', unavailable: 'requires a paid Ollama subscription' },
  'deepseek-v4-pro': { provider: 'ollama-cloud', model: 'deepseek-v4-pro', tier: 'large-open', unavailable: 'requires a paid Ollama subscription' },
  'deepseek-v4-flash': { provider: 'ollama-cloud', model: 'deepseek-v4-flash', tier: 'large-open', unavailable: 'requires a paid Ollama subscription' },
  'gemini3': { provider: 'ollama-cloud', model: 'gemini-3-flash-preview:cloud',  tier: 'large-open', unavailable: 'retired 2026-07-15' },
  rnj:      { provider: 'ollama-cloud', model: 'rnj-1:8b-cloud',                 tier: 'large-open', unavailable: 'retired 2026-06-30' },

  // --- small models, served locally by Ollama (all resident; ~8 GB for the five) ---
  qwen:       { provider: 'ollama', model: process.env.OLLAMA_SMALL_MODEL   || 'qwen3.5:2b',            tier: 'small-local' },
  gemma:      { provider: 'ollama', model: process.env.OLLAMA_SMALL_MODEL_2 || 'gemma3:1b',             tier: 'small-local' },
  llama:      { provider: 'ollama', model: process.env.OLLAMA_SMALL_MODEL_3 || 'llama3.2:1b',          tier: 'small-local' },
  smollm:     { provider: 'ollama', model: process.env.OLLAMA_SMALL_MODEL_4 || 'smollm2:1.7b',         tier: 'small-local' },
  granite:    { provider: 'ollama', model: process.env.OLLAMA_SMALL_MODEL_5 || 'granite3.1-dense:2b',  tier: 'small-local' },

  // --- mid-size, still comfortably resident locally ---
  'qwen3-4b': { provider: 'ollama', model: 'qwen3:4b',    tier: 'mid-local' },
  'gemma4-e4b': { provider: 'ollama', model: 'gemma4:e4b', tier: 'mid-local' },

  // --- a size ladder, all resident locally. Used for the scaling question. ---
  'granite-2b':   { provider: 'ollama', model: 'granite3.2:2b',              tier: 'small-local' },
  'exaone-2.4b':  { provider: 'ollama', model: 'exaone3.5:2.4b',             tier: 'small-local' },
  'r1-1.5b':      { provider: 'ollama', model: 'deepseek-r1:1.5b',           tier: 'small-local' },
  'qwen3-1.7b':   { provider: 'ollama', model: 'qwen3:1.7b',                 tier: 'small-local' },

  /**
   * qwen2.5:3b is the BASE MODEL of the CTF project's fine-tune (`ctf-bot`). Seating
   * both makes the transfer question a paired comparison rather than a guess: same
   * architecture, same size, same quantisation family, differing only by a LoRA
   * trained on capture-the-flag replays. Without the base model present, any
   * difference in ctf-bot's score could just be "3B models do this."
   */
  'qwen2.5-3b':   { provider: 'ollama', model: 'qwen2.5:3b',                 tier: 'mid-local' },
  'llama3.2-3b':  { provider: 'ollama', model: 'llama3.2:3b',                tier: 'mid-local' },
  'gemma3-4b':    { provider: 'ollama', model: 'gemma3:4b',                  tier: 'mid-local' },
  'phi4-mini':    { provider: 'ollama', model: 'phi4-mini-reasoning:latest', tier: 'mid-local' },
  'nemotron-4b':  { provider: 'ollama', model: 'nemotron-mini:4b',           tier: 'mid-local' },

  'llama3.1-8b':  { provider: 'ollama', model: 'llama3.1:8b',                tier: 'upper-mid-local' },
  'qwen2.5-7b':   { provider: 'ollama', model: 'qwen2.5:7b',                 tier: 'upper-mid-local' },
  'mistral-7b':   { provider: 'ollama', model: 'mistral:latest',             tier: 'upper-mid-local' },
  'granite-8b':   { provider: 'ollama', model: 'granite3.1-dense:8b',        tier: 'upper-mid-local' },
  'exaone-7.8b':  { provider: 'ollama', model: 'exaone3.5:7.8b',             tier: 'upper-mid-local' },
  'olmo2-7b':     { provider: 'ollama', model: 'olmo2:7b',                   tier: 'upper-mid-local' },

  /**
   * Large and NON-reasoning, as the control for gpt-oss:20b. If the two land together,
   * size is what mattered; if they diverge, the reasoning mode is doing the work — and
   * that distinction is invisible with only one large model on the board.
   */
  'mistral-small-24b': { provider: 'ollama', model: 'mistral-small:latest',  tier: 'large-local' },
  'phi4-reasoning':    { provider: 'ollama', model: 'phi4-reasoning:latest', tier: 'large-local' },

  /**
   * Large open model, resident locally. 13.8 GB of weights — it fits in this
   * machine's memory without any streaming, which makes it the cheap way to get a
   * `large-local` arm and the correct control for Swiftlet: if a resident 20B and a
   * streamed 35B score the same, the streaming architecture bought nothing for this
   * task and only the parameter count mattered.
   */
  'gpt-oss-20b': { provider: 'ollama', model: 'gpt-oss:20b', tier: 'large-local' },

  /**
   * The CTF project's own fine-tune: Qwen2.5-3B + LoRA on tournament replays,
   * quantised to Q4_K_M. Seated here untouched — it was trained on capture-the-flag
   * transcripts, not Mafia, so it tests transfer rather than skill. If it beats
   * stock 2-3B models at social deduction, that is a finding about what replay
   * fine-tuning generalises to; if it does not, that is the more likely and equally
   * reportable result.
   */
  'ctf-bot': { provider: 'ollama', model: 'ctf-custom-q4:latest', tier: 'small-local-tuned' },

  /**
   * Large MoE models running locally through Swiftlet's OpenAI-compatible server
   * (github.com/leonickson1/Swiftlet). Apple Silicon only.
   *
   * This is a third tier, and for this benchmark it is the interesting one: ~3B
   * active parameters out of 35B/80B total, so per Swiftlet's own README these
   * models "chat and write like large models but recall facts like small ones".
   * Mafia needs almost no factual recall and a great deal of writing and
   * transcript reasoning, which is the half that survives. Whether that holds is
   * measured here, not assumed.
   *
   * Start the server first:
   *   swiftlet-server --model ~/models/qwen3.6-35b.qpack --port 8080
   */
  'swiftlet-35b': {
    provider: 'openai-compatible',
    model: process.env.SWIFTLET_MODEL || 'qwen3.6-35b',
    baseUrl: process.env.SWIFTLET_BASE_URL || 'http://localhost:8080/v1',
    apiKeyEnv: null,
    tier: 'large-local',
  },
  'swiftlet-80b': {
    provider: 'openai-compatible',
    model: process.env.SWIFTLET_MODEL_80B || 'qwen3-next-80b',
    baseUrl: process.env.SWIFTLET_BASE_URL || 'http://localhost:8080/v1',
    apiKeyEnv: null,
    tier: 'large-local',
  },

  /**
   * Rule-based baseline. Not a language model: a few dozen lines of policy over the
   * same ledger the models see. Every claim about a model playing Mafia "well" is
   * meaningless without it — exp 032 in the trainingResearch repo found a bounded
   * agentic domain needed no learned component at all, and this checks whether
   * social deduction is another one.
   */
  scripted: { provider: 'scripted', model: 'rule-based-v1', tier: 'baseline' },
};

/** Named rosters. Length determines the player count and therefore the role setup. */
const ROSTERS = {
  // No API keys, no GPU — exercises the engine end to end in a couple of seconds.
  test: ['scripted', 'scripted', 'scripted', 'scripted', 'scripted', 'scripted', 'scripted'],

  // Single-tier fields: how a tier does against itself.
  api: ['claude', 'gpt', 'gemini', 'grok', 'perplexity', 'claude', 'gpt'],

  /**
   * Open question 4 — the check that validates every other number in RESULTS.md.
   * Frontier models seated with the rule-based control and one local anchor
   * (qwen3-4b) so the result links back to runs 007-011 through the anchor.
   */
  'frontier-vs-control': ['claude', 'gpt', 'gemini', 'grok', 'qwen3-4b', 'scripted', 'scripted'],

  /**
   * The affordable substitute for `frontier-vs-control`, which is blocked on unfunded
   * API accounts. Seats gpt-oss:120b beside gpt-oss:20b — the SAME model family at 6x
   * the parameters — so scale is compared within a family rather than across vendors,
   * with the control on the board and qwen3-4b anchoring back to runs 007-011.
   */
  'scale-vs-control': ['gpt-oss-120b', 'gpt-oss-120b', 'nemotron', 'gpt-oss-20b', 'qwen3-4b', 'scripted', 'scripted'],
  cloud: ['gpt-oss-120b', 'gpt-oss-120b', 'nemotron', 'nemotron', 'qwen3-4b', 'scripted', 'scripted'],
  local: ['qwen', 'gemma', 'llama', 'smollm', 'granite', 'qwen', 'gemma'],

  /**
   * The headline experiment: two small local models seated among five stronger ones.
   * A mixed field is the only way to measure deception *and* detection on the same
   * board — a small-vs-small game tells you they are bad at it together, which is a
   * different and much weaker claim.
   */
  mixed: ['claude', 'gpt-oss-120b', 'nemotron', 'qwen', 'gemma', 'qwen3-4b', 'scripted'],

  /** Small models plus the rule-based baseline, to separate skill from format. */
  'local-vs-baseline': ['qwen', 'gemma', 'llama', 'smollm', 'granite', 'scripted', 'scripted'],

  /**
   * The fully-local headline experiment: three size tiers plus the control on one
   * board, no API keys and no network. This is the roster that actually answers "how
   * big does a local model need to be to play social deduction" — a small-vs-small
   * field would only show they are bad at it together, which is a much weaker claim.
   */
  'local-tiers': ['gpt-oss-20b', 'gpt-oss-20b', 'qwen3-4b', 'qwen', 'gemma', 'scripted', 'scripted'],

  /**
   * Does CTF-replay fine-tuning transfer? Paired against its own base model, so a
   * difference cannot be explained by size alone.
   */
  'ctf-transfer': ['ctf-bot', 'ctf-bot', 'qwen2.5-3b', 'qwen2.5-3b', 'gemma', 'granite', 'scripted'],

  /**
   * The size ladder: 1B -> 2B -> 4B -> 8B -> 20B plus the control, one seat each, all
   * local and all resident. This is the roster that answers "how big does a local model
   * need to be", which no single-tier field can.
   */
  /**
   * The ladder is deliberately SPLIT across three batches instead of seating every size
   * at once. All six sizes together is ~39 GB of resident weights, which does not fit
   * the batch memory budget on a machine that is also doing other work.
   *
   * `llama3.1-8b` and `qwen3-4b` appear in all three as shared anchors, at the same
   * seed. That makes the large models comparable to each other *through* the anchors
   * (a common-reference design) without ever holding both 20B+ models in memory
   * simultaneously — which is the comparison `reasoning-vs-not` wanted and could not
   * afford directly.
   */
  'ladder-small': ['gemma', 'qwen', 'granite-2b', 'qwen3-4b', 'llama3.1-8b', 'scripted', 'scripted'],
  'ladder-gptoss': ['gpt-oss-20b', 'gpt-oss-20b', 'llama3.1-8b', 'qwen3-4b', 'qwen', 'scripted', 'scripted'],
  'ladder-mistral': ['mistral-small-24b', 'mistral-small-24b', 'llama3.1-8b', 'qwen3-4b', 'qwen', 'scripted', 'scripted'],

  /**
   * Reasoning vs non-reasoning at matched scale, since the reasoning models needed a
   * different integration and that may cost or buy them something at play time too.
   */
  'reasoning-vs-not': ['qwen3-4b', 'qwen3-4b', 'gemma3-4b', 'gemma3-4b', 'phi4-mini', 'llama3.2-3b', 'scripted'],

  /**
   * Experiment 011: everything on ledger except one seat, and the mirror. The odd seat
   * is compared against its own duplicate inside the SAME games, so divergence is shared.
   */
  'ctx-one-full': ['qwen', 'qwen@full', 'qwen3-4b', 'qwen3-4b@full', 'gpt-oss-20b', 'scripted', 'scripted'],
  'ctx-one-ledger': ['qwen@full', 'qwen', 'qwen3-4b@full', 'qwen3-4b', 'gpt-oss-20b', 'scripted', 'scripted'],

  /**
   * TEN distinct models, one seat each, for the long documented batch. Composition is
   * dictated by what actually runs: the frontier APIs are unfunded (012), so the two
   * hosted seats are the Ollama Cloud models that answered, and the rest are local.
   *
   * That is a better spread than ten same-tier models anyway — it covers 1B to 120B plus
   * the rule-based control on one board, so scale is a within-batch comparison instead of
   * a cross-session one, which run 010 showed is the only safe kind.
   *
   * Local resident weights ~28 GB (the two cloud seats cost none), inside the 40 GB
   * budget. Ten players means 3 Mafia, 1 Doctor, 1 Detective, 5 Villagers.
   */
  'ten-model': [
    'gpt-oss-120b',   // large-open, HOSTED — costs no local memory
    'nemotron',       // large-open, HOSTED — costs no local memory
    'llama3.1-8b',    // upper-mid-local, ~7.4 GB resident
    'qwen3-4b',       // mid-local, ~3.8 GB — the anchor back to runs 007-011
    'qwen2.5-3b',     // mid-local, ~2.9 GB
    'qwen',           // small-local 2B, ~4.1 GB
    'granite',        // small-local 2B, ~2.4 GB
    'exaone-2.4b',    // small-local 2.4B, ~2.5 GB
    'gemma',          // small-local 1B, ~1.2 GB
    'scripted',       // the control, which every claim is measured against
  ],

  /**
   * Memory-safe variant, and the only shape that survives a machine with no headroom.
   *
   * Runs 013 and 013b both died to the OS: measured mid-failure, the machine had **0.6 GB
   * free and swap 93% full** from processes outside this project, so no local-model roster
   * of any size was going to survive. HOSTED seats cost zero local memory, so this roster
   * puts eight of ten seats on models that need none — one small local anchor and the
   * control are the only local cost (~4 GB).
   *
   * NO LOCAL SEATS AT ALL. This roster originally kept one (`qwen3-4b`) as the anchor
   * back to runs 007-011, but local inference is itself broken on this machine: Ollama's
   * llama runner segfaults on load (`exit status 2`) with 0.4 GB free and swap at 51 of
   * 52 GB, so a 2.5 GB model will not load. **Losing the anchor is a real cost** — this
   * batch cannot be compared to 007-011 except through the rule-based control, which is
   * the same policy in both and therefore the only common reference left.
   *
   * The price is distinct models: **one plus the control**. nemotron was dropped after
   * measurement, not preference: at ~40 s/call versus gpt-oss:120b's ~7 s it consumed
   * most of the wall-clock, and it was also the worst model for truncation (11% strict
   * decision capture), so it cost the most and contributed the least trustworthy data.
   * `hosted-two-model` keeps it for when time is not the constraint.
   *
   * What remains is still a real experiment, and arguably the one that matters most while
   * the frontier accounts are unfunded: **does the best hosted model available beat a few
   * dozen lines of rule-based policy?** At 100 games gpt-oss:120b reaches n~800
   * accusations against the control's n~200 — the cleanest read on open question 4 that
   * this machine can produce. What it buys is n. Over 100 games
   * gpt-oss:120b reaches n~400 accusations and nemotron n~300 — far past the +/-0.09 noise
   * floor, and enough to settle whether a large hosted model clears the control, which is
   * the closest available proxy for open question 4 while the frontier accounts are unfunded.
   */
  /**
   * All-cloud, four distinct models plus the control, chosen on MEASURED latency so a
   * 100-game batch actually finishes: gemma4 0.5 s, minimax-m3 2.8 s, gpt-oss:120b 3.7 s.
   * nemotron-3-super (168 s/call) and nemotron-3-ultra (40 s) are excluded — one seat of
   * nemotron-ultra alone costs more wall-clock than every other seat combined, and the
   * earlier three-seat nemotron roster made night 1 take ten minutes.
   *
   * Seat counts come from latency measured UNDER LOAD, not from single-call probes.
   * The probe said minimax-m3 was 2.8 s; in a running game it averages **19.4 s**, which
   * would have made a 100-game batch ~23 hours. Same error as DEFECT 5 — a figure taken
   * from a toy request is not a calibration. Measured in-game: gemma4 2.0 s,
   * gpt-oss:120b 6.0 s, minimax-m3 19.4 s.
   *
   * So the fast models take the seats and minimax-m3 keeps one, for coverage rather than
   * volume: ~4.5 min/game, 100 games in ~7 hours, with gpt-oss:120b at n~400 accusations
   * against the control's n~200.
   */
  'cloud-ten': [
    'gpt-oss-120b', 'gpt-oss-120b', 'gpt-oss-120b', 'gpt-oss-120b',
    'gemma4-cloud', 'gemma4-cloud', 'gemma4-cloud',
    'minimax-m3',
    'scripted', 'scripted',
  ],

  'hosted-heavy': [
    'gpt-oss-120b', 'gpt-oss-120b', 'gpt-oss-120b', 'gpt-oss-120b',
    'gpt-oss-120b', 'gpt-oss-120b', 'gpt-oss-120b', 'gpt-oss-120b',
    'scripted', 'scripted',
  ],

  /**
   * Same shape but keeping nemotron as a second model, for when wall-clock is not the
   * binding constraint. At ~40 s/call against gpt-oss:120b's ~7 s, three nemotron seats
   * made a 100-game batch take days rather than hours (measured: night 1 alone ran ~10
   * minutes), so it is off the default path.
   */
  'hosted-two-model': [
    'gpt-oss-120b', 'gpt-oss-120b', 'gpt-oss-120b', 'gpt-oss-120b', 'gpt-oss-120b',
    'nemotron', 'nemotron', 'nemotron',
    'scripted', 'scripted',
  ],

  /**
   * gpt-oss:20b is deliberately NOT in `ten-model`: at ~14 GB resident it is more than
   * half the local budget on its own, and including it is what killed run 013 at game 14.
   * The 20B-vs-120B same-family comparison it enables belongs in its own small batch,
   * where it fits — that is `scale-vs-control`.
   */

  /** Eight distinct mid-size models, one seat each — widest single-batch coverage. */
  wide: ['qwen2.5-3b', 'llama3.2-3b', 'gemma3-4b', 'granite-2b', 'exaone-2.4b', 'qwen3-4b', 'nemotron-4b', 'scripted'],

  /**
   * Local-only field spanning the resident and streamed large tiers. Needs a running
   * Swiftlet server on port 8080 in addition to Ollama; gpt-oss-20b is seated beside
   * it deliberately, as the resident-vs-streamed comparison.
   */
  swiftlet: ['swiftlet-35b', 'swiftlet-35b', 'gpt-oss-20b', 'qwen3-4b', 'qwen', 'gemma', 'scripted'],
};

/**
 * In-game personas. Deliberately not model names: an agent that could tell which
 * seat held which model would play the metagame instead of the game. Distinct first
 * letters so a partial name from a sloppy model resolves unambiguously.
 */
const PERSONAS = ['Alice', 'Bob', 'Carol', 'Dave', 'Erin', 'Frank', 'Grace', 'Henry', 'Iris', 'Jack'];

function resolveRoster() {
  const explicit = opt('models');
  if (explicit) {
    return explicit.split(',').map((m) => m.trim()).filter(Boolean);
  }

  const named =
    opt('roster') ||
    (flag('test') && 'test') ||
    (flag('api') && 'api') ||
    (flag('cloud') && 'cloud') ||
    (flag('local') && 'local') ||
    (flag('mixed') && 'mixed') ||
    (flag('swiftlet') && 'swiftlet') ||
    process.env.ROSTER ||
    'test';

  const roster = ROSTERS[named];
  if (!roster) {
    throw new Error(
      `Unknown roster "${named}". Available: ${Object.keys(ROSTERS).join(', ')} — or pass --models=a,b,c`
    );
  }
  return [...roster];
}

/** Build the seat list: persona + the model that plays it. */
function buildSeats() {
  const roster = resolveRoster();

  if (roster.length > PERSONAS.length) {
    throw new Error(`Roster of ${roster.length} exceeds ${PERSONAS.length} available personas.`);
  }

  const counts = {};
  return roster.map((rawKey, i) => {
    /**
     * `key@context` overrides the context mode for that seat alone — e.g.
     * `qwen@full` among otherwise-ledger seats.
     *
     * This exists because run 008 could not attribute its own result: it switched every
     * seat from ledger to full at once, so the games diverged and the rule-based control
     * moved by as much as the models did. Varying ONE seat keeps trajectory divergence
     * shared across all seats in the same game, where it cancels instead of confounding.
     */
    const [key, seatContext] = rawKey.split('@');
    const entry = MODELS[key];
    if (!entry) {
      throw new Error(`Unknown model "${key}". Available: ${Object.keys(MODELS).join(', ')}`);
    }
    if (entry.unavailable) {
      throw new Error(`Model "${key}" is unavailable: ${entry.unavailable}. Remove it from the roster.`);
    }
    if (seatContext && !['ledger', 'full'].includes(seatContext)) {
      throw new Error(`Unknown context mode "${seatContext}" for seat "${key}". Use ledger or full.`);
    }
    // Same model in two seats gets a suffixed id so per-seat results stay separable
    // while the tier/model grouping still collapses them.
    counts[key] = (counts[key] || 0) + 1;
    const id = counts[key] > 1 ? `${key}#${counts[key]}` : key;
    return {
      id,
      key,
      name: PERSONAS[i],
      provider: entry.provider,
      model: entry.model,
      tier: entry.tier,
      baseUrl: entry.baseUrl || null,
      // null = follow the global --context setting
      contextMode: seatContext || null,
    };
  });
}

/**
 * Seat building can fail on a typo'd roster or model name. It happens at module load,
 * so an uncaught throw here surfaces as a raw stack trace before anything has printed
 * — and it would also break `--help`, which is exactly what someone reaches for after
 * mistyping a name. Captured instead and reported by index.js.
 */
let seats = [];
let configError = null;
try {
  seats = buildSeats();
} catch (err) {
  configError = err.message;
}

const CONFIG = {
  seats,
  configError,

  game: {
    contextMode: opt('context', process.env.CONTEXT_MODE || 'ledger'),
    /**
     * "json" constrains decoding to a per-request JSON schema; "text" uses the
     * KEY: value contract. JSON is the default because the text contract is
     * structurally broken for reasoning models — see src/agents/schemas.js. Keep
     * "text" available so the two are comparable rather than one silently replacing
     * the other.
     */
    outputMode: opt('output', process.env.OUTPUT_MODE || 'json'),
    /** Enum-constrain targets to living players. Off: it zeroes state-tracking metrics. */
    strictTargets: flag('strict-targets') || process.env.STRICT_TARGETS === 'true',
    /**
     * Ceiling on total resident model weights, in GB. This machine has 64 GB but runs
     * other work, so the batch budget is smaller than the hardware. Exceeding it does
     * not fail loudly — Ollama starts evicting and reloading models between turns, and
     * the latency column becomes a measure of disk throughput rather than of the model.
     * That is a silent data-quality failure, so preflight checks it.
     */
    memBudgetGb: parseFloat(opt('mem-budget', process.env.MEM_BUDGET_GB || '40')),
    discussionRounds: parseInt(opt('rounds', process.env.DISCUSSION_ROUNDS || '1'), 10),
    /** Defense phase before the vote. On by default; --no-defense disables it. */
    defense: !flag('no-defense') && process.env.DEFENSE !== 'false',
    maxDays: parseInt(opt('max-days', process.env.MAX_DAYS || '12'), 10),
    revealRoleOnDeath: (process.env.REVEAL_ROLE_ON_DEATH || 'true') !== 'false' && !flag('no-reveal'),
    seed: opt('seed', process.env.SEED || ''),
    games: parseInt(opt('games', '1'), 10),
    loop: flag('loop'),
    logDir: process.env.LOG_DIR || './logs',
  },

  api: {
    openai: { apiKey: process.env.OPENAI_API_KEY, baseUrl: 'https://api.openai.com/v1' },
    claude: { apiKey: process.env.ANTHROPIC_API_KEY },
    gemini: { apiKey: process.env.GEMINI_API_KEY },
    grok: { apiKey: process.env.XAI_API_KEY, baseUrl: 'https://api.x.ai/v1' },
    perplexity: { apiKey: process.env.PERPLEXITY_API_KEY, baseUrl: 'https://api.perplexity.ai' },
    ollama: { baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434' },
    ollamaCloud: { apiKey: process.env.OLLAMA_API_KEY },
  },

  MODELS,
  ROSTERS,
};

/** Which env vars must be set for the current roster. */
function missingKeys() {
  const needed = {
    openai: ['OPENAI_API_KEY', CONFIG.api.openai.apiKey],
    claude: ['ANTHROPIC_API_KEY', CONFIG.api.claude.apiKey],
    gemini: ['GEMINI_API_KEY', CONFIG.api.gemini.apiKey],
    grok: ['XAI_API_KEY', CONFIG.api.grok.apiKey],
    perplexity: ['PERPLEXITY_API_KEY', CONFIG.api.perplexity.apiKey],
    'ollama-cloud': ['OLLAMA_API_KEY', CONFIG.api.ollamaCloud.apiKey],
  };

  const missing = new Set();
  for (const seat of CONFIG.seats) {
    const check = needed[seat.provider];
    if (check && !check[1]) missing.add(`${check[0]} (needed by ${seat.key})`);
  }
  return [...missing];
}

module.exports = { CONFIG, MODELS, ROSTERS, PERSONAS, missingKeys, flag, opt };
