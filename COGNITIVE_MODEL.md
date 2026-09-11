# Cognitive Model

## 1. Why this plugin exists

AI coding agents are extremely good at implementation. That creates a specific risk for learning: the user can remain productive while gradually outsourcing the reasoning that would normally build engineering skill.

The plugin treats this as **cognitive debt**.

> Cognitive debt is important reasoning work completed by an AI agent that the user has not yet demonstrated they understand.

The concept is not a judgment of AI usage. It is a signal for where a small intervention may produce long-term value.

## 2. High-value vs low-value cognitive debt

### High-value

- problem formulation
- architecture selection
- algorithm selection
- root-cause analysis
- research hypothesis formation
- experiment design
- interpretation of unexpected results

### Low-value

- boilerplate
- repetitive CRUD
- formatting
- mechanical migrations
- generated test fixtures
- routine documentation formatting

V0.1 focuses on the first group.

## 3. Intervention levels

| Level | Behavior | Example |
|---|---|---|
| 0 | Normal | routine implementation |
| 1 | Nudge | ask the user to name the main assumption |
| 2 | Challenge | question an unsupported design choice |
| 3 | Reasoning gate | require a user-authored hypothesis before implementation |

The intervention level should be proportional to uncertainty and cognitive value.

## 4. Decision ownership

The plugin distinguishes three states:

```text
AI suggestion
      ↓
user evaluation
      ↓
user decision
```

The goal is not to prevent AI from proposing designs. The goal is to prevent an AI suggestion from becoming the user's decision without conscious evaluation.

## 5. Research mode

Research tasks use a stricter loop:

```text
Question
  ↓
Hypothesis
  ↓
Challenge
  ↓
Experiment
  ↓
Evidence
  ↓
Conclusion
```

A research hypothesis should be explicitly marked as user-authored, AI-suggested, or jointly refined. V0.1 records only the minimal metadata required for this distinction.

## 5.1 Teaching back as evidence capture

"Teaching back" asks the user to explain why a solution works. The plugin does
**not** grade the explanation. It extracts only what a deterministic rule can
observe:

- a stated cause and a stated mechanism;
- a concrete concept (an identifier, or a word from the topic);
- the user's own expressed confidence or uncertainty;
- answer length as a completeness band.

The result is labelled **evidence**, never correctness. A short answer is
evidence of a short answer, not of misunderstanding, and it does not by itself
create a knowledge gap. The two gap signals that do are the user declining to
answer, and the user saying outright that they are unsure.

Why so strict: an invented "correct" would be indistinguishable in the log from a
real one, and every later judgement — including this plugin's own reports — would
inherit the fabrication. Evidence that is honestly coarse is more useful than a
grade that is confidently wrong.

## 6. Heuristic signals

Possible signals include:

- architecture request with no user hypothesis;
- repeated "just implement it" requests for non-trivial design;
- debugging task where the user has not stated a suspected cause;
- user repeatedly accepting a generated solution without explanation;
- research task lacking a measurable hypothesis;
- same conceptual gap appearing repeatedly in teaching-back results
  (aggregated per normalized topic by `src/projection/learning.ts`).

These signals are heuristics, not psychological measurements.

## 7. Anti-annoyance rules

The plugin should never challenge every request.

Rules:

1. routine work passes through;
2. interventions have a budget;
3. a recently demonstrated competency reduces intervention frequency;
4. the user can explicitly request normal mode;
5. a failed intervention must not break the coding workflow.

## 8. What the plugin does not attempt to measure

It does not infer intelligence, personality, learning ability, or hidden reasoning quality. It does not calculate a definitive skill score.

The event log is an instrument for later review, not a psychological profile.

## 9. Topic-level learning state

`knowledge_gap.detected` events are aggregated by **normalized topic** — tokens
lowercased, deduplicated, sorted — so "refactor storage" and "storage refactor"
are one topic. Per topic the projection records the gap count, how many are
inside a recency window, the sessions involved, why each gap was recorded
(`skipped_answer`, `explicit_uncertainty`, `graded_low`), and whether a later
**strong** explanation (causal + mechanism evidence) answered it.

- `one_off` vs `recurring` is a count, not a judgment: the second gap on a topic
  makes it recurring.
- A strong explanation resolves the topic; a gap recorded after it reopens it.
- A skipped teaching-back is never a resolution.

This is **reporting-only**. Historical gap data never reaches the live prompt:
the same request produces the same directive whether the topic is new or its
fifth occurrence. Fewer gaps is not automatically progress — the caveats in §8
apply to this signal too.

## 10. Interpreting the longitudinal metrics

Metrics are computed only from persisted events, and are reported in three
groups plus coverage:

| Group | Examples |
|---|---|
| exposure | interventions issued, by reason, per session, episodes opened |
| response | hypotheses submitted, gate answered rate, teaching-back response rate |
| outcome | episode completion/abandonment, knowledge gaps by origin, recurring gap topics, median intervention→decision latency |
| utilization | sessions with/without an intervention |

Reading rules:

1. **Never read one number alone.** An intervention that produces no response is
   noise; a response rate without an outcome says nothing about reasoning.
2. **A missing denominator is `null`, not zero.** Zero-inflating a rate hides the
   fact that nothing was observed. Events written before correlation existed
   still count as exposure but cannot be joined to a response; they are reported
   as `uncorrelatedIssues` instead of being dropped.
3. **Correlation is not causation.** A change between a baseline period and a
   feedback period is not evidence that the plugin caused it: sample sizes are
   tiny, the baseline is not controlled, and other work moves at the same time.
   `comparePeriods()` returns that caution with the numbers, and the report prints
   it.
4. **Do not optimize for intervention count.** The objective is better reasoning
   with minimal interruption, so a high exposure with a low response is a
   regression, not a success.
