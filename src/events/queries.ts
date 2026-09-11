/**
 * Read-side helpers over the cognitive event log.
 *
 * Everything here treats stored data as **untrusted**: the log is a file on
 * disk that anything could have written, so parsed JSON is narrowed by a
 * runtime validator before it is typed as a \`CognitiveEvent\`.
 *
 * @module dsh-cognitive-feedback/events/queries
 */
import { COGNITIVE_EVENT_TYPES, SCHEMA_VERSION, type CognitiveEvent, type CognitiveEventType } from './types.js';

/** Whether a value is one of the known event types. */
export function isCognitiveEventType(value: unknown): value is CognitiveEventType {
  return typeof value === 'string' && (COGNITIVE_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * Narrow one parsed JSONL record to a cognitive event.
 *
 * Returns \`null\` -- meaning "skip this record" -- for anything that is not a
 * well-formed v1 event: a non-object, a missing identity field, an unknown
 * \`type\`, a non-object payload, or a different \`schemaVersion\`.
 *
 * This is deliberately stricter than "it parsed as JSON". The previous reader
 * returned whatever parsed, so a structurally invalid record would flow onward
 * wearing a \`CognitiveEvent\` type it never earned.
 */
export function parseCognitiveEvent(value: unknown): CognitiveEvent | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== SCHEMA_VERSION) return null;
  if (typeof record.id !== 'string' || record.id === '') return null;
  if (typeof record.timestamp !== 'string' || record.timestamp === '') return null;
  if (typeof record.sessionId !== 'string' || record.sessionId === '') return null;
  if (!isCognitiveEventType(record.type)) return null;
  if (typeof record.payload !== 'object' || record.payload === null || Array.isArray(record.payload)) return null;
  return record as unknown as CognitiveEvent;
}

/** Rolling-window budget options. */
export interface InterventionWindowOptions {
  /** Reference time in epoch milliseconds. */
  readonly now?: number;
  /** Window length in milliseconds; defaults to 24 hours. */
  readonly windowMs?: number;
  /** Count only level-3 interventions. */
  readonly strongOnly?: boolean;
}

/**
 * Count \`intervention.triggered\` events inside a rolling window. Used to
 * enforce the intervention budget across restarts from the persisted log
 * instead of an ephemeral in-memory counter.
 */
export function countRecentInterventions(
  events: readonly CognitiveEvent[],
  options: InterventionWindowOptions = {},
): number {
  const now = options.now ?? Date.now();
  const windowMs = options.windowMs ?? 24 * 60 * 60 * 1000;
  const strongOnly = options.strongOnly ?? false;
  const cutoff = now - windowMs;
  let count = 0;
  for (const event of events) {
    if (event.type !== 'intervention.triggered') continue;
    const at = Date.parse(event.timestamp);
    if (!Number.isFinite(at) || at < cutoff) continue;
    if (strongOnly && event.payload.level < 3) continue;
    count += 1;
  }
  return count;
}
