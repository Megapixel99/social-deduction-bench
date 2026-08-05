/**
 * Role definitions and night-action ordering.
 *
 * A role is data, not behaviour: the engine reads `nightAction` to decide what to
 * ask for during the night phase, and `faction` to decide who has won. Adding a
 * role (Vigilante, Jester, Godfather) should not require touching the engine.
 */

const FACTION = {
  TOWN: 'town',
  MAFIA: 'mafia',
};

const ROLES = {
  MAFIA: {
    id: 'mafia',
    name: 'Mafia',
    faction: FACTION.MAFIA,
    // Mafia act as a bloc: each member nominates, the engine resolves by plurality.
    nightAction: 'kill',
    // Mafia know each other. This is the only role with teammate visibility.
    knowsTeammates: true,
    description:
      'You are MAFIA. At night you and your partners choose one player to eliminate. ' +
      'By day you must pass as an innocent villager. You win when the Mafia equal or ' +
      'outnumber the remaining town.',
  },

  DOCTOR: {
    id: 'doctor',
    name: 'Doctor',
    faction: FACTION.TOWN,
    nightAction: 'protect',
    knowsTeammates: false,
    description:
      'You are the DOCTOR. Each night you choose one player to protect; if the Mafia ' +
      'target them, they survive. You may protect yourself. Nobody knows your role — ' +
      'revealing it makes you a target, but staying silent may cost the town.',
  },

  DETECTIVE: {
    id: 'detective',
    name: 'Detective',
    faction: FACTION.TOWN,
    nightAction: 'investigate',
    knowsTeammates: false,
    description:
      'You are the DETECTIVE. Each night you investigate one player and learn whether ' +
      'they are Mafia. Your information is the town\'s strongest asset and it makes you ' +
      'the Mafia\'s most valuable kill.',
  },

  VILLAGER: {
    id: 'villager',
    name: 'Villager',
    faction: FACTION.TOWN,
    nightAction: null,
    knowsTeammates: false,
    description:
      'You are a VILLAGER. You have no night action and no private information — only ' +
      'what is said and how people vote. You win when every Mafia is eliminated.',
  },
};

/**
 * Order in which night actions resolve. Investigation happens before the kill so a
 * Detective who is killed the same night still learns their result (they just never
 * get to share it) — this keeps the private-knowledge record honest for metrics.
 */
const NIGHT_ORDER = ['investigate', 'kill', 'protect'];

/**
 * Standard role distributions by player count. Keyed by player count so a match
 * setup is a lookup rather than arithmetic scattered through the engine.
 */
const SETUPS = {
  5: ['mafia', 'doctor', 'detective', 'villager', 'villager'],
  6: ['mafia', 'mafia', 'doctor', 'detective', 'villager', 'villager'],
  7: ['mafia', 'mafia', 'doctor', 'detective', 'villager', 'villager', 'villager'],
  8: ['mafia', 'mafia', 'doctor', 'detective', 'villager', 'villager', 'villager', 'villager'],
  9: ['mafia', 'mafia', 'mafia', 'doctor', 'detective', 'villager', 'villager', 'villager', 'villager'],
  10: ['mafia', 'mafia', 'mafia', 'doctor', 'detective', 'villager', 'villager', 'villager', 'villager', 'villager'],
};

function getRole(roleId) {
  const role = Object.values(ROLES).find((r) => r.id === roleId);
  if (!role) throw new Error(`Unknown role: ${roleId}`);
  return role;
}

function getSetup(playerCount) {
  const setup = SETUPS[playerCount];
  if (!setup) {
    throw new Error(
      `No role setup defined for ${playerCount} players. Supported: ${Object.keys(SETUPS).join(', ')}`
    );
  }
  return [...setup];
}

module.exports = { FACTION, ROLES, NIGHT_ORDER, SETUPS, getRole, getSetup };
