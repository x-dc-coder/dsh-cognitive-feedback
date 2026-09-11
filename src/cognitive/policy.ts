/**
 * Policy Engine -- the decision-ownership model.
 *
 * The policy answers one question before it decides anything: **who owns the
 * current decision?**
 *
 * ```text
 * Task -> Cognitive Value -> Decision Ownership -> Intervention
 *                                  ├── agent  -> execute (no intervention)
 *                                  ├── shared -> prompt injection (never blocks)
 *                                  └── user   -> reasoning gate (blocks until answered)
 * ```
 *
 * "This deserves cognitive support" and "the user must answer first" are NOT the
 * same thing; keeping them separate is what stops the policy from drifting into
 * a pile of ad-hoc heuristics (issue #9).
 *
 * Levels:
 *
 * | Level | Kind | Ownership | Blocking |
 * |---|---|---|---|
 * | 0 | none | agent | no |
 * | 1 | nudge (PROMPT) | shared | no |
 * | 2 | challenge (CHALLENGE) | shared | no |
 * | 3 | reasoning gate (USER Q&A) | user | yes |
 *
 * Deterministic: no LLM, no randomness. `decidePolicy()` returns the full
 * decision (kind, ownership, value, level, blocking, reason, rationale) so the
 * choice is explainable; `decide()` returns just the execution action for
 * callers that only need to act.
 *
 * @module dsh-cognitive-feedback/cognitive/policy
 */
import type { CognitiveState, InterventionLevel } from './state.js';

/** What the policy can decide, as an executable action. */
export type PolicyAction =
  | { readonly type: 'none' }
  | { readonly type: 'prompt'; readonly level: 1 | 2 }
  | { readonly type: 'reasoning_gate'; readonly reason: string }
  | { readonly type: 'teaching_back'; readonly reason: string };

/** Who owns the decision the current task is about to make. */
export type DecisionOwnership = 'agent' | 'shared' | 'user';

/** How much cognitive value the policy assigns to the current task. */
export type CognitiveValue = 'low' | 'medium' | 'high';

/** The intervention kind, named as the ownership model names it. */
export type DecisionKind = 'none' | 'nudge' | 'challenge' | 'reasoning_gate';

/** One fully explained policy decision. */
export interface PolicyDecision {
  readonly kind: DecisionKind;
  /** The executable action; `decide()` returns exactly this. */
  readonly action: PolicyAction;
  readonly ownership: DecisionOwnership;
  readonly value: CognitiveValue;
  readonly level: InterventionLevel;
  /** True only for a reasoning gate: the agent must wait for the user. */
  readonly blocking: boolean;
  /** Stable machine label (`routine`, `architecture`, `root-cause`, ...). */
  readonly reason: string;
  /** One line explaining *why* this decision was reached. */
  readonly rationale: string;
}

/** Operator configuration, all fields optional. */
export interface CognitiveConfig {
  /** Master switch. When false the plugin is fully inert. */
  enabled: boolean;
  /** Max level-3 (reasoning gate) interventions per rolling 24h. */
  strongPerDay: number;
  /** Max level-1/2 (nudge/challenge) interventions per rolling 24h. */
  lightPerDay: number;
  /** Emit a teaching-back check after high-value work. */
  teachingBack: boolean;
  /** System-prompt section order; free slot between TEAM_POLICY(600) and PTC_ONLY(800). */
  sectionOrder: number;
  /** Include the directive to pause via the ask_user_question tool. */
  useAskUserTool: boolean;
  /** JSONL path; resolved by the adapter from \`$DSH_HOME\` when omitted. */
  eventsPath: string | null;
}

/** V0.1 defaults. The budget is deliberately conservative. */
export const DEFAULT_CONFIG: CognitiveConfig = {
  enabled: true,
  strongPerDay: 5,
  lightPerDay: 10,
  teachingBack: true,
  sectionOrder: 700,
  useAskUserTool: true,
  eventsPath: null,
};

/**
 * Task types the user owns by default: their outcome is a judgement call, not
 * an implementation detail. Debugging joins them only when it is BOTH
 * high-impact and high-uncertainty (see `classify.isHighImpactDebugging`).
 */
export const USER_OWNED_TASKS: ReadonlySet<string> = new Set(['architecture', 'research']);

/** Current intervention budget use. */
export interface InterventionBudget {
  readonly strongUsed: number;
  readonly lightUsed: number;
}

/** Inputs to one decision. */
export interface DecideOptions {
  readonly config?: Partial<CognitiveConfig> | undefined;
  readonly budget?: InterventionBudget | undefined;
}

function none(reason: string, rationale: string, ownership: DecisionOwnership = 'agent'): PolicyDecision {
  return { kind: 'none', action: { type: 'none' }, ownership, value: 'low', level: 0, blocking: false, reason, rationale };
}

function nudge(reason: string, rationale: string): PolicyDecision {
  return {
    kind: 'nudge',
    action: { type: 'prompt', level: 1 },
    ownership: 'shared',
    value: 'medium',
    level: 1,
    blocking: false,
    reason,
    rationale,
  };
}

function challenge(reason: string, rationale: string): PolicyDecision {
  return {
    kind: 'challenge',
    action: { type: 'prompt', level: 2 },
    ownership: 'shared',
    value: 'medium',
    level: 2,
    blocking: false,
    reason,
    rationale,
  };
}

function gate(reason: string, rationale: string): PolicyDecision {
  return {
    kind: 'reasoning_gate',
    action: { type: 'reasoning_gate', reason },
    ownership: 'user',
    value: 'high',
    level: 3,
    blocking: true,
    reason,
    rationale,
  };
}

/**
 * Decide the next intervention, with its ownership and rationale.
 *
 * Order matters and is the policy: an already-open gate wins, routine work
 * passes through, user-owned decisions gate, unclear debugging challenges, and
 * ordinary implementation gets at most one light nudge per topic.
 */
export function decidePolicy(state: CognitiveState, options: DecideOptions = {}): PolicyDecision {
  const config: CognitiveConfig = { ...DEFAULT_CONFIG, ...(options.config ?? {}) };
  if (!config.enabled) return none('disabled', 'the plugin is disabled');

  const budget = options.budget ?? { strongUsed: 0, lightUsed: 0 };
  const topic = state.currentTopic;
  const taskType = state.taskType;

  // A pending gate must not be re-issued; the user owns the decision until they
  // answer, and the agent is already paused.
  if (state.pendingGate) {
    return none('gate-pending', 'a reasoning gate is already open; the user owns this decision', 'user');
  }

  // 1. Routine work is agent-owned: it passes through untouched.
  if (state.taskRoutine) {
    return none('routine', 'routine work is agent-owned; there is no reasoning to protect');
  }

  // 2. User-owned decisions: the user states the reasoning before implementation.
  const userOwned = USER_OWNED_TASKS.has(String(taskType)) || (taskType === 'debugging' && state.taskHighImpactDebug);
  if (userOwned && !state.currentHypothesis && state.lastGateTopic !== topic) {
    const reason = taskType === 'debugging' ? 'root-cause' : String(taskType);
    if (budget.strongUsed < config.strongPerDay) {
      return gate(reason, 'a user-owned decision must be stated by the user before implementation');
    }
    // Budget degradation: a spent gate budget does not silence the signal, it
    // downgrades to the strongest intervention still allowed.
    if (budget.lightUsed < config.lightPerDay) {
      return challenge(reason, 'the reasoning-gate budget is spent; degrade to a non-blocking challenge');
    }
    return none('budget-exhausted', 'both intervention budgets are spent for this window');
  }

  // 3. Shared ownership, cause not stated: challenge without blocking.
  if (taskType === 'debugging' && !state.currentHypothesis && state.lastActionTopic !== topic) {
    if (budget.lightUsed >= config.lightPerDay) {
      return none('budget-exhausted', 'the light intervention budget is spent for this window');
    }
    return challenge('debugging', 'the cause is not stated; ask for the user hypothesis without blocking');
  }

  // 4. Shared ownership, ordinary implementation: one light nudge per topic,
  //    never while a teaching-back directive is live.
  if (taskType === 'implementation' && !state.currentHypothesis && !state.teachingBackPending && state.lastActionTopic !== topic) {
    if (budget.lightUsed >= config.lightPerDay) {
      return none('budget-exhausted', 'the light intervention budget is spent for this window');
    }
    return nudge('implementation', 'ordinary implementation is shared ownership: name the main assumption before coding');
  }

  return none('nothing-to-add', 'no ownership signal warrants a new intervention right now');
}

/** Decide the next action. Thin adapter over `decidePolicy()`. */
export function decide(state: CognitiveState, options: DecideOptions = {}): PolicyAction {
  return decidePolicy(state, options).action;
}

/** The intervention currently rendered into the system prompt, if any. */
export type ActiveIntervention =
  | { readonly kind: 'gate'; readonly reason: string; readonly topic: string | undefined }
  | { readonly kind: 'nudge'; readonly reason: string; readonly topic: string | undefined }
  | { readonly kind: 'challenge'; readonly reason: string; readonly topic: string | undefined }
  | { readonly kind: 'teaching_back'; readonly reason: string; readonly topic: string | undefined };

/**
 * Compute the currently active intervention from state, if any. Purely derived
 * so the prompt renderer can stay deterministic and cache-stable.
 *
 * A level-1 prompt is a `nudge`; a level-2 prompt is a `challenge`. They share
 * `lastActionType === 'prompt'`, so the recorded `interventionLevel` is what
 * distinguishes them.
 */
export function activeIntervention(state: CognitiveState): ActiveIntervention | null {
  // reason is always the TASK TYPE (drives the rendered decision label);
  // topic is the subject and drives the fingerprint's change detection.
  if (state.pendingGate) {
    return { kind: 'gate', reason: state.taskType ?? 'decision', topic: state.currentTopic };
  }
  if (state.lastActionType === 'prompt' && state.lastActionTopic === state.currentTopic && !state.currentHypothesis) {
    return state.interventionLevel >= 2
      ? { kind: 'challenge', reason: state.taskType ?? 'debugging', topic: state.currentTopic }
      : { kind: 'nudge', reason: state.taskType ?? 'implementation', topic: state.currentTopic };
  }
  if (state.teachingBackPending) {
    return {
      kind: 'teaching_back',
      reason: state.completedHighValueTopic ?? state.taskType ?? 'task',
      topic: state.currentTopic,
    };
  }
  return null;
}

/** Intervention level implied by an action. */
export function actionLevel(action: PolicyAction): InterventionLevel {
  if (action.type === 'prompt') return action.level;
  if (action.type === 'reasoning_gate') return 3;
  if (action.type === 'teaching_back') return 1;
  return 0;
}
