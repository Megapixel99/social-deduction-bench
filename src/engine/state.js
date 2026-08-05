const { getRole, getSetup, FACTION } = require('./roles.js');

/**
 * Game state and — the part that actually matters — the visibility rules.
 *
 * The whole point of Mafia as a benchmark is that information is asymmetric, so
 * this file has one job it must not get wrong: `viewFor(playerId)` may never leak
 * a fact that player is not entitled to. Everything an agent is told about the
 * world comes through that one method, so there is exactly one place to audit.
 *
 * Records are kept append-only and structured (never pre-rendered prose) so the
 * same history can be re-rendered at different verbosity for different models,
 * and so the metrics pass can read it without parsing English.
 */

const PHASE = {
  SETUP: 'setup',
  NIGHT: 'night',
  DAWN: 'dawn',
  DISCUSSION: 'discussion',
  VOTE: 'vote',
  EXECUTION: 'execution',
  ENDED: 'ended',
};

class GameState {
  /**
   * @param {Array<{id: string, name: string, provider: string, model: string}>} seats
   *   Seat definitions. `name` is the in-game persona (Alice, Bob, ...); `id` is the
   *   model-backed identity. Agents only ever see personas, so a model cannot be
   *   recognised by name and played differently — the persona/model mapping is
   *   re-attached afterwards for the leaderboard.
   * @param {object} opts
   * @param {import('./rng.js').Rng} opts.rng
   */
  constructor(seats, { rng, revealRoleOnDeath = true, maxDays = 12 } = {}) {
    this.rng = rng;
    this.revealRoleOnDeath = revealRoleOnDeath;
    this.maxDays = maxDays;

    this.day = 0;
    this.phase = PHASE.SETUP;
    this.winner = null;
    this.endReason = null;

    // Seating order is randomised so speaking order is not correlated with the
    // model roster ordering in config.
    const shuffledRoles = rng.shuffle(getSetup(seats.length));

    this.players = rng.shuffle(seats).map((seat, i) => ({
      ...seat,
      seat: i,
      role: shuffledRoles[i],
      alive: true,
      diedOn: null,        // { day, phase }
      deathCause: null,    // 'mafia_kill' | 'execution'
    }));

    /**
     * Public record — every player sees all of it. Structured events only.
     * { day, phase, type, actor, target, text }
     */
    this.publicLog = [];

    /**
     * Private record, keyed by player name. Investigation results, teammate
     * identities, night-chat among Mafia, and each agent's own prior reasoning.
     */
    this.privateLog = {};
    for (const p of this.players) this.privateLog[p.name] = [];

    /** Structured night submissions per day: { day, actor, action, target }. */
    this.nightActions = [];

    /** Structured day votes: { day, voter, target } (target null = abstain). */
    this.votes = [];

    /**
     * Public accusations: { day, round, actor, suspect, confidence }. One per
     * statement, which is what makes detection measurable per turn rather than only
     * at game end — a single game yields 15-25 of these instead of one win/loss bit.
     *
     * These are PUBLIC by design and are included in every player's view. A player's
     * private belief lives only in their own THINKING and never leaves this process.
     */
    this.suspicions = [];

    /** Protocol failures: { day, phase, actor, kind, detail }. */
    this.violations = [];

    this.seedPrivateKnowledge();
  }

  // --- setup -------------------------------------------------------------

  /** Tell Mafia who their partners are. Nothing else is known at start. */
  seedPrivateKnowledge() {
    const mafia = this.players.filter((p) => this.roleOf(p).faction === FACTION.MAFIA);
    for (const m of mafia) {
      const partners = mafia.filter((o) => o.name !== m.name).map((o) => o.name);
      this.addPrivate(m.name, {
        type: 'role_assigned',
        role: m.role,
        partners,
        text: partners.length
          ? `You are Mafia. Your partner${partners.length > 1 ? 's are' : ' is'} ${partners.join(', ')}.`
          : 'You are the only Mafia.',
      });
    }
    for (const p of this.players) {
      if (this.roleOf(p).faction === FACTION.MAFIA) continue;
      this.addPrivate(p.name, {
        type: 'role_assigned',
        role: p.role,
        partners: [],
        text: `You are the ${getRole(p.role).name}.`,
      });
    }
  }

  // --- lookups -----------------------------------------------------------

  roleOf(player) {
    return getRole(typeof player === 'string' ? this.player(player).role : player.role);
  }

  player(name) {
    const p = this.players.find((x) => x.name === name);
    if (!p) throw new Error(`No such player: ${name}`);
    return p;
  }

  livingPlayers() {
    return this.players.filter((p) => p.alive);
  }

  livingNames() {
    return this.livingPlayers().map((p) => p.name);
  }

  isMafia(name) {
    return this.roleOf(name).faction === FACTION.MAFIA;
  }

  livingMafia() {
    return this.livingPlayers().filter((p) => this.isMafia(p.name));
  }

  livingTown() {
    return this.livingPlayers().filter((p) => !this.isMafia(p.name));
  }

  /** Mafia teammates still alive, excluding the asker. */
  livingPartners(name) {
    if (!this.isMafia(name)) return [];
    return this.livingMafia()
      .filter((p) => p.name !== name)
      .map((p) => p.name);
  }

  // --- record keeping ----------------------------------------------------

  addPublic(event) {
    const entry = { day: this.day, phase: this.phase, ...event };
    this.publicLog.push(entry);
    return entry;
  }

  addPrivate(playerName, event) {
    const entry = { day: this.day, phase: this.phase, ...event };
    this.privateLog[playerName].push(entry);
    return entry;
  }

  addViolation(actor, kind, detail) {
    this.violations.push({ day: this.day, phase: this.phase, actor, kind, detail });
  }

  kill(name, cause) {
    const p = this.player(name);
    p.alive = false;
    p.diedOn = { day: this.day, phase: this.phase };
    p.deathCause = cause;
    return p;
  }

  // --- win conditions ----------------------------------------------------

  /**
   * Mafia win at parity, not elimination: once they equal the remaining town they
   * can force every vote, so continuing play is theatre. Town wins only by
   * eliminating every Mafia.
   */
  checkWin() {
    const mafia = this.livingMafia().length;
    const town = this.livingTown().length;

    if (mafia === 0) return { winner: FACTION.TOWN, reason: 'all_mafia_eliminated' };
    if (mafia >= town) return { winner: FACTION.MAFIA, reason: 'mafia_reached_parity' };
    if (this.day >= this.maxDays) return { winner: null, reason: 'day_limit_reached' };
    return null;
  }

  // --- visibility --------------------------------------------------------

  /**
   * Everything a given player is allowed to know, as structured data.
   *
   * The only role information included is: the asker's own role, their Mafia
   * partners (if Mafia), and roles that death has already made public. There is
   * deliberately no branch here that can reach another living player's role.
   */
  viewFor(name) {
    const me = this.player(name);
    const revealedRoles = {};
    if (this.revealRoleOnDeath) {
      for (const p of this.players) {
        if (!p.alive) revealedRoles[p.name] = p.role;
      }
    }

    return {
      you: {
        name: me.name,
        role: me.role,
        roleName: getRole(me.role).name,
        faction: getRole(me.role).faction,
        alive: me.alive,
        description: getRole(me.role).description,
        partners: this.livingPartners(name),
      },
      day: this.day,
      phase: this.phase,
      living: this.livingNames(),
      dead: this.players
        .filter((p) => !p.alive)
        .map((p) => ({
          name: p.name,
          day: p.diedOn?.day ?? null,
          cause: p.deathCause,
          role: revealedRoles[p.name] ?? null,
        })),
      publicLog: this.publicLog,
      privateLog: this.privateLog[name],
      votes: this.votes,
      suspicions: this.suspicions,
      // Ground truth is never included. If a future change needs it here, it is a
      // change to the benchmark, not a convenience.
    };
  }

  /** Full state including hidden roles — for the logger and metrics only. */
  snapshot() {
    return {
      day: this.day,
      phase: this.phase,
      winner: this.winner,
      endReason: this.endReason,
      seed: this.rng.seed,
      players: this.players.map((p) => ({
        name: p.name,
        id: p.id,
        provider: p.provider,
        model: p.model,
        tier: p.tier ?? null,
        role: p.role,
        faction: getRole(p.role).faction,
        seat: p.seat,
        alive: p.alive,
        diedOn: p.diedOn,
        deathCause: p.deathCause,
      })),
      publicLog: this.publicLog,
      privateLog: this.privateLog,
      nightActions: this.nightActions,
      votes: this.votes,
      suspicions: this.suspicions,
      violations: this.violations,
    };
  }
}

module.exports = { GameState, PHASE };
