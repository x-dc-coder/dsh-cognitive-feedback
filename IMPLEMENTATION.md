# V0.1 Implementation Plan

## Phase 0 — Verify the DSH surface (DONE)

Verified on 2026-09-11 against the installed DSH **`0.1.5-rc.1`**. Findings are recorded in `docs/dsh-integration.md`; the summary is:

| Surface | rc.1 answer |
|---|---|
| Plugin anatomy | Cordis plugin package; default export; loaded via profile `cordis.patch.yml` `insert` rows (local path or `dsh plugin add`) |
| System-prompt extension | `ctx.systemPrompt.section({ name, order, text })` — text may be a per-assembly function |
| Dynamic update | Provider-function re-evaluation per assembly; auto-scoped when registered through `agent.ctx` |
| Session events | `ctx.on('session/event', (session, event) => …)` firehose; `turn/start`, `step/start`, `user/message`, `assistant/message`, `tool/result` |
| Agent events | `agent/created`, `agent/disposed`, `agent/pre-step`, `agent/turn-stopping`, `agent/status`, `agent/inbox/spliced` |
| Agent drive API | `ctx.agents.create/resume`; `handle.agent.followup/steer/inject/cancel/whenIdle` |
| User input | Official `ask_user_question` tool over the `ctx.userQuestions` seam (pauses the turn) |
| Inbox | Two lists `next-turn` / `next-step` via `agent/inbox/spliced` + session projection |
| Section orders | `SECTION_ORDERS` constants; cognitive section takes `700` |

Do not infer APIs from older DSH versions; re-verify against the installed declarations on every baseline bump.

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

The gate carrier is the official `ask_user_question` tool, which pauses the agent turn and returns the user's answer as compact JSON. Request a hypothesis with a stable question `id` and record the answer as a `hypothesis.submitted` event with `authorship: "user"`.

When the host has no user-interaction surface the tool call settles as an error rather than hanging; the plugin then degrades to a prompt-level gate (request the reasoning in the cognitive section and proceed) instead of inventing a second event loop.

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

Default location (respects the DSH home convention; do not hard-code `~/.dsh`):

```text
$DSH_HOME/cognitive-feedback/events.jsonl      # DSH_HOME defaults to ~/.dsh
```

The exact path remains configurable through plugin config.

## Actual source layout (implemented)

The plugin is written in **TypeScript** and compiled to dependency-free ESM. DSH loads the build output; it never sees the sources.

```text
src/
├── index.ts                 # plugin entry: name + apply(ctx, config)
├── dsh-adapter.ts           # the ONLY DSH-aware layer (events, section, signals)
├── cognitive/
│   ├── controller.ts        # orchestrator: state -> policy -> events -> section
│   ├── state.ts             # StateEngine (cache-stable versioning)
│   ├── policy.ts            # deterministic policy + budget
│   ├── classify.ts          # deterministic task / hypothesis classifier
│   └── signal.ts            # the normalized signal the adapter produces
├── prompt/
│   └── renderer.ts          # section rendering + memoizing renderer
├── events/
│   ├── types.ts             # versioned contract; payloads as a discriminated union
│   ├── factory.ts           # event construction
│   └── queries.ts           # read path + runtime narrowing of untrusted JSON
└── storage/
    ├── sink.ts              # CognitiveEventSink interface
    ├── jsonl-sink.ts        # default append-only store
    └── memory-sink.ts       # tests / read-only hosts
test/
├── *.test.js                # unit + adapter tests against dist/ (no DSH required)
├── types/type-regressions.ts# compile-only @ts-expect-error assertions
└── live/                    # real headless-session acceptance harness
```

Deviations from the sketched layout, and why:

- **`cognitive/signal.ts`** holds `CognitiveSignal`. Putting it in the adapter would make the core import the adapter and invert the dependency direction; the adapter depends on the core, never the reverse.
- **No `episodes/`.** The issue that proposed this layout explicitly excludes the Cognitive Episode feature (that is a separate issue), and unused type stubs would be dead code.
- **No `gate.ts` / `teaching-back.ts`.** The gate is a policy action plus a rendered directive, not an event loop; teaching back is state-driven. Splitting them would produce files holding only constants.
- **The plugin declares no static `inject`.** A Cordis `inject` gate is *required*: an entry waiting on it never activates and fails the whole profile boot (observed live against rc.1). Optional service use goes through `ctx.inject(['systemPrompt'], cb)`.

### Build, type and test

```bash
npm run resolve:dsh-types   # map DSH types to the INSTALLED harness (read-only)
npm run build               # tsc -> dist/ (JS + .d.ts)
npm run typecheck           # src + test/types, no emit
npm test                    # build, then node --test test/*.test.js
npm run test:live "<prompt>"  # real headless sessions
```

### Type-boundary policy

- `tsc` runs with `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess` and `verbatimModuleSyntax`.
- No `any` is used to pass the DSH API boundary. The single assertion is `AgentWithScopedContext` in `dsh-adapter.ts`: `agent.ctx` is documented in the dsh-agent README but is absent from the public `Agent` interface (which declares only `id`), so it has no official type at the rc.1 baseline. The assertion is confined to that boundary and carries the reason inline.
- Parsed JSONL is **untrusted**: `parseCognitiveEvent` narrows it at runtime, so nothing wears the `CognitiveEvent` type without earning it.

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
- section text is deterministic for the same state;
- an inactive state renders an empty section.

### Dynamic injection & prompt cache (live)

- the cognitive section toggles between active and empty across assemblies within one session;
- surrounding sections (identity, tool sections) are unchanged before and after a toggle;
- the assembled prompt is stable byte-for-byte while state is unchanged;
- on the configured model route, repeated assemblies with an unchanged prefix report cached-prefix reuse where the adapter exposes it (record the observed metric in `docs/testing.md`);
- when no cache metric is exposed, a relative comparison against a control run must show no material regression.

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