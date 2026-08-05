# AI vs AI Mafia

Language models play Mafia against each other. The point is not the transcript — it is
that **deception and deception-detection get measured per turn, separately, and
corrected for chance**, so the results say something a win/loss column cannot.

> **Note on authorship.** A self-directed research project. The concept, research
> questions and system design are mine; much of the implementation was AI-assisted
> (built with coding agents). Findings here are exploratory, not rigorously validated.

## Why not just count wins

A seven-player Mafia game is mostly variance. The Mafia can lose with perfect play
because the Detective's first coin-flip investigation happened to land, and win with
incoherent play because two villagers fixated on each other. Ranking models by win
rate over any batch you can afford to run measures luck.

So every town player makes one **public accusation** per statement. Ground truth is
known to the engine, and the exact probability of hitting a Mafia by chance is recorded
for that turn's roster. Accuracy minus that baseline is **detection lift** — a signed
number with a meaningful zero, and 15–25 samples per game instead of one bit.

The rule-based baseline, twelve 7-player games, seed 1:

```
model            tier        n   det.lift  vote.lift  decep.  consist   calib  invalid
rule-based-v1    baseline   84    +0.293     +0.293    1.703    0.967  +0.217    0.000
```

One game from that same batch scored **−0.400**. Same players, same policy. That gap is
the argument for the whole approach.

## Quick start

No API keys, no GPU, runs in seconds:

```bash
npm install && npm run test-game
```

```bash
node test/checks.js
```

Then pick a roster:

```bash
node src/index.js --local --games=30 --seed=1
```

## The metrics

| column | meaning |
|---|---|
| `det.lift` | accusation accuracy minus chance for that turn. **0 = no signal.** Town only — a Mafia accusing a villager is playing correctly, so scoring it as a miss would be nonsense. |
| `vote.lift` | town votes landing on real Mafia, minus chance |
| `decep.` | share of town accusations a Mafia drew vs its fair share. **Below 1.0 = being believed.** |
| `consist` | did the vote match the accusation made out loud — cheap talk vs costly signal. Town: coherence. Mafia: possibly strategy. Reported per faction, never summed. |
| `calib` | mean confidence when right minus when wrong. **Near zero = confident nonsense**, however well the prose reads. |
| `invalid` | turns where no legal move could be parsed and a random one was substituted |

**Read `invalid` first.** Above ~0.15, the other columns describe a model that was not
reliably making moves and are not comparable with one that was. Naming a dead player,
inventing a player, illegal self-targeting and unparseable replies are counted
separately per agent — a model that reasons well but drifts on a shrinking roster has a
different problem from one that cannot reason, and averaging them hides the
distinction that matters most for small models.

## Rosters

Seat count sets the role distribution (5–10 players supported).

| roster | seats | needs |
|---|---|---|
| `--test` | seven rule-based players | nothing |
| `--api` | Claude, GPT, Gemini, Grok, Perplexity | provider keys |
| `--cloud` | large open models via Ollama Cloud | `OLLAMA_API_KEY` |
| `--local` | small models via local Ollama | `ollama serve` |
| `--mixed` | small local models seated among larger ones | both |
| `--swiftlet` | large local MoE + small local | a Swiftlet server |
| `--roster=local-vs-baseline` | small models against the control | `ollama serve` |
| `--models=a,b,c` | explicit seats, any mix | depends |

```bash
node src/index.js --models=qwen,qwen,claude,claude,scripted,scripted,scripted
```

Personas (Alice, Bob, …) are deliberately not model names: an agent that could tell
which seat held which model would play the metagame instead of the game. The
persona-to-model mapping is re-attached afterwards for the leaderboard.

## Options

```
--context=ledger|full   how much record each agent sees (default ledger)
--output=json|text      json constrains decoding to a per-request schema (default)
--strict-targets        enum-constrain targets; zeroes state-tracking metrics
--rounds=N              statements per player per day (default 1)
--games=N               games this session (default 1)
--seed=N                base seed; makes a whole batch reproducible
--loop                  keep starting batches until interrupted
--max-days=N            draw after N days (default 12)
--no-reveal             do not reveal an eliminated player's role
--help
```

Reuse a `--seed` across arms. Role assignment and seating are drawn from it, so arms
become paired comparisons instead of independent samples — which is what lets a
30-game batch say anything at all.

## The two channels

Each day statement asks for four fields, and the split is the design:

```
THINKING:   private reasoning. Never shown to another player.
SUSPECT:    the public accusation. Goes on the record next to the later vote.
CONFIDENCE: 0.0-1.0
STATEMENT:  what everyone reads.
```

`THINKING` versus `SUSPECT`/`STATEMENT` separates the **decision channel** (bounded —
one of ≤9 names, machine-checkable against ground truth) from the **speech channel**
(unbounded, only judgeable by its effect). Keeping them apart lets a model be measured
as a reasoner and as a persuader independently, and lets the two be served by
*different* models — the cheapest way to find out which half of social deduction a
small local model can actually do.

`SUSPECT` is public on purpose. An earlier version documented it as a private belief
while the ledger showed it to everyone, which would have let every Mafia read the
town's private suspicions. The private-versus-public comparison survives from a better
signal anyway: the **vote**. Talk is cheap, votes are costly, and the gap between them
is the classic Mafia tell — computed in `ledger.js` from public data alone.

## The output contract

`--output=json` (default) constrains decoding to a per-request JSON schema.
`--output=text` uses a `KEY: value` contract.

JSON is the default because the text contract is **structurally broken for reasoning
models**: they reason in proportion to how much context they are given, so as the ledger
grows the reply exhausts its token budget before emitting any field. gpt-oss:20b
produced its vote in 0 of 5 votes; raising the cap to 2,500 tokens pushed a single vote
to 91 seconds and only moved the failure a day later. Constrained decoding fixed it —
invalid-move rate 0.467 → **0.000** for qwen3:4b, per-game wall-clock ~18 min → ~5 min.

Targets are deliberately **not** enum-constrained. Restricting them to living players
would make illegal moves impossible and silently zero `invalid_move_rate` and
`namedDeadPlayer` — the metrics that measure roster tracking, and a headline
small-model result. A constraint would be presented as a capability.
`--strict-targets` opts in if you want guaranteed-playable games instead.

## Context modes

`--context=ledger` (default) hands each agent a derived table — who accused whom by
day, who voted how, where a stated accusation and an actual vote diverged — plus the
last eight statements verbatim. `--context=full` hands over the raw transcript.

This is the main experimental knob, and it comes from a measurement rather than a
preference: context is the largest single lever on a small model, but a window wider
than the capacity can use makes results *worse*. So a 2B model is never asked to
re-derive "Bob accused Carol three days running" from 4,000 tokens of dialogue. Whether
that actually rescues small-model play is the question the harness answers, not an
assumption baked into it. See [RESEARCH.md](RESEARCH.md).

## Layout

```
src/
  index.js                CLI, batch runner, leaderboard
  config.js               model registry, named rosters, seat assignment
  logger.js               session logs (atomic writes, JSONL for API calls)
  metrics.js              per-turn luck-corrected metrics and aggregation
  engine/
    roles.js              role data and night-action ordering
    state.js              game state and the visibility rules
    ledger.js             context rendering: derived ledger vs raw transcript
    engine.js             the phase machine; adjudicates every model output
    rng.js                seeded PRNG so any game replays exactly
  agents/
    base-agent.js         model call, field parsing, name resolution
    prompts.js            every prompt, built only from a player's own view
    scripted-player.js    rule-based baseline (the control)
    factory.js            seat -> adapter
    providers/            openai (+ any OpenAI-compatible), claude, gemini,
                          grok/perplexity, ollama, ollama-cloud
test/checks.js            parsing, win conditions, determinism, visibility
```

`state.js` has one job it must not get wrong: `viewFor(name)` may never leak a fact
that player is not entitled to. Every prompt is built from it and nothing else, so
there is exactly one place to audit — and `test/checks.js` audits it across every seat
in both render modes, then **mutation-tests the leak detector** by planting a leak. A
detector that has never caught one is indistinguishable from one that is asleep.

## Provenance

The provider adapters, the session logger and the `KEY: value` parse-and-repair
discipline are ported from a previous AI-vs-AI project (`../CTF`) rather than rewritten
— roughly 1,100 lines of already-debugged integration code, including the Ollama
`keep_alive`/`think:false` details and the Ollama Cloud rate-limit retry.

The game engine, hidden-information state, ledger, metrics, baseline and prompts are
written for this project. Design decisions traceable to measurements in
`../llmRnD/trainingReseach` are cited at the point of use in the code and collected in
[RESEARCH.md](RESEARCH.md).

## Requirements

- Node.js ≥ 20
- Optional: a local Ollama for `--local`; provider keys for `--api`/`--cloud`;
  Apple Silicon and a Swiftlet server for `--swiftlet`

Copy `.env.example` to `.env` and fill in only what your roster needs.

## License

MIT — see [LICENSE](LICENSE).
