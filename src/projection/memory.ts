/**
 * The prompt / memory boundary.
 *
 * The live system prompt must stay small, deterministic and cache-friendly, so
 * it may depend on exactly one thing: the **current** intervention directive,
 * derived from `CognitiveState`. Historical cognitive events must never be
 * dumped into it -- that inflates context pressure and can defeat prefix reuse.
 *
 * This module names both sides of that boundary so it cannot erode by accident:
 *
 * ```text
 * LIVE PROMPT                        LONG-TERM MEMORY
 * CognitiveState                     raw CognitiveEvent log
 *      │ renderCognitiveSection()          │ buildProjection()
 *      ▼                                   ▼
 * one bounded directive              CognitiveProjection
 * (never reads the log)              (read-only; reporting / future adapters)
 * ```
 *
 * `CognitiveMemorySource` is the seam a future memory implementation (Soul-Spark,
 * a database, a summarizer) fills. It is an interface, not a runtime dependency:
 * the plugin ships an inert source and nothing in `cognitive/` or `prompt/`
 * imports this module.
 *
 * @module dsh-cognitive-feedback/projection/memory
 */
import type { CognitiveEvent } from '../events/types.js';
import { buildProjection, type CognitiveProjection } from './index.js';

/**
 * A read-only, derived view of long-term cognitive history.
 *
 * Implementations must never mutate events and must never be consulted while the
 * cognitive section is being rendered.
 */
export interface CognitiveMemorySource {
  /** The current derived view, or `null` when memory is unavailable. */
  projection(): CognitiveProjection | null;
}

/** The memory source the plugin ships: no long-term memory at all. */
export const NO_MEMORY: CognitiveMemorySource = Object.freeze({
  projection: () => null,
});

/** A memory source over an event provider (tests, tools, a future adapter). */
export function createMemorySource(events: () => readonly CognitiveEvent[]): CognitiveMemorySource {
  return {
    projection: () => {
      try {
        return buildProjection(events());
      } catch {
        // A memory failure is never allowed to matter to the live prompt or to
        // a coding session: degrade to "no memory".
        return null;
      }
    },
  };
}
