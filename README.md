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
- `tools/inspect-session.mjs` — Session V3 log inspector: injection evidence + cache metrics
- `test/` — unit tests and the live headless acceptance harness

## Development philosophy

This repository is itself an experiment in AI-assisted engineering. When an AI agent works on this project, it should not immediately implement a vague request. It should first make the problem, hypothesis, design, evidence, and verification plan explicit.

The plugin should therefore be developed in the same way it is intended to make other AI-assisted work better.

## Status

**V0.1 implemented and verified against a real DSH 0.1.5-rc.1 session.**

The vertical slice works end to end: observe a signal → classify the task → decide whether to intervene → inject a section into the system prompt → record a structured event.

- `lib/` — dependency-free ESM plugin (no build step)
- `node --test test/*.test.js` — **50/50 unit tests pass** (no DSH required)
- `bash test/live/run-live.sh "<prompt>"` — real headless sessions, control vs treatment

Verified live:

| Claim | Evidence |
|---|---|
| an architecture request is detected deterministically | `intervention.triggered {level: 3, reason: "architecture"}` in the JSONL |
| the section really reaches the model | treatment `system/message` is 5421 chars and contains `[COGNITIVE FEEDBACK]`; control is 4507 chars and does not |
| the plugin is prompt-transparent when inactive | step-1 usage is byte-identical across arms (`cacheRead=768, uncachedInput=15462`) |
| dynamic injection does not break prompt-cache reuse | steps 2+ read the full ~17k prefix from cache; per-step hit rate **98.25%** with the section present vs 96.67% without |
| no tool-schema churn | the plugin registers no tools; one `system/message` node is emitted across a 4-step run |

See `docs/testing.md` for the method, the raw numbers, and the two real defects the live tests caught.