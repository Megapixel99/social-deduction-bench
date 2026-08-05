const { logApiCall, logAgentTurn } = require('../logger.js');

/**
 * Output token budget per request kind.
 *
 * A single global cap is wrong in both directions at once. Measured on
 * gpt-oss:20b: a shared 1024-token cap was hit exactly on a day statement, cutting
 * STATEMENT off mid-sentence — which would have scored a capable model as a poor
 * speaker for a reason that had nothing to do with the model. The same 1024 spent on
 * a night action, where the entire answer is a name plus a sentence of reasoning, is
 * most of the wall-clock cost of a batch.
 *
 * So: decisions get a small budget, speech gets a large one.
 */
const MAX_TOKENS = {
  statement: 1400,
  mafia_chat: 600,
  vote: 500,
  night_kill: 500,
  night_investigate: 500,
  night_protect: 500,
  default: 800,
};

/**
 * Base class for all player agents. Ported from the CTF project's base-agent and
 * kept deliberately close to it: subclasses implement only `callModel(messages)`
 * returning { text, thinking, tokensUsed }, and every provider quirk stays inside
 * its own adapter.
 *
 * What is different here is the response contract. The CTF agent parsed one field
 * (a shell command) and the container was the judge of whether it was any good.
 * A Mafia turn has two channels that must be read separately:
 *
 *   the DECISION channel — a vote, a night target, a named prime suspect. Machine
 *   checkable against ground truth, and bounded: the answer is always one of a
 *   handful of living players.
 *
 *   the SPEECH channel — free text the other agents will read. Unbounded, and only
 *   judgeable by its effect on other players.
 *
 * Keeping them apart is the point of the benchmark. It lets a model be measured as
 * a reasoner and as a persuader independently, and it lets the two channels be
 * served by *different* models — which is the cheapest way to find out which half
 * of social deduction a small local model can actually do.
 */
class BaseAgent {
  constructor({ playerName, provider, model, contextMode = 'ledger' }) {
    this.playerName = playerName;
    this.provider = provider;
    this.model = model;
    this.contextMode = contextMode;

    /** Rolling record of this agent's own private reasoning, fed back next turn. */
    this.notes = [];
    this.turnCount = 0;

    /** Per-agent protocol failure counters — reported as a first-class metric. */
    this.stats = {
      calls: 0,
      apiErrors: 0,
      unparseable: 0,
      truncated: 0,
      namedDeadPlayer: 0,
      namedUnknownPlayer: 0,
      namedSelfIllegally: 0,
      fellBackToRandom: 0,
      totalTokens: 0,
      totalLatencyMs: 0,
    };
  }

  /**
   * @param {Array} messages
   * @param {{maxTokens: number}} opts
   */
  async callModel(messages, opts) {
    throw new Error('callModel() must be implemented by a provider subclass');
  }

  /**
   * One model request. Returns { fields, raw, error }.
   *
   * @param {object} req
   * @param {string} req.kind          e.g. 'statement', 'vote', 'night_kill'
   * @param {string} req.systemPrompt
   * @param {string} req.userPrompt
   * @param {string[]} req.expect       field names to extract, e.g. ['THINKING','VOTE']
   */
  async ask({ kind, systemPrompt, userPrompt, expect }) {
    this.turnCount++;
    this.stats.calls++;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];

    const maxTokens = MAX_TOKENS[kind] ?? MAX_TOKENS.default;

    const started = Date.now();
    let response;
    try {
      response = await this.callModel(messages, { maxTokens });
    } catch (err) {
      this.stats.apiErrors++;
      const detail = err.message || String(err);
      console.error(`  [${this.playerName}] API error on ${kind}: ${detail}`);
      logAgentTurn({
        player: this.playerName,
        provider: this.provider,
        model: this.model,
        kind,
        error: detail,
      });
      return { fields: {}, raw: '', error: detail };
    }
    const latencyMs = Date.now() - started;
    this.stats.totalLatencyMs += latencyMs;
    this.stats.totalTokens += response.tokensUsed || 0;

    logApiCall({
      player: this.playerName,
      provider: this.provider,
      model: this.model,
      kind,
      requestMessages: messages,
      responseText: response.text,
      tokensUsed: response.tokensUsed,
      latencyMs,
    });

    const fields = parseFields(response.text, expect, response.thinking);
    const missing = expect.filter((f) => f !== 'THINKING' && !fields[f]);
    if (missing.length) this.stats.unparseable++;

    // A reply that stopped because it ran out of budget rather than because the model
    // was finished is a truncation, not a bad answer. Counted separately so it can
    // never be mistaken for one — if this is non-zero the budget above is wrong, and
    // the affected model's speech-channel numbers are understated.
    if (response.tokensUsed && response.truncated) this.stats.truncated++;

    logAgentTurn({
      player: this.playerName,
      provider: this.provider,
      model: this.model,
      kind,
      fields,
      missing,
      raw: response.text,
      latencyMs,
      tokensUsed: response.tokensUsed,
    });

    return { fields, raw: response.text, error: null, latencyMs };
  }

  /** Keep the agent's own reasoning available to it next turn, bounded. */
  addNote(day, text) {
    if (!text) return;
    this.notes.push({ day, text: truncate(text.trim(), 400) });
    if (this.notes.length > 6) this.notes.shift();
  }

  /**
   * Resolve a model-produced name to a legal target.
   *
   * This is where a small model's game-state tracking gets measured. Naming a dead
   * player, a player who was never in the game, or itself when self-targeting is
   * illegal are all distinct failures and counted separately — a model that plays
   * competently but drifts on the roster is a different problem from one that
   * cannot reason, and averaging them into one "accuracy" number would hide that.
   *
   * @returns {{ name: string|null, violation: string|null }}
   */
  resolveTarget(raw, legalNames, { allNames = [], allowSelf = true } = {}) {
    if (!raw) return { name: null, violation: 'no_target_given' };

    const cleaned = raw
      .replace(/^[`*_\s"'-]+/, '')
      .replace(/[`*_\s"'.!?]+$/, '')
      .trim();

    const match = matchName(cleaned, legalNames);
    if (match) {
      if (!allowSelf && match === this.playerName) {
        this.stats.namedSelfIllegally++;
        return { name: null, violation: 'named_self_illegally' };
      }
      return { name: match, violation: null };
    }

    // Legal-target match failed. Distinguish "named someone dead" from "invented a
    // name" — the first means the model is a phase behind, the second means it is
    // not tracking the roster at all.
    const deadMatch = matchName(cleaned, allNames.filter((n) => !legalNames.includes(n)));
    if (deadMatch) {
      this.stats.namedDeadPlayer++;
      return { name: null, violation: 'named_dead_player' };
    }

    this.stats.namedUnknownPlayer++;
    return { name: null, violation: 'named_unknown_player' };
  }

  summary() {
    const s = this.stats;
    return {
      player: this.playerName,
      provider: this.provider,
      model: this.model,
      ...s,
      avgLatencyMs: s.calls ? Math.round(s.totalLatencyMs / s.calls) : 0,
    };
  }
}

// --- parsing ----------------------------------------------------------------

/**
 * Extract `KEY: value` fields from a model response.
 *
 * Written to be forgiving in exactly the ways models are actually sloppy —
 * markdown bold around the key, a code fence around everything, a missing final
 * field — because the alternative is discarding turns from weaker models and
 * silently making them look better than they are. Every repair is counted, so
 * "needed repairing" stays visible in the metrics instead of vanishing.
 */
function parseFields(text, expect, externalThinking) {
  const fields = {};
  if (!text) return fields;

  // Strip a wrapping code fence if the whole reply is inside one.
  let body = text.trim();
  const fenced = body.match(/^```(?:\w+)?\s*\n([\s\S]*?)\n?```$/);
  if (fenced) body = fenced[1].trim();

  const keyPattern = expect.map(escapeRegex).join('|');

  for (const key of expect) {
    // Capture up to the next expected key or the true end of the reply. Allows
    // markdown decoration around the key and an optional bullet before it.
    //
    // The terminator is `$(?![\s\S])` rather than `$`: the `m` flag is needed so a
    // key can be matched at the start of any line, but it also makes a bare `$`
    // match end-of-LINE, which silently truncated every multi-line STATEMENT to its
    // first sentence.
    const re = new RegExp(
      `^[\\s>*_-]*\\**\\s*${escapeRegex(key)}\\s*\\**\\s*:\\s*([\\s\\S]*?)` +
        `(?=\\n[\\s>*_-]*\\**\\s*(?:${keyPattern})\\s*\\**\\s*:|$(?![\\s\\S]))`,
      'im'
    );
    const m = body.match(re);
    if (m) {
      const value = m[1].trim().replace(/^\**|\**$/g, '').trim();
      if (value) fields[key] = value;
    }
  }

  if (externalThinking && !fields.THINKING) fields.THINKING = externalThinking;

  // A reply with no recognisable field at all is still worth using for the speech
  // channel — a model that ignores the format but says something coherent should
  // not be scored as silent. Decision fields are never guessed this way.
  if (!Object.keys(fields).length && body) {
    if (expect.includes('STATEMENT')) fields.STATEMENT = body;
    else if (expect.includes('MESSAGE')) fields.MESSAGE = body;
    fields.THINKING = fields.THINKING || body;
  }

  // Single-line decision fields sometimes arrive with trailing prose
  // ("Carol — she's been evasive"). Keep the first clause.
  for (const key of ['VOTE', 'TARGET', 'SUSPECT']) {
    if (fields[key]) fields[key] = fields[key].split('\n')[0].trim();
  }

  if (fields.CONFIDENCE) {
    const n = parseFloat(fields.CONFIDENCE.replace('%', ''));
    if (!Number.isNaN(n)) fields.CONFIDENCE = n > 1 ? n / 100 : n;
    else delete fields.CONFIDENCE;
  }

  return fields;
}

/** Exact -> case-insensitive -> whole-word -> unique-prefix name matching. */
function matchName(raw, candidates) {
  if (!raw || !candidates.length) return null;

  if (candidates.includes(raw)) return raw;

  const lower = raw.toLowerCase();
  const ci = candidates.find((c) => c.toLowerCase() === lower);
  if (ci) return ci;

  // The name appearing as a whole word inside a longer answer.
  const wordHits = candidates.filter((c) => new RegExp(`\\b${escapeRegex(c)}\\b`, 'i').test(raw));
  if (wordHits.length === 1) return wordHits[0];

  // A unique prefix ("Char" for "Charlie"). Ambiguous prefixes are rejected
  // rather than guessed — guessing would fabricate a decision the model did
  // not make and pollute the decision-channel metrics.
  const prefixHits = candidates.filter((c) => c.toLowerCase().startsWith(lower));
  if (prefixHits.length === 1) return prefixHits[0];

  return null;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function truncate(str, max) {
  if (!str) return '';
  return str.length <= max ? str : str.slice(0, max) + '...';
}

module.exports = { BaseAgent, parseFields, matchName, truncate, MAX_TOKENS };
