# Roadmap

## V0.1 — Cognitive Feedback Core

**Goal:** prove that a lightweight intervention layer can reduce high-value reasoning outsourcing without materially hurting coding throughput.

Includes:

- dynamic cognitive prompt;
- deterministic intervention policy;
- reasoning gate;
- teaching back;
- local JSONL event log;
- future sink interface.

Explicitly excludes Soul-Spark runtime integration.

## Deferred from V0.1

- `hypothesis.challenged` event type — declared in the original schema but never emitted by the V0.1 implementation, so it was removed from the shipped vocabulary. Reintroduce it when a feature actually records a challenge to a user hypothesis.

## Shipped after V0.1 (2026-09-11)

Seven follow-up issues, all additive: the event schema stays **v1**, and every new
field or event type is optional, so an older log and an older reader both keep
working.

| Issue | Delivered |
|---|---|
| #2 correlation ids | `episodeId`/`interventionId` travel with the state; related events join by id, never by topic or timestamp |
| #1 Cognitive Episode | derived reasoning unit (`src/projection/episodes.ts`), deterministic reconstruction in append order, explicit `episode.closed` terminator |
| #3 teaching-back evidence | deterministic extraction of cause / mechanism / concept / confidence / length; still no correctness judgment |
| #4 prompt / memory boundary | renderer cannot import history (test-enforced); `CognitiveMemorySource` seam; every directive bounded |
| #5 projections | one-pass session/episode/intervention read models, digest-keyed in-memory + on-disk cache, rebuildable and discardable |
| #6 longitudinal metrics | exposure / response / outcome / utilization from persisted events; baseline-vs-feedback comparison with a non-causality caveat |
| #7 topic learning state | recurrence aggregated by normalized topic; resolution requires a later strong explanation; reporting-only |
| #9 decision ownership | policy answers `agent` / `shared` / `user` before choosing none / nudge / challenge / reasoning gate; matrix in `docs/decision-policy.md`; user-owned signals degrade instead of vanishing |

## V0.2 — Better feedback

Potential additions:

- improved task classification — **shipped** (evaluation/selection patterns);
- configurable intervention profiles;
- competency-aware cooldowns;
- richer debugging prompts;
- research-mode workflow;
- session review summary — **partly shipped** (`tools/cognitive-report.mjs` episodes/metrics);
- stronger tests against real DSH sessions — **partly shipped** (live harness + projection/metrics tests).

## V0.3 — Long-term learning

Potential additions:

- historical cognitive trend analysis — **shipped** (projections + longitudinal metrics);
- recurring knowledge-gap detection — **shipped** (topic learning state, #7);
- user-defined learning goals;
- adaptive intervention frequency — explicitly **not** yet: metrics are descriptive, and the policy stays deterministic and non-adaptive until the evidence supports it;
- durable skill evidence — **partly shipped** (structured teaching-back evidence, #3).

## Future — Soul-Spark integration

When Soul-Spark is stable enough, add an adapter implementing:

```ts
interface CognitiveEventSink {
  append(event: CognitiveEvent): Promise<void>;
}
```

The plugin should not need to know whether the sink is a file, database, API, or Soul-Spark service.

## Evaluation metrics

The plugin should eventually be evaluated with both productivity and learning metrics:

### Productivity

- task completion time;
- intervention overhead;
- unnecessary intervention rate;
- coding throughput;
- user override frequency.

### Cognitive ownership

- percentage of architecture tasks with user-authored hypotheses;
- independent debugging attempts;
- teaching-back success rate;
- repeated knowledge-gap frequency;
- decision ownership rate.

### Research workflow

- hypothesis quality;
- explicit experiment design;
- evidence-backed conclusions;
- frequency of AI-suggested ideas becoming unexamined decisions.

No single metric should be treated as a definitive measure of ability.