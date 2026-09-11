/**
 * CognitiveEventSink -- the only storage abstraction V0.1 needs.
 *
 * A future Soul-Spark adapter implements this interface without the controller
 * or policy layer knowing. Storage failures must never break coding; sinks
 * throw and the controller degrades.
 *
 * @module dsh-cognitive-feedback/storage/sink
 */
import type { CognitiveEvent } from '../events/types.js';

/** Append-only event storage. */
export interface CognitiveEventSink {
  append(event: CognitiveEvent): Promise<void>;
  readAll(): Promise<CognitiveEvent[]>;
}
