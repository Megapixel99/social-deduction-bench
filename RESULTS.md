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

## 011 — Isolate the context effect: one seat differs — QUEUED (design)

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
