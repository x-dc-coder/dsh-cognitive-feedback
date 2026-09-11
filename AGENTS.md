# AGENTS.md

## Mission

Build a small DSH plugin that improves human reasoning ownership during AI-assisted development.

The plugin is not a surveillance system and not a replacement for the developer. It should intervene only when the expected cognitive value is high.

## Development rules

### 1. Understand before implementing

For non-trivial tasks, the agent must first produce:

```text
Problem
Hypothesis
Evidence / relevant DSH API
Proposed Design
Alternatives
Why this design
Verification Plan
```

Do not start implementation from an ambiguous requirement.

### 2. Verify DSH APIs from source

Target baseline is DSH **`0.1.5-rc.1`** (verified installed baseline, 2026-09-11). DSH is a developer preview and changes quickly.

Never invent an API based on memory. Inspect the exact installed package declarations under `node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/` before coding, and record the verified surface in `docs/dsh-integration.md`.

### 3. Keep V0.1 small

Do not introduce:

- Soul-Spark as a runtime dependency;
- a dashboard;
- a database;
- a second LLM agent;
- a complex ML classifier;
- long-term user profiling;
- automatic source-code transformations.

If a feature is useful but not required for the four V0.1 capabilities, put it in `ROADMAP.md` instead.

### 4. Preserve normal DSH behavior

Cognitive feedback is optional. A plugin failure must never turn into a coding failure.

Prefer:

```text
feature failure → warning → normal DSH execution
```

over:

```text
feature failure → blocked agent
```

### 5. Human decision ownership

AI may propose. The user decides.

Architecture, algorithm, research hypothesis, and root-cause decisions are high-value areas where the plugin should seek explicit user reasoning when appropriate.

### 6. Do not collect hidden chain-of-thought

Store structured metadata and short user-authored answers when necessary. Do not design features around collecting or persisting hidden reasoning traces.

### 7. Test policy separately from DSH integration

The core policy should be testable without a running DSH instance. DSH-specific behavior belongs behind an adapter.

### 8. Update documentation with behavior changes

When implementation changes the architecture, event schema, intervention behavior, or compatibility baseline, update the relevant documentation in the same change.

## Preferred implementation loop

```text
Inspect
  ↓
Form hypothesis
  ↓
Design
  ↓
Implement smallest slice
  ↓
Test
  ↓
Explain why it works
  ↓
Record lessons / gaps
```

## Definition of done

A change is not complete merely because tests pass. For non-trivial changes, the developer should be able to explain:

- what problem was solved;
- why the design works;
- what alternatives were rejected;
- how the implementation was verified;
- what remains uncertain.