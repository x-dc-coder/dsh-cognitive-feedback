/**
 * Append-only JSONL sink. Default V0.1 store.
 *
 * - one JSON object per line, never rewritten;
 * - a malformed line is skipped on read instead of crashing the reader;
 * - a line that parses but is not a well-formed v1 event is skipped too;
 * - writes create the parent directory on demand;
 * - write failures throw so the controller can warn and continue (fail open).
 *
 * @module dsh-cognitive-feedback/storage/jsonl-sink
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseCognitiveEvent } from '../events/queries.js';
import type { CognitiveEvent } from '../events/types.js';
import type { CognitiveEventSink } from './sink.js';

export class JsonlSink implements CognitiveEventSink {
  readonly path: string;
  private directoryReady = false;

  constructor(path: string) {
    if (!path) throw new Error('JsonlSink requires a path');
    this.path = path;
  }

  async append(event: CognitiveEvent): Promise<void> {
    if (!this.directoryReady) {
      mkdirSync(dirname(this.path), { recursive: true });
      this.directoryReady = true;
    }
    appendFileSync(this.path, `${JSON.stringify(event)}\n`, 'utf8');
  }

  async readAll(): Promise<CognitiveEvent[]> {
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return [];
      throw error;
    }
    const events: CognitiveEvent[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue; // Malformed persistence must not crash the controller.
      }
      const event = parseCognitiveEvent(parsed);
      if (event) events.push(event);
    }
    return events;
  }
}
