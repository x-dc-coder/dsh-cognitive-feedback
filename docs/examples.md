# Runtime Examples

## Example 1 — Routine implementation

User:

> Add a `--verbose` flag to the CLI.

Expected behavior:

```text
No intervention.
```

This is routine implementation unless the task reveals a non-trivial architectural choice.

## Example 2 — Architecture change

User:

> Refactor the storage layer so we can support three backends.

Expected behavior:

```text
Reasoning gate

Before implementation, state:
1. the problem with the current design;
2. your proposed abstraction;
3. why it should support the three backends.
```

The AI may challenge the proposal before implementation.

## Example 3 — Debugging

User:

> The worker sometimes processes the same job twice. Fix it.

If the cause is unclear, expected behavior:

```text
Challenge

What is your current hypothesis for why duplicate processing occurs?
What evidence supports it?
```

The agent should investigate after the user has stated an initial hypothesis, while remaining free to revise it when evidence contradicts it.

## Example 4 — Teaching back

After a non-trivial synchronization fix:

```text
Teaching back:
Explain in 2–5 sentences why the fix prevents duplicate processing.
```

Record only the structured outcome and the minimum user-authored answer needed for later review.

## Example 5 — Research

User:

> Try a new adaptive partitioning strategy for the VRP experiment.

Expected flow:

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

The plugin should distinguish an AI suggestion from the user's final research decision.

## Example 6 — User requests normal mode

User:

> I know this pattern well. Just implement the boilerplate.

Expected behavior:

```text
Normal execution.
```

The system should not fight the user when the task is genuinely routine.
