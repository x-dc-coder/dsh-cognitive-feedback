/**
 * State Engine -- short-lived cognitive state.
 *
 * Cache discipline: \`stateVersion\` bumps ONLY on a meaningful change, and the
 * store returns the *same object reference* when nothing changed. The prompt
 * renderer keys its memo on that version, so an unchanged state produces a
 * byte-identical cognitive section and the assembled prompt prefix stays
 * reusable.
 *
 * Fields that can be cleared are typed \`T | undefined\` rather than optional, so
 * clearing is explicit and type-checked under \`exactOptionalPropertyTypes\`.
 *
 * @module dsh-cognitive-feedback/cognitive/state
 */
import { analyzeMessage, type TaskType } from './classify.js';

/** Intervention intensity, proportional to uncertainty and cognitive value. */
export type InterventionLevel = 0 | 1 | 2 | 3;

/** Which cognitive mode the session is in. */
export type CognitiveMode = 'normal' | 'learning' | 'challenge' | 'research';

/** Outcome recorded for a teaching-back check. */
export type TeachingBackResult = 'correct' | 'partially_correct' | 'incorrect' | 'skipped' | 'unassessed';

/**
 * Short-lived state driving current behavior. Never a long-term user profile.
 *
 * The first block mirrors the documented V0.1 cognitive model; the second is
 * operational bookkeeping the behavior needs.
 */
export interface CognitiveState {
  sessionId: string;
  mode: CognitiveMode;
  taskType: TaskType | undefined;
  interventionLevel: InterventionLevel;
  recentDecisionOutsourcing: number;
  recentUnexplainedImplementations: number;
  currentTopic: string | undefined;
  currentHypothesis: string | undefined;
  /** Monotonic version; bumps only on real change. */
  stateVersion: number;

  pendingGate: boolean;
  lastGateTopic: string | undefined;
  lastActionType: 'none' | 'prompt' | 'reasoning_gate' | 'teaching_back';
  lastActionTopic: string | undefined;
  teachingBackPending: boolean;
  completedHighValueTopic: string | undefined;
  /** Latest user-authored text, kept only in memory for the current turn. */
  lastUserText: string | undefined;
}

/** A freshly created state for one session. */
export function createState(sessionId: string): CognitiveState {
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
    pendingGate: false,
    lastGateTopic: undefined,
    lastActionType: 'none',
    lastActionTopic: undefined,
    teachingBackPending: false,
    completedHighValueTopic: undefined,
    lastUserText: undefined,
  };
}

/** Immutable bump: returns a new state with stateVersion + 1. */
function bump(state: CognitiveState, patch: Partial<CognitiveState>): CognitiveState {
  return { ...state, ...patch, stateVersion: state.stateVersion + 1 };
}

export class StateEngine {
  private state: CognitiveState;

  constructor(sessionId: string) {
    this.state = createState(sessionId);
  }

  snapshot(): CognitiveState {
    return this.state;
  }

  /**
   * Apply one normalized signal. Returns the current state; the reference is
   * unchanged when the signal produced no meaningful difference.
   */
  update(signal: import('./signal.js').CognitiveSignal): CognitiveState {
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
    const patch: Partial<CognitiveState> = {};
    let changed = false;

    if (topicChanged) {
      patch.currentTopic = info.topic;
      patch.currentHypothesis = undefined;
      patch.pendingGate = false;
      patch.lastGateTopic = undefined;
      // Reset action memory so a later high-value task can ask again.
      patch.lastActionType = 'none';
      patch.lastActionTopic = undefined;
      // teachingBackPending is deliberately NOT cleared here: any user reply
      // yields a new topic key, so clearing on topic change would kill the
      // teaching-back it was about to ask for. The controller's completion
      // branch consumes it on the user's answer instead.
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
   */
  recordAction(action: import('./policy.js').PolicyAction, topic: string | undefined): CognitiveState {
    const s = this.state;
    const level: InterventionLevel =
      action.type === 'prompt' ? action.level : action.type === 'reasoning_gate' ? 3 : action.type === 'teaching_back' ? 1 : 0;
    const patch: Partial<CognitiveState> = {
      lastActionType: action.type,
      lastActionTopic: topic,
      interventionLevel: level,
    };
    if (action.type === 'reasoning_gate') {
      patch.pendingGate = true;
      patch.lastGateTopic = topic;
      patch.mode = 'challenge';
    }
    // NOTE: a teaching_back action deliberately does NOT clear
    // teachingBackPending. Clearing it here meant the section stopped rendering
    // in the very same assembly, so the model never saw the directive. The
    // directive stays live until the user answers it (see the controller's
    // completion branch) or the topic changes.
    if (action.type === 'teaching_back') {
      patch.lastActionTopic = topic;
    }
    this.state = bump(s, patch);
    return this.state;
  }

  /** Mark that a high-value task finished and deserves a teaching-back check. */
  markHighValueCompleted(topic: string | undefined): CognitiveState {
    this.state = bump(this.state, {
      teachingBackPending: true,
      completedHighValueTopic: topic,
    });
    return this.state;
  }

  /** Record a teaching-back outcome; repeated gaps feed the knowledge-gap signal. */
  recordTeachingBack(result: TeachingBackResult): CognitiveState {
    const s = this.state;
    const unexplained = result === 'skipped' || result === 'incorrect' || result === 'partially_correct';
    this.state = bump(s, {
      teachingBackPending: false,
      recentUnexplainedImplementations: unexplained ? s.recentUnexplainedImplementations + 1 : s.recentUnexplainedImplementations,
    });
    return this.state;
  }
}