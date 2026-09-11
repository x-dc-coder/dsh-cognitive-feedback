/**
 * Policy Engine -- deterministic conversion of state + budget into a small
 * action set. No LLM classifier.
 *
 * @module dsh-cognitive-feedback/cognitive/policy
 */
import type { CognitiveState, InterventionLevel } from './state.js';

/** What the policy can decide. */
export type PolicyAction =
  | { readonly type: 'none' }
  | { readonly type: 'prompt'; readonly level: 1 | 2 }
  | { readonly type: 'reasoning_gate'; readonly reason: string }
  | { readonly type: 'teaching_back'; readonly reason: string };

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
  /** JSONL path; resolved by the adapter from $DSH_HOME when omitted. */
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

/** Which high-value task types require a user hypothesis before implementing. */
const GATE_TASKS: ReadonlySet<string> = new Set(['architecture', 'research']);

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

/** Decide the next action. */
export function decide(state: CognitiveState, options: DecideOptions = {}): PolicyAction {
  const config: CognitiveConfig = { ...DEFAULT_CONFIG, ...(options.config ?? {}) };
  if (!config.enabled) return { type: 'none' };

  const budget = options.budget ?? { strongUsed: 0, lightUsed: 0 };
  const topic = state.currentTopic;
  const taskType = state.taskType;

  // A pending gate must not be re-issued; wait for the user's answer.
  if (state.pendingGate) return { type: 'none' };

  // High-value decisions without a user-authored hypothesis -> reasoning gate.
  if (taskType && GATE_TASKS.has(taskType) && !state.currentHypothesis && state.lastGateTopic !== topic) {
    if (budget.strongUsed >= config.strongPerDay) return { type: 'none' };
    return { type: 'reasoning_gate', reason: taskType };
  }

  // High-uncertainty debugging without a stated cause -> light challenge.
  if (taskType === 'debugging' && !state.currentHypothesis && state.lastActionTopic !== topic) {
    if (budget.lightUsed >= config.lightPerDay) return { type: 'none' };
    return { type: 'prompt', level: 2 };
  }

  // NOTE: teaching back is not decided here. Its directive is driven by
  // teachingBackPending, which the controller sets the moment the directive
  // goes live (and where it records + charges the intervention). Routing it
  // through decide() would delay the log until the next user message and could
  // double-count it.
  return { type: 'none' };
}

/** The intervention currently rendered into the system prompt, if any. */
export type ActiveIntervention =
  | { readonly kind: 'gate'; readonly reason: string; readonly topic: string | undefined }
  | { readonly kind: 'challenge'; readonly reason: string; readonly topic: string | undefined }
  | { readonly kind: 'teaching_back'; readonly reason: string; readonly topic: string | undefined };

/**
 * Compute the currently active intervention from state, if any. Purely derived
 * so the prompt renderer can stay deterministic and cache-stable.
 */
export function activeIntervention(state: CognitiveState): ActiveIntervention | null {
  // reason is always the TASK TYPE (drives the rendered decision label);
  // topic is the subject and drives the fingerprint's change detection.
  if (state.pendingGate) {
    return { kind: 'gate', reason: state.taskType ?? 'decision', topic: state.currentTopic };
  }
  if (state.lastActionType === 'prompt' && state.lastActionTopic === state.currentTopic && !state.currentHypothesis) {
    return { kind: 'challenge', reason: state.taskType ?? 'debugging', topic: state.currentTopic };
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
