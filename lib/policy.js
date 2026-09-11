/**
 * Policy Engine — deterministic conversion of state + budget into a small
 * action set. No LLM classifier (AGENTS.md §3).
 *
 * @module dsh-cognitive-feedback/policy
 */

/** @typedef {import('./types.js').CognitiveState} CognitiveState */

/**
 * V0.1 defaults. The budget is deliberately conservative: interrupting only
 * when expected learning value exceeds interaction cost.
 */
export const DEFAULT_CONFIG = {
  enabled: true,
  /** Max level-3 (reasoning gate) interventions per rolling 24h. */
  strongPerDay: 5,
  /** Max level-1/2 (nudge/challenge) interventions per rolling 24h. */
  lightPerDay: 10,
  /** Emit a teaching-back check after high-value work. */
  teachingBack: true,
  /** System-prompt section order; free slot between TEAM_POLICY(600) and PTC_ONLY(800). */
  sectionOrder: 700,
  /** Whether to include the directive to pause via the ask_user_question tool. */
  useAskUserTool: true,
  /** JSONL path; resolved by the adapter from $DSH_HOME when null. */
  eventsPath: null,
};

/**
 * Which high-value task types require a user hypothesis before implementing.
 * @type {ReadonlySet<string>}
 */
const GATE_TASKS = new Set(['architecture', 'research']);

/**
 * Decide the next action.
 *
 * @param {CognitiveState & Record<string, any>} state
 * @param {{ config?: typeof DEFAULT_CONFIG, budget?: { strongUsed: number, lightUsed: number } }} [options]
 * @returns {import('./types.js').PolicyAction}
 */
export function decide(state, options = {}) {
  const config = { ...DEFAULT_CONFIG, ...(options.config ?? {}) };
  if (!config.enabled) return { type: 'none' };

  const budget = options.budget ?? { strongUsed: 0, lightUsed: 0 };
  const topic = state.currentTopic;
  const taskType = state.taskType;

  // A pending gate must not be re-issued; wait for the user's answer.
  if (state.pendingGate) return { type: 'none' };

  // High-value decisions without a user-authored hypothesis → reasoning gate.
  if (taskType && GATE_TASKS.has(taskType) && !state.currentHypothesis && state.lastGateTopic !== topic) {
    if (budget.strongUsed >= config.strongPerDay) return { type: 'none' };
    return { type: 'reasoning_gate', reason: taskType };
  }

  // High-uncertainty debugging without a stated cause → light challenge.
  if (taskType === 'debugging' && !state.currentHypothesis && state.lastActionTopic !== topic) {
    if (budget.lightUsed >= config.lightPerDay) return { type: 'none' };
    return { type: 'prompt', level: 2 };
  }

  // Post-task teaching back for high-value work.
  if (config.teachingBack && state.teachingBackPending && state.lastActionType !== 'teaching_back') {
    if (budget.lightUsed >= config.lightPerDay) return { type: 'none' };
    return { type: 'teaching_back', reason: state.completedHighValueTopic ?? taskType ?? 'task' };
  }

  return { type: 'none' };
}

/**
 * Compute the currently *active* intervention from state, if any. Purely
 * derived so the prompt renderer can stay deterministic and cache-stable.
 *
 * @param {CognitiveState & Record<string, any>} state
 * @returns {{ kind: 'gate'|'challenge'|'teaching_back', reason: string } | null}
 */
export function activeIntervention(state) {
  // `reason` is always the TASK TYPE (drives the rendered decision label);
  // `topic` is the subject and drives the fingerprint's change detection.
  if (state.pendingGate) {
    return { kind: 'gate', reason: state.taskType ?? 'decision', topic: state.currentTopic };
  }
  if (
    state.lastActionType === 'prompt' &&
    state.lastActionTopic === state.currentTopic &&
    !state.currentHypothesis
  ) {
    return { kind: 'challenge', reason: state.taskType ?? 'debugging', topic: state.currentTopic };
  }
  if (state.teachingBackPending) {
    return { kind: 'teaching_back', reason: state.completedHighValueTopic ?? state.taskType ?? 'task', topic: state.currentTopic };
  }
  return null;
}