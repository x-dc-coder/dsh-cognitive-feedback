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
    | "hypothesis.challenged"
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

## Compatibility rules

- New optional fields should be backward-compatible.
- Breaking changes require a new `schemaVersion`.
- Readers should ignore unknown event types when possible.
- Writers should never mutate historical events.
