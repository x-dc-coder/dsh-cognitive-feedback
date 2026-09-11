# DSH Cognitive Feedback

A lightweight cognitive-feedback plugin for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness).

## Purpose

DSH Cognitive Feedback is designed to preserve **human reasoning ownership** while keeping AI-agent development productive.

The plugin does not try to reduce AI usage. Instead, it detects moments where outsourcing the reasoning would create high-value cognitive debt and inserts a small intervention: a nudge, a challenge, a reasoning gate, or a teaching-back check.

> **Principle:** AI should accelerate implementation without silently replacing problem formulation, architecture decisions, debugging reasoning, or research judgment.

## V0.1 scope

V0.1 intentionally contains only four capabilities:

1. **Dynamic Cognitive Prompt** — inject a compact runtime instruction when an intervention is useful.
2. **Reasoning Gate** — before high-value decisions, ask the user to state a hypothesis or proposed direction.
3. **Teaching Back** — after selected work, ask the user to explain why the solution works.
4. **Cognitive Event Log** — persist structured events locally for later analysis.

Soul-Spark is **not** a V0.1 runtime dependency. A small `CognitiveEventSink` interface is reserved for future integration.

## Non-goals for V0.1

- No Soul-Spark integration
- No dashboard or web UI
- No cloud synchronization
- No long-term skill scoring
- No automatic source-code modification
- No full transcript storage by default
- No hidden chain-of-thought collection
- No ML-based cognitive classifier
- No complicated dependency graph

## Target baseline

V0.1 targets **DSH `0.1.5-rc.1`** (the installed baseline verified on 2026-09-11). DSH is in developer preview and its plugin APIs may change. The plugin must isolate DSH-specific integration code so future upgrades remain localized.

The plugin injects its cognitive section through the rc.1 `ctx.systemPrompt` section registry and observes `session/event` / `agent/*` events. See `docs/dsh-integration.md` for the verified interface contract and `docs/testing.md` for the acceptance tests, including the dynamic-injection / prompt-cache check.

## Architecture

```text
DSH Runtime
    │
    ├── session / agent events
    │
    ▼
Cognitive Controller
    ├── State Engine
    ├── Policy Engine
    ├── Prompt Builder
    ├── Reasoning Gate
    ├── Teaching Back
    └── Event Logger
              │
              ▼
      local JSONL event store
              │
              ▼
       CognitiveEventSink
              │
              └── future Soul-Spark adapter
```

## Prompt / memory boundary

Two data paths are deliberately kept apart:

| | Live prompt | Long-term memory |
|---|---|---|
| Input | current `CognitiveState` | raw `CognitiveEvent` log |
| Producer | `renderCognitiveSection()` (`src/prompt/renderer.ts`) | `buildProjection()` (`src/projection/`) |
| Output | one bounded directive, or nothing | episodes / sessions / interventions for reports |
| Cache | byte-stable while the state fingerprint is unchanged | rebuildable at any time |

`src/prompt/renderer.ts` never imports storage, the event log, or the projection
layer, and a test enforces that structurally. Historical events cannot change an
otherwise identical current prompt — also covered by a regression test.

Future memory work (Soul-Spark, a database, a summarizer) plugs into the
`CognitiveMemorySource` interface in `src/projection/memory.ts`. That is a seam,
not a dependency: the plugin ships an inert `NO_MEMORY` source, and neither the
policy nor the prompt layer imports it.

## Design constraints

- **Fail open:** if the plugin fails, normal DSH coding behavior continues.
- **Small prompts:** interventions should be short and actionable.
- **Rule first:** V0.1 uses deterministic heuristics instead of another LLM classifier.
- **User owns decisions:** the plugin may challenge a decision but never silently make the decision for the user.
- **Structured data only:** store cognitive metadata, not hidden reasoning traces.
- **Low intervention budget:** the system should help without becoming annoying.

## Repository map

- `ARCHITECTURE.md` — runtime architecture and component boundaries
- `COGNITIVE_MODEL.md` — cognitive debt, intervention policy, and learning model
- `EVENT_SCHEMA.md` — versioned event contract
- `IMPLEMENTATION.md` — V0.1 implementation plan and acceptance criteria
- `ROADMAP.md` — staged evolution beyond V0.1
- `AGENTS.md` — development rules for AI coding agents
- `docs/dsh-integration.md` — verified DSH rc.1 interface contract and compatibility notes
- `docs/testing.md` — unit + live acceptance tests, including dynamic prompt injection and cache impact
- `docs/examples.md` — expected runtime behavior examples
- `docs/development-workflow.md` — recommended human/AI development loop
- `src/` — TypeScript implementation (the only source; `lib/*.js` no longer exists)
- `src/projection/` — derived, rebuildable read models over the raw event log (episodes, sessions, interventions); never consulted by the live prompt
- `dist/` — build output loaded by DSH (generated; not committed)
- `tools/inspect-session.mjs` — Session V3 log inspector: injection evidence + cache metrics
- `tools/cognitive-report.mjs` — review the append-only log through the projection layer: funnel, episodes, sessions, interventions, timeline (run `npm run build` first)
- `test/` — unit tests and the live headless acceptance harness

## Development

```bash
npm install
npm run resolve:dsh-types   # map @deepseek-ai/* to the INSTALLED harness types (read-only)
npm run build               # tsc -> dist/ (JavaScript + .d.ts)
npm run typecheck           # type check, including test/types/*.ts regressions
npm test                    # build + unit tests
npm run test:live "<prompt>"  # real headless DSH sessions (control vs treatment)
```

### Why the DSH types are mapped, not installed

The published `@deepseek-ai` packages disagree with each other on peer ranges
(`dsh-agent@0.1.5-rc.1` pulls `dsh-session-projection@^0.1.5-rc.1`, whose newest
match demands `dsh-session@^0.1.5-rc.2` while the harness ships `0.1.5-rc.1`), so
npm refuses to resolve the tree.

`resolve:dsh-types` therefore writes a **gitignored** `tsconfig.dsh.json` that
maps `@deepseek-ai/*` straight at the installed harness declarations. It is
read-only and writes nothing outside this repository. That is also more correct
than installing: the plugin is type-checked against exactly the version it runs on.

> An earlier revision of this workflow symlinked the harness packages into this
> project's `node_modules`. A later `npm install` followed the link and pruned
> roughly 240 packages out of the global harness install. Path mapping cannot do
> that, so it is the only mechanism used now.

## Development philosophy

This repository is itself an experiment in AI-assisted engineering. When an AI agent works on this project, it should not immediately implement a vague request. It should first make the problem, hypothesis, design, evidence, and verification plan explicit.

The plugin should therefore be developed in the same way it is intended to make other AI-assisted work better.

## Status

**V0.1 implemented and verified against a real DSH 0.1.5-rc.1 session.**

The vertical slice works end to end: observe a signal → classify the task → decide whether to intervene → inject a section into the system prompt → record a structured event.

- `src/**/*.ts` — TypeScript source; `dist/` is the built plugin (JS + `.d.ts`)
- `npm test` — builds, then **133/133 unit tests pass** (no DSH required), including the DSH adapter boundary via a fake Cordis context
- `npm run typecheck` — includes type-level regressions (`@ts-expect-error` assertions in `test/types/`)
- `npm run test:live` — real headless sessions, control vs treatment

**Beyond V0.1** (schema stays v1; every addition is optional/additive):

| Increment | What it added |
|---|---|
| correlation | `episodeId`/`interventionId` on every related event, so joins never guess from topic or timestamp |
| Cognitive Episode | a derived reasoning unit reconstructed from the log, with an explicit `episode.closed` terminator |
| teaching-back evidence | deterministic evidence extraction (cause, mechanism, concept, confidence, length) instead of a bare grade |
| prompt / memory boundary | the live renderer is structurally unable to read history; a `CognitiveMemorySource` seam for future memory |
| projection layer | one-pass session/episode/intervention read models with a rebuildable, discardable cache |
| longitudinal metrics | exposure / response / outcome / utilization from persisted events, with a baseline comparison and an explicit non-causality caveat |
| topic learning state | knowledge-gap recurrence aggregated by normalized topic, reporting-only |

Verified live:

| Claim | Evidence |
|---|---|
| an architecture request is detected deterministically | `intervention.triggered {level: 3, reason: "architecture"}` in the JSONL |
| the section really reaches the model **exactly once** | treatment `system/message` is 4971 chars with 1 `[COGNITIVE FEEDBACK]` block; control is 4508 chars with 0 |
| the plugin is prompt-transparent when inactive | step-1 usage is byte-identical across arms (`cacheRead=768, uncachedInput=15462`) |
| dynamic injection does not break prompt-cache reuse | steps 2+ read the full ~17k prefix from cache; per-step hit rate **98.25%** with the section present vs 96.67% without |
| no tool-schema churn | the plugin registers no tools; one `system/message` node is emitted across a 4-step run |

See `docs/testing.md` for the method, the raw numbers, and the real defects the live tests and the independent review caught.