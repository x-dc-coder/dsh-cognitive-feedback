# DSH Integration Notes

## Target

V0.1 targets DeepSeek Harness **`0.1.5-rc.1`** (verified against the installed baseline on 2026-09-11 via `dsh --version`).

DSH is a Cordis-based, plugin-first agent harness in developer preview, so compatibility-breaking changes are expected across releases. This document records the **verified rc.1 integration surface**, quoted from the installed package type declarations under
`node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/{dsh-agent,dsh-system-prompt,dsh-session,dsh-tool-ask-user}`.

When an API differs here, the actual installed source wins and this document must be updated in the same change (per `AGENTS.md` §8).

## Verified integration surface (rc.1)

### 1. System-prompt injection — `ctx.systemPrompt`

Prompt contributions are **registered sections**, not string concatenation. They are assembled per model step in ascending `order`.

```ts
ctx.systemPrompt.section({
  name: 'cognitive-feedback',
  order: 700,                                  // free slot between TEAM_POLICY(600) and PTC_ONLY(800)
  text: (context) => state.active
    ? renderCognitiveSection(state)            // re-evaluated on every assembly
    : '',
})
```

- `text` accepts a function `(context: AssembleContext) => string`, evaluated at each assembly — this **is** the plugin's dynamic-update mechanism. No manual prompt rewrite is needed.
- Registering through `agent.ctx` makes the section **agent-scoped**: it shadows a same-named global without affecting other agents.
- `ctx.systemPrompt.variable(name, resolver)` contributes `{{name}}` references resolved per assembly.
- Official `SECTION_ORDERS` already occupy `HARNESS_IDENTITY(-1000)`, `DEPLOYMENT_PERSONA_PREFIX(0)`, `PLAN_POLICY(500)`, `TEAM_POLICY(600)`, `PTC_ONLY(800)`, `FILE_REFERENCE(900)`, `TOOL_*(1000+)`, `TOOLS_SDK(5000)`, `…`. V0.1 uses an unoccupied order in the 700–799 range.
- Events: `system-prompt/assemble` (waterfall over the assembled prompt) and `system-prompt/change` (registry notification).

> **KV-cache note.** The registry model lets the cognitive section change its text per assembly while the surrounding prompt structure stays stable. Whether a given model route actually retains KV-cache benefit across these assemblies must be **verified empirically per route** (see `docs/testing.md`); it is not an inherent property of the plugin.

### 2. Observation — session & agent events

`ctx.on('session/event', (session, event) => …)` is the firehose of durable Session V3 events. Relevant kinds include `turn/start`, `step/start`, `user/message`, `assistant/message`, `tool/result`, `session/created`, and `session/disposed`.

Live agent lifecycle and per-message signals:

```ts
ctx.on('agent/created', (agent) => …)          // live Agent published
ctx.on('agent/disposed', (agent) => …)
ctx.on('agent/pre-step', …)                    // intercept/replace a proposed step
ctx.on('agent/turn-stopping', …)               // runs before a completed turn closes
ctx.on('agent/status', …)
```

### 3. User input for the Reasoning Gate — `ask_user_question`

DSH ships the official `ask_user_question` tool (`@deepseek-ai/dsh-tool-ask-user`), backed by the `ctx.userQuestions` seam. It **pauses the agent turn** and waits for the human answer, returning compact JSON:

```ts
{ questions: [{ id, question, header?, options?: [{ label, description }], multi_select? }] }
// →
{ answers: [{ id, selected: string[], custom? }] }
```

- This is the reasoning-gate carrier: gate before a high-value decision by asking the user for a hypothesis, then let the model continue.
- **Fail open:** if no answerer accepts the request, the model receives an error instead of a hang. A runtime-owned child agent cannot call this tool and must report the unresolved question in its final result.
- Keep a prompt-level gate as a fallback for hosts without a user-interaction surface.

### 4. Driving an agent — `ctx.agents` / `AgentHandle`

```ts
const handle = await ctx.agents.create({ sessionId, meta?, agentOptions?, setup? })
await handle.agent.followup({ content, source })   // enqueue next turn + wake
await handle.agent.steer({ content, source })      // submit next-step input + wake
await handle.agent.inject({ content, source })     // model-facing context, no wake
handle.agent.cancel(cause)
await handle.agent.whenIdle()
```

The `setup(agentCtx, agent)` callback composes the agent's scoped world **before publication**: scoped prompt sections, tools, variables, and listeners registered there exist before `session/created` and the first prompt assembly. V0.1 mounts the cognitive section scoped to an agent this way.

### 5. Inbox — two pending lists via projection + events

Pending input is **two ordered lists** (`next-turn`, `next-step`), not a single `agent.inbox` property:

```ts
type InboxTarget = 'next-turn' | 'next-step'
interface InboxState { 'next-turn': UserMessage[]; 'next-step': UserMessage[] }
'agent/inbox/spliced': { target, start, removedCount?, inserted, outcome? }   // event
// exposed through SessionProjectionStateMap.inbox
```

### 6. Plugin form and configuration (Harness paradigm)

The plugin follows the documented Harness plugin form (`docs/user/develop/basic/`
in the harness documentation):

```ts
export const name = 'cognitive-feedback';

export interface Config { /* ... */ }

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(DEFAULT_CONFIG.enabled),
  /* ... one field per tunable, defaults on the schema ... */
});

export function apply(ctx: Context, config: Config): void { /* ... */ }
```

| Paradigm requirement | How this plugin satisfies it |
|---|---|
| `name` + `apply(ctx, config)` | in `src/index.ts` |
| Config as a **Standard Schema**, not a plain object | `Schema.object({...})` from `@deepseek-ai/schemastery`; Cordis validates and fills defaults while loading |
| Defaults on the schema | every field uses `.default(...)`, derived from `DEFAULT_CONFIG` so core and schema cannot drift |
| Fail loudly on invalid config | verified: `strongPerDay: 'x'` fails the load with `$.strongPerDay expected number but got x` |
| No `inject` gate for optional services | `inject` is a *required* dependency gate; an unresolved one keeps the entry PENDING and fails the whole profile boot. Prompt injection therefore uses the framework's optional-registration pattern `ctx.inject(['systemPrompt'], cb)` |
| **Automatic cleanup** | every registration goes through `ctx` (`ctx.on`, `ctx.inject`, `scoped.systemPrompt.section`), which the lifecycle contract disposes on unload. The plugin keeps **no private disposer list** and exposes no `dispose()` |
| No hardcoded tunables | all seven settings are config fields, changeable from `cordis.patch.yml` without a code edit |

### 6. Plugin distribution & loading

Plugins load through the **profile bundle** mechanism: a profile's `cordis.patch.yml` `insert` list, applied over the profile root. A local-path row works for development:

```yaml
- insert:
    - id: cognitive-feedback
      name: /home/dc/projects/dsh-cognitive-feedback/dist/index.js
```

Install as a package with `dsh plugin --profile <name> add <package>` (forwards to pnpm in the profile dir). V0.1 ships as a Cordis plugin package (a `src/index.ts` default export) installable by either route.

## Normalized cognitive signals

The plugin maps raw DSH events to its own small signal vocabulary behind the DSH Adapter, keeping policy code DSH-free:

```ts
type CognitiveSignal = {
  sessionId: string;
  kind:
    | 'user_message' | 'assistant_message' | 'tool_result'
    | 'turn_start' | 'turn_end' | 'session_started' | 'session_ended';
  text?: string;
  metadata?: Record<string, unknown>;
}
```

## Compatibility testing

For every DSH version bump:

1. run unit tests without DSH (policy, storage, prompt);
2. install the plugin against the target DSH version;
3. start a fresh session;
4. verify normal coding without interventions;
5. trigger an architecture gate (`ask_user_question` path and prompt-level fallback);
6. complete a teaching-back flow;
7. inspect the generated cognitive JSONL;
8. restart and verify graceful recovery;
9. verify the dynamic cognitive section toggles per assembly and confirm whether KV-cache benefit is retained on the configured route.

Keep the DSH Adapter as the only area that should require significant compatibility edits.