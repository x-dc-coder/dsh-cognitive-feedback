# DSH Integration Notes

## Target

V0.1 targets DeepSeek Harness `dsh-v0.1.5-alpha.1`.

DSH describes itself as a plugin-first agent harness and is currently in developer preview, so compatibility-breaking changes are expected.

## Relevant alpha.1 changes

The `v0.1.5-alpha.1` release includes:

- dynamic system-prompt updates without invalidating KV cache when the configured model explicitly supports the behavior;
- Session V3;
- Agent plugin API change: `ctx.agent` was removed and callers pass the Agent explicitly;
- Inbox changed to a type interface, with pending messages accessed through `agent.inbox`;
- system prompts are represented in the Session V3 message history.

These changes matter directly to this plugin because cognitive feedback is expected to update runtime instructions and observe session/agent activity.

## Important compatibility rule

The repository documentation is a design specification, not a substitute for source inspection.

Before implementation, inspect the exact DSH tag/source and verify:

1. plugin manifest structure;
2. package/peer dependency names;
3. system-prompt extension API;
4. event/session subscription mechanism;
5. Agent lifecycle;
6. user-input/inbox mechanism;
7. dynamic system-prompt update mechanism;
8. plugin cleanup/disposal contract.

If an API differs from this document, the actual DSH source wins and this document should be updated.

## Dynamic prompt strategy

The plugin should contribute a small cognitive-feedback section rather than overwrite DSH's base system prompt.

Conceptually:

```text
base DSH system prompt
        +
cognitive feedback section
        ↓
assembled runtime prompt
```

When no intervention is active, the cognitive section should be absent or minimal.

When the runtime supports safe dynamic updates, state changes may update only the cognitive section so the model can retain the benefits of existing context/KV cache behavior.

## Session events

The plugin should normalize DSH events into its own internal signals instead of coupling policy code directly to raw Session V3 structures.

Example normalized signal:

```ts
type CognitiveSignal = {
  sessionId: string;
  kind:
    | "user_message"
    | "assistant_message"
    | "tool_call"
    | "tool_result"
    | "system_update"
    | "session_started"
    | "session_ended";
  text?: string;
  metadata?: Record<string, unknown>;
};
```

The exact adapter shape is subject to source verification.

## Plugin installation model

DSH supports multiple plugin forms. V0.1 should follow the simplest repository/community-plugin form compatible with the target alpha rather than creating a bespoke distribution mechanism.

The plugin repository should expose the standard DSH plugin manifest and package metadata once the exact conventions have been verified against the source.

## Compatibility testing

For every DSH version bump:

1. run unit tests without DSH;
2. install the plugin against the target DSH version;
3. start a fresh session;
4. verify normal coding without interventions;
5. trigger an architecture gate;
6. complete a teaching-back flow;
7. inspect the generated cognitive JSONL;
8. restart and verify graceful recovery.

Keep the DSH adapter as the only area that should require significant compatibility edits.
