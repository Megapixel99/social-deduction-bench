const { BaseAgent } = require('./base-agent.js');
const { logAgentTurn } = require('../logger.js');

/**
 * Rule-based baseline. No model, no API key, no GPU.
 *
 * This exists because of exp 032 in that prior research: in a bounded domain,
 * agentic behaviour needed no learned component at all — ~230 lines of rules scored
 * planner 12/12 and end-to-end 6/6 — and it worked "because failures are specific
 * enough to key a policy on". Mafia's decision channel is bounded in exactly that
 * way: pick one of at most nine living names.
 *
 * So the baseline is not a stub to make the engine testable. It is the control that
 * decides whether any model result means anything. If a 2B model does not beat this,
 * it is not doing social deduction; if a frontier model barely beats it, the game is
 * measuring bandwagon dynamics rather than reasoning. Publishing model numbers
 * without this comparison would be the same mistake as asserting a side effect
 * instead of a mechanism.
 *
 * The policy itself is deliberately the strongest *simple* thing, not a strawman:
 * score by voting-record evidence, and bandwagon. Bandwagoning is genuinely
 * effective in real Mafia, which is what makes it a demanding control.
 */
class ScriptedAgent extends BaseAgent {
  constructor(opts) {
    super({ ...opts, provider: 'scripted' });
    this.rng = opts.rng;
  }

  /**
   * Replaces the model call entirely. Same return shape as BaseAgent.ask so the
   * engine cannot tell the difference — which is the point: the baseline plays under
   * identical rules, identical legal-move resolution, and identical logging.
   */
  async ask({ kind, view, legal, expect, day, phase }) {
    this.turnCount++;
    this.stats.calls++;

    const fields = this.decide(kind, view, legal);

    logAgentTurn({
      player: this.playerName,
      provider: this.provider,
      model: this.model,
      kind,
      day,
      phase,
      fields,
      missing: expect.filter((f) => f !== 'THINKING' && !fields[f]),
      raw: '(rule-based)',
      latencyMs: 0,
      tokensUsed: 0,
    });

    return { fields, raw: '(rule-based)', error: null, latencyMs: 0 };
  }

  decide(kind, view, legal) {
    switch (kind) {
      case 'statement':
        return this.statement(view);
      case 'vote':
        return this.vote(view);
      case 'defense':
        return this.defense(view);
      case 'mafia_chat':
        return this.mafiaChat(view);
      case 'night_kill':
        return this.nightKill(view, legal);
      case 'night_investigate':
        return this.nightInvestigate(view, legal);
      case 'night_protect':
        return this.nightProtect(view, legal);
      default:
        return { THINKING: 'no policy for this request', TARGET: this.rng.pick(legal || view.living) };
    }
  }

  // --- evidence scoring ---------------------------------------------------

  /**
   * Suspicion score per living player, from the public record only.
   *
   * Every term is something the engine already computed and put in the ledger, which
   * is the same information a model is shown. The baseline gets no privileged access
   * beyond its own role's private knowledge.
   */
  scores(view) {
    const me = view.you.name;
    const others = view.living.filter((n) => n !== me);
    const score = {};
    for (const n of others) score[n] = 0;

    const revealedRole = {};
    for (const d of view.dead) if (d.role) revealedRole[d.name] = d.role;

    for (const v of view.votes) {
      if (!score.hasOwnProperty(v.voter) || !v.target) continue;

      // Voting record against players whose role death later revealed. Voting to
      // execute a villager is the single most usable public tell available.
      const role = revealedRole[v.target];
      if (role === 'mafia') score[v.voter] -= 2;
      else if (role) score[v.voter] += 2;

      // Voting against what you said you believed.
      const stated = view.suspicions.filter((s) => s.day === v.day && s.actor === v.voter).pop();
      if (stated && stated.suspect !== v.target) score[v.voter] += 1;

      // Voting for me.
      if (v.target === me) score[v.voter] += 1;
    }

    // Bandwagon term: weight toward whoever the room already distrusts. Small, so it
    // breaks ties rather than overriding evidence.
    for (const s of view.suspicions) {
      if (score.hasOwnProperty(s.suspect) && s.actor !== me) score[s.suspect] += 0.5;
      if (s.suspect === me && score.hasOwnProperty(s.actor)) score[s.actor] += 1;
    }

    // Private knowledge overrides everything it covers.
    for (const e of view.privateLog) {
      if (e.type === 'investigation_result' && score.hasOwnProperty(e.target)) {
        score[e.target] += e.result === 'mafia' ? 100 : -100;
      }
    }

    // Mafia never suspect their own.
    if (view.you.faction === 'mafia') {
      for (const p of view.you.partners) delete score[p];
    }

    return score;
  }

  top(view) {
    const score = this.scores(view);
    const entries = Object.entries(score);
    if (!entries.length) return { name: null, score: 0, reason: 'no living candidates' };

    const max = Math.max(...entries.map(([, v]) => v));
    const tied = entries.filter(([, v]) => v === max).map(([n]) => n);
    return { name: this.rng.pick(tied), score: max, tied: tied.length };
  }

  // --- day ----------------------------------------------------------------

  statement(view) {
    const { name: suspect, score } = this.top(view);
    if (!suspect) {
      return { THINKING: 'no legal suspects', SUSPECT: null, CONFIDENCE: 0, STATEMENT: 'I have nothing to add.' };
    }

    const reason = this.reasonFor(view, suspect);
    const confidence = Math.max(0.1, Math.min(0.95, 0.4 + score * 0.1));

    return {
      THINKING: `Highest suspicion score is ${suspect} at ${score.toFixed(1)}. ${reason}`,
      SUSPECT: suspect,
      CONFIDENCE: confidence,
      STATEMENT: this.phrase(suspect, reason),
    };
  }

  /** The strongest single piece of public evidence against a name, in words. */
  reasonFor(view, suspect) {
    const revealedRole = {};
    for (const d of view.dead) if (d.role) revealedRole[d.name] = d.role;

    const badVotes = view.votes.filter(
      (v) => v.voter === suspect && v.target && revealedRole[v.target] && revealedRole[v.target] !== 'mafia'
    );
    if (badVotes.length) {
      const names = [...new Set(badVotes.map((v) => v.target))];
      return `they voted to execute ${names.join(' and ')}, who turned out to be town`;
    }

    const mismatch = view.votes.find((v) => {
      if (v.voter !== suspect || !v.target) return false;
      const stated = view.suspicions.filter((s) => s.day === v.day && s.actor === suspect).pop();
      return stated && stated.suspect !== v.target;
    });
    if (mismatch) {
      const stated = view.suspicions.filter((s) => s.day === mismatch.day && s.actor === suspect).pop();
      return `on day ${mismatch.day} they named ${stated.suspect} and then voted ${mismatch.target}`;
    }

    const againstMe = view.votes.filter((v) => v.voter === suspect && v.target === view.you.name);
    if (againstMe.length) return `they have voted against me ${againstMe.length} time(s) without making a case`;

    const accusedBy = view.suspicions.filter((s) => s.suspect === suspect).length;
    if (accusedBy) return `they have drawn ${accusedBy} accusation(s) and answered none of them`;

    return `there is little to go on yet, and they have contributed the least`;
  }

  /** Vary the wording so a transcript of baseline players is readable. */
  phrase(suspect, reason) {
    const templates = [
      `I am on ${suspect}. Look at the record: ${reason}. Unless someone has a better read, that is where my vote goes.`,
      `${suspect}, explain yourself — ${reason}. That is the clearest thing on the board right now.`,
      `My case is against ${suspect}: ${reason}. I would rather be wrong for a stated reason than right by accident.`,
      `Nothing has changed my mind about ${suspect}. ${reason}. I am voting accordingly.`,
    ];
    return this.rng.pick(templates);
  }

  /**
   * Defend against the room's consensus.
   *
   * The control has to play every phase the models play, or its numbers are not a
   * comparison. Without this it returned no STATEMENT and stood mute while accused,
   * which would have understated the baseline on exactly the metric the defense phase
   * exists to measure.
   *
   * The policy is the strongest simple one available: redirect to the best alternative
   * suspect the public record supports, citing the same voting-record evidence the
   * accusation policy uses.
   */
  defense(view) {
    const scores = this.scores(view);
    // Whoever accused me is not a credible alternative to offer, so prefer someone else.
    const accusedMe = new Set(
      view.suspicions.filter((x) => x.suspect === view.you.name).map((x) => x.actor)
    );
    const pool = Object.keys(scores).filter((n) => !accusedMe.has(n));
    const pick = (pool.length ? pool : Object.keys(scores)).sort((a, b) => scores[b] - scores[a])[0];

    if (!pick) {
      return {
        STATEMENT: 'I have no case to answer beyond a hunch. Nobody has produced a vote or a contradiction against me.',
        THINKING: 'No alternative suspect available; deny and point at the absence of evidence.',
      };
    }

    const reason = this.reasonFor(view, pick);
    return {
      STATEMENT:
        `The case against me is a hunch, not a record — nobody has shown a vote or a contradiction. ` +
        `If you want evidence, look at ${pick}: ${reason}. Voting me out costs you a day and tells you nothing.`,
      THINKING: `Accused by ${[...accusedMe].join(', ') || 'the room'}. Redirecting to ${pick} (score ${scores[pick]?.toFixed?.(1)}).`,
    };
  }

  vote(view) {
    const { name, score } = this.top(view);
    const target = name || this.rng.pick(view.living.filter((n) => n !== view.you.name));
    return { THINKING: `Voting the highest-scored candidate (${target}, ${score?.toFixed?.(1) ?? '0'}).`, VOTE: target };
  }

  // --- night --------------------------------------------------------------

  /**
   * Coordination has to name the same target the kill policy will pick, or the
   * baseline's own transcript contradicts itself — it would propose one name in the
   * Mafia channel and kill a different one minutes later. A control that visibly
   * fails to follow its own plan is not a usable control, so both read the same
   * threat scoring.
   */
  mafiaChat(view) {
    const legal = view.living.filter((n) => n !== view.you.name && !view.you.partners.includes(n));
    const { TARGET } = this.nightKill(view, legal.length ? legal : view.living);
    return {
      THINKING: `Proposing the highest-threat town player (${TARGET}) so the bloc converges.`,
      MESSAGE: `${TARGET} is the problem — they are the one building a case that reaches us. I say we take ${TARGET} tonight and then back whatever consensus forms tomorrow rather than leading it.`,
    };
  }

  /**
   * Kill whoever is most dangerous, measured as accusation accuracy: a town player
   * who keeps naming actual Mafia is a de facto Detective whether or not they are
   * one. The Mafia cannot see ground truth, so this is computed from what the
   * asker already knows — which of their own team a player has named.
   */
  nightKill(view, legal) {
    const mine = new Set([view.you.name, ...view.you.partners]);
    const danger = {};
    for (const n of legal) danger[n] = 0;

    for (const s of view.suspicions) {
      if (!danger.hasOwnProperty(s.actor)) continue;
      if (mine.has(s.suspect)) danger[s.actor] += 3;   // naming us
      else danger[s.actor] += 0.5;                      // active but wrong
    }
    for (const v of view.votes) {
      if (!danger.hasOwnProperty(v.voter)) continue;
      if (mine.has(v.target)) danger[v.voter] += 3;
    }

    const max = Math.max(...Object.values(danger));
    const tied = Object.keys(danger).filter((n) => danger[n] === max);
    const target = this.rng.pick(tied);
    return {
      THINKING: `Most dangerous remaining town player is ${target} (threat ${max}).`,
      TARGET: target,
    };
  }

  /** Investigate the loudest player not yet cleared — the highest information gain. */
  nightInvestigate(view, legal) {
    const known = new Set(
      view.privateLog.filter((e) => e.type === 'investigation_result').map((e) => e.target)
    );
    const candidates = legal.filter((n) => !known.has(n));
    const pool = candidates.length ? candidates : legal;

    const activity = {};
    for (const n of pool) activity[n] = 0;
    for (const s of view.suspicions) if (activity.hasOwnProperty(s.actor)) activity[s.actor] += 1;

    const max = Math.max(...Object.values(activity));
    const tied = Object.keys(activity).filter((n) => activity[n] === max);
    const target = this.rng.pick(tied);
    return { THINKING: `Investigating the most active uncleared player: ${target}.`, TARGET: target };
  }

  /** Protect whoever the Mafia would most want dead — the most accurate accuser. */
  nightProtect(view, legal) {
    const value = {};
    for (const n of legal) value[n] = n === view.you.name ? 0.5 : 0;
    for (const s of view.suspicions) if (value.hasOwnProperty(s.actor)) value[s.actor] += 1;

    const max = Math.max(...Object.values(value));
    const tied = Object.keys(value).filter((n) => value[n] === max);
    const target = this.rng.pick(tied);
    return { THINKING: `Protecting the most active town voice: ${target}.`, TARGET: target };
  }
}

module.exports = { ScriptedAgent };
