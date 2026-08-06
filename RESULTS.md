# Results log

Append-only. One entry per batch, newest last. Format follows the experiment log in
`../llmRnD/trainingReseach/CLAUDE.md`: **Why / Setup / Result / Finding / Limits**, so a
reader can tell what was measured from what was inferred.

Rules for this file, learned the hard way in the runs below:

1. **Record `n`, and record it per model.** Every wrong conclusion in this log so far
   came from reading a table whose n was 6.
2. **Only compare arms that share a seed.** Role assignment and seating are drawn from
   it, so a shared seed makes arms paired rather than independent samples. The control's
   own score moved +0.293 → +0.133 → −0.114 → +0.125 across seeds and batch sizes on an
   *unchanged policy*; that spread is the yardstick any model gap must beat.
3. **Read `invalid` before anything else.** Above ~0.15 the row describes a model that
   was not reliably making moves.
4. **Distinguish harness defects from model results.** Runs 002 and 003 measured my
   token budget, not the models. Both are kept here rather than deleted, because the
   pattern of how they failed is the useful part.

Hardware for every run: Apple M1 Max, 64 GB, local Ollama. Raw logs in `results/`.

---

## Metric key

| column | meaning |
|---|---|
| `det.lift` | public-accusation accuracy minus that turn's exact chance baseline. 0 = no signal. Town seats only. |
| `vote.lift` | town votes landing on real Mafia, minus chance |
| `decep.` | share of town accusations a Mafia drew vs its fair share. Below 1.0 = believed. |
| `consist` | vote matched the accusation said out loud (cheap talk vs costly signal) |
| `calib` | mean confidence when right minus when wrong. Near 0 = confident nonsense. |
| `invalid` | turns where no legal move parsed and a seeded random one was substituted |

---

## 001 — Rule-based control, seeds 1 and 7 — 2026-08-04

- **Why:** establish the bar before any model runs. Exp 032 in trainingResearch found a
  bounded agentic domain needed no learned component at all, so a model that cannot beat
  a few dozen lines of policy is not doing social deduction.
- **Setup:** `--test` (7 rule-based seats), 12 games each at seed 1 and seed 7.
  Policy: score by voting-record evidence, then bandwagon.
- **RESULT:**

  | seed | n | det.lift | decep. | consist | calib | town wins |
  |---|---|---|---|---|---|---|
  | 1 | 84 | +0.293 | 1.703 | 0.967 | +0.217 | 6/12 |
  | 7 | 84 | +0.133 | 1.571 | 0.906 | +0.225 | 3/12 |

- **FINDING — the control's own seed-to-seed spread is ±0.08 on 12 games.** Same policy,
  same n. This is the noise floor every later comparison has to clear, and it is larger
  than most model gaps measured since.
- **FINDING — pure bandwagoning is anti-informative early.** A single game from the seed-1
  batch scored **−0.400**; the policy only goes positive once voting-record evidence
  accumulates.
- **Limits:** one policy, one player count.

## 002 — Small local models, 12 games — 2026-08-04

- **Why:** the primary question. Can a 1-2B local model play at all?
- **Setup:** `--local --games=12 --seed=7`, text (`KEY: value`) contract. Paired with
  001's seed-7 control.
- **RESULT:**

  | model | n | det.lift | invalid | calib | town wins |
  |---|---|---|---|---|---|
  | control (001) | 84 | +0.133 | 0.000 | +0.225 | 3/12 |
  | granite3.1-dense:2b | 12 | +0.156 | 0.029 | 0.000 | 0/12 |
  | qwen3.5:2b | 24 | +0.053 | 0.115 | −0.200 | 0/12 |
  | smollm2:1.7b | 12 | −0.003 | 0.189 | — | 0/12 |
  | llama3.2:1b | 12 | −0.400 | 0.513 | — | 0/12 |
  | gemma3:1b | 24 | −0.450 | 0.509 | — | 0/12 |

- **FINDING — a field of small local models lost all 12 games as town**, where the control
  won 3.
- **FINDING — there is a compliance cliff between 1B and 2B.** 0.51 invalid at 1B vs
  0.03–0.12 at 2B. The 1B det.lift figures are therefore not measurements of deduction;
  they are what random voting scores.
- **FINDING — calibration is the result that survives.** Control +0.225, granite exactly
  **0.000**, qwen3.5:2b **−0.200** (more confident when *wrong*). This is
  trainingResearch finding 12 — fluency without meaning — as a number.
- **Not established:** whether any 2B model beats the control. +0.156 vs +0.133 at n=12
  vs n=84 is inside 001's noise floor.
- **Transcript failures no metric caught:** llama3.2:1b broke character with an assistant
  refusal; granite3.1-dense:2b as Mafia wrote *"bring us closer to our goal of
  outnumbering the remaining town members"* in a **public** statement.

## 003 — Tier arm, text contract — VOID (harness defect) — 2026-08-04

- **Why:** does a larger local model clear the control?
- **Setup:** `--roster=local-tiers`, text contract. Abandoned at 2 games.
- **RESULT:** gpt-oss:20b invalid 0.474 with **54%** of replies hitting the token cap;
  qwen3:4b 0.467 with **87%**.
- **FINDING — this measured my token budget, not the models.** Reasoning models reason in
  proportion to context, so as the ledger grows the reply exhausts its budget before
  emitting any field. gpt-oss:20b produced its vote in **0 of 5** votes. Raising the cap
  to 2,500 moved the failure a day later and pushed one vote to **91 s**; the chase does
  not converge because the ledger keeps growing.
- **Three patches, each helping and none sufficient:** per-kind budgets; Qwen3's
  `/no_think` (it ignores API-level `think:false`); decision-first field ordering
  (capture 6/18 → 9/13, still 54% truncated).
- **Kept, not deleted.** The useful part is that plausible patches improved the symptom
  without touching the cause, and the cause only became visible once truncation was
  counted separately from bad answers.

## 004 — Output contract fixed: schema-constrained decoding — 2026-08-04

- **Why:** 003's cause was the contract itself.
- **Setup:** per-request JSON schema via Ollama's `format`; `--output=json` now default.
  Same prompts replayed from 003's logs.
- **RESULT — invalid-move rate, text vs schema:**

  | model | invalid (text) | invalid (schema) | latency |
  |---|---|---|---|
  | qwen3:4b | 0.467 | **0.000** | 16.5 s → 4.6 s |
  | gpt-oss:20b | 0.474 → 0.292 | **0.143** | 91 s (vote) → 20 s |
  | gemma3:1b | 0.509 | **0.192** | 2.7 s |
  | qwen3.5:2b | 0.115 | **0.080** | 4.3 s |

- **FINDING — a grammar cannot emit a document missing a required property**, so
  reasoning is structurally unable to crowd out the decision. Per-game wall-clock
  ~18 min → ~5 min.
- **FINDING — exp 015's warning does not transfer.** That experiment found
  grammar-constrained decoding "yields degenerate loops instead of syntax errors"; no
  degeneracy was seen at any size here. It concerned character-level masking of a weak
  from-scratch LM whose distribution was nowhere near valid. These are instruction-tuned
  models emitting a few short fields.
- **DESIGN — targets are deliberately not enum-constrained.** Restricting them to living
  players would make illegal moves impossible and silently zero `invalid_move_rate` and
  `namedDeadPlayer` — the metrics that measure roster tracking, and 002's headline
  result. That would present a constraint as a capability. `--strict-targets` opts in.
- **Residual defect at this point:** gpt-oss:20b still capped 29% of replies.

## 005 — gpt-oss needs a reasoning EFFORT level, not a bigger cap — 2026-08-04

- **Why:** close 004's residual, which was a live confound against the one model whose
  result looked wrong.
- **Setup:** largest real statement prompt from the logs, schema on, budgets varied.
- **RESULT:**

  | think | budget | done_reason | eval | valid JSON | latency |
  |---|---|---|---|---|---|
  | `false` | 1200 | length | 1200 | no | 22.8 s |
  | `false` | 2500 | length | 2500 | no | 48.4 s |
  | `"low"` | 1200 | **stop** | 142 | **yes** | **6.3 s** |
  | `"low"` | 2000 | **stop** | 103 | **yes** | **3.6 s** |

- **FINDING — `think:false` does not disable reasoning for gpt-oss.** The tokens go to a
  harmony channel the JSON schema does not constrain, so it exhausts any budget while
  its emitted JSON stays absent. An effort level fixes it and is 4–7× faster. In-game
  mean latency 19.6 s → 4.3 s, 20/20 valid JSON.
- **FINDING — that is three distinct reasoning-model defects, in three different
  places:** the visible channel (fixed by schema), the hidden channel (fixed by effort
  level), and Qwen3's plain-prose reasoning (fixed by `/no_think`). None was visible from
  the play metrics alone; all three needed truncation counted as its own signal.

## 006 — Tier arm, schema contract, 6 games — NOT CONCLUSIVE — 2026-08-04

- **Setup:** `--roster=local-tiers --games=6 --seed=7 --output=json`, before 005's fix.
- **RESULT:** qwen3:4b +0.600 (n=6), control −0.114 (n=12), gemma3:1b −0.200,
  gpt-oss:20b −0.378 (n=12), qwen3.5:2b −0.400. Town won 1/6.
- **FINDING — not a leaderboard.** n is 6–12 accusations. The control scored −0.114 here
  against +0.133 in 001 on the same fixed policy, so the sampling noise exceeds nearly
  every gap in the table.
- **Superseded by 007**, which reversed the ordering entirely — see below. Kept as the
  record of why 6 games is not enough.

## 007 — Tier arm, 60 games, seed 7 — interim notes (superseded by the RESULT entry below)

- **Why:** 006's ordering was noise and gpt-oss was confounded by truncation. Raise n
  with 005's fix in place.
- **Setup:** `--roster=local-tiers --games=60 --seed=7 --output=json`. Seats:
  2× gpt-oss:20b, 1× qwen3:4b, 1× qwen3.5:2b, 1× gemma3:1b, 2× rule-based control.
  ~90–110 s/game.
- **Interim at 8 games:** gpt-oss:20b **+0.137** (top), qwen3:4b **−0.400** — a complete
  reversal of 006 at the same seed, which is the cleanest available demonstration that
  006 was noise.
- **Interim at 33 games (n=33–66):**

  | model | tier | n | det.lift | decep. | consist | calib | invalid |
  |---|---|---|---|---|---|---|---|
  | qwen3.5:2b | small-local | 33 | +0.218 | 0.662 | 0.640 | −0.050 | 0.149 |
  | gemma3:1b | small-local | 33 | +0.148 | 0.638 | 0.694 | 0.000 | 0.129 |
  | control | baseline | 66 | +0.125 | 1.948 | 0.853 | **+0.192** | 0.000 |
  | gpt-oss:20b | large-local | 66 | +0.038 | 1.785 | 0.911 | +0.006 | 0.016 |
  | qwen3:4b | mid-local | 33 | −0.041 | 0.885 | 0.980 | 0.000 | 0.043 |

- **Interim reading, to be re-checked at n=60:** the size ordering is inverted (2B and 1B
  above the 20B), which is suspicious enough to deserve the standing rule about
  distrusting a good measurement. But `calib` is consistent with 002 and with
  trainingResearch finding 12: the control carries **+0.192** of confidence signal and
  every model carries ~0.000 or negative. Models pick suspects slightly better than
  bandwagoning while their stated confidence means nothing.
- **Caveat:** qwen3.5:2b named a dead player 29 times and its invalid rate (0.149) sits
  right on the 0.15 gate, so its det.lift is the least trustworthy row.

## 007 — RESULT: tier arm, 60 games, seed 7 — the spread collapses

- **Setup:** `--roster=local-tiers --games=60 --seed=7 --output=json`, with 005's
  reasoning-effort fix in place. Seats: 2× gpt-oss:20b, 1× qwen3:4b, 1× qwen3.5:2b,
  1× gemma3:1b, 2× rule-based control. Town won **13 of 60**.
- **RESULT:**

  | model | tier | n | det.lift | vote.lift | decep. | consist | calib | invalid |
  |---|---|---|---|---|---|---|---|---|
  | qwen3.5:2b | small-local | 60 | +0.167 | +0.025 | 1.067 | 0.667 | −0.050 | 0.147 |
  | **control** | baseline | 120 | **+0.146** | +0.122 | 1.616 | 0.858 | **+0.148** | 0.000 |
  | gpt-oss:20b | large-local | 120 | +0.108 | +0.120 | 1.766 | 0.901 | +0.040 | 0.013 |
  | gemma3:1b | small-local | 60 | +0.085 | +0.106 | 0.781 | 0.705 | −0.013 | 0.136 |
  | qwen3:4b | mid-local | 60 | +0.078 | +0.062 | 0.921 | 0.976 | −0.007 | 0.051 |

- **FINDING — at adequate n the detection spread collapses to +0.078…+0.167.** Every
  model and the control sit inside one tenth of a point. Compare the same roster and seed
  at n=6 (006: +0.600 to −0.378) and n=8 (+0.137 to −0.400). **The dramatic orderings
  were entirely sampling noise, and this is the cleanest demonstration of it the project
  has** — same seed, same code, three batch sizes, three different "leaderboards", one
  converged answer.
- **FINDING — no model clearly beats the rule-based control on detection.** The best,
  qwen3.5:2b at +0.167, leads the control by 0.021 — and the control's *own* score across
  batches has been +0.293 / +0.133 / −0.114 / +0.125 / +0.146 on an unchanged policy. The
  gap is far inside that. Nor is the size ordering meaningful: the 20B (+0.108) sits
  between the 2B and the 4B.
- **FINDING — calibration is the one metric that discriminates, and it has held its sign
  at every batch size.** Control **+0.148**; gpt-oss:20b +0.040; qwen3:4b −0.007;
  gemma3:1b −0.013; qwen3.5:2b −0.050. The models pick suspects about as well as a
  bandwagon policy while their stated confidence carries **no information** — and two of
  four are *inverted*, more confident when wrong. Consistent with 002 (n=12) and with
  trainingResearch finding 12: next-token loss cannot separate fluent from correct.
- **CAVEAT — qwen3.5:2b's top row is the least trustworthy.** invalid 0.147 sits on the
  0.15 gate and it named a dead player **63 times**. gemma3:1b: 48 times (invalid 0.136);
  qwen3:4b: 28; gpt-oss:20b: 9. Roster tracking scales with size cleanly even where
  detection does not — the clearest size effect in the table.
- **INTERPRETATION CAUTION — low `decep.` for small models is probably not skill.**
  gemma3:1b draws the least suspicion (0.781) while gpt-oss:20b draws the most (1.766).
  A model that says little of substance gives the room no grounds to suspect it, which
  looks identical to being a good liar in this metric. Distinguishing the two needs a
  statement-substance measure this repo does not have.
- **Memory budget held:** per-model latency by quarter (g1-15 → g46-60) drifted only
  2.8→3.6 s (gemma3:1b) and 4.8→5.2 s (gpt-oss:20b), with no step change, so no eviction
  thrash. *(The ad-hoc quarter-by-quarter script globbed the last 60 game files across
  all sessions, so two models from unrelated preflight test runs appeared in it; the
  007 rows are unaffected.)*
- **Limits:** one roster, one seed family, one player count. Town won only 22%, so the
  deception-side numbers come from games that ended early. No frontier model has been
  run, so it remains untested whether *anything* clears the control by a margin that
  survives this noise floor — which is the check that validates every row above.

## 008 — RESULT: `--context=full` vs `ledger`, paired, 60 games each

- **Why:** prediction 4 in `RESEARCH.md`, the only one whose answer is useful either way.
  The ledger exists because trainingResearch finding 55 measured context as the largest
  small-model lever *while* a window wider than the capacity can use made results worse,
  and findings 10/50 measured an explicit table beating added parameters.
- **Setup:** identical to 007 — same roster, **same seed 7**, 60 games, schema contract —
  changing only `--context=full`. Town won **7 of 60**, against 13 of 60 in 007.
- **RESULT — det.lift, paired:**

  | model | ledger (007) | full (008) | delta | vs control |
  |---|---|---|---|---|
  | qwen3:4b | +0.078 | −0.035 | −0.113 | +0.023 |
  | gemma3:1b | +0.085 | −0.033 | −0.118 | +0.018 |
  | **control** | +0.146 | +0.010 | **−0.136** | (is control) |
  | gpt-oss:20b | +0.108 | −0.028 | −0.136 | −0.000 |
  | qwen3.5:2b | +0.167 | −0.195 | **−0.362** | **−0.226** |

- **FINDING — the derived ledger beats the raw transcript for every arm, and it is not
  close.** Absolute drops of −0.113 to −0.362, every model going from positive to
  *negative* detection lift, and town wins nearly halving. On the absolute numbers the
  ledger is the single largest design lever measured in this project.
- **FINDING — but the rule-based control dropped too, by −0.136, and it never reads the
  rendered prompt at all.** The control consumes `view.suspicions` and `view.votes` as
  structured data; `--context=full` cannot touch its inputs directly. Its drop is
  *downstream*: the models played differently, the games diverged, and the control's
  policy depends on other players' voting records and on the bandwagon signal. So a large
  part of the absolute effect is "these games got harder for everyone", not "full context
  hurt this model".
- **FINDING — corrected against the control, only the 2B model is materially affected.**
  qwen3.5:2b −0.226 relative; gpt-oss:20b **−0.000**; qwen3:4b +0.023 and gemma3:1b +0.018,
  both inside noise. **Prediction 4 is therefore half right.** It predicted the ledger
  would help small models and be noise for large ones: the difficulty-corrected numbers say
  exactly that for the 2B and the 20B, while the raw numbers say the ledger helps
  everything. Which of those is the real effect is not settled by this design.
- **LIMITATION that matters more than the result — paired seeds fix initial conditions,
  not trajectories.** The seed fixes role assignment, seating and tie-breaks, but the
  moment any model makes a different choice the two games diverge. So 007 and 008 are
  paired at setup and independent thereafter, and "full context hurt model X" cannot be
  cleanly separated from "full context made the games harder for everybody". The control's
  −0.136 is the size of that confound, and it is as large as most of the effects.
- **Secondary observations:** `consist` fell in full mode for every arm (control
  0.858→0.751, gemma3:1b 0.705→0.470), so players' votes matched their stated accusations
  less often when given raw transcripts. gemma3:1b's invalid rose 0.136→**0.170**, over the
  0.15 gate. `calib` moved slightly *up* for the models (qwen3.5:2b −0.050→+0.067,
  gpt-oss:20b +0.040→+0.098) — unexplained, and not over-read at this n.
- **Design consequence:** `--context=ledger` stays the default, now on evidence rather
  than on the inference from findings 55/10/50 that motivated it.

## 009a — RESULT: ladder-small, 30 games — every model below chance

- **Setup:** `--roster=ladder-small --games=30 --seed=7`. Seats: gemma3:1b, qwen3.5:2b,
  granite3.2:2b, qwen3:4b, llama3.1:8b, 2× control. 12.5 GB resident. Town won **2 of 30**.
- **RESULT:**

  | model | tier | n | det.lift | decep. | consist | invalid | dead-player refs |
  |---|---|---|---|---|---|---|---|
  | **control** | baseline | 60 | **+0.076** | 0.262 | 0.784 | 0.000 | 0 |
  | granite3.2:2b | small-local | 30 | −0.179 | 0.919 | 0.722 | 0.026 | 9 |
  | **llama3.1:8b** | upper-mid | 30 | **−0.196** | 0.000 | 0.750 | **0.000** | **1** |
  | gemma3:1b | small-local | 30 | −0.212 | 0.445 | 0.633 | 0.145 | 14 |
  | qwen3:4b | mid-local | 30 | −0.229 | 0.917 | 0.971 | 0.050 | 8 |
  | qwen3.5:2b | small-local | 30 | −0.320 | 2.332 | 0.647 | 0.191 | 35 |

- **FINDING — with five model seats and no 20B, every model scores BELOW chance and only
  the control is positive.** This is much starker than 007, where the field was half
  control and included a 20B.
- **FINDING — llama3.1:8b is the clean counterexample that kills the format excuse.**
  invalid **0.000**, one dead-player reference in 30 games, perfect protocol compliance —
  and det.lift **−0.196**. Its accusations are worse than picking a living player at
  random. **Whatever is failing at 8B is not the response contract and not roster
  tracking; it is the inference itself.** Every previous negative result had a plausible
  format confound attached. This one does not.
- **FINDING — town won 2 of 30.** A field of weak town players cannot convert. Combined
  with 007 (13/60) and 008 (7/60), the pattern is that town's win rate tracks how good the
  *field* is rather than any single seat, which is a property of the game and a reason the
  per-turn metrics exist.
- **Caveat:** qwen3.5:2b invalid 0.191 and gemma3:1b 0.145 — the first is over the gate,
  the second on it. llama3.1:8b's `decep.` of 0.000 means it drew zero town accusations as
  Mafia, which at 30 games and a 6.7% town win rate more likely reflects games ending
  before suspicion could form than concealment skill.
- **Limits:** one seed family, 30 games, one roster. n=30 per model is half of 007's.

## 009b/009c — RESULT: the large end, anchored — reasoning mode beats size

- **Why:** 007 put a 20B *below* a 2B, which needed either confirming or explaining. Two
  candidate explanations: size does not help, or the reasoning *mode* is what helps and
  gpt-oss:20b happens to have it. One large model on the board cannot separate those.
- **Setup:** two 30-game batches at seed 7, each holding **one** large model, because both
  together is ~39 GB and over the memory budget (DEFECT 12). `llama3.1:8b`, `qwen3:4b`,
  `qwen3.5:2b` and the control appear in both as **anchors**, making the large models
  comparable *through* them.
- **RESULT — 009b (gpt-oss:20b, 23.9 GB, town 8/30):**

  | model | n | det.lift | invalid | calib | lat |
  |---|---|---|---|---|---|
  | control | 60 | **+0.155** | 0.000 | +0.228 | 0 |
  | qwen3.5:2b | 30 | +0.137 | 0.101 | 0.000 | 4.0 s |
  | **gpt-oss:20b** | 60 | **+0.113** | 0.013 | +0.056 | 4.2 s |
  | llama3.1:8b | 30 | +0.083 | 0.006 | −0.050 | 7.1 s |
  | qwen3:4b | 30 | −0.073 | 0.039 | −0.025 | 4.4 s |

- **RESULT — 009c (mistral-small:24b, 24.4 GB, town 6/30):**

  | model | n | det.lift | invalid | calib | lat |
  |---|---|---|---|---|---|
  | control | 60 | **+0.147** | 0.000 | +0.154 | 0 |
  | qwen3.5:2b | 30 | +0.094 | 0.152 | — | 4.4 s |
  | qwen3:4b | 30 | +0.026 | 0.053 | −0.033 | 4.5 s |
  | **mistral-small:24b** | 60 | **−0.001** | 0.000 | −0.032 | **18.3 s** |
  | llama3.1:8b | 30 | −0.005 | 0.000 | 0.000 | 5.9 s |

- **ANCHOR DRIFT — the design worked.** Between arms: control +0.155 → +0.147
  (**−0.008**), qwen3.5:2b −0.043, qwen3:4b +0.099, llama3.1:8b −0.088; mean ≈ **−0.010**.
  The control barely moved, so the two batches are comparable and the split was not a
  compromise. *(The 8B and 4B anchors swinging ±0.09 at n=30 is the noise floor at that
  sample size — worth remembering before reading any n=30 row closely.)*
- **FINDING — reasoning mode, not parameter count.** mistral-small:24b is the **larger**
  model (23.6 B vs 20.9 B) and non-reasoning, and it scores at **exactly chance**
  (−0.001). gpt-oss:20b with low reasoning effort scores **+0.113**. Δ ≈ **+0.114**, about
  +0.104 after anchor correction — an order of magnitude larger than the anchor noise, and
  **both have essentially perfect protocol compliance** (invalid 0.000 and 0.013), so this
  is not a format artefact. This is the clearest single explanatory result in the project:
  what buys detection here is *deliberate inference at generation time*, not scale.
- **FINDING — the control still leads every arm.** +0.155 and +0.147, above every model in
  both. Nothing measured so far beats a few dozen lines of voting-record policy.
- **FINDING — the worst cost/benefit measured here.** mistral-small:24b costs 18.3 s per
  call, 4.4× gpt-oss:20b's 4.2 s, and returns chance-level detection. The reasoning model
  is both better and cheaper, because low effort emits few visible tokens.
- **Caveats:** n=30 per anchor seat, 60 for the doubled large seats. qwen3.5:2b's 009c row
  (invalid 0.152) is over the gate. Town won 8/30 and 6/30, so deception-side numbers come
  from short games. One seed family throughout.

## 010 — RESULT: CTF fine-tune vs its own base — no transfer, and it cost compliance

- **Why:** the CTF project's `ctf-custom-q4` is Qwen2.5-3B + LoRA on capture-the-flag
  replays, reported there as matching mid-size cloud models on offense (bounded) and
  trailing on defense (open-ended). Seated beside **its own base model** so a difference
  cannot be explained by size or family.
- **Setup:** `--roster=ctf-transfer --games=30 --seed=7`. 2× ctf-custom-q4, 2× qwen2.5:3b,
  gemma3:1b, granite3.1-dense:2b, 1× control. Town won **2 of 30**.
- **RESULT:**

  | model | n | det.lift | invalid | calib | dead-player refs |
  |---|---|---|---|---|---|
  | gemma3:1b | 30 | +0.202 | 0.128 | 0.000 | 20 |
  | control | 30 | +0.071 | 0.000 | +0.188 | 0 |
  | granite3.1-dense:2b | 30 | +0.006 | 0.097 | −0.056 | 23 |
  | **ctf-custom-q4 (tuned)** | 60 | **−0.133** | **0.103** | −0.005 | **43** |
  | **qwen2.5:3b (base)** | 60 | **−0.159** | **0.013** | −0.027 | **11** |

- **FINDING — no transfer.** Tuned −0.133 vs base −0.159 is **+0.026**, inside the noise
  floor (±0.09 at n=30 per 009b/c; these are n=60 so perhaps ±0.06). Both sit below
  chance. As predicted: CTF replays teach shell-command selection, not social inference.
- **FINDING — and the fine-tune actively cost protocol compliance.** Dead-player
  references **43 vs 11** and invalid **0.103 vs 0.013** against its own base — roughly
  eight times the roster-tracking failures and eight times the illegal moves, for no
  detection gain. **A LoRA on out-of-domain replays degraded a capability it was never
  aimed at.** This is the sharper version of the prediction and it echoes the CTF
  project's own v5/v7 lesson, where replay loops reinforced the model's mistakes and had
  to be rolled back.
- **CAUTION — gemma3:1b tops this table at +0.202, and that number is not a model
  property.** The same model across batches: −0.450 (002, void text contract), +0.085
  (007), −0.033 (008), −0.212 (009a), **+0.202** (010). Excluding the void run that is a
  **0.414 spread** at n=30–60. Its invalid here is 0.128 with 20 dead-player references.
- **META-FINDING that qualifies every table in this log — det.lift is a property of a
  model *in a field*, not of a model.** Roster composition moves a weak model's score more
  than the model's own identity does, because detection depends on the evidence other
  players generate. Cross-batch comparisons are therefore only safe through **shared
  anchors at the same seed** (as in 009b/c), never by lifting a row out of one table and
  putting it beside a row from another. Several readings earlier in this log came close to
  that mistake.

## 011 — Isolate the context effect: one seat differs — READY (harness built)

- **Why:** 008 could not attribute its own result. It switched every seat from ledger to
  full at once, the games diverged, and the rule-based control — which never reads the
  rendered prompt — moved by −0.136, as much as the models did.
- **BUILT:** context mode is now **per-seat**, not global. A roster entry may be written
  `key@ledger` / `key@full`; unqualified seats follow `--context`. Verified: overrides
  parse, an unknown mode is rejected at config load, and `engine.viewFor` reads the mode
  off the agent rather than global config (which was the actual cause of 008's ambiguity).
  Two rosters added: `ctx-one-full` and its mirror `ctx-one-ledger`.
- **Setup:** duplicate seats differing only in context mode — `qwen` vs `qwen@full`,
  `qwen3-4b` vs `qwen3-4b@full` — inside the *same games*. Trajectory divergence is then
  shared by construction and cancels, instead of confounding the comparison.
- **Expected:** if 008's raw −0.11 to −0.36 was mostly game difficulty, the within-game
  gap here will be much smaller. If the ledger genuinely helps, the `@full` twin
  underperforms its own `ledger` twin in the same games.

- **Why:** 008 cannot attribute its own result, because both arms changed every seat at
  once and the games diverged. This is the fix.
- **Setup:** all seven seats on `--context=ledger` except **one**, which gets `full`. Run
  the mirror too (all `full`, one `ledger`). Compare that seat against its own tier-mates
  *inside the same games*, so trajectory divergence is shared by construction and
  cancels instead of confounding.
- **Requires a small change:** context mode is currently global
  (`CONFIG.game.contextMode`, applied to every agent in `buildAgents`). It needs to be
  per-seat — a roster entry option rather than one flag.
- **Why this is the right next experiment:** it is the only way to turn 008's large but
  unattributable effect into an attributable one, and the ledger is load-bearing enough
  in this design that it deserves a clean number.

- **Why:** the only prediction in `RESEARCH.md` whose answer is useful either way
  (prediction 4). The ledger exists because trainingResearch finding 55 measured context
  as the largest small-model lever *while* a window wider than the capacity can use made
  results worse, and findings 10/50 measured an explicit table beating added parameters.
  If the derived ledger helps small models and not large ones, that design is load-bearing.
  If it helps large models more, my reading of finding 55 is wrong. If it changes nothing,
  either the transcripts are too short for context to bind or the tables are not the state
  that matters.
- **Setup:** identical to 007 but `--context=full`, same roster, **same seed 7**, 60
  games, so it is paired game-for-game with 007 rather than an independent sample.
- **Expected:** ledger ≥ full by +0.05 det.lift or better for the 1–2B seats; within noise
  for gpt-oss:20b.

## 009 — Size ladder, 1B → 24B — QUEUED

- **Why:** 007 suggests an inverted size ordering. A ladder with one seat per size and a
  non-reasoning large model beside the reasoning one separates the two explanations:
  size, or reasoning mode.
- **Setup:** `--roster=ladder --games=30 --seed=7`. Seats: gemma3:1b, qwen3.5:2b,
  qwen3:4b, llama3.1:8b, gpt-oss:20b, mistral-small:24b, control.
- **Risk to watch:** ~39 GB of weights resident across six models. If Ollama starts
  evicting and reloading, latency will spike and that is a throughput artefact, not a
  model property — check `lat.ms` for step changes before reading anything else.

## 010 — CTF fine-tune transfer, paired against its base — QUEUED

- **Why:** the CTF project's `ctf-custom-q4` is Qwen2.5-3B + LoRA on capture-the-flag
  replays. Its README reports the tuned model matching mid-size cloud models on offense
  (bounded) and trailing on defense (open-ended). Mafia's decision channel is
  offense-shaped and its speech channel defense-shaped, so this predicts a split.
- **Setup:** `--roster=ctf-transfer --games=30 --seed=7`, seating `ctf-bot` beside
  **qwen2.5:3b, its own base model**, so a difference cannot be explained by size.
- **Expected:** no transfer. CTF replays teach shell-command selection, not social
  inference, and trainingResearch's v5/v7 lesson was that replay loops reinforce a
  model's own mistakes.

## 012 — Frontier APIs are BLOCKED (billing), substituted with within-family scale — 2026-08-05

- **Why:** open question 4 — do frontier models clear the rule-based control? It is the
  check that validates every other number in this log: if frontier models also sit near
  +0.13, the benchmark is measuring bandwagon dynamics rather than reasoning.
- **BLOCKED — all four frontier providers refused on account state, not on code.** Probed
  one cheap call each before committing to a batch:

  | provider | model | result |
  |---|---|---|
  | Anthropic | claude-opus-5 | `400` — credit balance too low |
  | OpenAI | gpt-4o | `429` — account is not active, check billing |
  | xAI | grok-3 | `403` |
  | Google | gemini-2.5-pro | fetch error |

  Keys authenticate; the accounts are unfunded. **Open question 4 cannot be answered
  from this machine until an API account is funded** — no amount of harness work
  substitutes.
- **DEFECT 14 found by the same probe (would have failed the whole batch).** The Claude
  adapter, ported from the CTF project, sent `temperature: 0.8`. Sampling parameters are
  **rejected with a 400 on every current Claude model** (Opus 5, Sonnet 5, Opus 4.8/4.7),
  so the roster would have died on its first call. Also updated: `claude-sonnet-4-6` →
  `claude-opus-5`, structured outputs via `output_config.format`, and `max_tokens` raised
  because on Opus 5 it caps thinking *plus* response text together. A one-call-per-provider
  probe cost about a tenth of a cent and caught it.
- **Ollama Cloud, probed the same way:** `gpt-oss:120b` and `nemotron-3-super` answer;
  `glm-5.1` needs a paid subscription; `gemini-3-flash-preview` (retired 2026-07-15) and
  `rnj-1:8b` (retired 2026-06-30) are gone. Three of the five entries carried over from
  the CTF config were dead. They are now marked `unavailable` and **preflight refuses any
  roster containing one** — a retired model otherwise fails a batch an hour in.
- **SUBSTITUTED — `scale-vs-control`, which is arguably the better experiment.** Seats
  **gpt-oss:120b beside gpt-oss:20b**: the same model family at 6x the parameters, on one
  board, with the control present and `qwen3-4b` anchoring back to 007-011. That compares
  scale *within* a family rather than across vendors, so a difference cannot be a
  vendor-training artefact. gpt-oss:20b already measured +0.113 (009b), which makes this a
  direct read on whether 6x the parameters buys detection.
- **Pilot health (6 games, seed 7):** zero API errors. gpt-oss:120b 10/10 valid JSON at
  5.5 s/call; nemotron 3/4 at 21.8 s; gpt-oss:20b 3/3; qwen3:4b 2/2. Results to follow.
- **What this does NOT establish:** nothing about frontier models. `gpt-oss:120b` is a
  large open model, not GPT-5 or Opus 5, so question 4 stays open and the caveat on every
  other table stands.

### 012 pilot result — PIPELINE VALIDATED, numbers NOT a result

6 games, seed 7, `--roster=scale-vs-control`. Town won 2 of 6.

| model | tier | n | det.lift | decep. | consist | calib | invalid | lat.ms |
|---|---|---|---|---|---|---|---|---|
| nemotron-3-super | large-open | 6 | +0.633 | 0.816 | 1.000 | — | 0.143 | 16712 |
| gpt-oss:20b | large-local | 6 | +0.043 | 0.674 | 1.000 | +0.100 | 0.000 | 4652 |
| control | baseline | 12 | +0.026 | 0.000 | 0.923 | +0.258 | 0.000 | 0 |
| gpt-oss:120b | large-open | 12 | −0.089 | 2.665 | 0.875 | +0.150 | 0.080 | 9079 |
| qwen3:4b | mid-local | 6 | −0.121 | 0.000 | 1.000 | +0.063 | 0.032 | 3996 |

- **DO NOT READ THIS AS A LEADERBOARD.** n is 6–12 accusations per model — precisely the
  regime that produced +0.600/−0.378 in run 006 and then *reversed completely* at n=60 in
  007. `nemotron-3-super` at +0.633 rests on **six** data points, and its invalid rate
  (0.143) sits on the gate. Recording the table for provenance, not as a finding.
- **What the pilot DID establish, which was its purpose:** the hosted-model path works
  end to end. Zero API errors across 6 games; `gpt-oss:120b` invalid 0.080 at 9.1 s/call;
  `nemotron` 0.143 at 16.7 s; both local seats clean. Nothing in the harness blocks a real
  batch.
- **Throughput for sizing one:** ~5 min/game, so 30 games ≈ 2.5 h and 60 games ≈ 5 h.
- **The question it was built to answer is now runnable but unanswered.** gpt-oss:120b
  (−0.089) scoring *below* gpt-oss:20b (+0.043) — 6× the parameters for no gain — is the
  interesting hypothesis and is **entirely inside the noise** at these n. It needs 30+
  games before it means anything. Note 20b's own +0.113 in 009b came from n=120.
- **One observation the metrics do not capture, worth a look in the raw log:**
  `gpt-oss:120b` claimed Detective and cited its actual investigation result in a public
  statement — real hidden-information play, and the first genuinely competent Mafia
  reasoning seen in this project. Whether that converts to detection lift is what the
  larger batch would decide.

## 013 — 100-game ten-model batch — KILLED at 14/100, relaunched — 2026-08-05

- **Why:** a long, fully documented batch with ten models, so per-turn reasoning and game
  events exist as report material rather than only as metrics.
- **KILLED at game 14 of 100, by the OS, with no error in the log.** Swap 19.5 of 20 GB,
  7.8M swapouts. Cause was **DEFECT 15**: preflight summed *file sizes* (28.3 GB, passed)
  while real residency is 1.3-1.6x that — `num_ctx: 8192` allocates a KV cache per model
  that the file size does not include. The guard measured a proxy and the proxy passed.
- **Salvaged:** the 14 completed games are intact and usable — **835 model calls across
  all 10 models**, with reports generated from them. Nothing was lost but time, because
  each game is written to its own file as it finishes rather than at the end of the batch.
- **Fixed, two stages:** estimate resident as `file x 1.5` before pulling, then **verify
  actual residency from `/api/ps` after warming** and refuse if over. On the new roster:
  estimated 24.2 GB, verified **17.5 GB** — the multiplier errs safe.
- **ROOT CAUSE, found after two more failures — DEFECT 16, not memory pressure at all.**
  013b died in game 1 and 014 refused to start, both with swap ~93% full, which looked like
  the machine simply having no headroom. It was not. `warmModel()` omitted `num_ctx`, so
  Ollama loaded each model at its **native** context length and reserved a matching KV
  cache: `qwen3:4b`, 2.5 GB on disk, was **42.3 GB resident**. Adding `num_ctx: 8192` to
  the warm-up took it to **4.1 GB**. One model in every roster was consuming the entire
  budget, which is why shrinking the roster did not help — `qwen3:4b` was the anchor I had
  insisted on keeping. **The full ten-model roster fits after the fix; nothing needed to be
  given up.**
- **Roster changed to fit, at a cost worth naming (SUPERSEDED by the fix above).** `gpt-oss:20b` is ~14 GB resident,
  over half the local budget, and its inclusion is what killed the run. Dropping it bought
  six distinct smaller models, so the batch still fields ten: gpt-oss:120b and nemotron
  (hosted, no local memory), llama3.1:8b, qwen3:4b, qwen2.5:3b, qwen3.5:2b,
  granite3.1-dense:2b, exaone3.5:2.4b, gemma3:1b, and the rule-based control. **The
  20B-vs-120B same-family comparison is lost from this batch** and belongs in
  `scale-vs-control`, where it fits.

## 015 — 100-game ten-model batch — STOPPED at 43 games (DEFECT 17) — 2026-08-05

- **Setup:** `--roster=ten-model --games=100 --seed=7`, ten seats (1B to 120B plus the
  rule-based control), after DEFECT 16 fixed the memory problem. Ran clean on memory:
  Ollama held 9-11 GB throughout, no eviction.
- **STOPPED at 43 games** on discovering DEFECT 17. The interim table was not measuring
  the models: four of nine seats sat above the 0.15 invalid gate, and re-analysis showed
  that was truncated JSON being discarded, not models failing to choose.
- **Re-analysis of the captured `api.jsonl` (43 games, no games re-run):**

  | model | calls | decision captured, before → after salvage | recovered |
  |---|---|---|---|
  | nemotron-3-super | 227 | 16% → **55%** | +88 |
  | qwen3.5:2b | 59 | 2% → **88%** | +51 |
  | gpt-oss:120b | 256 | 86% → 91% | +14 |
  | gemma3:1b | 100 | 96% → 100% | +4 |
  | exaone3.5:2.4b, qwen3:4b, granite3.1-dense:2b, llama3.1:8b, qwen2.5:3b | 365 | 100% → 100% | 0 |

- **FINDING — five of nine models were never affected.** Their run-015 rows were real;
  llama3.1:8b at +0.013 and the control at +0.001 stand. The two badly affected models are
  the two most verbose, which is the mechanism: they hit the cap mid-`statement`.
- **What re-analysis CANNOT do, stated plainly:** it corrects the diagnosis, not the games.
  Those 43 games played out with seeded random moves substituted for the 157 lost
  decisions, so their trajectories are what they are and `det.lift` cannot be recomputed
  from salvaged decisions — a different vote produces a different game.
- **Fixed:** salvage parser plus the statement budget raised 1200 → 2200 (10-player prompts
  produce longer statements than the 7-player runs the budget was tuned on). Four checks
  added, including a mutation test.
- **Method note — three wrong hypotheses before the right one.** Roster size, then empty
  fields, then refusals; each was consistent with the aggregate violation counts, and only
  reading a raw API response settled it. Same pattern as runs 003 and 013: aggregate
  counters localise a problem, they do not identify it.
