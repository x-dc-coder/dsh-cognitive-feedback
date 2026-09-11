# Decision Policy: Prompt Injection vs User Q&A

This document defines the boundary the policy layer enforces. It is the
authoritative answer to two different questions the plugin must never conflate:

> **Prompt Injection** = remind the user to think, without blocking the agent.
>
> **User Q&A** = the decision belongs to the user; the agent must not decide on
> their behalf before they answer.

"An intervention is useful here" and "the user must answer first" are separate
questions. The policy asks the second one explicitly.

## 1. The model

```text
Task
  ↓
Cognitive Value            (low | medium | high)
  ↓
Decision Ownership         (agent | shared | user)
  ├── agent  → execute directly (no intervention)
  ├── shared → prompt injection (never blocks)
  └── user   → reasoning gate / user Q&A (blocks until answered)
  ↓
Intervention level 0..3
```

### Ownership semantics

| Ownership | Meaning | The agent may... |
|---|---|---|
| `agent` | there is no reasoning worth protecting | decide and execute |
| `shared` | the decision is reversible, but the user should stay cognitively involved | continue, with a reminder in the prompt |
| `user` | the outcome is a judgement call the user owns | not implement until the user states their thinking |

### Levels

| Level | Kind | Ownership | Blocking |
|---|---|---:|---|
| 0 | `none` | agent | no |
| 1 | `nudge` (PROMPT) | shared | no |
| 2 | `challenge` (CHALLENGE) | shared | no |
| 3 | `reasoning_gate` (USER Q&A) | user | **yes** |

Only level 3 blocks. A nudge or challenge is a directive in the system prompt;
the agent keeps working.

## 2. Decision matrix

The matrix is implemented as deterministic rules over the task classifier and
the current state — there is no LLM in this path.

| Task shape | Ownership | Intervention | Blocking |
|---|---|---|---|
| Boilerplate / CRUD / formatting / rename / ordinary tests / fixtures | agent | none | no |
| Ordinary implementation or refactor | shared | nudge (level 1) | no |
| Debugging whose cause is not stated | shared | challenge (level 2) | no |
| Architecture design or a large architecture change | user | reasoning gate (level 3) | **yes** |
| Major data-model change | user | reasoning gate | **yes** |
| Technology selection (database / framework / protocol / store) | user | reasoning gate | **yes** |
| High-impact root-cause debugging | user | reasoning gate | **yes** |
| Research question | user | reasoning gate | **yes** |
| Research hypothesis (when the user has not stated one) | user | reasoning gate | **yes** |
| Experiment design / key research direction | user | reasoning gate | **yes** |

Rules that keep it honest:

- **routine wins.** A mechanical request is agent-owned even if it mentions a
  high-value keyword ("Rename the architecture.md file").
- **one intervention per topic.** The same topic is not nudged, challenged or
  gated twice.
- **a stated hypothesis resolves the signal.** Once the user has stated their
  reasoning, the gate is not re-issued and the nudge is suppressed.
- **user-owned decisions degrade, they do not vanish.** If the gate budget is
  spent, the signal becomes a non-blocking challenge; only when both budgets are
  spent does the intervention disappear.

## 3. Debugging rule

Debugging must not become "ask the user before every fix":

```text
ordinary / low-uncertainty debug        → challenge (level 2, non-blocking)
high-impact + high-uncertainty root cause → reasoning gate (level 3, blocking)
```

"High-impact" requires both an **impact** signal (production, data loss or
corruption, security, race condition, deadlock, memory leak, outage, payment)
and an **uncertainty** signal (sometimes, intermittent, flaky, non-deterministic,
sporadic, random, race, deadlock). A symptom that merely moves stays a challenge.

## 4. Research rule

Research tasks are stricter than ordinary development, and follow:

```text
Question → Hypothesis → Challenge → Decision → Experiment → Evidence → Conclusion
```

A research question, a hypothesis the user has not stated, and experiment design
are all user-owned. The gate asks for the **minimum** judgement needed — the
problem as the user sees it, their hypothesis or direction, and why they expect
it to work — not a questionnaire.

## 5. Reasoning gate behaviour

When ownership is `user`:

1. the directive goes into the cognitive section, once, in the assembly that
   follows the request;
2. the directive asks the agent to use the official `ask_user_question` tool
   (question id `cognitive-gate`), so the turn pauses;
3. the user's answer is recorded as `hypothesis.submitted` +
   `decision.recorded` with `authorship: "user"`, correlated to the gate;
4. the gate is not re-issued while it is pending;
5. if no user-interaction surface exists, the directive degrades to a
   prompt-level request and the agent continues — fail open, never a hang.

## 6. Failure isolation

Every policy outcome is advisory. A policy failure, a prompt-construction
failure, a sink failure or a teaching-back failure must leave the agent able to
keep coding (`AGENTS.md` §4). `enabled: false` is fully inert: no state, no
policy, no events, no prompt section.

## 7. Verification

- `test/policy-matrix.test.js` — the matrix as a table: kind, ownership, level,
  blocking and reason for every row, plus the degradation ladder, the
  hypothesis-suppresses case, pending gates and the recorded event fields.
- `test/policy.test.js` — the documented examples from `docs/examples.md` are a
  contract test.
- `test/prompt.test.js` — nudge / challenge / gate render distinct, bounded,
  cache-stable text; the renderer cannot see history.
- Live: a gate in a real GUI session actually pauses (`docs/testing.md` §5), and
  the live re-verification in §3.3 checks injection after the ownership work.
