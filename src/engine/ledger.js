/**
 * Context rendering — turning a player's view into the text they are prompted with.
 *
 * Two modes, and the difference between them is the main experimental knob in this
 * repo:
 *
 *   "full"    the raw transcript, every statement verbatim. What a model with
 *             enough context and enough capacity would prefer.
 *
 *   "ledger"  a derived table of who accused whom and who voted for whom on each
 *             day, plus only the most recent statements verbatim.
 *
 * The ledger exists because of two measurements in that prior research:
 *
 *   - Context is the largest single lever on a small model (+0.106 to +0.139 top-1
 *     for 1.2% more parameters, 64 -> 256 tokens) but a window wider than the
 *     capacity can use makes things *worse* — 1024 lost to 256 on every cell.
 *     So the fix for a small model is not "show it everything".
 *
 *   - An explicit count table over the current document beats adding parameters,
 *     and keeps paying even when the model's window already covers the text,
 *     because a table is a direct copy mechanism and attention over a token is not
 *     the same as a softmax emitting it.
 *
 * The analogue here: do not ask a 2B model to re-derive "Bob has accused Carol
 * three days running" from 4,000 tokens of dialogue. Compute it in the engine and
 * hand it over as a row. Whether that actually rescues small-model play is the
 * question the harness is built to answer, not an assumption baked into it.
 */

const { getRole } = require('./roles.js');

/** How many recent statements to quote verbatim in ledger mode. */
const LEDGER_RECENT_STATEMENTS = 8;

function renderContext(view, mode = 'ledger') {
  return mode === 'full' ? renderFull(view) : renderLedger(view);
}

// --- shared sections ------------------------------------------------------

function renderIdentity(view) {
  const lines = [`You are ${view.you.name}. ${view.you.description}`];
  if (view.you.partners.length) {
    lines.push(`Your surviving Mafia partner(s): ${view.you.partners.join(', ')}.`);
  }
  return lines.join('\n');
}

function renderRoster(view) {
  const lines = [`Living players (${view.living.length}): ${view.living.join(', ')}`];
  if (view.dead.length) {
    const dead = view.dead.map((d) => {
      const how = d.cause === 'execution' ? 'voted out' : 'killed at night';
      const role = d.role ? `, was ${getRole(d.role).name}` : '';
      return `${d.name} (day ${d.day}, ${how}${role})`;
    });
    lines.push(`Dead: ${dead.join('; ')}`);
  } else {
    lines.push('Dead: nobody yet');
  }
  return lines.join('\n');
}

function renderPrivateKnowledge(view) {
  const relevant = view.privateLog.filter((e) =>
    ['role_assigned', 'investigation_result', 'protect_result', 'mafia_chat', 'own_note'].includes(e.type)
  );
  if (!relevant.length) return '';

  const lines = ['YOUR PRIVATE KNOWLEDGE (nobody else has this):'];
  for (const e of relevant) {
    const when = e.day === 0 ? 'start' : `night ${e.day}`;
    if (e.type === 'own_note') {
      lines.push(`  [your note, day ${e.day}] ${e.text}`);
    } else {
      lines.push(`  [${when}] ${e.text}`);
    }
  }
  return lines.join('\n');
}

// --- ledger mode ----------------------------------------------------------

/**
 * Accusation table: for each day, who each player named as their top suspect.
 * This is the derived state the model would otherwise have to reconstruct.
 */
function renderAccusationTable(view) {
  if (!view.suspicions.length) return '';

  const byDay = groupBy(view.suspicions, (s) => s.day);
  const lines = ['ACCUSATION RECORD (who named whom as their prime suspect):'];
  for (const day of Object.keys(byDay).sort((a, b) => a - b)) {
    const entries = byDay[day].map((s) => {
      const conf = s.confidence != null ? ` (${Math.round(s.confidence * 100)}%)` : '';
      return `${s.actor}->${s.suspect}${conf}`;
    });
    lines.push(`  Day ${day}: ${entries.join(', ')}`);
  }

  // Running totals — the "count table" part. Cheap for the engine, and the thing
  // a small model most reliably fails to keep straight over several days.
  const accusedCount = {};
  const accuserCount = {};
  for (const s of view.suspicions) {
    accusedCount[s.suspect] = (accusedCount[s.suspect] || 0) + 1;
    accuserCount[s.actor] = (accuserCount[s.actor] || 0) + 1;
  }
  const totals = Object.entries(accusedCount)
    .sort(([, a], [, b]) => b - a)
    .map(([name, n]) => `${name} accused ${n}x`);
  if (totals.length) lines.push(`  Totals: ${totals.join(', ')}`);

  return lines.join('\n');
}

/** Vote table: how every completed vote actually landed. */
function renderVoteTable(view) {
  if (!view.votes.length) return '';

  const byDay = groupBy(view.votes, (v) => v.day);
  const lines = ['VOTE RECORD:'];
  for (const day of Object.keys(byDay).sort((a, b) => a - b)) {
    const dayVotes = byDay[day];
    const tally = {};
    for (const v of dayVotes) {
      const key = v.target || 'abstain';
      (tally[key] = tally[key] || []).push(v.voter);
    }
    const parts = Object.entries(tally)
      .sort(([, a], [, b]) => b.length - a.length)
      .map(([target, voters]) => `${target} <- ${voters.join(',')} (${voters.length})`);
    lines.push(`  Day ${day}: ${parts.join(' | ')}`);
  }
  return lines.join('\n');
}

/**
 * Flag players whose stated suspicion and actual vote diverged. A Mafia steering a
 * vote does this on purpose; a confused model does it by accident. Either way it is
 * the single most informative row a town player can be handed, and computing it in
 * the engine costs nothing.
 */
function renderInconsistencies(view) {
  const lines = [];
  const byDay = groupBy(view.votes, (v) => v.day);
  for (const day of Object.keys(byDay).sort((a, b) => a - b)) {
    for (const vote of byDay[day]) {
      if (!vote.target) continue;
      const stated = view.suspicions
        .filter((s) => s.day === Number(day) && s.actor === vote.voter)
        .pop();
      if (stated && stated.suspect !== vote.target) {
        lines.push(`  Day ${day}: ${vote.voter} accused ${stated.suspect} but voted ${vote.target}`);
      }
    }
  }
  if (!lines.length) return '';
  return ['STATED-VS-VOTED MISMATCHES:', ...lines].join('\n');
}

function renderRecentStatements(view, limit = LEDGER_RECENT_STATEMENTS) {
  const statements = view.publicLog.filter((e) => e.type === 'statement');
  if (!statements.length) return '';
  const recent = statements.slice(-limit);
  const omitted = statements.length - recent.length;
  const lines = [
    omitted > 0
      ? `MOST RECENT STATEMENTS (${omitted} earlier statement(s) summarised in the tables above):`
      : 'STATEMENTS SO FAR:',
  ];
  for (const s of recent) {
    lines.push(`  [Day ${s.day}] ${s.actor}: "${s.text}"`);
  }
  return lines.join('\n');
}

function renderEvents(view) {
  const events = view.publicLog.filter((e) => e.type !== 'statement');
  if (!events.length) return '';
  const lines = ['EVENTS:'];
  for (const e of events) lines.push(`  [Day ${e.day}] ${e.text}`);
  return lines.join('\n');
}

function renderLedger(view) {
  return [
    renderIdentity(view),
    renderRoster(view),
    renderPrivateKnowledge(view),
    renderEvents(view),
    renderAccusationTable(view),
    renderVoteTable(view),
    renderInconsistencies(view),
    renderRecentStatements(view),
  ]
    .filter(Boolean)
    .join('\n\n');
}

// --- full mode ------------------------------------------------------------

/** The raw record in chronological order, nothing derived, nothing dropped. */
function renderFull(view) {
  const lines = [];
  let lastDay = null;
  for (const e of view.publicLog) {
    if (e.day !== lastDay) {
      lines.push(`--- Day ${e.day} ---`);
      lastDay = e.day;
    }
    lines.push(e.type === 'statement' ? `  ${e.actor}: "${e.text}"` : `  * ${e.text}`);
  }

  return [
    renderIdentity(view),
    renderRoster(view),
    renderPrivateKnowledge(view),
    lines.length ? ['FULL TRANSCRIPT:', ...lines].join('\n') : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

// --- util -----------------------------------------------------------------

function groupBy(arr, keyFn) {
  const out = {};
  for (const item of arr) {
    const k = keyFn(item);
    (out[k] = out[k] || []).push(item);
  }
  return out;
}

module.exports = { renderContext, renderLedger, renderFull, LEDGER_RECENT_STATEMENTS };
