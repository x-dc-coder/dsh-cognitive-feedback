/**
 * Cognitive event construction. Append-only, versioned, minimal.
 *
 * @module dsh-cognitive-feedback/events
 */
import { randomUUID } from 'node:crypto';
import { SCHEMA_VERSION } from './types.js';

/**
 * Build one schema-versioned cognitive event.
 *
 * @param {import('./types.js').CognitiveEventType} type
 * @param {Record<string, unknown>} payload
 * @param {{ sessionId: string, project?: string, now?: () => Date, id?: string }} meta
 * @returns {import('./types.js').CognitiveEvent}
 */
export function makeEvent(type, payload, meta) {
  const now = meta.now ?? (() => new Date());
  return {
    schemaVersion: SCHEMA_VERSION,
    id: meta.id ?? `evt_${randomUUID()}`,
    timestamp: now().toISOString(),
    sessionId: meta.sessionId,
    ...(meta.project ? { project: meta.project } : {}),
    type,
    payload,
  };
}

/**
 * Count `intervention.triggered` events inside a rolling window. Used to
 * enforce the intervention budget across restarts from the persisted log
 * instead of an ephemeral in-memory counter.
 *
 * @param {readonly import('./types.js').CognitiveEvent[]} events
 * @param {{ now?: number, windowMs?: number, strongOnly?: boolean }} [options]
 * @returns {number}
 */
export function countRecentInterventions(events, options = {}) {
  const now = options.now ?? Date.now();
  const windowMs = options.windowMs ?? 24 * 60 * 60 * 1000;
  const strongOnly = options.strongOnly ?? false;
  const cutoff = now - windowMs;
  let count = 0;
  for (const event of events) {
    if (event.type !== 'intervention.triggered') continue;
    const at = Date.parse(event.timestamp);
    if (!Number.isFinite(at) || at < cutoff) continue;
    if (strongOnly) {
      const level = Number(event.payload?.level ?? 0);
      if (level < 3) continue;
    }
    count += 1;
  }
  return count;
}
