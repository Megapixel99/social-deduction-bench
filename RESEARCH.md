# Can a small local LLM play Mafia?

An assessment written before running the model experiments, so that the predictions
in it are falsifiable rather than retrofitted. Sources are the two repos this project
draws on — `../CTF` (AI-vs-AI capture the flag, 106+ logged sessions, a 3B LoRA
custom bot) and `../llmRnD/trainingReseach` (69 experiments on non-neural and
small-model language modelling) — plus one external project, Swiftlet.

Everything here is exploratory. The trainingResearch repo's own standing rule
applies: distrust a suspiciously good measurement, and check before publishing,
because a false finding costs more than the minutes checking would have taken.

---

## 1. The short answer

**Split the question, because the honest answer is different for each half.**

Mafia is two tasks wearing one costume:

| | task | shape |
|---|---|---|
| **Decision channel** | pick a vote, a night target, an accusation | bounded — one of ≤9 names |
| **Speech channel** | say something that moves other players | unbounded generation |

The prediction: a 1–2B local model can do the decision channel at a level worth
measuring, and **cannot** do the speech channel. It will produce fluent,
well-formed, strategically empty paragraphs — and it will lose track of who is
alive.

That is not a hedge. It is the direct consequence of three measurements:

**Finding 3 (exp 011/013) — ranking skill does not transfer to generation.** Models
that rank next tokens well produced ~0% runnable programs when sampled, falling into
repetition cycles. "Generation punishes the absence of long-range state; ranking
never tests for it." A Mafia statement is generation conditioned on long-range state
— eight days of who said what — which is precisely the combination that failed.

**Finding 12 (exp 022) — domain restriction buys fluency, not meaning.** Same
tokens, parameters and compute: a model trained on one arXiv subfield beat a
broad-mix model on that subfield by +3.7pt top-1 and degenerated 17× less, *and wrote
confident nonsense* ("performs a discrete language model"). The conclusion was blunt:
next-token loss cannot distinguish fluent from correct. A small model in a Mafia game
will sound like a player. Sounding like a player is the failure mode, not the success
criterion, and it is the reason this repo does not score models on transcript vibes.

**Finding 19 (exp 032) — a bounded agentic domain needs no learned component.** ~230
lines of rules scored planner 12/12, end-to-end 6/6, and a repair loop turned 0/3 into
2/3 on injected faults. It worked "because failures are *specific* enough to key a
policy on." Mafia's decision channel is bounded in exactly that way — which cuts both
ways. It means a small model has a real chance there, and it means a rule-based
baseline may match it, so the baseline is mandatory.

## 2. What the CTF project already demonstrated

The strongest local evidence is the CTF custom bot: Qwen2.5-3B-Instruct, MLX LoRA on
tournament replays, quantised to Q4_K_M, served by Ollama.

> a 3B locally-served custom bot trained on tournament replays matches mid-size cloud
> models on offense (≈1.86 captures/game) but trails frontier models on defense

That asymmetry is the whole answer in miniature. **Offense** in that game is a
bounded, pattern-shaped task: rotate among known exploit vectors against a known
target. **Defense** is open-ended: anticipate an adversary you cannot see. The 3B
model reached parity on the bounded half and fell behind on the open-ended half.

Mafia's decision channel is CTF-offense-shaped. Its speech channel is
CTF-defense-shaped. Expect the same split, and expect fine-tuning on replays to move
the decision channel and barely touch the speech channel — the v5 and v7 lesson from
that project was that self-play loops reinforce a model's own mistakes and can regress
the thing you were trying to fix.

## 3. Swiftlet changes the question

[Swiftlet](https://github.com/leonickson1/Swiftlet) (~10k lines of Swift + Metal) runs
Qwen3.6-35B-A3B and Qwen3-Next-80B-A3B on Apple Silicon by keeping the dense core
resident and streaming sparse MoE experts from disk.

Reported: **2.6 GB peak RAM for 35B**, 4.3 GB for 80B; 7–11 tok/s decode for 35B on an
M5 Mac, 4.5–5 tok/s for 80B; 18 GB / 42 GB on disk; macOS 14+ / Apple Silicon only.
It ships an OpenAI-compatible server: `swiftlet-server --model ... --port 8080`.

This reframes the premise. The question was "can a *small* model compete." Swiftlet's
answer is that **local and small are no longer the same axis.** You can run a 35B
model locally in 2.6 GB, so the interesting comparison is three tiers, not two:

| tier | example | RAM | what it tests |
|---|---|---|---|
| `small-local` | qwen3.5:2b, gemma3:1b | ~1–2 GB | can a genuinely small model do this at all |
| `large-local` | swiftlet-35b | ~2.6 GB | does local-but-large close the gap |
| `large-open` / `frontier` | gpt-oss:120b, Claude | hosted | the ceiling |

One caveat in Swiftlet's own README is unusually favourable here:

> only about 3B parameters are active per token, so these models chat and write like
> large models but recall facts like small ones

Mafia needs almost no factual recall and a great deal of writing-and-reasoning over a
transcript. That is the half the architecture keeps. If the claim holds, `large-local`
should behave close to `large-open` on this benchmark specifically — a much better
result for local play than the small-model arm can deliver, and a genuinely
interesting thing to publish.

The honest caveats: Apple Silicon only; 7–11 tok/s means a ~100-call game runs
~15 minutes serialised, so a 100-game batch is roughly a day, and batch throughput is
the real constraint rather than quality; it is one person's project, so the numbers
should be measured here, not cited. Integration cost is near zero — an
OpenAI-compatible base URL, which is why `src/agents/providers/openai.js` carries an
`OpenAICompatibleAgent` and `config.js` has a `swiftlet-35b` entry rather than any
Swiftlet-specific code. Nothing depends on it.

## 4. What the findings changed in the build

These are design decisions traceable to a measurement, not preferences.

**The ledger (`src/engine/ledger.js`).** Finding 55: context is the largest neural
lever measured anywhere in that repo — +0.106 to +0.139 top-1 for 1.2% more parameters
going from a 64- to a 256-token window — *but* 1024 lost to 256 on every cell, because
"a window is worth only what the capacity can use." So the fix for a small model is
not to show it everything. Findings 10 and 50 add that an explicit count table over
the current document beats adding parameters and keeps paying even when the window
already covers the text, because a table is a direct copy mechanism.

Applied: the engine computes the accusation record, the vote record, and the
stated-versus-voted mismatches, and hands them over as rows. A 2B model is never asked
to re-derive "Bob accused Carol three days running" from 4,000 tokens of dialogue.
`--context=ledger|full` makes this a measurable knob rather than an assumption — and
finding 55's real lesson is that the ledger might *not* help, since document state
substitutes for context a model lacks rather than for parameters.

**Metrics are per-turn and luck-corrected (`src/metrics.js`).** Finding 24: five
checks in that repo passed for the wrong reason, every one asserting an observable
more than one mechanism could produce. Win rate in a 7-player Mafia game is exactly
that observable — the Mafia can lose with perfect play because a coin-flip
investigation landed. So the headline metric is **detection lift**: each town player
makes one public accusation per statement, ground truth is known, and accuracy is
reported minus the exact chance baseline for that turn's roster. One game yields
15–25 of those instead of one bit.

**Protocol integrity is a first-class metric, not error handling.** A model that names
a dead player has failed differently from one that reasoned badly, and averaging them
would hide the distinction that matters most for the small-model question. Naming a
dead player, naming a player who was never in the game, illegal self-targeting,
unparseable replies and random fallbacks are counted separately per agent. `invalid`
is the first column to read: above ~0.15 the other columns describe a model that was
not reliably making moves.

**The rule-based baseline is a control, not a stub.** Finding 19 again. Its policy is
the strongest *simple* thing — score by voting-record evidence, then bandwagon —
because bandwagoning genuinely works in real Mafia.

**Atomic log writes.** Findings 24b/24c: the same non-atomic write bug appeared in four
state writers in that repo, one of which turned a 57.8 MB index into a 1.5 MB stump on
Ctrl-C. `src/logger.js` writes temp-then-rename from the start.

## 5. The baseline is already measured

Twelve 7-player games, rule-based players in every seat, seed 1:

```
model            tier        n   det.lift  vote.lift  decep.  consist   calib  invalid
rule-based-v1    baseline   84    +0.293     +0.293    1.703    0.967  +0.217    0.000
```

Town/Mafia finished 6–6. **+0.293 detection lift is the bar.** A model that scores
below it is not doing social deduction — it is doing something a few dozen lines of
policy already do.

Two things that fell out of this immediately:

- A single game from the same batch scored **−0.400**. Same players, same policy.
  That is the variance argument made concretely: per-game win rate is not a
  measurement, and neither is a 5-game batch.
- Pure bandwagoning is *anti-informative* on its own — it went negative until enough
  voting-record evidence accumulated to override it. Useful, because it means the
  benchmark can distinguish "reasoning from evidence" from "following the room."

## 6. Falsifiable predictions

Stated with numbers so they can be wrong.

1. **`small-local` clears detection chance but not the baseline.** det.lift between
   0.00 and +0.20, against the baseline's +0.293.
2. **`small-local` invalid-move rate exceeds 0.15**, mostly naming dead players, and
   it gets worse as the roster shrinks — the point in the game where tracking matters
   most.
3. **Calibration gap near zero for `small-local`** (< 0.05, against the baseline's
   +0.217) while its statements read fluently. This is finding 12's confident nonsense
   showing up as a number.
4. **The ledger helps `small-local` and does little for frontier models.** `--context=ledger`
   over `--context=full`: +0.05 or better det.lift for 1–2B, within noise above ~30B.
   If the ledger helps frontier models *more*, my reading of finding 55 is wrong.
5. **`small-local` Mafia are worse liars than they are detectives** — deception index
   above 1.0, i.e. leaking, because passing requires modelling what others infer.
6. **`large-local` (Swiftlet 35B) lands closer to `large-open` than to `small-local`**
   on detection, per the "writes like a large model, recalls like a small one"
   caveat — the tested half is the half that survives.

Prediction 4 is the one worth building around: it is the only one whose answer is
useful whichever way it goes.

## 7. Running it

```bash
node src/index.js --test --games=12 --seed=1
```

```bash
node src/index.js --local --games=30 --seed=1 --context=ledger
```

```bash
node src/index.js --local --games=30 --seed=1 --context=full
```

The headline experiment — small models seated among larger ones, which is the only way
to measure deception and detection on the same board:

```bash
node src/index.js --mixed --games=30 --seed=1
```

Small models against the control, which separates skill from format compliance:

```bash
node src/index.js --roster=local-vs-baseline --games=30 --seed=1
```

Reuse the same `--seed` across arms: role assignment and seating are drawn from it, so
arms become paired comparisons rather than independent samples, which is what makes a
30-game batch say anything.

## 8. What would falsify the framing

- **Small models score at or above +0.293 detection lift with invalid-move rates under
  0.05.** Then the bounded-versus-open split is wrong and social deduction is easier
  than the generation findings imply.
- **The ledger makes no difference to any tier.** Then either the transcripts are short
  enough that context was never the binding constraint, or the derived tables are not
  the state that matters — both worth knowing, and both arguing for longer games.
- **A fine-tune on replays lifts the speech channel, not just decisions.** That would
  contradict the CTF offense/defense asymmetry, and would be the most interesting
  result available here.
- **Frontier models also sit near the baseline.** Then the benchmark is measuring
  bandwagon dynamics rather than reasoning, and the game needs longer discussion
  phases before any model comparison means anything. This is the failure mode to check
  for *first*, because it invalidates every other number.
