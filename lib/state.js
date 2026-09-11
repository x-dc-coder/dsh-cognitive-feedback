/**
 * State Engine — short-lived cognitive state.
 *
 * Cache discipline: `stateVersion` bumps ONLY on a meaningful change, and the
 * store returns the *same object reference* when nothing changed. The prompt
 * renderer keys its memo on that version, so an unchanged state produces a
 * byte-identical cognitive section and the assembled prompt prefix stays
 * reusable (see docs/testing.md).
 *
 * @module dsh-cognitive-feedback/state
 */
import { analyzeMessage } from './classify.js';

/**
 * @param {string} sessionId
 * @returns {import('./types.js').CognitiveState & Record<string, any>}
 */
export function createState(sessionId) {
  return {
    sessionId,
    mode: 'normal',
    taskType: undefined,
    interventionLevel: 0,
    recentDecisionOutsourcing: 0,
    recentUnexplainedImplementations: 0,
    currentTopic: undefined,
    currentHypothesis: undefined,
    stateVersion: 0,
    // Operational fields (still short-lived, still never a user profile).
    pendingGate: false,
    lastGateTopic: undefined,
    lastActionType: 'none',
    lastActionTopic: undefined,
    teachingBackPending: false,
    completedHighValueTopic: undefined,
    /** Latest user-authored text, kept only in memory for the current turn. */
    lastUserText: undefined,
  };
}

/** Immutable bump: returns a new state with stateVersion + 1. */
function bump(state, patch) {
  return { ...state, ...patch, stateVersion: state.stateVersion + 1 };
}

export class StateEngine {
  /** @param {string} sessionId */
  constructor(sessionId) {
    /** @type {ReturnType<typeof createState>} */
    this.state = createState(sessionId);
  }

  /** @returns {ReturnType<typeof createState>} */
  snapshot() {
    return this.state;
  }

  /**
   * Apply one normalized signal. Returns the current state; the reference is
   * unchanged when the signal produced no meaningful difference.
   *
   * @param {import('./types.js').CognitiveSignal} signal
   * @returns {ReturnType<typeof createState>}
   */
  update(signal) {
    const s = this.state;
    if (signal.kind === 'session_started') {
      if (s.mode === 'normal' && s.stateVersion === 0) return this.state;
      return (this.state = bump(s, { mode: 'normal', pendingGate: false }));
    }
    if (signal.kind === 'session_ended') {
      return (this.state = bump(s, { mode: 'normal', pendingGate: false, currentHypothesis: undefined }));
    }
    if (signal.kind !== 'user_message') return this.state;

    const text = String(signal.text ?? '');
    const info = analyzeMessage(text);

    // A pending gate converts the next user message into the hypothesis answer.
    if (s.pendingGate && text.trim().length >= 12) {
      return (this.state = bump(s, {
        currentHypothesis: text,
        pendingGate: false,
        mode: 'challenge',
        lastUserText: text,
      }));
    }

    const topicChanged = info.topic !== s.currentTopic && info.topic !== '';
    const patch = {};
    let changed = false;

    if (topicChanged) {
      patch.currentTopic = info.topic;
      // A new topic invalidates the previous hypothesis and clears gate memory.
      patch.currentHypothesis = undefined;
      patch.pendingGate = false;
      patch.lastGateTopic = undefined;
      changed = true;
    }
    if (info.taskType !== s.taskType) {
      patch.taskType = info.taskType;
      changed = true;
    }
    if (info.hypothesis && !s.currentHypothesis) {
      patch.currentHypothesis = text;
      patch.pendingGate = false;
      changed = true;
    }
    if (info.routine && s.mode !== 'normal') {
      patch.mode = 'normal';
      changed = true;
    } else if (!info.routine && (info.taskType === 'architecture' || info.taskType === 'research') && s.mode !== 'research') {
      patch.mode = 'research';
      changed = true;
    } else if (!info.routine && info.taskType === 'debugging' && s.mode === 'normal') {
      patch.mode = 'challenge';
      changed = true;
    }
    if (text !== s.lastUserText) {
      patch.lastUserText = text;
      changed = true;
    }
    if (signal.sessionId && signal.sessionId !== s.sessionId) {
      patch.sessionId = signal.sessionId;
      changed = true;
    }

    if (!changed) return this.state;
    return (this.state = bump(s, patch));
  }

  /**
   * Record the outcome of a policy decision so cooldowns and teaching-back
   * tracking reflect it. Always a meaningful change.
   *
   * @param {import('./types.js').PolicyAction} action
   * @param {string|undefined} topic
   */
  recordAction(action, topic) {
    const s = this.state;
    const patch = { lastActionType: action.type, lastActionTopic: topic, interventionLevel: /** @type {any} */ (action.type === 'prompt' ? action.level : action.type === 'reasoning_gate' ? 3 : action.type === 'teaching_back' ? 1 : 0) };
    if (action.type === 'reasoning_gate') {
      patch.pendingGate = true;
      patch.lastGateTopic = topic;
      patch.mode = 'challenge';
    }
    if (action.type === 'teaching_back') {
      patch.teachingBackPending = false;
    }
    this.state = bump(s, patch);
    return this.state;
  }

  /** Mark that a high-value task finished and deserves a teaching-back check. */
  markHighValueCompleted(topic) {
    this.state = bump(this.state, {
      teachingBackPending: true,
      completedHighValueTopic: topic,
    });
    return this.state;
  }

  /** Record a teaching-back outcome; repeated gaps feed the knowledge-gap signal. */
  recordTeachingBack(result) {
    const s = this.state;
    const unexplained = result === 'skipped' || result === 'incorrect' || result === 'partially_correct';
    this.state = bump(s, {
      teachingBackPending: false,
      recentUnexplainedImplementations: unexplained ? s.recentUnexplainedImplementations + 1 : s.recentUnexplainedImplementations,
    });
    return this.state;
  }
}
