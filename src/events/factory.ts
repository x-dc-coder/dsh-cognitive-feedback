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
    type,
    payload,
  } as CognitiveEvent;
}
