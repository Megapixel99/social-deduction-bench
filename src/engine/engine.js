const { PHASE } = require('./state.js');
const { FACTION, NIGHT_ORDER, getRole } = require('./roles.js');
const { nightPrompt, mafiaChatPrompt, statementPrompt, votePrompt } = require('../agents/prompts.js');
const { logGameEvent, logPhase } = require('../logger.js');

/**
 * The Mafia phase machine.
 *
 * night -> dawn -> discussion -> vote -> execution -> (win check) -> night ...
 *
 * Two properties this file is responsible for:
 *
 * 1. **The engine adjudicates; agents only propose.** Every model output is
 *    resolved against the legal move set before it touches state, and an illegal
 *    or missing move falls back to a seeded random legal move rather than stalling
 *    the match. A weak model must be able to finish a game — otherwise it drops out
 *    of the sample and the remaining games flatter it.
 *
 * 2. **Every fallback is recorded.** `fellBackToRandom` is reported per agent, so
 *    "played badly" and "did not produce a parseable move" never get averaged
 *    together. The CTF project learned this the hard way: an auto-audit that
 *    silently substituted a real command for an idle one made idle defenders look
 *    functional until the substitution was surfaced as its own counter.
 */
class GameEngine {
  /**
   * @param {import('./state.js').GameState} state
   * @param {Map<string, import('../agents/base-agent.js').BaseAgent>} agents keyed by player name
   * @param {object} config
   */
  constructor(state, agents, config) {
    this.state = state;
    this.agents = agents;
    this.config = config;
    this.rng = state.rng;
  }

  agent(name) {
    const a = this.agents.get(name);
    if (!a) throw new Error(`No agent for player ${name}`);
    return a;
  }

  /** A view with the render mode attached, which is what prompts read. */
  viewFor(name) {
    const view = this.state.viewFor(name);
    view.contextMode = this.config.contextMode;
    view.outputMode = this.config.outputMode;
    return view;
  }

  // --- main loop ----------------------------------------------------------

  async run() {
    const s = this.state;

    logGameEvent({
      type: 'game_start',
      seed: s.rng.seed,
      contextMode: this.config.contextMode,
      players: s.players.map((p) => ({ name: p.name, model: p.model, provider: p.provider, role: p.role })),
      message: `Game start — ${s.players.length} players, seed ${s.rng.seed}, context mode "${this.config.contextMode}"`,
    });

    this.announce(
      `The game begins. Players: ${s.livingNames().join(', ')}. ` +
        `Among them are ${s.livingMafia().length} Mafia.`
    );

    while (!s.winner && !s.endReason) {
      s.day++;

      // No win check between night and dawn: the night phase only collects and
      // resolves submissions, and nobody actually dies until dawn applies the
      // outcome. A check here could never fire, and leaving one in would imply
      // deaths land earlier than they do.
      await this.runNight();

      await this.runDawn();
      if (this.settle()) break;

      await this.runDiscussion();
      await this.runVote();
      await this.runExecution();
      if (this.settle()) break;
    }

    s.phase = PHASE.ENDED;
    const outcome = {
      winner: s.winner,
      reason: s.endReason,
      days: s.day,
      survivors: s.livingNames(),
    };
    logGameEvent({ type: 'game_end', ...outcome, message: this.describeOutcome() });
    console.log(`\n${this.describeOutcome()}\n`);
    return outcome;
  }

  /** Evaluate win conditions; returns true if the game is over. */
  settle() {
    const result = this.state.checkWin();
    if (!result) return false;
    this.state.winner = result.winner;
    this.state.endReason = result.reason;
    return true;
  }

  describeOutcome() {
    const s = this.state;
    const roles = s.players
      .map((p) => `${p.name}=${getRole(p.role).name}${p.alive ? '' : ' (dead)'}`)
      .join(', ');
    const who =
      s.winner === FACTION.TOWN
        ? 'TOWN WINS'
        : s.winner === FACTION.MAFIA
          ? 'MAFIA WINS'
          : 'DRAW';
    return `${who} after ${s.day} day(s) — ${s.endReason}. Roles: ${roles}`;
  }

  announce(text, extra = {}) {
    const entry = this.state.addPublic({ type: 'announcement', actor: 'narrator', text, ...extra });
    console.log(`  * ${text}`);
    return entry;
  }

  // --- night --------------------------------------------------------------

  async runNight() {
    const s = this.state;
    s.phase = PHASE.NIGHT;
    logPhase({ day: s.day, phase: PHASE.NIGHT });
    console.log(`\n=== NIGHT ${s.day} ===`);

    const mafia = s.livingMafia();

    // Private Mafia coordination first, so the kill is a joint decision that leaves
    // a readable record of how it was reached.
    if (mafia.length > 1) await this.runMafiaChat(mafia);

    const submissions = { kill: [], investigate: [], protect: [] };

    for (const action of NIGHT_ORDER) {
      const actors = s.livingPlayers().filter((p) => getRole(p.role).nightAction === action);
      for (const actor of actors) {
        const target = await this.requestNightAction(actor, action);
        if (target) submissions[action].push({ actor: actor.name, target });
      }
    }

    await this.resolveNight(submissions);
  }

  async runMafiaChat(mafia) {
    for (const m of mafia) {
      const view = this.viewFor(m.name);
      const partners = this.state.livingPartners(m.name);
      const { systemPrompt, userPrompt, expect } = mafiaChatPrompt(view, partners);
      const { fields } = await this.agent(m.name).ask({
        kind: 'mafia_chat',
        systemPrompt,
        userPrompt,
        expect,
        // `view`/`legal` are ignored by model-backed agents, which read the rendered
        // prompt. The rule-based baseline reads them instead of the text, so it plays
        // under exactly the same legal-move set without parsing its own prompt.
        view,
        legal: partners,
      });

      this.agent(m.name).addNote(this.state.day, fields.THINKING);
      const message = fields.MESSAGE || '(says nothing)';

      // Visible to the whole Mafia bloc and to no one else.
      for (const reader of mafia) {
        this.state.addPrivate(reader.name, {
          type: 'mafia_chat',
          actor: m.name,
          text: `[Mafia channel, night ${this.state.day}] ${m.name}: "${message}"`,
        });
      }
      console.log(`  [mafia] ${m.name}: ${message}`);
    }
  }

  async requestNightAction(actor, action) {
    const s = this.state;
    // Mafia may not kill each other; the Doctor may protect anyone including self;
    // the Detective may not investigate themselves.
    let legal = s.livingNames();
    if (action === 'kill') legal = legal.filter((n) => !s.isMafia(n));
    if (action === 'investigate') legal = legal.filter((n) => n !== actor.name);

    if (!legal.length) return null;

    const view = this.viewFor(actor.name);
    const { systemPrompt, userPrompt, expect } = nightPrompt(view, action, legal);
    const agent = this.agent(actor.name);
    const { fields } = await agent.ask({
      kind: `night_${action}`,
      systemPrompt,
      userPrompt,
      expect,
      view,
      legal,
    });
    agent.addNote(s.day, fields.THINKING);

    const { name, violation } = agent.resolveTarget(fields.TARGET, legal, {
      allNames: s.players.map((p) => p.name),
      allowSelf: action !== 'investigate',
    });

    let target = name;
    if (!target) {
      target = this.rng.pick(legal);
      agent.stats.fellBackToRandom++;
      s.addViolation(actor.name, violation || 'unresolved_target', {
        action,
        raw: fields.TARGET || null,
        substituted: target,
      });
      console.log(
        `  [${actor.name}] ${action}: could not resolve "${fields.TARGET ?? '(none)'}" (${violation}) — random legal target ${target}`
      );
    }

    s.nightActions.push({ day: s.day, actor: actor.name, action, target, role: actor.role });
    return target;
  }

  async resolveNight(submissions) {
    const s = this.state;

    // Detective results are private and delivered immediately.
    for (const { actor, target } of submissions.investigate) {
      const isMafia = s.isMafia(target);
      s.addPrivate(actor, {
        type: 'investigation_result',
        target,
        result: isMafia ? 'mafia' : 'not_mafia',
        text: `You investigated ${target}. Result: ${isMafia ? 'MAFIA' : 'NOT Mafia'}.`,
      });
      console.log(`  [detective] investigated ${target} -> ${isMafia ? 'MAFIA' : 'not mafia'}`);
    }

    // Mafia kill by plurality of nominations; ties broken by the seeded stream.
    let killTarget = null;
    if (submissions.kill.length) {
      const tally = {};
      for (const { target } of submissions.kill) tally[target] = (tally[target] || 0) + 1;
      const top = Math.max(...Object.values(tally));
      const tied = Object.keys(tally).filter((t) => tally[t] === top);
      killTarget = tied.length === 1 ? tied[0] : this.rng.pick(tied);
      if (tied.length > 1) {
        console.log(`  [mafia] split vote (${tied.join(' vs ')}) — resolved to ${killTarget}`);
      }
    }

    const protectTarget = submissions.protect[0]?.target ?? null;
    for (const { actor, target } of submissions.protect) {
      s.addPrivate(actor, {
        type: 'protect_result',
        target,
        saved: killTarget === target,
        text:
          killTarget === target
            ? `You protected ${target} — the Mafia attacked them and you saved their life.`
            : `You protected ${target}. They were not attacked.`,
      });
    }

    s.nightOutcome = { killTarget, protectTarget, saved: killTarget && killTarget === protectTarget };
  }

  // --- dawn ---------------------------------------------------------------

  async runDawn() {
    const s = this.state;
    s.phase = PHASE.DAWN;
    logPhase({ day: s.day, phase: PHASE.DAWN });

    const { killTarget, saved } = s.nightOutcome || {};

    if (!killTarget) {
      this.announce(`Day ${s.day} breaks. Nobody died last night.`);
    } else if (saved) {
      // The save is announced as a quiet night, not as a save: telling the town a
      // Doctor exists and succeeded is information the Mafia would also receive,
      // and it hands them the Doctor's existence for free.
      this.announce(`Day ${s.day} breaks. Nobody died last night.`);
      console.log(`  (${killTarget} was attacked and saved)`);
    } else {
      const victim = s.kill(killTarget, 'mafia_kill');
      const roleNote = s.revealRoleOnDeath ? ` They were the ${getRole(victim.role).name}.` : '';
      this.announce(`Day ${s.day} breaks. ${killTarget} was found dead.${roleNote}`, {
        target: killTarget,
        deathCause: 'mafia_kill',
        revealedRole: s.revealRoleOnDeath ? victim.role : null,
      });
    }
  }

  // --- discussion ---------------------------------------------------------

  async runDiscussion() {
    const s = this.state;
    s.phase = PHASE.DISCUSSION;
    logPhase({ day: s.day, phase: PHASE.DISCUSSION });
    console.log(`\n=== DAY ${s.day} — DISCUSSION ===`);

    const rounds = this.config.discussionRounds;

    for (let round = 1; round <= rounds; round++) {
      // Rotate who speaks first each day so first-speaker advantage (or
      // disadvantage) does not attach to one seat across a batch of games.
      const speakers = this.rotate(s.livingPlayers(), s.day - 1);

      for (const speaker of speakers) {
        if (!speaker.alive) continue; // cannot happen today, but cheap to hold
        await this.requestStatement(speaker, round, rounds);
      }
    }
  }

  async requestStatement(speaker, round, rounds) {
    const s = this.state;
    const view = this.viewFor(speaker.name);
    const { systemPrompt, userPrompt, expect } = statementPrompt(view, round, rounds);
    const agent = this.agent(speaker.name);
    const legalNames = s.livingNames().filter((n) => n !== speaker.name);
    const { fields } = await agent.ask({
      kind: 'statement',
      systemPrompt,
      userPrompt,
      expect,
      view,
      legal: legalNames,
    });

    agent.addNote(s.day, fields.THINKING);
    s.addPrivate(speaker.name, {
      type: 'own_note',
      text: fields.THINKING || '(no reasoning recorded)',
    });

    // Decision channel: the public accusation, recorded so it can be scored against
    // ground truth and compared with how this player later votes.
    const { name: suspect, violation } = agent.resolveTarget(fields.SUSPECT, legalNames, {
      allNames: s.players.map((p) => p.name),
      allowSelf: false,
    });

    if (suspect) {
      s.suspicions.push({
        day: s.day,
        round,
        actor: speaker.name,
        suspect,
        confidence: typeof fields.CONFIDENCE === 'number' ? fields.CONFIDENCE : null,
        // Recorded now so the metrics pass never has to re-derive ground truth.
        suspectIsMafia: s.isMafia(suspect),
        actorIsMafia: s.isMafia(speaker.name),
        chanceBaseline: this.chanceBaseline(speaker.name),
        // How many players this accuser could have named. Needed to express
        // "drew more suspicion than its fair share" against a stable denominator.
        poolSize: legalNames.length,
      });
    } else {
      s.addViolation(speaker.name, violation || 'unresolved_suspect', { raw: fields.SUSPECT || null });
    }

    // Speech channel: what everyone reads.
    const statement = fields.STATEMENT || '(remains silent)';
    s.addPublic({ type: 'statement', actor: speaker.name, text: statement, round });
    console.log(`  ${speaker.name}: ${statement}`);
  }

  /**
   * Probability that naming a living player at random hits a Mafia, from this
   * player's seat. Recorded per turn so detection accuracy can be reported as lift
   * over chance instead of a raw rate — the roster shrinks as the game goes on and
   * the same raw accuracy means something different on day 1 and day 4.
   */
  chanceBaseline(actorName) {
    const s = this.state;
    const others = s.livingPlayers().filter((p) => p.name !== actorName);
    if (!others.length) return 0;
    const mafiaAmong = others.filter((p) => s.isMafia(p.name)).length;
    return mafiaAmong / others.length;
  }

  // --- vote ---------------------------------------------------------------

  async runVote() {
    const s = this.state;
    s.phase = PHASE.VOTE;
    logPhase({ day: s.day, phase: PHASE.VOTE });
    console.log(`\n=== DAY ${s.day} — VOTE ===`);

    const voters = this.rotate(s.livingPlayers(), s.day - 1);

    for (const voter of voters) {
      const view = this.viewFor(voter.name);
      const { systemPrompt, userPrompt, expect } = votePrompt(view);
      const agent = this.agent(voter.name);
      const legal = s.livingNames().filter((n) => n !== voter.name);
      const { fields } = await agent.ask({
        kind: 'vote',
        systemPrompt,
        userPrompt,
        expect,
        view,
        legal,
      });
      agent.addNote(s.day, fields.THINKING);
      const { name, violation } = agent.resolveTarget(fields.VOTE, legal, {
        allNames: s.players.map((p) => p.name),
        allowSelf: false,
      });

      let target = name;
      if (!target) {
        target = this.rng.pick(legal);
        agent.stats.fellBackToRandom++;
        s.addViolation(voter.name, violation || 'unresolved_vote', {
          raw: fields.VOTE || null,
          substituted: target,
        });
        console.log(
          `  ${voter.name} votes ??? -> could not resolve "${fields.VOTE ?? '(none)'}" (${violation}), random legal vote ${target}`
        );
      } else {
        console.log(`  ${voter.name} votes ${target}`);
      }

      const stated = s.suspicions.filter((x) => x.day === s.day && x.actor === voter.name).pop();
      s.votes.push({
        day: s.day,
        voter: voter.name,
        target,
        voterIsMafia: s.isMafia(voter.name),
        targetIsMafia: s.isMafia(target),
        statedSuspect: stated?.suspect ?? null,
        matchedStated: stated ? stated.suspect === target : null,
        chanceBaseline: this.chanceBaseline(voter.name),
      });

      s.addPublic({ type: 'vote', actor: voter.name, target, text: `${voter.name} voted for ${target}.` });
    }
  }

  async runExecution() {
    const s = this.state;
    s.phase = PHASE.EXECUTION;
    logPhase({ day: s.day, phase: PHASE.EXECUTION });

    const dayVotes = s.votes.filter((v) => v.day === s.day && v.target);
    const tally = {};
    for (const v of dayVotes) tally[v.target] = (tally[v.target] || 0) + 1;

    const summary = Object.entries(tally)
      .sort(([, a], [, b]) => b - a)
      .map(([n, c]) => `${n}:${c}`)
      .join(', ');

    if (!Object.keys(tally).length) {
      this.announce(`No votes were cast. Nobody is eliminated.`);
      return;
    }

    const top = Math.max(...Object.values(tally));
    const tied = Object.keys(tally).filter((n) => tally[n] === top);

    if (tied.length > 1) {
      // A tie eliminating nobody keeps the vote meaningful: a Mafia bloc that only
      // manages to split the town has not won the day.
      this.announce(`The vote is tied (${summary}). Nobody is eliminated.`, { tally });
      return;
    }

    const victim = s.kill(tied[0], 'execution');
    const roleNote = s.revealRoleOnDeath ? ` They were the ${getRole(victim.role).name}.` : '';
    this.announce(`The town votes out ${victim.name} (${summary}).${roleNote}`, {
      target: victim.name,
      deathCause: 'execution',
      tally,
      revealedRole: s.revealRoleOnDeath ? victim.role : null,
    });
  }

  // --- util ---------------------------------------------------------------

  rotate(arr, by) {
    if (!arr.length) return arr;
    const n = ((by % arr.length) + arr.length) % arr.length;
    return [...arr.slice(n), ...arr.slice(0, n)];
  }
}

module.exports = { GameEngine };
