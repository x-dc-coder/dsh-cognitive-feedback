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
  /** Correlation: the reasoning episode this event belongs to. */
  episodeId?: string;
  /** Correlation: the intervention lifecycle this event belongs to. */
  interventionId?: string;
  type:
    | "session.started"
    | "session.ended"
    | "episode.closed"
    | "intervention.triggered"
    | "hypothesis.submitted"
    | "decision.recorded"
    | "teaching_back.requested"
    | "teaching_back.completed"
    | "knowledge_gap.detected";
  payload: Record<string, unknown>;
};
```

## Correlation

`sessionId`, `episodeId` and `interventionId` are three deliberately different
things:

| Field | Names one | Lifetime |
|---|---|---|
| `sessionId` | DSH session | process/session |
| `episodeId` | cognitive episode (one reasoning unit) | opened by the trigger, closed by teaching-back completion or abandonment |
| `interventionId` | one intervention lifecycle | minted when an intervention is issued, resolved by the answer, or abandoned with its episode |

They exist so a reader can join related events **without topic strings or
timestamps** — which are ambiguous the moment two events share a millisecond, or
the user rephrases the topic. `eventsForIntervention()` /
`eventsForEpisode()` (and the `indexByCorrelation()` index) are the read path.

Both fields are optional and new: every event written before correlation existed
stays readable, and a parser rejects a present-but-unusable value (a non-string
or empty id) rather than letting it become a join key.

## Example: intervention

```json
{
  "schemaVersion": 1,
  "id": "evt_01",
  "timestamp": "2026-09-11T03:00:00.000Z",
  "sessionId": "session_01",
  "project": "example-project",
  "episodeId": "ep_9f1c...",
  "interventionId": "iv_2b77...",
  "type": "intervention.triggered",
  "payload": {
    "level": 3,
    "reason": "architecture",
    "taskType": "architecture",
    "topic": "refactor-storage-layer-support-three-backends",
    "ownership": "user",
    "value": "high"
  }
}
```

`payload.ownership` (`agent` | `shared` | `user`) and `payload.value`
(`low` | `medium` | `high`) are the policy's explanation for the intervention:
who owned the decision, and how much cognitive value it carried. They are
optional, so events written before the ownership model still read. See
`docs/decision-policy.md`.

## Example: hypothesis

The user's answer carries the **same `interventionId`** as the gate that asked
for it, so the pair joins without any topic comparison.

```json
{
  "schemaVersion": 1,
  "id": "evt_02",
  "timestamp": "2026-09-11T03:01:00.000Z",
  "sessionId": "session_01",
  "episodeId": "ep_9f1c...",
  "interventionId": "iv_2b77...",
  "type": "hypothesis.submitted",
  "payload": {
    "text": "The race condition is caused by two workers mutating shared state.",
    "authorship": "user",
    "taskType": "debugging"
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
  "episodeId": "ep_9f1c...",
  "interventionId": "iv_77aa...",
  "type": "teaching_back.completed",
  "payload": {
    "result": "unassessed",
    "topic": "worker-duplicate-processing",
    "evidence": {
      "assessment": "evidence_extracted",
      "result": "unassessed",
      "answered": true,
      "wordCount": 39,
      "lengthBand": "adequate",
      "causalExplanation": true,
      "mechanismExplanation": true,
      "keyConceptReferenced": true,
      "uncertaintyAcknowledged": false,
      "confidence": null,
      "signals": ["causal", "mechanism", "key-concept", "length:adequate"]
    }
  }
}
```

The answer text itself is **not** in the event -- only observable structure.

## Example: episode terminator

`episode.closed` is the only event whose payload is pure lifecycle. It is
written when the reasoning unit ends, so an **interrupted** episode is a fact in
the log rather than something a reader has to guess.

```json
{
  "schemaVersion": 1,
  "id": "evt_04",
  "timestamp": "2026-09-11T03:20:00.000Z",
  "sessionId": "session_01",
  "episodeId": "ep_9f1c...",
  "interventionId": "iv_2b77...",
  "type": "episode.closed",
  "payload": { "outcome": "abandoned", "reason": "topic-changed" }
}
```

## Cognitive episodes

An episode is the primary reasoning unit. It is **derived**, never stored as an
object: `reconstructEpisodes()` rebuilds it from the raw events in append order
(`src/projection/episodes.ts`), so JSONL stays the single source of truth and a
projection can always be discarded and regenerated.

| Lifecycle step | Event that records it |
|---|---|
| trigger | `intervention.triggered` (gate/challenge), or the first `hypothesis.submitted` when the user stated the reasoning unprompted |
| hypothesis | `hypothesis.submitted` |
| decision | `decision.recorded` |
| implementation outcome | `teaching_back.requested` — the directive goes live only once high-value work is delivered |
| teaching-back | `teaching_back.requested` → `teaching_back.completed` |
| end | `episode.closed` (`completed` after teaching back, `abandoned` on a topic change or session end) |

Rules that keep reconstruction deterministic:

- an episode **starts** at the first event carrying a new `episodeId`;
- a topic change or session end **abandons** the open episode and writes
  `episode.closed {outcome: "abandoned"}`;
- an episode with a live teaching-back directive is **not** abandoned by the
  topic shift of its own answer — that message is the answer;
- a new episode in the same session, or a session end, implicitly abandons a
  previous episode whose terminator is missing, so logs written before
  `episode.closed` existed still reconstruct.

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
for a future evaluator (a host may supply one through `completeTeachingBack`).

### Evidence, not judgment

`payload.evidence` (V0.2) is a **deterministic evidence extraction**, labelled
`assessment: "evidence_extracted"`. It reports whether the answer states a cause,
states a mechanism, names a concrete concept, admits uncertainty, and what
confidence the *user* expressed — never whether the explanation is true.

| Evidence field | Rule |
|---|---|
| `causalExplanation` | the answer contains a causal connective (`because`, `caused by`, `so that`, `leads to`, ...) |
| `mechanismExplanation` | the answer states how (`works by`, `by using`, `implemented by`, `through ...`) |
| `keyConceptReferenced` | the answer contains a code-like identifier, or a token from the topic key |
| `uncertaintyAcknowledged` | the user flags doubt (`not sure`, `unclear`, `no idea`, `might`) |
| `confidence` | `low` if uncertainty, `high` if the user asserts confidence, `medium` if they hedge, else `null` |
| `lengthBand` | `brief` (<12 words), `adequate` (12–45), `detailed` (>45) |

`knowledge_gap.detected.payload.origin` names why a gap was recorded:
`skipped_answer` (no answer), `explicit_uncertainty` (the user said they do not
know), or `graded_low` (a host-supplied low grade). A merely brief answer is
**not** a gap.

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
| challenge issued | `hypothesis.challenged` *(not emitted; see ROADMAP)* |
| every signal handled while an episode is open | `episode.closed` on completion or abandonment |
| teaching-back prompt issued | `teaching_back.requested` |
| teaching-back answered | `teaching_back.completed` |

The plugin never persists raw message text by default — only structured metadata and short user-authored answers explicitly required to represent a cognitive event (see Privacy principles).

## Compatibility rules

- New optional fields are backward-compatible and keep `schemaVersion: 1`.
  `episodeId`, `interventionId` and the `episode.closed` event type were added
  that way: old readers ignore an unknown type, new readers still accept events
  that never carried correlation.
- Breaking changes require a new `schemaVersion`.
- Readers should ignore unknown event types when possible.
- Writers should never mutate historical events.