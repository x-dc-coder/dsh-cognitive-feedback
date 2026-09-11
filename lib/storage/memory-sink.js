/**
 * In-memory sink for tests and for hosts without a writable home directory.
 *
 * @module dsh-cognitive-feedback/storage/memory-sink
 */

/** @implements {import('./sink.js').CognitiveEventSink} */
export class MemorySink {
  /** @param {import('../types.js').CognitiveEvent[]} [initial] */
  constructor(initial = []) {
    /** @type {import('../types.js').CognitiveEvent[]} */
    this.events = [...initial];
    /** @type {string[]} */
    this.failures = [];
    /** Set to a non-null message to force the next append to fail (tests). */
    this.failWith = null;
  }

  /** @param {import('../types.js').CognitiveEvent} event */
  async append(event) {
    if (this.failWith) {
      const message = this.failWith;
      this.failWith = null;
      throw new Error(message);
    }
    this.events.push(event);
  }

  /** @returns {Promise<import('../types.js').CognitiveEvent[]>} */
  async readAll() {
    return [...this.events];
  }
}
