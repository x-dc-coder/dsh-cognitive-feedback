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

Produces short, removable intervention text. It should never replace the complete DSH system prompt. The cognitive section should be clearly delimited and regenerated when state changes.

Example:

```text
[COGNITIVE FEEDBACK]
Before implementing this architecture change, state:
1. what problem you think exists;
2. your proposed design;
3. why you expect it to solve the problem.
The assistant may challenge the proposal before implementation.
[/COGNITIVE FEEDBACK]
```

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

### Teaching Back

After selected tasks, ask the user to explain the solution in 2–5 sentences. The plugin evaluates only the observable answer, not hidden reasoning.

Possible outcome:

```ts
"correct" | "partially_correct" | "incorrect" | "skipped"
```

### Event Logger

Appends versioned `CognitiveEvent` objects to a local sink. The default V0.1 implementation is JSONL.

The logger must not sit on the critical coding path in a way that can break the agent. Write failures should be reported and degraded gracefully.

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
