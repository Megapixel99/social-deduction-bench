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
  claude:     { provider: 'claude',       model: 'claude-sonnet-4-6',                tier: 'frontier' },
  gpt:        { provider: 'openai',       model: 'gpt-4o',                           tier: 'frontier' },
  gemini:     { provider: 'gemini',       model: 'gemini-2.5-pro-preview-05-06',     tier: 'frontier' },
  grok:       { provider: 'grok',         model: 'grok-3',                           tier: 'frontier' },
  perplexity: { provider: 'perplexity',   model: 'sonar-pro',                        tier: 'frontier' },

  // --- open models via Ollama Cloud (no local GPU) ---
  'gpt-oss':  { provider: 'ollama-cloud', model: process.env.CLOUD_MODEL_1 || 'gpt-oss:120b',                    tier: 'large-open' },
  'gemini3':  { provider: 'ollama-cloud', model: process.env.CLOUD_MODEL_2 || 'gemini-3-flash-preview:cloud',    tier: 'large-open' },
  glm:        { provider: 'ollama-cloud', model: process.env.CLOUD_MODEL_3 || 'glm-5.1:cloud',                   tier: 'large-open' },
  nemotron:   { provider: 'ollama-cloud', model: process.env.CLOUD_MODEL_4 || 'nemotron-3-super:cloud',          tier: 'large-open' },
  rnj:        { provider: 'ollama-cloud', model: process.env.CLOUD_MODEL_5 || 'rnj-1:8b-cloud',                  tier: 'large-open' },

  // --- small models, served locally by Ollama (all resident; ~8 GB for the five) ---
  qwen:       { provider: 'ollama', model: process.env.OLLAMA_SMALL_MODEL   || 'qwen3.5:2b',            tier: 'small-local' },
  gemma:      { provider: 'ollama', model: process.env.OLLAMA_SMALL_MODEL_2 || 'gemma3:1b',             tier: 'small-local' },
  llama:      { provider: 'ollama', model: process.env.OLLAMA_SMALL_MODEL_3 || 'llama3.2:1b',          tier: 'small-local' },
  smollm:     { provider: 'ollama', model: process.env.OLLAMA_SMALL_MODEL_4 || 'smollm2:1.7b',         tier: 'small-local' },
  granite:    { provider: 'ollama', model: process.env.OLLAMA_SMALL_MODEL_5 || 'granite3.1-dense:2b',  tier: 'small-local' },

  // --- mid-size, still comfortably resident locally ---
  'qwen3-4b': { provider: 'ollama', model: 'qwen3:4b',    tier: 'mid-local' },
  'gemma4-e4b': { provider: 'ollama', model: 'gemma4:e4b', tier: 'mid-local' },

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
  cloud: ['gpt-oss', 'gemini3', 'glm', 'nemotron', 'rnj', 'gpt-oss', 'gemini3'],
  local: ['qwen', 'gemma', 'llama', 'smollm', 'granite', 'qwen', 'gemma'],

  /**
   * The headline experiment: two small local models seated among five stronger ones.
   * A mixed field is the only way to measure deception *and* detection on the same
   * board — a small-vs-small game tells you they are bad at it together, which is a
   * different and much weaker claim.
   */
  mixed: ['claude', 'gpt-oss', 'gemini3', 'qwen', 'gemma', 'glm', 'nemotron'],

  /** Small models plus the rule-based baseline, to separate skill from format. */
  'local-vs-baseline': ['qwen', 'gemma', 'llama', 'smollm', 'granite', 'scripted', 'scripted'],

  /**
   * The fully-local headline experiment: three size tiers plus the control on one
   * board, no API keys and no network. This is the roster that actually answers "how
   * big does a local model need to be to play social deduction" — a small-vs-small
   * field would only show they are bad at it together, which is a much weaker claim.
   */
  'local-tiers': ['gpt-oss-20b', 'gpt-oss-20b', 'qwen3-4b', 'qwen', 'gemma', 'scripted', 'scripted'],

  /** Does CTF-replay fine-tuning transfer to a different social task? */
  'ctf-transfer': ['ctf-bot', 'ctf-bot', 'qwen', 'qwen3-4b', 'gemma', 'granite', 'scripted'],

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
  return roster.map((key, i) => {
    const entry = MODELS[key];
    if (!entry) {
      throw new Error(`Unknown model "${key}". Available: ${Object.keys(MODELS).join(', ')}`);
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
    discussionRounds: parseInt(opt('rounds', process.env.DISCUSSION_ROUNDS || '1'), 10),
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
