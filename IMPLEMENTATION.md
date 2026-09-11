# V0.1 Implementation Plan

## Phase 0 — Verify the DSH surface

Before writing plugin code, inspect the exact DSH `v0.1.5-alpha.1` source/API.

Confirm:

- plugin manifest/anatomy;
- system-prompt extension point;
- agent/session event access;
- Session V3 event shape;
- dynamic system-prompt update API;
- plugin lifecycle and disposal;
- how a plugin can request/await user input;
- current package names and peer dependency ranges.

Do not infer APIs from older DSH versions.

## Phase 1 — Minimal vertical slice

Implement one end-to-end path:

```text
DSH signal
  → normalized signal
  → policy
  → cognitive prompt
  → event
```

The first slice should be able to detect one high-value task type, such as architecture, and inject one short intervention.

## Phase 2 — Reasoning Gate

Add:

1. detect architecture/high-uncertainty debugging/research signals;
2. request a user hypothesis;
3. record the hypothesis;
4. let the model challenge it;
5. record the final user decision;
6. continue implementation.

If the DSH API cannot elegantly pause/resume an agent turn, implement the first version as a prompt-level gate rather than inventing a second event loop.

## Phase 3 — Teaching Back

Add a post-task trigger for selected tasks.

Prompt:

```text
Teaching back: explain in 2–5 sentences why the solution solves the original problem.
```

The evaluator should classify the response into:

- `correct`
- `partially_correct`
- `incorrect`
- `skipped`

The first implementation may use deterministic checks or a lightweight evaluator; do not introduce a complicated model pipeline solely for evaluation.

## Phase 4 — Persistence

Implement:

```text
CognitiveEventSink
├── JsonlSink
└── MemorySink
```

Default location:

```text
~/.dsh/cognitive-feedback/events.jsonl
```

The exact path should remain configurable.

## Proposed source layout

```text
src/
├── index.ts
├── controller.ts
├── state.ts
├── policy.ts
├── prompt.ts
├── gate.ts
├── teaching-back.ts
├── events.ts
├── types.ts
├── dsh-adapter.ts
└── storage/
    ├── sink.ts
    ├── jsonl-sink.ts
    └── memory-sink.ts
```

Do not create files until the actual DSH plugin conventions have been verified. Adapt this layout when DSH's architecture suggests a better boundary.

## Deterministic policy examples

```ts
if (taskType === "architecture" && !state.currentHypothesis) {
  return {
    type: "reasoning_gate",
    reason: "architecture"
  };
}

if (taskType === "debugging" && uncertainty === "high") {
  return {
    type: "prompt",
    level: 2
  };
}

if (implementationIsRoutine) {
  return { type: "none" };
}
```

## Tests

Minimum test groups:

### Policy

- routine task → no intervention;
- architecture task without hypothesis → gate;
- high-uncertainty debugging → challenge;
- intervention budget exhausted → no strong intervention.

### Events

- every event has schema version;
- IDs are unique;
- JSONL output is append-only;
- malformed persistence does not crash the controller.

### Prompt

- cognitive section is bounded and removable;
- prompts remain short;
- no secrets are inserted;
- prompt regeneration is deterministic for the same state.

### Failure isolation

- DSH adapter failure does not crash the rest of the host;
- event sink failure does not block coding;
- teaching-back failure degrades to skipped.

## V0.1 acceptance criteria

The plugin is ready for a real-world alpha test when:

- it installs as a DSH plugin;
- it runs on the target DSH alpha baseline;
- routine coding is essentially unaffected;
- architecture/debugging/research tasks can trigger interventions;
- the user can provide a hypothesis before a reasoning gate continues;
- teaching-back can be recorded;
- cognitive events are stored as JSONL;
- Soul-Spark is not required;
- plugin failures fail open;
- automated tests cover policy and storage behavior.
