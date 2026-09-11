# Testing

Two layers, both required. Unit tests prove the cognitive logic; live tests prove the plugin actually injects into a real DSH prompt **without breaking prompt-cache reuse**.

## 1. Unit tests (no DSH)

```bash
npm run build          # tests run against dist/
node --test test/*.test.js
```

They import the core modules directly, so they run in milliseconds with no DSH instance, no model calls, and no network (`AGENTS.md` §7). **78 tests across 10 files.**

| File | Covers |
|---|---|
| `classify.test.js` | routine vs high-value classification, hypothesis detection, deterministic topic keys |
| `state.test.js` | state transitions, reference stability for unchanged signals, gate→hypothesis conversion |
| `policy.test.js` | gate / challenge / teaching-back decisions, budget suppression, disabled config, and a **contract test replaying all six documented examples from `docs/examples.md`** |
| `prompt.test.js` | bounded delimited rendering, determinism, fingerprint memoization, no secrets |
| `storage.test.js` | schema version, unique ids, append-only JSONL, malformed-line tolerance |
| `controller.test.js` | end-to-end decision flow, budget persistence across restarts, **fail-open on sink errors** |
| `adapter.test.js` | native-event → cognitive-signal mapping, `$DSH_HOME` path resolution |
| `adapter-install.test.js` | the **DSH integration boundary** via a fake Cordis context: order-700 section registration (global + agent-scoped), inbox splice reaching the section in the same assembly, duplicate-delivery de-duplication, disposal, **no tool surface touched**, and three failure paths degrading with a warning instead of throwing |
| `events.test.js` | rolling 24h budget window, strong-only counting, malformed-timestamp tolerance |
| `controller.test.js` (teaching back) | the directive renders, the answer is observed as `unassessed`, pending clears, and a **later** high-value task can still ask |
| `concurrency.test.js` | two sessions decided and persisted concurrently produce well-formed, non-interleaved JSONL |

### Why the runtime tests are still JavaScript

The source is TypeScript; the behavior tests are not. That is a deliberate
choice, not an unfinished migration:

- the tests import the **built** \`dist/\` output, so they exercise exactly what
  DSH loads. Type-checking the source and running the artifact are different
  questions, and this keeps them separate;
- Node's test runner executes \`.js\` natively, with no transpile step, no loader
  configuration and no extra dependency in the test path;
- type-level behavior is not lost. \`test/types/type-regressions.ts\` is compiled
  by \`npm run typecheck\` and uses \`@ts-expect-error\` to assert that a wrong event
  payload, an unknown event type, an out-of-range level, an invalid mode and an
  invalid task type are all rejected. An assertion there fails the build if the
  rejection stops happening.

So the split is: **\`.ts\` for anything the compiler must judge, \`.js\` for anything
the runtime must execute.**

## 2. Live tests (real DSH session)

```bash
bash test/live/run-live.sh "<task prompt>"
```

The harness boots the real `headless` profile twice — `control` (`enabled: false`) and `treatment` (enabled) — with a generated patch overlay, then reads the flushed Session V3 logs.

```text
test/live/cognitive.patch.template.yml   # profile overlay (plugin + isolated event path)
tools/inspect-session.mjs                # Session V3 log inspector
```

### Credentials

The provider key is read from the running `dsh` process environment at test time and is never printed or written to disk. No credential is stored in the repository.

### Inspecting a session log

```bash
node tools/inspect-session.mjs <path>/session.v3.jsonl.zstd [--json] [--system]
```

DSH appends **one zstd frame per flush**, so a log is a concatenation of frames that neither `zstdDecompressSync` nor the streaming decoder reads past the first one. The inspector recovers every frame, validates the JSON, de-duplicates by `seq`, and reports the event histogram, the `system/message` nodes, and provider usage.

## 3. What the live tests found (and why they matter)

Two real defects were caught only by running against an actual session:

### 3.1 A Cordis `inject` gate is required, not optional

Declaring `export const inject = { optional: ['systemPrompt'] }` made the loader treat `optional` as a service name. The entry stayed `pending (waiting for service: optional)` and **the whole profile failed to boot**:

```text
Error: dsh: plugin tree failed to load: 1 entry did not activate
  lib/index.js: pending (waiting for service: optional)
```

The plugin therefore declares no static `inject` and wires prompt injection through the documented optional pattern `ctx.inject(['systemPrompt'], cb)`.

### 3.2 The request arrives before the prompt is assembled — but only via the inbox splice

With the controller fed from `user/message`, the section rendered **empty**. The event order in a real log explains why:

```text
seq 3  agent/inbox/spliced   # ← the user request enters the inbox
seq 4  turn/start
seq 6  step/start
seq 7  system/message        # ← the prompt is assembled HERE
seq 8  user/message          # ← the plugin used to learn about the request only now
```

The log places `system/message` before `user/message` by surface convention, so a signal taken from `user/message` always misses the assembly it was meant to influence. Fixes:

- the adapter takes the request from `agent/inbox/spliced`, which lands at seq 3;
- `controller.ingest()` performs **all** state and policy mutation synchronously (only persistence is deferred), so the section provider observes the decision during the same assembly;
- the later `user/message` is de-duplicated by request text.

After the fix, the treatment prompt is measurably larger and contains the section:

| Run | `system/message` length | `[COGNITIVE FEEDBACK]` blocks |
|---|---|---|
| control (`enabled: false`) | 4508 | 0 |
| treatment (enabled) | 4971 | **1** |

> An earlier revision of this table reported 5421 chars and asserted only *presence*. Both registrations were rendering, so the directive was injected **twice** (2 blocks, 925-char delta). The independent code review caught it; the fix makes both registrations share one section name so DSH's agent-scope shadowing applies. `tools/inspect-session.mjs` now reports the block **count**, and `adapter-install.test.js` asserts cardinality — presence alone cannot catch duplication.

## 4. Prompt-cache acceptance test

### 4.1 The mechanism being protected

On the DeepSeek route the plugin targets, the adapter declares `systemPromptUpdate: 'in-history'` (`deepseek-flash` does by default). Under that mode a mid-conversation system-prompt change is **appended after the cached history instead of rewriting the leading system message**, so the prefix through that history stays reusable. Two consequences drive the design:

- the plugin must **never change the tool schema set** — a tool-schema change prevents reuse from the first altered token (the adapter registers no tools);
- the section text must be **byte-stable while state is unchanged** — the renderer memoizes on a fingerprint, and an inactive state renders the empty string.

### 4.2 What is measured

Provider usage, read back from the session log (and exposed live as the `tokenUsage` session projection):

```text
cacheReadTokens     input tokens served from the provider cache
cacheWriteTokens    input tokens written to the provider cache
inputTokens         uncached input tokens (disjoint from the cache fields)
```

```text
cacheHitRate = cacheReadTokens / (cacheReadTokens + cacheWriteTokens + inputTokens)
```

### 4.3 Method

A **multi-step** task is required: a single-step task cannot show prefix reuse. The harness copies a small fixture directory into each work dir and asks the model to read several files, forcing multiple assemblies.

`COG_LIVE_RUNS` controls runs per arm:

- `1` (default) — one measured run per arm. The provider's own server-side prefix cache may still be warm from an earlier identical run.
- `2` — an explicit **warm run followed by the measured run**; the workspace is reset to byte-identical fixture content before each run, so an agent edit can never silently change the prompt under test.

```bash
COG_LIVE_RUNS=2 COG_LIVE_OUT=/tmp/cog-warm bash test/live/run-live.sh "<prompt>"
```

**Known confounds (all of them).** A single-pass comparison of the two hit rates is not by itself evidence of anything, for four independent reasons:

1. **Step count.** The arms do not necessarily run the same number of steps — the model decides when to stop — and the treatment prompt is longer by exactly the section. A whole-run hit rate mixes one fixed cold-start cost over a different number of steps. Compare the **per-step** rows and the steps-2+ hit rate instead of only the aggregate.
2. **Arm order.** The provider cache is content-addressed and shared, so whichever arm runs first can warm the prefix the second one hits. Control runs first by default; `COG_LIVE_REVERSE=1` counterbalances.
3. **Sample size.** The §4.5 numbers are n=1 per arm with no repetitions and no variance. Treat them as an observation, not a measurement.
4. **`cacheWriteTokens` is 0 in every sample**, so that term never contributes to the denominator; the hit rate reduces to `cacheRead / (cacheRead + inputTokens)`.

The numbers in §4.5 were produced with `COG_LIVE_RUNS=1` and the default arm order. Running each arm twice (once in each order) and reporting medians is the honest way to turn this into a measurement.

### 4.4 Acceptance

1. the treatment session contains at least one `system/message` node with the cognitive section, and the control contains none;
2. within the treatment session, the leading system node is stable across steps (in-history appends rather than rewriting the head);
3. on the measured run, the treatment cache hit rate is not materially below the control's;
4. when the section is inactive, repeated assemblies render identical text (covered by `prompt.test.js`).

### 4.5 Measured results (2026-09-11, `deepseek-official/deepseek-flash`)

Two real multi-step sessions, fixture of three `.md` files, read-before-answer task.

**A. Section inactive (routine task) — the plugin is prompt-transparent**

| step | control `cacheRead` / `uncached` | treatment `cacheRead` / `uncached` |
|---|---|---|
| 1 | 768 / 15462 | 768 / **15462** |
| 2 | 16384 / 142 | 16384 / 259 |
| 3 | 16640 / 262 | 16768 / 221 |
| 4 | 17024 / 239 | — |

Step 1 is **byte-identical in both arms** (`768 / 15462`), proving that an inactive cognitive section adds nothing to the prompt. Steps 2+ reuse the same ~16k prefix in both arms.

**B. Section active (architecture task) — prefix reuse survives injection**

> These numbers were recorded **before** the duplicate-injection fix, so the treatment prompt then carried the block twice (5421 chars). Duplication changes prompt size, not prefix stability, so the reuse conclusion is unaffected — but the treatment prompt is now 4971 chars with one 463-char section.

| | control (4507 chars) | treatment (5421 chars, section present **twice** — pre-fix) |
|---|---|---|
| step 1 (cold) | 768 / 15474 | 1024 / 15436 |
| step 2 | 16384 / 164 | 17024 / 228 |
| step 3 | 16640 / 270 | 17280 / 310 |
| step 4 | 17536 / 379 | 18688 / 408 |
| step 5 | 18176 / 1558 | — |
| **steps 2+ hit rate** | **96.67%** | **98.25%** |
| whole-run hit rate | 79.57% | 76.73% |
| `system/message` nodes | 1 | **1** |

Conclusions:

1. **Injection is real.** In the pre-fix runs the treatment prompt carried `[COGNITIVE FEEDBACK]` **twice** and was 914 characters longer; the control prompt has neither. Post-fix it carries the block once (463-character delta, verified below).
2. **The prefix is reused for every step after the first.** Steps 2+ read 17k–18.7k tokens from the provider cache; the per-step hit rate is **98.25%** with the section present, marginally *better* than the 96.67% control because the run finished one step sooner.
3. **The whole-run hit-rate gap (76.73% vs 79.57%) is not a cache regression.** It is an artifact of step count: the single cold step-1 miss is amortized over 4 steps in the treatment and 5 in the control. On established steps the treatment is equal or better.
4. **Exactly one `system/message` node is emitted across all steps.** The section's text stayed byte-stable while the gate was active (the renderer memoizes on the state fingerprint), so DSH never had to log a changed prompt mid-series — the in-history append path was not even needed. The change would occur only when the intervention state itself changes.
5. The plugin registers **no tools**, so the tool-schema set — the one thing that would invalidate reuse from the first altered token — never changes.

## 5. Live GUI verification — the reasoning gate really pauses

The `ask_user_question` mechanism cannot be exercised in the headless profile (no
answerer), so the gate was, for a long time, only ever observed as an *injected
directive* — never as an actual pause. It was verified in a real GUI session
(dsh 0.1.5-rc.1, `web` profile, `deepseek-official/deepseek-flash`, temporary
`cordis.patch.yml` insert). Recorded evidence, all from the session log and the
plugin's event log rather than from observation:

| Step | Evidence |
|---|---|
| the request was classified | `intervention.triggered {level: 3, reason: "architecture", topic: "refactor-storage-layer-support-three-backends"}` in `events.jsonl` |
| the directive reached the model **once** | `system/message` at `seq=8`, 52125 chars, **blocks = 1** |
| the model complied | `tool/call seq=37 name=run_code`, whose code is `const res = await tools.ask_user_question({ questions: [{ id: "cognitive-gate", …` |
| the turn is genuinely paused | the session holds **3 `tool/call` but only 2 `tool/result`** — the third is outstanding |
| the tool schema never changed | `distinct signatures 1 (constant)` |

The injected text was exactly:

```text
[COGNITIVE FEEDBACK]
Reasoning gate — an architecture decision is about to be made.
Before implementing, get the user's own thinking first:
1. what problem they believe exists;
2. their proposed design or hypothesis;
3. why they expect it to work.
Use the `ask_user_question` tool (question id `cognitive-gate`) so the turn pauses for their answer.
Then you may challenge, refine, or validate it — but do not implement until they answer.
[/COGNITIVE FEEDBACK]
```

So the full chain is verified end to end: classify → record → inject **once** →
model pauses on the official tool → user answers.

### The complete loop, after the answer

Continuing the same session once the user answered produced the whole loop, again
from the logs:

```text
07:48:22  intervention.triggered   {level: 3, reason: "architecture"}
08:02:06  hypothesis.submitted     {authorship: "user", taskType: "architecture"}
08:02:06  decision.recorded        {owner: "user"}
```

and, in the session log, four `system/message` nodes with **no rewrite of the
leading node** (`0` replacement events) — the `in-history` append path, which is
exactly why prefix reuse survives injection:

| seq | turn/step | blocks | active directive |
|---|---|---|---|
| 8 | 1/1 | 1 | Reasoning gate |
| 43 | 1/4 | 1 | Reasoning gate (still unanswered) |
| 65 | 2/1 | **0** | none — the gate cleared on the answer |
| 80 | 2/2 | 1 | **Teaching back** — went live once the work was implemented |

**A defect this run exposed.** At seq=80 the teaching-back directive was live in
the prompt while `teaching_back.requested` had **not** been recorded and the
budget had not been charged: the event was only emitted from `decide()`, which
needs a further user message. A simply-shown intervention could therefore go
unlogged. Teaching back is now state-driven — the controller records and charges
it the moment the directive goes live. Verified trail:

```text
intervention.triggered -> hypothesis.submitted -> decision.recorded
  -> teaching_back.requested -> teaching_back.completed
```

Note: the running `web` process was started **before** this fix, so it still
carries the old behaviour until the next restart.

Still not covered: an `ask_user_question` pause for a *debugging* gate, and a
teaching-back grade (V0.1 emits `unassessed`/`skipped` by design).

## 6. Harness paradigm audit

Plugin-doctor ships a read-only static audit of the Harness plugin paradigm
(`plugin_paradigm_audit`, checks P1-P9). Run it against this plugin with:

```bash
# via the tool, from a DSH session:
plugin_paradigm_audit { target: /home/dc/projects/dsh-cognitive-feedback, details: true }
```

Latest result:

```text
dsh-cognitive-feedback v0.1.0
- entry: dist/index.js . TS project . has Config schema
- runtime deps: @deepseek-ai/schemastery
- P8-runtime-deps [info] one runtime dependency declared
- counts: critical 0 . warning 0 . info 1
```

The single `info` is the `@deepseek-ai/schemastery` dependency, which the audit
itself acknowledges is required when a plugin exports a Config schema: the
paradigm demands a Standard Schema, so the alternative is a worse option (a
hand-rolled validator).

The audit independently confirms the fixes made during the TypeScript and
paradigm work, each of which it would have flagged:

| Audit check | What it would have caught here |
|---|---|
| P2 Config must be a Schemastery schema | the plugin previously accepted an unvalidated plain object |
| P3 lifecycle | the adapter used to keep a private disposer list, duplicating the framework |
| P4 inject shape | an earlier `inject = { optional: [...] }` made the loader wait on a service literally named "optional" and failed the whole profile boot |
| P5 event names must exist in the host | an earlier `ctx.on('dispose', ...)` subscribed to an event Cordis never emits |
| P9 TypeScript project shape | source layout, entry resolution, generated `.d.ts` |

**The audit is static, and says so.** Its own footer names the class of problem it
cannot judge: *"injection timing, event-handler ordering, and same-name section
shadowing must be verified in a real session."* Those are precisely the defects
that live here -- the duplicate section injection (a same-name shadowing bug) and
the inbox-splice ordering bug -- so this audit complements §2/§3/§5 rather than
replacing them. Both have been run against this plugin.

## 7. Reviewing real usage

The plugin's value is cumulative, so one interaction proves nothing. The
append-only log at `$DSH_HOME/cognitive-feedback/events.jsonl` is the evidence
base, and `tools/cognitive-report.mjs` turns it into a funnel plus projected
episode/session/intervention views:

```bash
npm run build                                 # the tool reports on the code that runs
node tools/cognitive-report.mjs               # whole log
node tools/cognitive-report.mjs --days 7      # last week
node tools/cognitive-report.mjs --session <id> --json
node tools/cognitive-report.mjs --episodes    # episode rows with status
node tools/cognitive-report.mjs --rebuild     # ignore + rewrite the projection cache
```

The tool reads the log through the real `JsonlSink` reader, projects it in one
pass (`src/projection/`), and caches the derived view at
`events.projection.json` beside the log. The cache is keyed to a log digest and
versioned, so a **stale or corrupt cache is discarded and regenerated**; deleting
it by hand is always safe. A windowed report (`--days`, `--session`) never
overwrites the canonical whole-log cache.

```text
funnel
  sessions started          18
  interventions issued      1
  user hypotheses submitted 1
  decisions recorded        1
  teaching back requested   0
  teaching back completed   0
  knowledge gaps detected   0

interventions by reason
  architecture (level 3)     1
```

What to look at, and what it does **not** mean:

| Signal | Reading |
|---|---|
| `interventions issued` ≫ `hypotheses submitted` | gates are being ignored — the intervention is noise, not help |
| `teaching back completed` with `skipped` | explanations are being skipped; a gap worth watching |
| `interventions issued` near zero over days of high-value work | the classifier is too conservative for this user |
| `knowledge gaps detected` repeating on one topic | a durable gap, the intended input for a future adapter |
| any of the above from a handful of sessions | **not a finding** — these are long-run signals |

A session id in the log maps to its content at
`$DSH_HOME/sessions/<cwd-slug>/<session-id>/session.v3.jsonl.zstd`, readable with
`tools/inspect-session.mjs` (see §2).

**Privacy.** Stored by design: structured metadata, and short user-authored
answers capped at 500 characters (`hypothesis.submitted.payload.text`). Not
stored: full transcripts, source files, tool output, or any hidden reasoning.
The log is plain append-only JSONL — inspect it, grep it, or delete it at any
time; nothing else depends on it.

## 8. Manual smoke test in a user profile

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- insert:
    - id: cognitive-feedback
      name: /home/dc/projects/dsh-cognitive-feedback/dist/index.js
      config:
        eventsPath: /tmp/cognitive-feedback/events.jsonl
```

Then start a session, send an architecture-shaped request, and check:

```bash
cat /tmp/cognitive-feedback/events.jsonl
```

Expect `session.started` followed by `intervention.triggered` with `level: 3`.