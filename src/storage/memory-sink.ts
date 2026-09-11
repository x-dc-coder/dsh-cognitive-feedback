/**
 * In-memory sink for tests and for hosts without a writable home directory.
 *
 * @module dsh-cognitive-feedback/storage/memory-sink
 */
import type { CognitiveEvent } from '../events/types.js';
import type { CognitiveEventSink } from './sink.js';

export class MemorySink implements CognitiveEventSink {
  readonly events: CognitiveEvent[];
  readonly failures: string[] = [];
  /** Set to a non-null message to force the next append to fail (tests). */
  failWith: string | null = null;

  constructor(initial: readonly CognitiveEvent[] = []) {
    this.events = [...initial];
  }

  async append(event: CognitiveEvent): Promise<void> {
    if (this.failWith) {
      const message = this.failWith;
      this.failWith = null;
      this.failures.push(message);
      throw new Error(message);
    }
    this.events.push(event);
  }

  async readAll(): Promise<CognitiveEvent[]> {
    return [...this.events];
  }
}
