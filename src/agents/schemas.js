/**
 * JSON schemas for the response contract.
 *
 * Why this exists. The original contract was free text — `KEY: value` lines, ported
 * from the CTF project where it worked well. It fails on reasoning models for a
 * structural reason: they reason in proportion to how much context they are handed, so
 * as the game's ledger grows the reply exhausts its token budget before emitting any
 * field. Measured on gpt-oss:20b, the VOTE field arrived in 0 of 5 votes; raising the
 * cap to 2,500 tokens only moved the failure a day later and pushed one vote to 91
 * seconds. Reordering so the decision came first helped (field capture 6/18 → 9/13)
 * but left 54% of replies truncated.
 *
 * Schema-constrained decoding fixes it outright, on the same prompts:
 *
 *   model         text contract              schema
 *   gpt-oss:20b   91s, 2500 tok, no field    7.4s,  96 tok, legal vote
 *   qwen3:4b      43s, truncated             4.0s, 142 tok, legal vote
 *   gemma3:1b     100% unparseable           valid JSON, legal vote
 *   llama3.2:1b   51% invalid moves          valid JSON, legal vote
 *
 * All four returned done_reason "stop" with coherent reasoning, at 20-30x fewer output
 * tokens. The mechanism is not subtle: the grammar cannot emit a document that lacks a
 * required property, so reasoning is unable to crowd the decision out.
 *
 * This was worth checking rather than assuming, because exp 015 in the trainingResearch
 * repo found the opposite for grammar-constrained decoding — "masking a not-near-valid
 * distribution yields degenerate loops instead of syntax errors." That result stands;
 * it does not transfer here. It concerned character-level grammar masking over a weak
 * from-scratch LM whose distribution was nowhere near valid. These are instruction-tuned
 * models emitting a handful of short fields, so the constrained distribution is one they
 * were already close to.
 *
 * TARGETS ARE DELIBERATELY NOT ENUM-CONSTRAINED. Restricting the target property to the
 * living roster would make an illegal move impossible — and would silently zero out
 * `invalid_move_rate` and `named_dead_player`, which are the metrics that measure
 * whether a model tracks a shrinking roster. That is a headline finding for small
 * models (llama3.2:1b and gemma3:1b substituted ~51% of moves at random; qwen3.5:2b
 * named a dead player 16 times), and a schema that made those numbers zero would
 * present a constraint as a capability. The bug being fixed is "the field never
 * arrives", not "the target is illegal", so the schema fixes only that.
 *
 * `--strict-targets` opts into the enum anyway, for anyone who wants every game
 * guaranteed playable and accepts that the state-tracking metrics go to zero.
 */

/** Field name -> JSON property name and type. */
const FIELD_SPEC = {
  VOTE: { key: 'vote', type: 'string', targetLike: true },
  TARGET: { key: 'target', type: 'string', targetLike: true },
  SUSPECT: { key: 'suspect', type: 'string', targetLike: true },
  CONFIDENCE: { key: 'confidence', type: 'number' },
  STATEMENT: { key: 'statement', type: 'string' },
  MESSAGE: { key: 'message', type: 'string' },
  THINKING: { key: 'thinking', type: 'string' },
};

/**
 * Build a schema for a request.
 *
 * Property order follows `expect`, which puts the decision first. Constrained decoders
 * generally emit properties in schema order, so the decision is committed before the
 * reasoning string — the same robustness the text contract got from field ordering,
 * kept here as belt and braces.
 *
 * @param {string[]} expect field names, decision-first
 * @param {object} opts
 * @param {string[]} opts.legalNames used only when strictTargets is on
 * @param {boolean} opts.strictTargets enum-constrain target-like fields
 */
function schemaFor(expect, { legalNames = [], strictTargets = false } = {}) {
  const properties = {};
  const required = [];

  for (const field of expect) {
    const spec = FIELD_SPEC[field];
    if (!spec) continue;

    const prop = { type: spec.type };

    if (spec.type === 'number') {
      prop.minimum = 0;
      prop.maximum = 1;
    }
    if (spec.targetLike && strictTargets && legalNames.length) {
      prop.enum = [...legalNames];
    }

    properties[spec.key] = prop;
    required.push(spec.key);
  }

  return { type: 'object', properties, required };
}

/**
 * Convert a parsed JSON object back into the uppercase field shape the engine and
 * metrics already consume, so nothing downstream needs to know which contract produced
 * it. Both paths converge here.
 */
function fieldsFromJson(obj, expect) {
  const fields = {};
  if (!obj || typeof obj !== 'object') return fields;

  for (const field of expect) {
    const spec = FIELD_SPEC[field];
    if (!spec) continue;

    let value = obj[spec.key];
    // Tolerate a model that used the uppercase field name as the JSON key.
    if (value === undefined) value = obj[field];
    if (value === undefined || value === null) continue;

    if (spec.type === 'number') {
      const n = typeof value === 'number' ? value : parseFloat(String(value).replace('%', ''));
      if (!Number.isNaN(n)) fields[field] = n > 1 ? n / 100 : n;
    } else {
      const s = String(value).trim();
      if (s) fields[field] = s;
    }
  }

  return fields;
}

/**
 * Extract a JSON object from a model reply.
 *
 * Constrained decoding returns bare JSON, but a provider that ignored the schema may
 * still wrap it in prose or a code fence, and that case must not be scored as a
 * failure when the data is right there.
 */
function tryParseJson(text) {
  if (!text) return null;
  let body = text.trim();

  const fenced = body.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenced) body = fenced[1].trim();

  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // fall through to a brace scan
  }

  /**
   * Salvage a TRUNCATED JSON document.
   *
   * DEFECT 17. Constrained decoding guarantees the schema's shape, not that generation
   * finishes: when the token budget runs out mid-string the document is unparseable in
   * its entirety, so every field is lost — including the decision sitting complete at
   * the front. Measured on run 015: nemotron-3-super lost **50%** of its replies this
   * way, and the resulting 0.281 "invalid move rate" was mostly truncation, not the
   * model failing to choose.
   *
   * This also silently voided the earlier fix. Decision-first field ordering was added
   * so a truncated reply would still carry the move — true for the `KEY: value` contract,
   * false for JSON, where a cut anywhere invalidates the whole document. **Switching
   * contracts retired a mitigation without retiring the problem it solved**, and nothing
   * re-checked the assumption.
   *
   * So: close whatever is still open — an unterminated string, then any open brackets —
   * and re-parse. Fields completed before the cut survive; the one being written when
   * the budget ran out is dropped, which is the correct outcome for a partial value.
   */
  const salvaged = salvageTruncatedJson(body);
  if (salvaged) return salvaged;

  // First balanced {...} in the reply, respecting strings and escapes so a brace
  // inside a statement does not end the scan early.
  const start = body.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(body.slice(start, i + 1));
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
        } catch {
          return null;
        }
        return null;
      }
    }
  }
  return null;
}

/**
 * Repair a JSON document cut off mid-generation. Returns the parsed object, or null if
 * the text is not recoverable (not truncation — genuinely malformed).
 */
function salvageTruncatedJson(text) {
  if (!text.startsWith('{')) return null;

  let depth = 0;
  let inStr = false;
  let esc = false;
  const stack = [];

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{' || ch === '[') { stack.push(ch); depth++; }
    else if (ch === '}' || ch === ']') { stack.pop(); depth--; }
  }

  // A complete document has nothing open; nothing to salvage.
  if (!inStr && depth === 0) return null;

  let repaired = text;
  if (inStr) repaired += '"';
  // Drop a trailing partial key/value pair so the close is syntactically valid.
  repaired = repaired.replace(/,\s*"[^"]*"\s*:?\s*$/, '').replace(/,\s*$/, '');
  if (!repaired.endsWith('"') && /:\s*$/.test(repaired)) repaired = repaired.replace(/\s*"[^"]*"\s*:\s*$/, '');
  for (let i = stack.length - 1; i >= 0; i--) repaired += stack[i] === '{' ? '}' : ']';

  try {
    const parsed = JSON.parse(repaired);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    return null;
  }
  return null;
}

module.exports = { schemaFor, fieldsFromJson, tryParseJson, salvageTruncatedJson, FIELD_SPEC };
