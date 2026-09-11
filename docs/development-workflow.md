# Development Workflow

This project should be developed using the same cognitive-feedback principles it is meant to provide to users.

## 1. Before coding

For a non-trivial issue, write:

### Problem

What is actually broken or missing?

### Hypothesis

What do we currently believe is causing the problem or what mechanism should solve it?

### Evidence

Which DSH source files, APIs, tests, or runtime observations support the hypothesis?

### Proposed design

What is the smallest design that can test the hypothesis?

### Alternatives

What other designs were considered and why were they rejected?

### Verification

What observable behavior would prove the implementation works?

## 2. During implementation

Use the smallest vertical slice possible.

Avoid building infrastructure for hypothetical future versions.

Prefer:

```text
one signal
→ one policy rule
→ one intervention
→ one event
→ one test
```

before adding more capabilities.

## 3. After implementation

The developer should perform a teaching-back check:

> Explain why this implementation solves the original problem and identify one limitation.

If the developer cannot explain it, the implementation may be correct but the learning objective is incomplete.

## 4. AI agent contract

AI agents may:

- inspect source code;
- propose alternatives;
- write implementation code;
- generate tests;
- refactor repetitive code.

AI agents should not silently own:

- the problem definition;
- architecture decisions;
- research hypotheses;
- interpretation of ambiguous experimental results.

Those decisions should remain explicit.

## 5. Issue lifecycle

Recommended sequence:

```text
Issue
 ↓
Problem statement
 ↓
Hypothesis
 ↓
Evidence
 ↓
Design
 ↓
Implementation
 ↓
Tests
 ↓
Teaching back
 ↓
Close
```

This workflow is intentionally slower at high-value decision points and fast everywhere else.
