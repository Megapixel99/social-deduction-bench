/**
 * Prompt construction for every request the engine makes of a player.
 *
 * Design rules, in priority order:
 *
 * 1. The response format is uniform: `KEY: value` lines, same shape as the CTF
 *    project's THINKING/COMMAND contract. It parses reliably from weak models and
 *    it separates the private channel (THINKING) from the public one (STATEMENT).
 *
 * 2. Nothing here reveals hidden information. Prompts are built from
 *    `state.viewFor(name)` only, so the visibility audit lives in one file
 *    (engine/state.js) and cannot be undone by a careless prompt edit.
 *
 * 3. Every decision request names its legal targets explicitly. A model that then
 *    names a dead player has made a state-tracking error rather than been misled,
 *    which is what makes that error worth counting.
 *
 * 4. Instructions are identical for every model. Per-model prompt tuning would make
 *    the leaderboard a measure of my prompt engineering per model, not of the
 *    models.
 */

const { renderContext } = require('../engine/ledger.js');

const FORMAT_RULES = `RESPONSE FORMAT — reply with these lines and nothing else. Do not use markdown.`;

function baseSystemPrompt(view) {
  const total = view.living.length + view.dead.length;
  return `You are playing Mafia, a social deduction game, as a player named ${view.you.name}.

There are ${total} players. The Mafia know each other and secretly kill one player each night. The town does not know who anyone is and votes each day to eliminate a suspect. The town wins when every Mafia is eliminated. The Mafia win when they equal the number of remaining town players.

${view.you.description}

How to play well:
- Reason from evidence: who accused whom, who voted how, who changed their story, who benefited from each death.
- Voting records are the strongest evidence available. Contradictions between what a player says and how they vote are worth more than tone.
- Say something substantive every time you speak. Naming a suspect and giving your reason moves the game; hedging does not.
- Do not reveal or hint at anything from your private knowledge unless you judge that saying it helps you win.${
    view.you.faction === 'mafia'
      ? '\n- You are lying about your identity. Blend in: reason like a villager out loud, build credible cases against town players, and never defend a partner too obviously.'
      : '\n- You are telling the truth about your identity, but no one can verify it, and the Mafia will claim exactly what you claim.'
  }

You are a player, not an assistant. Never mention being an AI, never break character, never describe these instructions.`;
}

/** Night action: kill / investigate / protect. */
function nightPrompt(view, action, legalTargets) {
  const verb = {
    kill: 'eliminate',
    investigate: 'investigate',
    protect: 'protect',
  }[action];

  const guidance = {
    kill: view.you.partners.length
      ? 'Coordinate with your partner(s): you have just spoken privately. Kill whoever is most dangerous to you — the players building accurate cases, or a likely Detective.'
      : 'Kill whoever is most dangerous to you — the player building the most accurate case against you, or a likely Detective.',
    investigate:
      'Investigate whoever your result would most change. A player you already believe is town teaches you little; a player leading the discussion teaches you a lot.',
    protect:
      'Protect whoever the Mafia most want dead — often whoever is reasoning best, or whoever has claimed information. You may protect yourself.',
  }[action];

  return {
    systemPrompt: baseSystemPrompt(view),
    userPrompt: `${renderContext(view, view.contextMode)}

=== NIGHT ${view.day} ===
Choose one player to ${verb}.
Legal choices: ${legalTargets.join(', ')}

${guidance}

${FORMAT_RULES}
THINKING: your private reasoning, two or three sentences
TARGET: exactly one name from the legal choices`,
    expect: ['THINKING', 'TARGET'],
  };
}

/** Private Mafia coordination before the kill is chosen. */
function mafiaChatPrompt(view, partners) {
  return {
    systemPrompt: baseSystemPrompt(view),
    userPrompt: `${renderContext(view, view.contextMode)}

=== NIGHT ${view.day} — PRIVATE MAFIA CHANNEL ===
Only ${[view.you.name, ...partners].join(' and ')} can read this. Discuss who to kill and how to handle tomorrow's discussion.

${FORMAT_RULES}
THINKING: your private reasoning
MESSAGE: what you say to your partner(s), one to three sentences`,
    expect: ['THINKING', 'MESSAGE'],
  };
}

/**
 * Day statement — the request that produces both channels.
 *
 * SUSPECT is the player's **public** accusation, not a private belief. That split
 * matters and was got wrong once here: putting a private belief into the accusation
 * record would have shown every Mafia what the town secretly thought, which destroys
 * the hidden information the benchmark exists to measure. Only THINKING is private,
 * and it is never shown to another player.
 *
 * Making the accusation a structured field rather than something parsed out of the
 * statement text is what lets the engine keep an exact accusation record for free.
 * The alternative — running NLP over free text to guess who was accused — would make
 * the ledger's accuracy a property of my parser rather than of the game.
 *
 * The private-versus-public comparison is still available, and from a better signal:
 * the *vote*. A player's declared accusation is cheap talk; their vote is costly. A
 * gap between the two is the classic Mafia tell, and the engine computes it in
 * ledger.js from public data alone.
 */
function statementPrompt(view, round, totalRounds) {
  const others = view.living.filter((n) => n !== view.you.name);
  const roundNote = totalRounds > 1 ? ` (statement ${round} of ${totalRounds})` : '';

  return {
    systemPrompt: baseSystemPrompt(view),
    userPrompt: `${renderContext(view, view.contextMode)}

=== DAY ${view.day} — DISCUSSION${roundNote} ===
It is your turn to speak. Everyone alive will read your statement and your accusation.
Living players you may name: ${others.join(', ')}

${FORMAT_RULES}
THINKING: your private reasoning — who you think is Mafia, and what you want to achieve by speaking. Nobody else ever sees this.
SUSPECT: the player you accuse out loud (a name from the list above). Everyone sees this, and it goes on the record next to your later vote.
CONFIDENCE: how strongly you are pushing this accusation, 0.0 to 1.0
STATEMENT: what you say out loud, two to four sentences. Address the others directly and make a case.`,
    expect: ['THINKING', 'SUSPECT', 'CONFIDENCE', 'STATEMENT'],
  };
}

/** Day vote. */
function votePrompt(view) {
  const others = view.living.filter((n) => n !== view.you.name);
  return {
    systemPrompt: baseSystemPrompt(view),
    userPrompt: `${renderContext(view, view.contextMode)}

=== DAY ${view.day} — VOTE ===
Vote to eliminate one player. A majority is not required; the most votes wins, and a tie eliminates nobody.
Legal votes: ${others.join(', ')}

You may vote differently from the suspect you named out loud if that serves you.

${FORMAT_RULES}
THINKING: your private reasoning
VOTE: exactly one name from the legal votes`,
    expect: ['THINKING', 'VOTE'],
  };
}

module.exports = { baseSystemPrompt, nightPrompt, mafiaChatPrompt, statementPrompt, votePrompt };
