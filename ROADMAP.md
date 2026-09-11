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

## V0.2 — Better feedback

Potential additions:

- improved task classification;
- configurable intervention profiles;
- competency-aware cooldowns;
- richer debugging prompts;
- research-mode workflow;
- session review summary;
- stronger tests against real DSH sessions.

## V0.3 — Long-term learning

Potential additions:

- historical cognitive trend analysis;
- recurring knowledge-gap detection;
- user-defined learning goals;
- adaptive intervention frequency;
- durable skill evidence.

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
