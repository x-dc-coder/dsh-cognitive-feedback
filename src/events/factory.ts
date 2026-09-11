/**
 * Cognitive event construction. Append-only, versioned, minimal.
 *
 * @module dsh-cognitive-feedback/events/factory
 */
import { randomUUID } from 'node:crypto';
import { SCHEMA_VERSION, type CognitiveEvent, type CognitiveEventType, type CognitiveEventPayloadMap } from './types.js';

/** Ambient inputs a factory call needs. */
export interface EventMeta {
  readonly sessionId: string;
  readonly project?: string | undefined;
  readonly now?: (() => Date) | undefined;
  readonly id?: string | undefined;
  readonly timestamp?: string | undefined;
  /** Correlation: the reasoning episode this event belongs to. */
  readonly episodeId?: string | undefined;
  /** Correlation: the intervention lifecycle this event belongs to. */
  readonly interventionId?: string | undefined;
}

/**
 * Build one schema-versioned cognitive event.
 *
 * The generic ties the payload type to the event type, so a mismatched pair is
 * a compile error rather than a runtime surprise.
 */
export function makeEvent<T extends CognitiveEventType>(
  type: T,
  payload: CognitiveEventPayloadMap[T],
  meta: EventMeta,
): CognitiveEvent {
  const now = meta.now ?? (() => new Date());
  return {
    schemaVersion: SCHEMA_VERSION,
    id: meta.id ?? `evt_${randomUUID()}`,
    timestamp: meta.timestamp ?? now().toISOString(),
    sessionId: meta.sessionId,
    ...(meta.project ? { project: meta.project } : {}),
    ...(meta.episodeId ? { episodeId: meta.episodeId } : {}),
    ...(meta.interventionId ? { interventionId: meta.interventionId } : {}),
    type,
    payload,
  } as CognitiveEvent;
}

/**
 * Mint one correlation id.
 *
 * Prefixed and random so an id is globally unique across sessions and process
 * restarts, and so a raw log line shows at a glance what kind of unit it names.
 */
export function newCorrelationId(prefix: 'ep' | 'iv'): string {
  return `${prefix}_${randomUUID()}`;
}
