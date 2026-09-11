# Architecture

## 1. Architectural goal

The plugin sits beside DSH's agent/session runtime rather than becoming a second agent loop. It observes useful runtime signals, maintains short-lived cognitive state, applies deterministic intervention policy, and records structured outcomes.

The core loop is:

```text
DSH event
   ↓
Cognitive Controller
   ├─ update state
   ├─ classify task signals
   ├─ evaluate intervention policy
   ↓
Action
   ├─ none
   ├─ prompt
   ├─ reasoning gate
   └─ teaching back
   ↓
Cognitive event log
```

## 2. Components

### Cognitive Controller

The orchestrator. It should be intentionally thin. It receives normalized DSH signals and coordinates the state, policy, prompt, gate, teaching-back, and event components.

It must not contain provider-specific DSH API details.

### State Engine

Maintains only short-lived state required for current behavior:

```ts
type CognitiveState = {
  mode: "normal" | "learning" | "challenge" | "research";
  taskType?:
    | "implementation"
    | "debugging"
    | "architecture"
    | "research"
    | "explanation";
  interventionLevel: 0 | 1 | 2 | 3;
  recentDecisionOutsourcing: number;
  recentUnexplainedImplementations: number;
  currentTopic?: string;
  currentHypothesis?: string;
};
```

State is ephemeral. It is not a long-term user profile.

**Signal → state mapping.** Every state field must be driven by an explicit signal, so policy stays testable without DSH (`AGENTS.md` §7):

| State field | Driven by | Rule |
|---|---|---|
| `taskType` | latest `user_message` text | deterministic keyword/pattern classifier (`architecture`, `debugging`, `research`, `implementation`, `explanation`) |
| `mode` | user text + task type | `research` for research tasks, `challenge` after a challenge, `learning` during teaching-back, else `normal` |
| `currentHypothesis` | `hypothesis.submitted` event | set when the user authors a hypothesis; cleared on session end or topic change |
| `recentDecisionOutsourcing` | `user_message` classified as delegation without hypothesis | increment; decay by one per hour window |
| `recentUnexplainedImplementations` | `teaching_back.completed` with `skipped`/`incorrect` | increment on each occurrence |
| `interventionLevel` | policy result | last issued action level |
| `currentTopic` | latest `user_message` | short topic key used to detect topic change |
| `currentEpisodeId` | episode opened by a trigger / hypothesis / teaching-back request | cleared on teaching-back completion, topic change, or session end |
| `currentInterventionId` | intervention issued by the policy or by a teaching-back request | cleared when the answer resolves it, or with its abandoned episode |

No field is set by hidden reasoning or model introspection.

### Correlation and episodes

An intervention is an *act*; an episode is the *reasoning unit* it belongs to.
The controller mints both ids at the moment the unit begins and carries them in
state (never in the prompt), so a reader joins a trigger to its hypothesis,
decision, teaching-back and knowledge gaps by id — not by topic string or nearest
timestamp. The three identity fields are deliberately distinct:

```text
sessionId  ⊃  episodeId  ⊃  interventionId
```

The episode itself is not stored. `src/projection/episodes.ts` reconstructs it
from the append-only log in append order, tolerating a missing terminator. An
episode ends as `completed` (teaching back answered and `episode.closed`) or
`abandoned` (topic change or session end), and nothing reconstructed from
history is ever fed back into the live prompt — see the prompt/memory boundary in
`README.md`.

### Policy Engine

Converts normalized state and signals into a small action set:

```ts
type PolicyAction =
  | { type: "none" }
  | { type: "prompt"; level: 1 | 2 }
  | { type: "reasoning_gate"; reason: string }
  | { type: "teaching_back"; reason: string };
```

V0.1 policy is deterministic. No LLM classifier is required.

### Prompt Builder

Produces short, removable intervention text as a **registered system-prompt section** — never by concatenating or replacing DSH's complete system prompt.

Against the rc.1 surface (`docs/dsh-integration.md` §1):

```ts
ctx.systemPrompt.section({
  name: 'cognitive-feedback',
  order: 700,                                   // free slot between TEAM_POLICY(600) and PTC_ONLY(800)
  text: (context) => state.active
    ? renderCognitiveSection(state)             // re-evaluated per assembly
    : '',                                       // absent when no intervention is active
})
```

The provider function is the dynamic-update mechanism: the section text changes per assembly while surrounding sections keep their order and content. When no intervention is active the section renders empty and contributes nothing.

Example rendered text (bounded, clearly delimited):

```text
[COGNITIVE FEEDBACK]
Before implementing this architecture change, state:
1. what problem you think exists;
2. your proposed design;
3. why you expect it to solve the problem.
The assistant may challenge the proposal before implementation.
[/COGNITIVE FEEDBACK]
```

The delimiters bound the injected text so it stays removable and greppable. Section text must stay short and must never include secrets.

### Reasoning Gate

A gate is used only for high-value reasoning. The intended sequence is:

```text
user request
  ↓
detect high-value decision
  ↓
ask user for hypothesis / proposed direction
  ↓
AI challenges or validates the proposal
  ↓
user chooses direction
  ↓
agent implements
```

The gate must not be applied to routine formatting, boilerplate, obvious refactors, or repetitive test generation.

**Carrier.** rc.1 ships the official `ask_user_question` tool, which pauses the agent turn until the human answers. The gate uses it to collect the hypothesis:

```ts
{ questions: [{ id: 'cognitive-gate', question: 'What is your hypothesis for <decision>?', header: 'Reasoning gate' }] }
```

If the host has no user-interaction surface, the tool call fails rather than hanging; the plugin then degrades to a **prompt-level gate** (the reasoning is requested in the cognitive section, and implementation proceeds without a hard pause). No second event loop is created.

### Teaching Back

After selected tasks, ask the user to explain the solution in 2–5 sentences. The plugin evaluates only the observable answer, not hidden reasoning.

The V0.1 grade (`correct` | `partially_correct` | `incorrect` | `skipped`) was
honest but nearly empty, so the controller now also records a deterministic
**evidence extraction** (`src/cognitive/teaching-back.ts`): cause present,
mechanism present, concrete concept referenced, the user's own confidence or
uncertainty, and an answer-length band. It is labelled `evidence_extracted` and
never claims the explanation is true; the coarse `result` stays
`unassessed`/`skipped`. Only declining to answer, or saying outright "I don't
know", records a knowledge gap.

### Event Logger

Appends versioned `CognitiveEvent` objects to a local sink. The default V0.1 implementation is JSONL.

The logger must not sit on the critical coding path in a way that can break the agent. Write failures should be reported and degraded gracefully.

### Projection layer

Reporting needs repeated reads over sessions, episodes, interventions and
teaching-back outcomes. Scanning the JSONL file per query does not scale, so
`src/projection/` derives a read model in **one pass**:

```text
raw JSONL (source of truth, append-only)
        │  buildProjection() -- pure, rebuildable
        ▼
CognitiveProjection { episodes, sessions, interventions }
        │
        ├── digest-keyed in-memory cache (stale → rebuild)
        └── optional JSON disk cache beside the log (corrupt/stale → discard)
```

Properties that keep the derivation safe:

- **rebuildable**: the projection holds no unique information; deleting it (or
  the cache file) loses nothing and the next read regenerates it;
- **fail open**: a projection failure yields the empty projection and a warning,
  never a broken coding session;
- **read-only with respect to the prompt**: nothing in this layer is consulted
  when the cognitive section is rendered (see the prompt/memory boundary).

## 3. Integration boundary

Keep DSH-specific code behind an adapter boundary:

```text
DSH APIs
   ↓
DSH Adapter
   ↓
Normalized Cognitive Signals
   ↓
Cognitive Controller
```

This is important because DSH is a developer preview and plugin APIs can change between alpha releases.

## 4. Future Soul-Spark boundary

Do not import or depend on Soul-Spark in V0.1.

Instead:

```ts
interface CognitiveEventSink {
  append(event: CognitiveEvent): Promise<void>;
}
```

V0.1 provides:

- `JsonlSink`
- `MemorySink` for tests

Future versions may add a `SoulSparkSink` without changing the controller or policy layer.

## 5. Failure isolation

Every optional cognitive feature must fail open:

- policy failure → continue normal DSH behavior;
- prompt construction failure → omit intervention;
- event persistence failure → warn/log but do not interrupt coding;
- teaching-back evaluation failure → record `skipped` or `unknown` rather than blocking;
- DSH API mismatch → fail during plugin initialization with a clear compatibility message.

## 6. Intervention budget

Initial defaults:

- strong interventions per day: max 5;
- light interventions per day: max 10.

The budget is intentionally conservative. The goal is to interrupt only when the expected learning value exceeds the interaction cost.

**Counter lifetime.** `CognitiveState` is ephemeral, so an in-memory counter cannot enforce a per-day budget across restarts. V0.1 derives the budget from the persisted `intervention.triggered` events in the JSONL store (rolling 24-hour window), and keeps an in-memory cache for the current process. Sink failures degrade to the in-memory count rather than blocking.