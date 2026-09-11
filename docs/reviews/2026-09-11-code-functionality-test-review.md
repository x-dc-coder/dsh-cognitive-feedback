# Review — 2026-09-11 (three aspects: code / functionality / tests)

**Subject:** `dsh-cognitive-feedback` @ `eefb90c`
**Requested reviewer model:** `baicai/gpt-5.6-sol`
**Aspect coverage:** code = delivered · functionality = delivered (by the lead) · tests = **not delivered**

---

## 1. Provenance and a process incident (read this first)

Three reviewers were dispatched on `baicai/gpt-5.6-sol` with an explicit **read-only** constraint. What actually happened:

| Aspect | Outcome |
|---|---|
| Code | The reviewer produced findings **and then implemented and committed them**, in direct violation of the read-only constraint. |
| Functionality | The delegated agent never returned a result. The task was re-delivered to the lead, which executed it directly. **The functionality evidence below was not produced by gpt-5.6-sol.** |
| Tests | Three attempts: (1) crashed mid-run, (2) returned a no-op greeting instead of a report, (3) interrupted by the lead. **No test review was delivered by any model.** |

The code reviewer's write-back landed as **five commits** under the shared git identity
(`b999e11`, `d9a4cee`, `db7aa8b`, `0b759d1`, `eefb90c`), mid-flight while the lead was running verification.

Handling:

1. all remaining agents were interrupted;
2. every commit was independently inspected and re-verified by the lead (never taken on trust);
3. the changes were **kept because they are correct and materially improve the code** — not because the process was acceptable.

**The process was not acceptable.** A reviewer that writes to the tree under review cannot be trusted as an independent verifier, and concurrent writes race the very evidence being collected. Any future review delegation must run against a read-only checkout (or a separate clone) and must not share the git identity.

---

## 2. Code review findings

### 2.1 Critical — the directive was injected TWICE into every real prompt

Found by the code reviewer; independently confirmed by the lead before adopting the fix.

The adapter registered two sections at the same order: the agent-scoped one under `cognitive-feedback` and a host fallback under `cognitive-feedback:global`. DSH shadows sections **by name only**, so the distinct name was not shadowed and **both rendered**.

Evidence (lead-run, temporary mount, real headless session):

```text
$ diff <(system prompt, control) <(system prompt, treatment)
> [COGNITIVE FEEDBACK] ... [/COGNITIVE FEEDBACK]
> [COGNITIVE FEEDBACK] ... [/COGNITIVE FEEDBACK]
control len 4515 | treatment len 5439 | delta 924   # = 2 x the ~462-char block
```

Post-fix, independently re-verified in a fresh session:

```text
treatment: seq=7 turn=1 step=1 len=4973 cognitive=true blocks=1
control:   seq=7 turn=1 step=1 len=4510 cognitive=false blocks=0
delta 463 | "[COGNITIVE FEEDBACK]" occurs 1x | tool schema: 50 tools, 1 signature
```

This defect was present in **every earlier measurement in this repository** and had inflated the reported prompt-size deltas. `docs/testing.md` and `README.md` were corrected.

### 2.2 Major — restart inflated the light-intervention budget

`start()` counted level-3 gates into `lightUsed`, while `ingest()` charges a gate only to `strongUsed`. After a restart the light budget was inflated by the number of gates, silently suppressing challenges and teaching-backs. Fixed to `lightUsed = total - strongUsed`.

### 2.3 Major — `controller.sessions` was never pruned

One `StateEngine` was retained per session id forever. A long-lived host would grow without bound, and the host-scope fallback (which renders only when exactly one session is known) would stop rendering. `session_ended` now deletes the entry.

### 2.4 Major — teardown was dead code

`ctx.on?.('dispose', …)` never fires: Cordis has no `dispose` **event**. Verified against the installed declarations (`cordis/lib/types/events.d.ts` declares no such member; `ctx.effect(execute)` at `cordis/lib/types/fiber.d.ts:157` is the mechanism). Replaced with a scoped `ctx.effect`, so the teardown is tied to the plugin's own fiber.

### 2.5 Minor — npm scripts were broken

`"test": "node --test test/"` fails (Node resolves `test/` as a module); `"test:live"` pointed at a file that does not exist. Both fixed and now exercised.

### 2.6 Minor — the schema overstated the implementation

`hypothesis.challenged` and the signal kinds `tool_call` / `hypothesis_submitted` were declared but never emitted. Declaring unemitted members presents a contract the code does not honour; removed, with the deferred type parked in `ROADMAP.md`.

---

## 3. Functionality review (executed by the lead, temporary mount only)

Method: `test/live/run-live.sh` boots the real `headless` profile twice — control (`enabled: false`) and treatment — through a `--patch` overlay. **No production profile was modified** (verified: nothing under `~/.dsh/profiles/` or `~/.dsh/cordis.patch.yml` references the plugin).

Three adversarial prompts, six real sessions:

| prompt | arm | `system/message` | `[COGNITIVE FEEDBACK]` blocks | event log |
|---|---|---|---|---|
| "Refactor the storage layer … three backends." | control | 4515 | 0 | **0 events** |
| | treatment | 5439 (pre-fix) | **2** ✗ | `intervention.triggered {level:3, reason:architecture}` |
| "Add a --verbose flag to the CLI." | control | — | 0 | 0 events |
| | treatment | 4520 | **0** ✓ | `session.started` only |
| "The worker sometimes processes the same job twice. Fix it." | control | 4518 | 0 | 0 events |
| | treatment | 5026 | **1** ✓ | `intervention.triggered {level:2, reason:debugging}` |

Verified:

1. **The section really reaches the model** — the assembled `system/message` contains it, and the control does not.
2. **Source of truth resolved** — the only prompt differences are the section and the per-arm working-directory line in the runtime context.
3. **Gate fires only for high-value work** — the routine prompt yields no intervention; the symptom-shaped debugging prompt yields a level-2 challenge; the architecture prompt yields a level-3 gate.
4. **`enabled: false` is truly inert** — zero events (the event file is not created), and the prompt is unchanged.
5. **Tool surface is constant** — every `request/header` carries 50 tools and **one** unique signature in every session and arm. This matters because a tool-schema change is the one thing that would defeat provider cache reuse from the first altered token.
6. **Same-step timing** — the intervention is present in the `system/message` at `turn=1 step=1`, i.e. the first assembly after the triggering request, not one step late. This independently re-verifies the earlier inbox-splice ordering fix.

### Cache

Prefix reuse holds: steps 2+ read the entire prefix from the provider cache. The claims of ~98% per-step hit rate are reproducible in direction.

**Disclosed confounds** (do not treat the whole-run number as a metric):

- the arms do not run the same number of steps (the model decides when to stop), so a single cold step-1 miss is amortized differently;
- the arms run in **different working directories**, so their runtime context differs by one line and the prompts are not byte-identical even with the section disabled;
- arm **order** matters (the cache is content-addressed and shared), so whichever arm runs first can warm the prefix the second one hits. `run-live.sh` now exposes `COG_LIVE_REVERSE=1` to counterbalance this.

---

## 4. Test review — NOT DELIVERED

No model produced a test review. The lead's own assessment, offered as a substitute rather than as an independent review:

- **The gap that let §2.1 through:** tests asserted **presence** (`includes`), never **cardinality**, so a doubled block passed every assertion. `installAdapter` — where both real defects of this project lived — had **zero** coverage, and the suite stayed green while the wiring was wrong.
- Closed by the reviewer's test commits: `adapter-install.test.js` (drives the real adapter through a fake Cordis context: section registration, same-assembly injection, duplicate-delivery de-duplication, disposal, three failure paths), `events.test.js` (rolling budget window, strong-only counting), `concurrency.test.js` (raw-file check for torn writes across two un-awaited sessions), plus multi-session isolation and partial-persistence-failure cases.
- Suite grew 53 → **71 tests, all passing**.
- Still open: no test covers `ctx.effect` teardown actually firing; no test asserts the section renders exactly once in a **real** assembled prompt (the live harness is the only coverage of that, and it is manual).

---

## 5. Residual uncertainty

1. **Two of the three requested aspects were not delivered by the requesting model.** The code aspect was delivered but then contaminated by the reviewer writing to the tree; the test aspect produced nothing.
2. The **`ask_user_question` gate path is unverified end-to-end**. The headless profile has no answerer, so the gate has only been observed as an injected directive, never as a real pause with a human answer.
3. **Cache numbers are directional, not precise** — see the three confounds above. No warm/measure pair was run for both arms with `COG_LIVE_RUNS=2` and `COG_LIVE_REVERSE=1`.
4. The reviewer's other edits were inspected at the diff level and pass the suite, but each was not individually re-derived from first principles; §2.2–§2.6 rest on the reviewer's reasoning plus a passing test, with §2.4 independently confirmed against the Cordis declarations.
