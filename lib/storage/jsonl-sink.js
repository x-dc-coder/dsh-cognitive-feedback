/**
 * Append-only JSONL sink. Default V0.1 store.
 *
 * - one JSON object per line, never rewritten;
 * - a malformed line is skipped on read instead of crashing the reader;
 * - writes create the parent directory on demand;
 * - write failures throw so the controller can warn and continue (fail open).
 *
 * @module dsh-cognitive-feedback/storage/jsonl-sink
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** @implements {import('./sink.js').CognitiveEventSink} */
export class JsonlSink {
  /** @param {string} path */
  constructor(path) {
    if (!path) throw new Error('JsonlSink requires a path');
    this.path = path;
    this.directoryReady = false;
  }

  /** @param {import('../types.js').CognitiveEvent} event */
  async append(event) {
    if (!this.directoryReady) {
      mkdirSync(dirname(this.path), { recursive: true });
      this.directoryReady = true;
    }
    appendFileSync(this.path, `${JSON.stringify(event)}\n`, 'utf8');
  }

  /** @returns {Promise<import('../types.js').CognitiveEvent[]>} */
  async readAll() {
    let raw;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch (error) {
      if (/** @type {any} */ (error)?.code === 'ENOENT') return [];
      throw error;
    }
    /** @type {import('../types.js').CognitiveEvent[]} */
    const events = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed));
      } catch {
        // Malformed persistence must not crash the controller.
      }
    }
    return events;
  }
}
