/**
 * Checks. Run with:  node test/checks.js
 *
 * Two of these are ordinary unit tests. The important one is the visibility
 * invariant, and it is written the way that prior research insists on:
 * asserting the mechanism rather than an observable that more than one mechanism
 * could produce, and then *mutation-testing the check itself*. A leak detector that
 * has never caught a leak is indistinguishable from one that is asleep — five checks
 * in that repo passed for the wrong reason before this discipline was adopted.
 */

const assert = require('assert');
const { parseFields, matchName } = require('../src/agents/base-agent.js');
const { salvageTruncatedJson, tryParseJson, fieldsFromJson } = require('../src/agents/schemas.js');
const { GameState } = require('../src/engine/state.js');
const { Rng } = require('../src/engine/rng.js');
const { renderContext } = require('../src/engine/ledger.js');
const { getRole } = require('../src/engine/roles.js');

let pass = 0;
let fail = 0;

function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok    ${name}`);
  } catch (err) {
    fail++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

// --- helpers ----------------------------------------------------------------

function makeState(seed = 7, count = 7) {
  const seats = ['Alice', 'Bob', 'Carol', 'Dave', 'Erin', 'Frank', 'Grace']
    .slice(0, count)
    .map((name, i) => ({ id: `m${i}`, key: `m${i}`, name, provider: 'scripted', model: 'test', tier: 'baseline' }));
  return new GameState(seats, { rng: new Rng(seed) });
}

// ============================================================================
section('Field parsing — the shapes models actually return');

check('clean response', () => {
  const f = parseFields(
    'THINKING: Bob dodged the question.\nSUSPECT: Bob\nCONFIDENCE: 0.7\nSTATEMENT: I am on Bob.',
    ['THINKING', 'SUSPECT', 'CONFIDENCE', 'STATEMENT']
  );
  assert.strictEqual(f.SUSPECT, 'Bob');
  assert.strictEqual(f.CONFIDENCE, 0.7);
  assert.strictEqual(f.STATEMENT, 'I am on Bob.');
});

check('markdown bold around keys', () => {
  const f = parseFields('**THINKING:** thinking here\n**VOTE:** Carol', ['THINKING', 'VOTE']);
  assert.strictEqual(f.VOTE, 'Carol');
});

check('whole reply wrapped in a code fence', () => {
  const f = parseFields('```\nTHINKING: hmm\nVOTE: Dave\n```', ['THINKING', 'VOTE']);
  assert.strictEqual(f.VOTE, 'Dave');
});

check('percentage confidence normalises to 0-1', () => {
  const f = parseFields('SUSPECT: Erin\nCONFIDENCE: 80%', ['SUSPECT', 'CONFIDENCE']);
  assert.strictEqual(f.CONFIDENCE, 0.8);
});

check('multi-line statement stops at the next key', () => {
  const f = parseFields(
    'STATEMENT: Line one.\nLine two.\nVOTE: Frank',
    ['STATEMENT', 'VOTE']
  );
  assert.strictEqual(f.STATEMENT, 'Line one.\nLine two.');
  assert.strictEqual(f.VOTE, 'Frank');
});

check('trailing prose on a decision field is trimmed to the first line', () => {
  const f = parseFields('VOTE: Grace\nShe has been evasive all game.', ['VOTE']);
  assert.strictEqual(f.VOTE, 'Grace');
});

check('format ignored entirely still yields a statement, never a decision', () => {
  const f = parseFields('I think Bob is lying about last night.', [
    'THINKING',
    'SUSPECT',
    'CONFIDENCE',
    'STATEMENT',
  ]);
  assert.ok(f.STATEMENT, 'free text should be usable as speech');
  assert.strictEqual(f.SUSPECT, undefined, 'a decision must never be invented from prose');
});

check('empty response yields nothing', () => {
  const f = parseFields('', ['THINKING', 'VOTE']);
  assert.deepStrictEqual(f, {});
});

// ============================================================================
section('Truncated-JSON salvage (DEFECT 17)');

check('recovers the decision from a reply cut mid-string', () => {
  // Exactly the shape run 015 produced: valid prefix, cut inside `statement`.
  const cut = '{\n  "suspect": "Bob",\n  "confidence": 0.7,\n  "statement": "Everyone, look at the voting rec';
  const obj = tryParseJson(cut);
  assert.ok(obj, 'truncated document should be salvageable');
  const f = fieldsFromJson(obj, ['SUSPECT', 'CONFIDENCE', 'STATEMENT', 'THINKING']);
  assert.strictEqual(f.SUSPECT, 'Bob', 'the decision must survive the cut');
  assert.strictEqual(f.CONFIDENCE, 0.7);
});

check('a complete document is not touched by the salvager', () => {
  assert.strictEqual(salvageTruncatedJson('{"vote":"Carol","thinking":"ok"}'), null);
});

check('genuinely malformed text is rejected, not guessed at', () => {
  assert.strictEqual(salvageTruncatedJson('not json at all'), null);
  assert.strictEqual(tryParseJson('I think Bob is lying.'), null);
});

check('MUTATION: without the salvager the decision is lost', () => {
  // If this ever passes, the salvage path is not the thing doing the work.
  const cut = '{"vote": "Dave", "thinking": "Dave has been evas';
  let strict = null;
  try { strict = JSON.parse(cut); } catch { /* expected */ }
  assert.strictEqual(strict, null, 'strict parse must fail on this input');
  assert.strictEqual(fieldsFromJson(tryParseJson(cut), ['VOTE', 'THINKING']).VOTE, 'Dave');
});

// ============================================================================
section('Name resolution');

const roster = ['Alice', 'Bob', 'Carol', 'Dave', 'Erin', 'Frank', 'Grace'];

check('exact and case-insensitive', () => {
  assert.strictEqual(matchName('Carol', roster), 'Carol');
  assert.strictEqual(matchName('carol', roster), 'Carol');
});

check('name embedded in a sentence', () => {
  assert.strictEqual(matchName('I vote for Dave', roster), 'Dave');
});

check('unique prefix', () => {
  assert.strictEqual(matchName('Gra', roster), 'Grace');
});

check('ambiguous input is rejected, not guessed', () => {
  // Two candidates present: resolving this would fabricate a decision.
  assert.strictEqual(matchName('either Bob or Carol', roster), null);
});

check('unknown name is rejected', () => {
  assert.strictEqual(matchName('Zachary', roster), null);
});

// ============================================================================
section('Visibility invariant — no view may leak a living player\'s role');

/**
 * Scan a rendered context for any other living player's role name.
 *
 * Asserts on the mechanism: the role words themselves appearing in text that a
 * specific player is about to be shown. Deliberately excludes the asker's own role
 * and their Mafia partners, which they are entitled to know.
 */
function findLeaks(state, viewerName, rendered) {
  const viewer = state.player(viewerName);
  const entitled = new Set([viewerName, ...state.livingPartners(viewerName)]);
  const leaks = [];

  for (const p of state.players) {
    if (entitled.has(p.name)) continue;
    if (!p.alive) continue; // dead roles are public when reveal is on
    const roleWord = getRole(p.role).name; // "Mafia", "Doctor", "Detective", "Villager"
    // Look for the role attributed to that specific player, and for the bare role
    // word appearing anywhere it could only have come from hidden state.
    const pattern = new RegExp(`${p.name}[^.\\n]{0,20}\\b${roleWord}\\b|\\b${roleWord}\\b[^.\\n]{0,20}${p.name}`, 'i');
    if (pattern.test(rendered)) {
      leaks.push(`${p.name} (${roleWord}) is identifiable in ${viewerName}'s view`);
    }
  }
  return leaks;
}

check('viewFor never includes another living player\'s role field', () => {
  const state = makeState(11);
  for (const viewer of state.players) {
    const view = state.viewFor(viewer.name);
    const entitled = new Set([viewer.name, ...state.livingPartners(viewer.name)]);

    // Structural check: the view has no per-player role data beyond what is allowed.
    assert.ok(!('players' in view), 'view must not expose the raw player list');
    for (const d of view.dead) {
      assert.ok(!d.alive, 'only dead players may carry a role in the view');
    }
    // The only role strings in the view object belong to the viewer or the dead.
    const json = JSON.stringify(view);
    for (const p of state.players) {
      if (entitled.has(p.name) || !p.alive) continue;
      const naive = new RegExp(`"name":"${p.name}"[^}]*"role"`, 'i');
      assert.ok(!naive.test(json), `role field present for ${p.name} in ${viewer.name}'s view`);
    }
  }
});

check('rendered ledger and full transcript leak nothing (all seats, mid-game)', () => {
  const state = makeState(23);
  // Advance the game by hand so there is a real record to render.
  state.day = 2;
  state.suspicions.push(
    { day: 1, round: 1, actor: 'Alice', suspect: 'Bob', confidence: 0.6 },
    { day: 1, round: 1, actor: 'Bob', suspect: 'Alice', confidence: 0.4 }
  );
  state.votes.push(
    { day: 1, voter: 'Alice', target: 'Bob' },
    { day: 1, voter: 'Bob', target: 'Carol' }
  );
  state.addPublic({ type: 'statement', actor: 'Alice', text: 'Bob is lying.' });

  for (const viewer of state.players) {
    for (const mode of ['ledger', 'full']) {
      const view = state.viewFor(viewer.name);
      const rendered = renderContext(view, mode);
      const leaks = findLeaks(state, viewer.name, rendered);
      assert.strictEqual(leaks.length, 0, `${mode}: ${leaks.join('; ')}`);
    }
  }
});

check('MUTATION: the leak detector actually catches a planted leak', () => {
  // If this check ever passes, findLeaks is asleep and the two checks above are
  // worthless. This is the check that makes them mean something.
  const state = makeState(31);
  const viewer = state.players.find((p) => !state.isMafia(p.name));
  const hidden = state.players.find((p) => p.name !== viewer.name && state.isMafia(p.name));

  const planted = `Roster: everyone is well. Note: ${hidden.name} is the Mafia.`;
  const leaks = findLeaks(state, viewer.name, planted);
  assert.ok(leaks.length > 0, 'planted leak was NOT detected — findLeaks is not doing its job');
});

check('MUTATION: detector does not fire on information the viewer is entitled to', () => {
  const state = makeState(31);
  const mafia = state.livingMafia();
  if (mafia.length < 2) return; // setup-dependent; 7-player setup has two
  const [a, b] = mafia;
  const legitimate = `You are Mafia. Your partner is ${b.name}, who is also Mafia.`;
  const leaks = findLeaks(state, a.name, legitimate);
  assert.strictEqual(leaks.length, 0, `false positive on entitled info: ${leaks.join('; ')}`);
});

// ============================================================================
section('Win conditions');

check('town wins when the last Mafia dies', () => {
  const state = makeState(5);
  for (const m of state.livingMafia()) state.kill(m.name, 'execution');
  const r = state.checkWin();
  assert.strictEqual(r.winner, 'town');
  assert.strictEqual(r.reason, 'all_mafia_eliminated');
});

check('mafia win at parity, not only at elimination', () => {
  const state = makeState(5);
  const mafiaCount = state.livingMafia().length;
  // Kill town until counts are equal.
  const town = state.livingTown();
  for (let i = 0; i < town.length - mafiaCount; i++) state.kill(town[i].name, 'mafia_kill');
  const r = state.checkWin();
  assert.strictEqual(r.winner, 'mafia');
  assert.strictEqual(r.reason, 'mafia_reached_parity');
});

check('game continues while town outnumbers mafia', () => {
  const state = makeState(5);
  assert.strictEqual(state.checkWin(), null);
});

check('day limit produces a draw, not a win', () => {
  const state = makeState(5);
  state.day = state.maxDays;
  const r = state.checkWin();
  assert.strictEqual(r.winner, null);
  assert.strictEqual(r.reason, 'day_limit_reached');
});

// ============================================================================
section('Setup and determinism');

check('every supported player count produces a legal setup', () => {
  for (let n = 5; n <= 7; n++) {
    const state = makeState(3, n);
    assert.strictEqual(state.players.length, n);
    assert.ok(state.livingMafia().length >= 1, `${n} players: no mafia`);
    assert.ok(state.livingMafia().length < state.livingTown().length, `${n} players: mafia start at parity`);
    assert.strictEqual(state.checkWin(), null, `${n} players: game over before it began`);
  }
});

check('same seed produces identical role assignment and seating', () => {
  const a = makeState(99);
  const b = makeState(99);
  assert.deepStrictEqual(
    a.players.map((p) => [p.name, p.role, p.seat]),
    b.players.map((p) => [p.name, p.role, p.seat])
  );
});

check('different seeds produce different games', () => {
  const a = makeState(1);
  const b = makeState(2);
  assert.notDeepStrictEqual(
    a.players.map((p) => [p.name, p.role]),
    b.players.map((p) => [p.name, p.role])
  );
});

check('mafia know their partners and nobody else does', () => {
  const state = makeState(77);
  for (const p of state.players) {
    const view = state.viewFor(p.name);
    if (state.isMafia(p.name)) {
      const expected = state.livingPartners(p.name);
      assert.deepStrictEqual(view.you.partners.sort(), expected.sort());
    } else {
      assert.strictEqual(view.you.partners.length, 0, `${p.name} is town but sees partners`);
    }
  }
});

// ============================================================================
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
