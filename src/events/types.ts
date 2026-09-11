/**
 * The versioned cognitive event contract.
 *
 * Payloads are a discriminated union keyed by event type, so a reader that
 * switches on `type` gets the exact payload shape and a writer cannot attach a
 * payload belonging to a different type.
 *
 * Correlation (`episodeId`, `interventionId`) lives at the TOP LEVEL next to
 * `sessionId`, not inside payloads: it is identity, not content, and any event
 * type may need to be joined to the reasoning unit it belongs to. The fields are
 * optional so every already-persisted v1 event stays readable.
 *
 * @module dsh-cognitive-feedback/events/types
 */
import type { TaskType } from '../cognitive/classify.js';
import type { InterventionLevel, TeachingBackResult } from '../cognitive/state.js';
import type { CognitiveValue, DecisionOwnership } from '../cognitive/policy.js';
import type { TeachingBackEvidence } from '../cognitive/teaching-back.js';

/** Current schema version. Breaking changes require a new number. */
export const SCHEMA_VERSION = 1;

/**
 * How a cognitive episode ended.
 *
 * `open` is never persisted: it is the state a reconstructed episode has when
 * no terminator was written yet (see `projection/episodes`).
 */
export type EpisodeOutcome = 'completed' | 'abandoned';

/** What caused a knowledge gap to be recorded. */
export type KnowledgeGapOrigin = 'skipped_answer' | 'explicit_uncertainty' | 'graded_low';

/**
 * Every event type the implementation actually emits.
 *
 * `hypothesis.challenged` is deliberately absent: nothing produces it, and
 * declaring unemitted members overstates the contract. It is parked in
 * ROADMAP.md until a feature records a challenge to a user hypothesis.
 */
export interface CognitiveEventPayloadMap {
  'session.started': { project: string | null };
  'session.ended': { interventions: number };
  /** One reasoning episode was opened; the episode id is on the event itself. */
  'episode.closed': { outcome: EpisodeOutcome; reason: string };
  'intervention.triggered': {
    level: InterventionLevel;
    reason: string;
    taskType: TaskType | null;
    topic: string | null;
    /** Who owned the decision (issue #9). Optional for pre-ownership events. */
    ownership?: DecisionOwnership;
    /** The cognitive value the policy assigned. Optional for pre-ownership events. */
    value?: CognitiveValue;
  };
  'hypothesis.submitted': { text: string; authorship: 'user'; taskType: TaskType | null };
  'decision.recorded': { owner: 'user'; topic: string | null };
  'teaching_back.requested': {
    level: InterventionLevel;
    reason: string | null;
    taskType: TaskType | null;
    topic: string | null;
  };
  /**
   * `evidence` carries the deterministic evidence extraction of the answer.
   * It is optional only so a pre-V0.2 event, or a host-supplied grade with no
   * answer to examine, still reads.
   */
  'teaching_back.completed': {
    result: TeachingBackResult;
    topic: string | null;
    evidence?: TeachingBackEvidence;
  };
  'knowledge_gap.detected': {
    topic: string | null;
    result: TeachingBackResult;
    /** Why the gap was recorded. Optional for pre-existing events. */
    origin?: KnowledgeGapOrigin;
  };
}

/** The known event types. */
export type CognitiveEventType = keyof CognitiveEventPayloadMap;

/** Correlation fields carried by any event that belongs to a reasoning unit. */
export interface EventCorrelation {
  /** The reasoning episode (`projection/episodes`) this event belongs to. */
  readonly episodeId?: string | undefined;
  /** The intervention lifecycle this event belongs to. */
  readonly interventionId?: string | undefined;
}

/**
 * One append-only cognitive event.
 *
 * The `type`/`payload` pair is a discriminated union: narrowing on `type` gives
 * the matching payload type, and mismatched pairs are rejected at compile time.
 *
 * `sessionId`, `episodeId` and `interventionId` are deliberately three
 * different things: a session contains many episodes, and an episode contains
 * many interventions. Keeping them distinct is what lets a reader join an
 * intervention to its hypothesis, decision and teaching-back without ever
 * guessing from topic strings or timestamps.
 */
export type CognitiveEvent = {
  [K in CognitiveEventType]: {
    readonly schemaVersion: typeof SCHEMA_VERSION;
    readonly id: string;
    readonly timestamp: string;
    readonly sessionId: string;
    readonly project?: string;
    readonly type: K;
    readonly payload: CognitiveEventPayloadMap[K];
  };
}[CognitiveEventType] &
  EventCorrelation;

/**
 * An event that has been decided but not yet persisted: the type/payload pair
 * before identity and timestamp are attached.
 */
export type PreparedEvent = {
  [K in CognitiveEventType]: { readonly type: K; readonly payload: CognitiveEventPayloadMap[K] };
}[CognitiveEventType] &
  EventCorrelation;

/** An event whose type is not statically known (for example after parsing JSONL). */
export interface UnknownCognitiveEvent {
  readonly schemaVersion?: unknown;
  readonly id?: unknown;
  readonly timestamp?: unknown;
  readonly sessionId?: unknown;
  readonly project?: unknown;
  readonly episodeId?: unknown;
  readonly interventionId?: unknown;
  readonly type?: unknown;
  readonly payload?: unknown;
}

export const COGNITIVE_EVENT_TYPES: readonly CognitiveEventType[] = [
  'session.started',
  'session.ended',
  'episode.closed',
  'intervention.triggered',
  'hypothesis.submitted',
  'decision.recorded',
  'teaching_back.requested',
  'teaching_back.completed',
  'knowledge_gap.detected',
] as const;
