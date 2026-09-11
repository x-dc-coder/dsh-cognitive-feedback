/**
 * Topic-level learning state -- a deterministic projection of knowledge gaps.
 *
 * The plugin already records `knowledge_gap.detected`, but a single event cannot
 * distinguish "this was hard today" from "this is the third time this month".
 * This module aggregates gaps by **normalized topic** so recurrence becomes
 * visible, and records whether a later strong teaching-back answered it.
 *
 * It is reporting-only. The live prompt must not react to history (see
 * `memory.ts`): a topic that recurred five times still produces exactly the same
 * directive as a first occurrence.
 *
 * Privacy: aggregation keeps the normalized topic key and short signal labels.
 * It never copies the user's answer or hypothesis text.
 *
 * @module dsh-cognitive-feedback/projection/learning
 */
import type { CognitiveEvent } from '../events/types.js';
import type { TeachingBackResult } from '../cognitive/state.js';
import { normalizeTopic } from '../cognitive/classify.js';

/** How often a normalized topic has come back. */
export type TopicRecurrence = 'one_off' | 'recurring';

/** Aggregated learning state for one normalized topic. */
export interface TopicLearningState {
  /** The canonical key (`normalizeTopic`) all source topics folded into. */
  readonly topic: string;
  /** The distinct raw topic strings that folded into this key, capped. */
  readonly rawTopics: readonly string[];
  readonly gapCount: number;
  /** Gaps inside the recency window. */
  readonly recentGaps: number;
  readonly firstGapAt: string;
  readonly lastGapAt: string;
  readonly sessions: readonly string[];
  readonly recurrence: TopicRecurrence;
  /** Coarse results of the teaching-back events on this topic. */
  readonly results: Readonly<Record<string, number>>;
  /** Why gaps were recorded (`skipped_answer`, `explicit_uncertainty`, ...). */
  readonly origins: Readonly<Record<string, number>>;
  /** A later strong explanation answered the most recent gap. */
  readonly resolved: boolean;
  /**
   * The last teaching-back on this topic. Only booleans are kept -- never the
   * answer text.
   */
  readonly lastTeachingBack: {
    readonly result: TeachingBackResult;
    readonly causalExplanation: boolean;
    readonly mechanismExplanation: boolean;
    readonly at: string;
  } | null;
}

/** Options for the topic projection. */
export interface LearningOptions {
  /** Reference time in epoch milliseconds; defaults to now. */
  readonly now?: number;
  /** Recency window for `recentGaps`; defaults to 30 days. */
  readonly windowMs?: number;
  /** Gaps needed before a topic counts as recurring; defaults to 2. */
  readonly minRecurrence?: number;
  /** Maximum distinct raw topics kept per canonical key; defaults to 5. */
  readonly maxRawTopics?: number;
}

interface MutableTopic {
  topic: string;
  rawTopics: string[];
  gapCount: number;
  recentGaps: number;
  firstGapAt: string;
  lastGapAt: string;
  sessions: string[];
  results: Record<string, number>;
  origins: Record<string, number>;
  lastGapIndex: number;
  strongTeachingBackIndex: number;
  lastTeachingBack: TopicLearningState['lastTeachingBack'];
}

const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Whether one teaching-back result is a *strong* resolution signal. */
function isStrongResolution(result: TeachingBackResult, causal: boolean, mechanism: boolean): boolean {
  return result !== 'skipped' && causal && mechanism;
}

/**
 * Aggregate knowledge gaps (and the teaching-back evidence that answers them) by
 * normalized topic, in append order.
 */
export function topicLearningStates(
  events: readonly CognitiveEvent[],
  options: LearningOptions = {},
): TopicLearningState[] {
  const now = options.now ?? Date.now();
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const minRecurrence = options.minRecurrence ?? 2;
  const maxRawTopics = options.maxRawTopics ?? 5;
  const cutoff = now - windowMs;

  const topics = new Map<string, MutableTopic>();
  const order: string[] = [];

  const ensure = (rawTopic: string | null): MutableTopic | null => {
    const key = normalizeTopic(String(rawTopic ?? ''));
    if (!key) return null;
    let state = topics.get(key);
    if (!state) {
      state = {
        topic: key,
        rawTopics: [],
        gapCount: 0,
        recentGaps: 0,
        firstGapAt: '',
        lastGapAt: '',
        sessions: [],
        results: {},
        origins: {},
        lastGapIndex: -1,
        strongTeachingBackIndex: -1,
        lastTeachingBack: null,
      };
      topics.set(key, state);
      order.push(key);
    }
    const raw = String(rawTopic ?? '');
    if (raw && !state.rawTopics.includes(raw) && state.rawTopics.length < maxRawTopics) state.rawTopics.push(raw);
    return state;
  };

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!event) continue;

    if (event.type === 'knowledge_gap.detected') {
      const state = ensure(event.payload.topic);
      if (!state) continue;
      state.gapCount += 1;
      const at = Date.parse(event.timestamp);
      if (Number.isFinite(at) && at >= cutoff) state.recentGaps += 1;
      if (!state.firstGapAt) state.firstGapAt = event.timestamp;
      state.lastGapAt = event.timestamp;
      if (!state.sessions.includes(event.sessionId)) state.sessions.push(event.sessionId);
      const origin = event.payload.origin ?? 'unknown';
      state.origins[origin] = (state.origins[origin] ?? 0) + 1;
      state.lastGapIndex = index;
      continue;
    }

    if (event.type === 'teaching_back.completed') {
      const state = ensure(event.payload.topic);
      if (!state) continue;
      const result = event.payload.result;
      state.results[result] = (state.results[result] ?? 0) + 1;
      const evidence = event.payload.evidence;
      const causal = evidence?.causalExplanation ?? false;
      const mechanism = evidence?.mechanismExplanation ?? false;
      state.lastTeachingBack = { result, causalExplanation: causal, mechanismExplanation: mechanism, at: event.timestamp };
      if (isStrongResolution(result, causal, mechanism)) state.strongTeachingBackIndex = index;
    }
  }

  return order.map((key) => {
    const state = topics.get(key);
    if (!state) throw new Error(`topic ${key} vanished`);
    return {
      topic: state.topic,
      rawTopics: state.rawTopics,
      gapCount: state.gapCount,
      recentGaps: state.recentGaps,
      firstGapAt: state.firstGapAt,
      lastGapAt: state.lastGapAt,
      sessions: state.sessions,
      recurrence: state.gapCount >= minRecurrence ? 'recurring' : 'one_off',
      results: state.results,
      origins: state.origins,
      // A gap that came back after a strong explanation means the gap is open
      // again; only a strong answer AFTER the most recent gap resolves it.
      resolved: state.lastGapIndex >= 0 && state.strongTeachingBackIndex > state.lastGapIndex,
      lastTeachingBack: state.lastTeachingBack,
    };
  });
}

/** How many topics recur at least `minRecurrence` times. */
export function countRecurringTopics(states: readonly TopicLearningState[]): number {
  return states.filter((state) => state.recurrence === 'recurring').length;
}

/** Topics whose most recent gap is not yet answered by a strong explanation. */
export function openRecurringTopics(states: readonly TopicLearningState[]): TopicLearningState[] {
  return states.filter((state) => state.recurrence === 'recurring' && !state.resolved);
}
