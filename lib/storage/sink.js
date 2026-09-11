/**
 * CognitiveEventSink — the only storage abstraction V0.1 needs.
 *
 * A future Soul-Spark adapter implements this interface without the controller
 * or policy layer knowing (ARCHITECTURE.md §4). Storage failures must never
 * break coding; sinks throw and the controller degrades.
 *
 * @module dsh-cognitive-feedback/storage/sink
 */

/**
 * @typedef {object} CognitiveEventSink
 * @property {(event: import('../types.js').CognitiveEvent) => Promise<void>} append
 * @property {() => Promise<import('../types.js').CognitiveEvent[]>} readAll
 */

export {};
