# CLAUDE.md

Guidance for Claude Code working in this repository. **Keep this file up to date** —
when the project gains code, findings, defects or conventions, update the relevant
section in the same session. Same convention as `../llmRnD/trainingReseach/CLAUDE.md`.

Companion files:
- `README.md` — how to run it.
- `RESEARCH.md` — the small-local-LLM question, predictions stated *before* measuring.
- `RESULTS.md` — the experiment log, one numbered entry per batch.
- **This file** — architecture, conventions, and the defect log below.

## Project purpose

AI-vs-AI Mafia as a **social-deduction benchmark**. The claim it exists to support is
not "models can play Mafia" — it is that **deception and deception-detection can be
measured per turn and corrected for chance**, so results say something a win/loss column
cannot.

Central research question: *how large does a local model need to be to do social
deduction, and which half of the task does size buy?*

## The two-channel design (read this before touching prompts)

Mafia is two tasks in one costume:

| channel | request | shape | measurable how |
|---|---|---|---|
| **decision** | vote, night target, public accusation | bounded — one of ≤9 names | against ground truth, per turn |
| **speech** | what other players read | unbounded generation | only by its effect on others |

Keeping them separate is the whole design. It lets a model be scored as a reasoner and
as a persuader independently, and lets the two be served by *different* models — the
cheapest way to find out which half a small model can do.

`THINKING` is the only private field. `SUSPECT` is a **public** accusation (see DEFECT 1).
The private-vs-public comparison comes from the **vote**, not from THINKING: talk is
cheap, votes are costly, and the gap between them is the classic Mafia tell.

## Architecture

```
src/
  index.js            CLI, batch runner, leaderboard
  config.js           model registry (39 entries), named rosters, seat assignment
  logger.js           session logs; atomic writes, JSONL for API calls
  metrics.js          per-turn luck-corrected metrics + aggregation
  engine/
    roles.js          role data, night-action order, setups by player count
    state.js          game state AND the visibility rules
    ledger.js         context rendering: derived ledger vs raw transcript
    engine.js         phase machine; adjudicates every model output
    rng.js            seeded PRNG; any game replays exactly
  agents/
    base-agent.js     model call, token budgets, field parsing, name resolution
    schemas.js        JSON schemas for the response contract
    prompts.js        every prompt, built only from a player's own view
    scripted-player.js rule-based control
    factory.js        seat -> adapter
    providers/        openai (+ any OpenAI-compatible), claude, gemini,
                      grok/perplexity, ollama, ollama-cloud
test/checks.js        parsing, win conditions, determinism, visibility
results/              raw logs behind every number in RESULTS.md
```

### Invariants that must not break

1. **`state.viewFor(name)` is the only source of what a player knows.** Every prompt is
   built from it, so the hidden-information audit lives in one file. There is
   deliberately no branch that can reach another *living* player's role.
   `test/checks.js` audits this across every seat in both render modes — and
   **mutation-tests the leak detector** by planting a leak, because a detector that has
   never caught one is indistinguishable from one that is asleep.
2. **The engine adjudicates; agents only propose.** Every model output is resolved
   against the legal move set before it touches state. An illegal or missing move falls
   back to a *seeded* random legal move so a weak model can still finish a game —
   otherwise it drops out of the sample and the remaining games flatter it.
3. **Every fallback is counted.** `invalid_move_rate`, `namedDeadPlayer`,
   `namedUnknownPlayer`, `unparseable`, `truncated`, `schemaIgnored` are separate
   counters. "Played badly" and "did not produce a parseable move" must never be
   averaged together.
4. **Instructions are identical for every model.** Reasoning-*mode* controls
   (`/no_think`, `think:"low"`) are exempt — they are switches, not task guidance.
   Tuning prompt *content* per model would make the leaderboard a measure of my prompt
   engineering.
5. **Nothing is enum-constrained that a metric depends on.** See DEFECT 8's design note.

## Conventions

- CommonJS, no TypeScript, no build step. Node ≥ 20.
- Comments explain *why*, and cite the measurement when a choice came from one.
- A finding gets written to `RESULTS.md` with its `n`. A change gets a DEFECT entry here.
- Reuse `--seed` across arms so comparisons are paired, never independent samples.
- `results/` keeps the raw log for every number published, including void runs.

## Defect log

Numbered as found. Kept because the *pattern* is reusable — nine of the eleven below
were cases where a harness flaw would have been published as a model result.

**DEFECT 1 — a "private" field was shown to everyone.** `SUSPECT` was documented as the
player's private belief, and the ledger rendered the accusation record into every
player's view. Every Mafia could have read the town's private suspicions, destroying the
hidden information the benchmark exists to measure. Fixed by making it explicitly a
*public* accusation, which also keeps the ledger derivable without running NLP over free
text. **Lesson: a field's visibility is part of its definition; document it where it is
consumed, not only where it is produced.**

**DEFECT 2 — regex `$` with the `m` flag truncated every multi-line statement.** Field
capture stopped at the first newline, so any statement longer than one line lost its
tail. Fixed with `$(?![\s\S])`. Caught by a unit check that asserted on a two-line value;
would have been invisible in aggregate metrics.

**DEFECT 3 — deception index divided by a near-zero denominator.** It was
accusations-received over the *mean* per town player. In 10-player games most town
players draw zero accusations, so the mean approached zero and the index read **12.5**.
Fixed by dividing by *total* town accusations (a number that grows with the game) scaled
by pool size, plus a minimum-sample gate. **Lesson: check a ratio's denominator at the
edges of the configuration space, not just the default.**

**DEFECT 4 — a win check that could never fire.** `settle()` ran between night and dawn,
but deaths are applied at dawn. Harmless, and removed anyway: leaving it in implies
deaths land earlier than they do.

**DEFECT 5 — token budget calibrated on a toy prompt.** Decisions were capped at 500
tokens; probed against a 100-token prompt, gpt-oss:20b finished in 162 with
`done_reason: stop`, confirming the cap looked generous. In a real game it produced the
VOTE field in **0 of 5** votes, because the real prompt is a ~2,500-token ledger and a
reasoning model reasons *in proportion to its context*. **Lesson: calibrate a budget on
the largest real input, never a synthetic one.**

**DEFECT 6 — Qwen3 ignores API-level `think:false`** and reasons in plain prose, burning
the budget before reaching any field. Its own `/no_think` control token works. Applied
in the Ollama adapter for `qwen3*` only.

**DEFECT 7 — `think:false` does not disable reasoning for gpt-oss either.** The tokens go
to a harmony channel the JSON schema does not constrain, so it exhausts any budget while
its emitted JSON stays absent — `false`/2500 truncated at 48.4 s, `"low"`/2000 finished
in 103 tokens and 3.6 s. The fix is an **effort level, not a bigger cap**, and it is
4–7× faster. **Lesson: three reasoning-model defects lived in three different places
(visible channel, hidden channel, plain-prose reasoning) and none was visible from the
play metrics — all three needed truncation counted as its own signal.**

**DEFECT 8 — the free-text contract is structurally wrong for reasoning models.** Root
cause of 5–7. Three patches each improved the symptom without touching the cause.
Fixed by schema-constrained decoding: a grammar cannot emit a document missing a required
property, so reasoning cannot crowd out the decision. qwen3:4b invalid 0.467 → **0.000**;
per-game wall-clock ~18 min → ~5 min.
*Design note:* targets are deliberately **not** enum-constrained. Restricting them to
living players would make illegal moves impossible and silently zero
`invalid_move_rate` and `namedDeadPlayer` — the metrics that measure roster tracking, and
a headline small-model finding. **A constraint must never be presented as a capability.**
`--strict-targets` opts in for anyone who wants guaranteed-playable games.

**DEFECT 9 — I compared arms across different seeds.** I quoted the control at +0.293
(seed 1) against models run at seed 7, where the control actually scores +0.133. Same
policy; the seed-to-seed spread was larger than the model gap I was claiming. **Lesson:
this is exactly trainingResearch finding 24 — asserting an observable more than one
mechanism could produce. Paired seeds are not a nicety; they are the difference between a
result and a coincidence.**

**DEFECT 10 — a config typo threw a raw stack trace and broke `--help`.** Seat building
runs at module load, so an unknown model name crashed before anything printed —
including the help text someone reaches for *after* mistyping a name. Captured into
`CONFIG.configError` and reported by `index.js`.

**DEFECT 12 — a roster that would not fit memory, and no check for it.** The `ladder`
roster seated gpt-oss:20b and mistral-small:24b together: ~39 GB of resident weights
against a ~40 GB practical budget on a machine also doing other work. Nothing would have
errored — Ollama would have evicted and reloaded between turns, and the latency column
would have quietly measured disk speed. I had even written that I would "watch `lat.ms`
for step changes", which is monitoring for a problem instead of preventing one. Fixed by
a preflight sum against `--mem-budget`, and by splitting the ladder into anchored
batches. **Lesson: if the failure mode is silent data corruption, a preflight refusal
beats a note-to-self to look for it later.**
*Addendum — the guard was unreachable where it mattered.* First version ran the check
**after** the pull loop, and `pullModel`'s `/api/tags` probe times out while another batch
is loading models, falling through to a real pull with a 3600 s timeout. So the guard
never ran on a busy machine, which is precisely when a roster is at risk. Moved ahead of
the pull, then defeated deliberately (`--mem-budget=5` must refuse; a real budget must
pass) — **a check that has not been defeated is a guess**, and this one had silently
printed nothing when I first claimed it worked.

**DEFECT 14 — a ported adapter sent a parameter that is now a hard error.** The Claude
adapter carried `temperature: 0.8` over from the CTF project. Sampling parameters
(`temperature`, `top_p`, `top_k`) are **rejected with a 400 on every current Claude
model**, so the frontier roster would have died on its first call rather than degrading.
Found by a one-call-per-provider probe that cost about a tenth of a cent, run before
committing to a paid batch. The same probe found three of five Ollama Cloud models from
that config were retired or subscription-gated. **Lesson: a ported integration inherits
the API of the day it was written. Probe one call per provider before a paid batch — and
mark dead models `unavailable` so preflight refuses them, rather than deleting the entry
and losing the record of why.**

**DEFECT 13 — the leaderboard pooled the arms of my own experiment.** Run 011 seated the
same model twice, differing only in `contextMode`, to compare ledger against full
transcript within one game. `aggregate()` keyed rows on `p.model`, so both seats merged
into a single row at n=80 and the comparison was averaged away entirely — the batch ran to
completion and produced a table that could not answer the question it was built for.
Recovered without re-running, because the per-game snapshots record each seat's
`contextMode`. Key is now `model [contextMode]`. **Lesson: the aggregation key must name
every variable the experiment varies. A row whose key omits the independent variable is
not a result.**

**DEFECT 11 — contradictory format instructions (caught before shipping).** With JSON
mode added, prompts still said "reply with these lines and nothing else" while the
decoder was constrained to JSON. `formatRules(view)` now states the contract actually in
force. **Lesson: when adding a second mode, grep for every place that describes the
first one.**

## Environment & commands

```bash
npm install
npm test                 # 25 checks: parsing, win conditions, determinism, visibility
npm run test-game        # rule-based players; no keys, no GPU, seconds
```

```bash
node src/index.js --help
```

Local runs need `ollama serve`. Batches must be run **sequentially** — two concurrent
Ollama batches thrash model loading and the latency figures become an artefact of
eviction rather than a property of the model. `results/` and `RESULTS.md` record what
each batch was for.

Hardware these results were measured on: Apple M1 Max, 64 GB. Throughput, not quality,
is the constraint on batch size: ~90–110 s/game for the `local-tiers` roster.

### Memory budget (DEFECT 12)

The machine has 64 GB but runs other work, so the **batch budget is ~40 GB of resident
model weights**, not 64. Over budget, Ollama evicts and reloads models between turns and
the `lat.ms` column silently becomes a measure of disk throughput rather than of the
model — invisible in the results table and expensive to discover after a multi-hour run.

`preflight()` in `src/index.js` sums the real sizes from Ollama's `/api/tags` and refuses
to start over `--mem-budget` (default 40). Current rosters:

| roster | resident weights |
|---|---|
| `ctf-transfer` | ~6.2 GB |
| `ladder-small` | ~12.5 GB |
| `local-tiers` | ~19.8 GB |
| `ladder-gptoss` | ~23.9 GB |
| `ladder-mistral` | ~24.4 GB |

**When a comparison needs two large models, do not seat them together.** The original
`ladder` held gpt-oss:20b *and* mistral-small:24b — ~39 GB, over budget. It is now split
into three batches that share `llama3.1-8b` and `qwen3-4b` as **anchors at the same
seed**, so the large models are comparable *through* the anchors (a common-reference
design) without ever being co-resident.

## Reading the results safely

**det.lift is a property of a model *in a field*, not of a model** (010). Roster
composition moves a weak model's score more than its own identity does, because detection
depends on the evidence other players generate — gemma3:1b spans a 0.414 range across
batches at n=30–60. So compare across batches **only through shared anchors at the same
seed** (the 009b/c design, where the control drifted −0.008), never by lifting a row from
one table beside a row from another.

Noise floor: **±0.09 at n=30**, measured from identical anchor models across 009b/009c.

## Open questions

1. ~~**Does the derived ledger actually help small models?**~~ **Measured (008): yes on
   the raw numbers, for every arm — but not cleanly attributable.** The rule-based
   control, which never reads the rendered prompt, dropped by the same −0.136, so most of
   the absolute effect is games getting harder rather than context mode. Corrected against
   it, only the 2B model is affected. **Paired seeds fix initial conditions, not
   trajectories** — the arms diverge at the first differing choice. Resolving it needs
   per-seat context mode (`RESULTS.md` 011), which is the highest-value change outstanding.
2. ~~**Is the inverted size ordering in 007 real?**~~ **Answered (009b/c): reasoning mode,
   not size.** mistral-small:24b — larger and non-reasoning — scores at chance (−0.001)
   where gpt-oss:20b with low reasoning effort scores +0.113, Δ ≈ +0.114 against ~0.010
   anchor drift, both with near-perfect compliance. The reasoning model is also 4.4× cheaper
   per call.
3. ~~**Does CTF-replay fine-tuning transfer?**~~ **Measured (010): no, and it cost
   compliance.** Tuned −0.133 vs its own base −0.159 is inside the noise floor, both below
   chance — but dead-player references went **43 vs 11** and invalid **0.103 vs 0.013**. A
   LoRA on out-of-domain replays degraded roster tracking, a capability it never targeted,
   for no detection gain.
4. **Do frontier models clear the control at all?** **BLOCKED, not untested** (012): all
   four frontier accounts are unfunded — Anthropic 400 credit balance, OpenAI 429 inactive,
   xAI 403, Google fetch error. Keys authenticate; there is no credit. Substituted with
   `scale-vs-control` (gpt-oss:120b vs gpt-oss:20b, same family, 6x parameters), which
   measures whether scale buys detection but says nothing about frontier models. **This
   remains the check that validates every other number in RESULTS.md.**
5. **Swiftlet's 35B/80B streamed tier.** Deferred deliberately while the output contract
   was broken, since the resident 20B hit that wall first. Now worth the 18 GB.
