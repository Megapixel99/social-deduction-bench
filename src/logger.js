const { mkdirSync, appendFileSync, writeFileSync } = require('fs');
const { join } = require('path');
const { CONFIG } = require('./config.js');

/**
 * Session logging. Ported from the CTF project's logger with the same structure —
 * an append-only human-readable event log for watching a game, plus buffered JSON
 * written atomically at checkpoints for analysis.
 *
 * Two changes, both from things the CTF logs turned out to make hard:
 *
 * - `api.jsonl` is written as JSON Lines instead of one big array. The CTF logger
 *   held every request in memory and rewrote the whole file on each flush, which is
 *   fine for a 10-minute match and unpleasant for a long batch. Lines also survive
 *   a crash mid-run, where a truncated JSON array does not.
 *
 * - Writes go to a temp file and are renamed into place. That prior research
 *   found the same non-atomic-write bug in four separate state writers, including
 *   one where Ctrl-C during a save turned a 57.8 MB index into a 1.5 MB stump. A
 *   guard on the read path is a hint the write path is unprotected, so this one is
 *   protected up front.
 */

const { renameSync, existsSync, unlinkSync } = require('fs');

let sessionDir = null;
let sessionId = null;
let gameIndex = 0;

const buffers = {
  events: [],   // every structured event, in order
  turns: [],    // one entry per model request, decision fields only
};

function initSession() {
  sessionId = new Date().toISOString().replace(/[:.]/g, '-');
  sessionDir = join(CONFIG.game.logDir, `session-${sessionId}`);
  mkdirSync(sessionDir, { recursive: true });

  buffers.events = [];
  buffers.turns = [];
  gameIndex = 0;

  writeFileSync(join(sessionDir, 'events.log'), `=== AI Mafia session ${sessionId} ===\n\n`);
  console.log(`[Logger] Session: ${sessionDir}`);
  return sessionDir;
}

/** Start a new game within the session; keeps batch runs in one directory. */
function startGame(n) {
  gameIndex = n;
  readable(`\n########## GAME ${n} ##########\n`);
}

function logGameEvent(event) {
  const entry = { ts: new Date().toISOString(), game: gameIndex, kind: 'game_event', ...event };
  buffers.events.push(entry);
  if (event.message) readable(`[game] ${event.message}`);
  return entry;
}

function logPhase({ day, phase }) {
  buffers.events.push({ ts: new Date().toISOString(), game: gameIndex, kind: 'phase', day, phase });
  readable(`\n--- day ${day} / ${phase} ---`);
}

/**
 * One model request, reduced to what analysis needs: the decision fields, whether
 * the format held, and cost. The raw response text is truncated here and kept in
 * full in api.jsonl, so the analysis file stays small enough to load.
 */
function logAgentTurn({ player, provider, model, kind, day, phase, fields, missing, raw, error, latencyMs, tokensUsed }) {
  const entry = {
    ts: new Date().toISOString(),
    game: gameIndex,
    kind: 'turn',
    player,
    provider,
    model,
    request: kind,
    day: day ?? null,
    phase: phase ?? null,
    error: error || null,
    fields: fields || {},
    missingFields: missing || [],
    rawPreview: truncate(raw, 600),
    latencyMs: latencyMs ?? null,
    tokensUsed: tokensUsed ?? null,
  };
  buffers.turns.push(entry);

  if (error) {
    readable(`[${player}] ${kind}: API ERROR — ${error}`);
  } else if (missing && missing.length) {
    readable(`[${player}] ${kind}: missing field(s) ${missing.join(', ')}`);
  }

  // 200, not 50: a 100-game batch produces thousands of turns and each flush
  // rewrites the whole file.
  if (buffers.turns.length % 200 === 0) flushAll();
  return entry;
}

/**
 * Append one line of game narration to `events.log`.
 *
 * `events.log` is documented as the human-readable event stream, but for most of this
 * project it carried only phase markers and errors — the statements, defenses and votes
 * went to stdout, so the only way to watch a game live was to tail the batch's stdout
 * wherever it happened to be redirected. This makes the session directory itself
 * watchable by tailing `events.log` inside the session directory.
 */
function logNarration(text) {
  readable(text);
}

/** Full request/response, appended immediately as one JSON line. */
function logApiCall({ player, provider, model, kind, requestMessages, responseText, tokensUsed, latencyMs }) {
  if (!sessionDir) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    game: gameIndex,
    player,
    provider,
    model,
    request: kind,
    requestMessages,
    responseText: truncate(responseText, 20000),
    tokensUsed: tokensUsed ?? null,
    latencyMs,
  });
  appendFileSync(join(sessionDir, 'api.jsonl'), line + '\n');
}

/** Write the finished game's full state, including hidden roles. */
function logGameResult({ snapshot, outcome, metrics, agentSummaries }) {
  const entry = {
    ts: new Date().toISOString(),
    game: gameIndex,
    kind: 'game_result',
    outcome,
    metrics,
    agentSummaries,
    snapshot,
  };
  buffers.events.push(entry);
  writeAtomic(join(sessionDir, `game-${String(gameIndex).padStart(3, '0')}.json`), entry);
  flushAll();
  return entry;
}

function flushAll() {
  if (!sessionDir) return;
  writeAtomic(join(sessionDir, 'events.json'), buffers.events);
  writeAtomic(join(sessionDir, 'turns.json'), buffers.turns);
}

/**
 * Temp file + rename, so an interrupt can never leave a half-written log. Catches
 * BaseException-equivalent by cleaning up in a finally: Ctrl-C is precisely the case
 * this exists for.
 */
function writeAtomic(path, data) {
  const tmp = `${path}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, path);
  } finally {
    if (existsSync(tmp)) {
      try {
        unlinkSync(tmp);
      } catch {
        /* the rename already consumed it */
      }
    }
  }
}

function readable(text) {
  if (!sessionDir) return;
  appendFileSync(join(sessionDir, 'events.log'), text + '\n');
}

function truncate(str, max) {
  if (!str) return '';
  return str.length <= max ? str : str.slice(0, max) + '... [truncated]';
}

function getSessionDir() {
  return sessionDir;
}

function getSessionId() {
  return sessionId;
}

module.exports = {
  initSession,
  logNarration,
  startGame,
  logGameEvent,
  logPhase,
  logAgentTurn,
  logApiCall,
  logGameResult,
  flushAll,
  getSessionDir,
  getSessionId,
};
