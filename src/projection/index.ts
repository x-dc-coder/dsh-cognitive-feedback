/**
 * The cognitive projection: one pass over the raw log, many indexed reads.
 *
 * `buildProjection()` is pure and rebuildable; `createProjectionCache()` wraps it
 * with staleness detection. Nothing here is on the ingest path, and nothing here
 * feeds the live system prompt (see `memory.ts` for that boundary).
 *
 * @module dsh-cognitive-feedback/projection
 */
import type { CognitiveEvent } from '../events/types.js';
import { reconstructEpisodes, summarizeEpisodes, type CognitiveEpisode, type EpisodeSummary } from './episodes.js';
import { aggregateSessions, aggregateInterventions, type InterventionAggregate, type SessionAggregate } from './aggregations.js';
import { RebuildableProjection, projectionDigest } from './cache.js';

/** The complete derived view of one event stream. */
export interface CognitiveProjection {
  /** Number of raw events the projection was built from. */
  readonly eventCount: number;
  /** Fingerprint of the raw events; changes whenever the log changes. */
  readonly digest: string;
  readonly episodes: readonly CognitiveEpisode[];
  readonly episodeSummary: EpisodeSummary;
  readonly sessions: readonly SessionAggregate[];
  readonly interventions: readonly InterventionAggregate[];
}

/** The projection of an empty (or unreadable) log. */
export const EMPTY_PROJECTION: CognitiveProjection = Object.freeze({
  eventCount: 0,
  digest: 'v1:0',
  episodes: Object.freeze([]),
  episodeSummary: Object.freeze({ total: 0, open: 0, completed: 0, abandoned: 0, completionRate: null }),
  sessions: Object.freeze([]),
  interventions: Object.freeze([]),
});

/** Build the full projection in a single pass over the events. */
export function buildProjection(events: readonly CognitiveEvent[]): CognitiveProjection {
  const episodes = reconstructEpisodes(events);
  return {
    eventCount: events.length,
    digest: projectionDigest(events),
    episodes,
    episodeSummary: summarizeEpisodes(episodes),
    sessions: aggregateSessions(events),
    interventions: aggregateInterventions(events),
  };
}

/** A projection cache bound to `buildProjection`. */
export function createProjectionCache(): RebuildableProjection<CognitiveProjection> {
  return new RebuildableProjection<CognitiveProjection>(buildProjection, EMPTY_PROJECTION);
}

export { RebuildableProjection, projectionDigest } from './cache.js';
export type { ProjectionCacheStats } from './cache.js';
export {
  reconstructEpisodes,
  episodeIndex,
  episodeOfEvent,
  summarizeEpisodes,
  type CognitiveEpisode,
  type EpisodeEventRef,
  type EpisodeStatus,
  type EpisodeSummary,
  type EpisodeTrigger,
} from './episodes.js';
export {
  aggregateSessions,
  aggregateInterventions,
  type InterventionAggregate,
  type InterventionKind,
  type InterventionStatus,
  type SessionAggregate,
} from './aggregations.js';
export {
  topicLearningStates,
  countRecurringTopics,
  openRecurringTopics,
  type LearningOptions,
  type TopicLearningState,
  type TopicRecurrence,
} from './learning.js';
export {
  NO_MEMORY,
  createMemorySource,
  type CognitiveMemorySource,
} from './memory.js';
export {
  cachePathFor,
  loadProjectionCache,
  saveProjectionCache,
  PROJECTION_CACHE_VERSION,
  type ProjectionCacheFile,
} from './disk-cache.js';
