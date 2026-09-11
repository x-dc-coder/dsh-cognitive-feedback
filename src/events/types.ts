/**
 * The versioned cognitive event contract.
 *
 * Payloads are a discriminated union keyed by event type, so a reader that
 * switches on \`type\` gets the exact payload shape and a writer cannot attach a
 * payload belonging to a different type.
 *
 * @module dsh-cognitive-feedback/events/types
 */
import type { TaskType } from '../cognitive/classify.js';
import type { InterventionLevel, TeachingBackResult } from '../cognitive/state.js';

/** Current schema version. Breaking changes require a new number. */
export const SCHEMA_VERSION = 1;

/**
 * Every event type the implementation actually emits.
 *
 * \`hypothesis.challenged\` is deliberately absent: nothing produces it, and
 * declaring unemitted members overstates the contract. It is parked in
 * ROADMAP.md until a feature records a challenge to a user hypothesis.
 */
export interface CognitiveEventPayloadMap {
  'session.started': { project: string | null };
  'session.ended': { interventions: number };
  'intervention.triggered': {
    level: InterventionLevel;
    reason: string;
    taskType: TaskType | null;
    topic: string | null;
  };
  'hypothesis.submitted': { text: string; authorship: 'user'; taskType: TaskType | null };
  'decision.recorded': { owner: 'user'; topic: string | null };
  'teaching_back.requested': {
    level: InterventionLevel;
    reason: string | null;
    taskType: TaskType | null;
    topic: string | null;
  };
  'teaching_back.completed': { result: TeachingBackResult; topic: string | null };
  'knowledge_gap.detected': { topic: string | null; result: TeachingBackResult };
}

/** The known event types. */
export type CognitiveEventType = keyof CognitiveEventPayloadMap;

/**
 * One append-only cognitive event.
 *
 * The \`type\`/\`payload\` pair is a discriminated union: narrowing on \`type\` gives
 * the matching payload type, and mismatched pairs are rejected at compile time.
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
}[CognitiveEventType];

/**
 * An event that has been decided but not yet persisted: the type/payload pair
 * before identity and timestamp are attached.
 */
export type PreparedEvent = {
  [K in CognitiveEventType]: { readonly type: K; readonly payload: CognitiveEventPayloadMap[K] };
}[CognitiveEventType];

/** An event whose type is not statically known (for example after parsing JSONL). */
export interface UnknownCognitiveEvent {
  readonly schemaVersion?: unknown;
  readonly id?: unknown;
  readonly timestamp?: unknown;
  readonly sessionId?: unknown;
  readonly project?: unknown;
  readonly type?: unknown;
  readonly payload?: unknown;
}

export const COGNITIVE_EVENT_TYPES: readonly CognitiveEventType[] = [
  'session.started',
  'session.ended',
  'intervention.triggered',
  'hypothesis.submitted',
  'decision.recorded',
  'teaching_back.requested',
  'teaching_back.completed',
  'knowledge_gap.detected',
] as const;