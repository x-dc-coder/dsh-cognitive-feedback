# Cognitive Event Schema

## Schema version

Current schema: **v1**.

Events are append-only and intentionally small.

```ts
type CognitiveEvent = {
  schemaVersion: 1;
  id: string;
  timestamp: string;
  sessionId: string;
  project?: string;
  type:
    | "session.started"
    | "intervention.triggered"
    | "hypothesis.submitted"
    | "decision.recorded"
    | "teaching_back.requested"
    | "teaching_back.completed"
    | "knowledge_gap.detected"
    | "session.ended";
  payload: Record<string, unknown>;
};
```

## Example: intervention

```json
{
  "schemaVersion": 1,
  "id": "evt_01",
  "timestamp": "2026-09-11T03:00:00.000Z",
  "sessionId": "session_01",
  "project": "example-project",
  "type": "intervention.triggered",
  "payload": {
    "level": 3,
    "reason": "architecture",
    "taskType": "architecture"
  }
}
```

## Example: hypothesis

```json
{
  "schemaVersion": 1,
  "id": "evt_02",
  "timestamp": "2026-09-11T03:01:00.000Z",
  "sessionId": "session_01",
  "type": "hypothesis.submitted",
  "payload": {
    "text": "The race condition is caused by two workers mutating shared state.",
    "authorship": "user"
  }
}
```

## Example: teaching back

```json
{
  "schemaVersion": 1,
  "id": "evt_03",
  "timestamp": "2026-09-11T03:15:00.000Z",
  "sessionId": "session_01",
  "type": "teaching_back.completed",
  "payload": {
    "result": "partially_correct",
    "topic": "worker synchronization"
  }
}
```

## Teaching-back results

`teaching_back.completed.payload.result` is one of:

| Value | Meaning |
|---|---|
| `correct` / `partially_correct` / `incorrect` | A grader judged the explanation (not produced by V0.1) |
| `unassessed` | The user gave an explanation; **V0.1 does not grade it** |
| `skipped` | No explanation was given (too short, or an explicit skip) |

V0.1 emits only `unassessed` and `skipped`. Judging correctness needs semantic
understanding the deterministic implementation does not have, and guessing would
put a fabricated signal in the log. The grade-bearing values stay in the schema
for a future evaluator.

## Privacy principles

By default, the plugin should **not** persist:

- API keys or credentials;
- environment secrets;
- complete source files;
- complete conversation transcripts;
- hidden chain-of-thought;
- raw tool output unless explicitly required by a future feature.

The plugin may persist short user-authored answers when they are necessary to represent a cognitive event.

## Future adapter

The storage abstraction is intentionally:

```ts
interface CognitiveEventSink {
  append(event: CognitiveEvent): Promise<void>;
}
```

This makes a future Soul-Spark adapter possible without coupling V0.1 to Soul-Spark's unstable implementation.

Only event types the V0.1 implementation actually emits are listed. `hypothesis.challenged` was removed because nothing produced it; it is recorded in `ROADMAP.md` instead.

## Mapping to native DSH vocabulary

The plugin's event types are its own self-contained schema (above). The DSH Adapter maps native rc.1 events into them; this table is the contract that keeps the mapping explicit:

| Native DSH event (rc.1) | Cognitive event |
|---|---|
| `session/created` | `session.started` |
| `session/disposed` | `session.ended` |
| `user/message` | (signal only; never persisted verbatim by default) |
| `assistant/message` | (signal only) |
| `tool/result` | (signal only) |
| `turn/start` / `step/start` | (signal: `turn_start`) |
| gate answer via `ask_user_question` | `hypothesis.submitted` |
| policy gate issued | `intervention.triggered` |
| challenge issued | `hypothesis.challenged` |
| teaching-back prompt issued | `teaching_back.requested` |
| teaching-back answered | `teaching_back.completed` |

The plugin never persists raw message text by default — only structured metadata and short user-authored answers explicitly required to represent a cognitive event (see Privacy principles).

## Compatibility rules

- New optional fields should be backward-compatible.
- Breaking changes require a new `schemaVersion`.
- Readers should ignore unknown event types when possible.
- Writers should never mutate historical events.