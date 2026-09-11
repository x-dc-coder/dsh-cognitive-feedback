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

V0.1 targets **DSH `v0.1.5-alpha.1`**. DSH is in developer preview and its plugin APIs may change. The plugin must isolate DSH-specific integration code so future upgrades remain localized.

The alpha.1 release introduced dynamic system-prompt updates, Session V3, and breaking Agent/Inbox plugin API changes. See `docs/dsh-integration.md` for the compatibility notes.

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
- `docs/dsh-integration.md` — DSH compatibility and integration notes
- `docs/examples.md` — expected runtime behavior examples
- `docs/development-workflow.md` — recommended human/AI development loop

## Development philosophy

This repository is itself an experiment in AI-assisted engineering. When an AI agent works on this project, it should not immediately implement a vague request. It should first make the problem, hypothesis, design, evidence, and verification plan explicit.

The plugin should therefore be developed in the same way it is intended to make other AI-assisted work better.

## Status

**Pre-implementation / V0.1 specification.**

The first implementation milestone is a minimal vertical slice: observe an event → classify a small set of task signals → decide whether to intervene → inject a prompt or gate → optionally collect a teaching-back result → append a structured event.
