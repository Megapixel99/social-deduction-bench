# Architecture

How the benchmark is built and why, for anyone reading or extending the code. The
measurements themselves live in [RESULTS.md](RESULTS.md); the standing rules for reading
them are in [README.md](README.md) and repeated in *Reading a result safely* below.

## What it is measuring

Mafia is two tasks wearing one costume, and separating them is the whole design:

| channel | request | shape | how it is measurable |
|---|---|---|---|
| **decision** | vote, night target, public accusation | bounded — one of ≤9 names | against ground truth, per turn |
| **speech** | what other players read | unbounded generation | only by its effect on others |

Keeping them apart lets a model be scored as a reasoner and as a persuader independently,
and lets the two be served by *different* models — the cheapest way to find out which half
of social deduction a small model can actually do.

`THINKING` is the only private field. `SUSPECT` is a **public** accusation. The
private-versus-public comparison comes from the **vote**, not from `THINKING`: talk is
cheap, votes are costly, and the gap between them is the classic Mafia tell.

### The day cycle

night → dawn → discussion → **defense** → vote → execution.

Between discussion and the vote, the single most-accused living player is shown who named
them and what each said, and answers the room. Ties are skipped: the room has not
converged, so nobody is on the spot.

Without that phase a day is a poll rather than an argument — an accused player can never
answer the case against them, which removes Mafia's most characteristic exchange and the
only route by which a wrongly accused villager saves themselves. It is measurable because
the accused was the vote favourite when they stood up, so surviving is direct evidence the
defense moved votes. Reported **per faction, never pooled** — a Mafia talking its way out
and a villager clearing themselves are different results. `--no-defense` restores the older
behaviour, which makes defense-vs-no-defense a paired experiment at one seed.

## Layout

```
src/
  index.js            CLI, batch runner, leaderboard, memory preflight
  report.js           logs -> transcripts, per-model reasoning, dataset.jsonl
  config.js           model registry, named rosters, seat assignment
  logger.js           session logs; atomic writes, JSONL for API calls
  metrics.js          per-turn luck-corrected metrics + aggregation
  engine/
    roles.js          role data, night-action order, setups by player count
    state.js          game state AND the visibility rules
    ledger.js         context rendering: derived ledger vs raw transcript
    engine.js         phase machine (night/dawn/discussion/defense/vote/execution)
    rng.js            seeded PRNG; any game replays exactly
  agents/
    base-agent.js     model call, token budgets, field parsing, name resolution
    schemas.js        JSON schemas for the response contract
    prompts.js        every prompt, built only from a player's own view
    scripted-player.js rule-based control
    factory.js        seat -> adapter
    providers/        openai (+ any OpenAI-compatible), claude, gemini,
                      grok/perplexity, ollama, ollama-cloud
test/checks.js        29 checks: parsing, win conditions, determinism, visibility
analysis/             cross-batch pipeline: extract -> analyze -> report/figures
results/              raw stdout behind every number in RESULTS.md
```

CommonJS, no TypeScript, no build step, Node ≥ 20. Comments explain *why*, and cite the
measurement when a choice came from one.

## Invariants that must not break

1. **`state.viewFor(name)` is the only source of what a player knows.** Every prompt is
   built from it, so the hidden-information audit lives in one file, and there is
   deliberately no branch that can reach another *living* player's role. `test/checks.js`
   audits this across every seat in both render modes — and **mutation-tests the leak
   detector** by planting a leak, because a detector that has never caught one is
   indistinguishable from one that is asleep.
2. **The engine adjudicates; agents only propose.** Every model output is resolved against
   the legal move set before it touches state. An illegal or missing move falls back to a
   *seeded* random legal move so a weak model still finishes its games — otherwise it drops
   out of the sample and the remaining games flatter it.
3. **Every fallback is counted separately.** `invalid_move_rate`, `namedDeadPlayer`,
   `namedUnknownPlayer`, `unparseable`, `truncated`, `schemaIgnored`. "Played badly" and
   "did not produce a parseable move" must never be averaged together.
4. **Instructions are identical for every model.** Reasoning-*mode* switches (`/no_think`,
   `think:"low"`) are exempt — they are switches, not task guidance. Tuning prompt *content*
   per model would make the leaderboard a measure of prompt engineering.
5. **Nothing is enum-constrained that a metric depends on.** Restricting a target to the
   living roster would make illegal moves impossible and silently zero `invalid_move_rate`
   and `namedDeadPlayer` — the metrics that measure roster tracking, and a headline
   small-model finding. **A constraint must never be presented as a capability.**
   `--strict-targets` opts in for anyone who wants guaranteed-playable games.
6. **The control plays every phase the models play.** When the defense phase was added,
   the rule-based agent had no policy for it and stood mute while accused — which would
   have understated the baseline on precisely the metric the phase exists to measure. A
   control that skips a phase is not a control; any new request kind needs a
   `scripted-player.js` case in the same change.
7. **Reuse `--seed` across arms.** Role assignment and seating are drawn from it, so arms
   become paired comparisons rather than independent samples. Comparing arms at different
   seeds has produced a published error in this project before.

## The output contract

`--output=json` (default) constrains decoding to a per-request JSON schema; `--output=text`
uses a `KEY: value` contract.

JSON is the default because the text contract is **structurally broken for reasoning
models**: they reason in proportion to the context handed to them, so as the ledger grows
the reply exhausts its token budget before emitting any field. One 20B model produced its
vote in 0 of 5 votes; raising the cap to 2,500 tokens pushed a single vote to 91 seconds and
only moved the failure a day later. Constrained decoding fixed it outright — invalid-move
rate 0.467 → 0.000 for one 4B model, per-game wall-clock ~18 min → ~5 min. A grammar cannot
emit a document missing a required property, so reasoning cannot crowd out the decision.

Constrained decoding guarantees shape, **not that generation finishes**. A reply truncated
mid-string is unparseable in its entirety, which discards a decision that was already
complete at the front of the document; measured on one batch, two verbose models lost 84%
and 98% of their decisions that way, and the resulting "invalid move rates" were mostly the
parser throwing away answers the models had given. `schemas.js` therefore closes open
strings and brackets and re-parses. That path is mutation-tested: the check fails if the
salvage is not the thing doing the work.

## Reading a result safely

- **`invalid` first.** Above ~0.15 the other columns describe a model that was not reliably
  making moves, and are not comparable with one that was.
- **`det.lift` per day, not pooled.** Day-1 turns are at chance (−0.005 on n=2103), mean
  game length is 2.5 days, so a pooled figure is diluted by turns nobody could have got
  right — by a different amount for each model.
- **`det.lift` is a property of a model *in a field*.** Roster composition moves a weak
  model's score more than its own identity does, because detection depends on the evidence
  other players generate. Compare across batches only through shared anchors at the same
  seed, never by lifting a row from one table beside a row from another.
- **Put an interval on it.** Use a **cluster bootstrap over games**, never over seats —
  seats inside one game are not independent, since one player's hit is another's miss, so
  resampling seats shrinks the interval in exactly the direction that manufactures a
  finding.
- **~30 games buys a readable arm.** The control is a fixed policy, so its spread across
  batches is pure sampling noise: 0.142 across batches of 30+, 0.541 across batches under
  15.

## Failure modes this harness has already hit

Kept because the pattern is reusable, and because most of these would have been published
as *model* results rather than recognised as harness flaws. The full numbered log is in the
project's working notes; these are the ones that generalise.

- **A "private" field that was rendered to everyone.** The public accusation was documented
  as a private belief while the ledger showed it to every player, which would have
  destroyed the hidden information the benchmark exists to measure. *A field's visibility is
  part of its definition — document it where it is consumed, not only where it is produced.*
- **A ratio with a near-zero denominator.** The deception index divided by the *mean*
  accusations per town player; in 10-player games most town players draw zero, so the index
  read 12.5. *Check a ratio's denominator at the edges of the configuration space, not just
  the default.*
- **A token budget calibrated on a toy prompt.** 500 tokens looked generous against a
  100-token probe and produced the vote field in 0 of 5 real votes, because the real prompt
  is a ~2,500-token ledger. *Calibrate a budget on the largest real input.*
- **A mitigation that silently expired.** Decision-first field ordering existed so a
  truncated reply still carried the move — true for the text contract, false for JSON.
  Switching contracts retired the protection without retiring the problem. *When you replace
  a mechanism, re-verify every mitigation that existed because of the old one.*
- **A guard that measured a proxy.** Preflight summed model *file* sizes against a memory
  budget and passed; real residency is 1.3–1.6× that, and a 100-game run died at game 14
  with the machine swapping. *"It passed" is not evidence when the thing measured is not the
  thing that runs out.*
- **A warm-up that did not match the real request.** It omitted `num_ctx`, so models loaded
  at their native context and reserved a KV cache to match — a 2.5 GB model went 42.3 GB
  resident. *When two code paths configure the same resource, the one that runs first wins.*
- **An aggregation key that omitted the independent variable.** A batch seated the same
  model twice to compare context modes; the leaderboard keyed rows on model name, so both
  arms merged and the comparison was averaged away. *A row whose key omits what the
  experiment varies is not a result.*
- **Arms compared across different seeds.** The control was quoted at +0.293 from one seed
  against models run at another, where it scores +0.133. The seed-to-seed spread was larger
  than the model gap being claimed.
- **A ported adapter carrying a dead parameter.** An inherited `temperature` is now a hard
  400 on current Claude models, so a paid batch would have died on its first call. *Probe
  one call per provider before committing to a paid run.*
- **A rate limit scored as model failure.** Exhausted retries were counted as invalid moves,
  making a provider outage look like a model that could not choose. *"No rate limiting
  observed" is not "no rate limit" — the difference only appears when throughput rises.*

## Reproducing the analysis

```bash
node analysis/extract.js       # logs/ -> per-game, per-seat and per-turn rows
node analysis/analyze.js       # aggregation + cluster-bootstrap intervals
node analysis/report-md.js     # -> reports/cross-batch-analysis.md
node analysis/make-figures.js  # -> reports/charts.html + docs/*.png (needs Chrome)
```

`analysis/geomcheck.js` checks chart label geometry — bounds, overlaps, and whether one
series' line crosses another's label — because a chart is only verified once someone has
actually looked at the output, and this makes that check repeatable.
