/**
 * Cognitive Episode reconstruction -- a pure, derived read of the event log.
 *
 * An **episode** is the primary reasoning unit: one trigger, the user's
 * hypothesis, the decision, the implementation outcome, and the teaching-back
 * check. It is not a stored object. It is rebuilt from the append-only log, so
 * the raw `CognitiveEvent` stream stays the only source of truth and a
 * projection can always be discarded and regenerated.
 *
 * ## What starts and ends an episode
 *
 * | Transition | Recorded as |
 * |---|---|
 * | start | the first event carrying a new `episodeId` (a trigger, a directly-authored hypothesis, or a teaching-back request) |
 * | implement | `teaching_back.requested` -- the directive is live only once high-value work completed |
 * | end: completed | `teaching_back.completed` + `episode.closed {completed}` |
 * | end: abandoned | `episode.closed {abandoned}` -- a topic change or a session end interrupted it |
 *
 * ## Determinism
 *
 * Reconstruction walks events in **append order** and never sorts by timestamp.
 * Two events in the same millisecond (which is common: a controller can write a
 * hypothesis and its decision together) still reconstruct unambiguously, and a
 * re-run over the same bytes always yields the same episodes.
 *
 * A missing `episode.closed` is tolerated rather than fatal: a new episode in
 * the same session, or the session's end, implicitly abandons the previous open
 * one. That keeps old logs (written before the terminator existed) readable.
 *
 * @module dsh-cognitive-feedback/projection/episodes
 */
import type { CognitiveEvent, CognitiveEventType } from '../events/types.js';
import type { TaskType } from '../cognitive/classify.js';
import type { InterventionLevel, TeachingBackResult } from '../cognitive/state.js';

/** Reconstructed lifecycle state. `open` is never persisted. */
export type EpisodeStatus = 'open' | 'completed' | 'abandoned';

/** One event that belongs to an episode, in log order. */
export interface EpisodeEventRef {
  readonly id: string;
  readonly type: CognitiveEventType;
  readonly timestamp: string;
  readonly interventionId: string | null;
}

/** The trigger that opened the episode. */
export interface EpisodeTrigger {
  readonly eventType: 'intervention.triggered' | 'hypothesis.submitted' | 'teaching_back.requested';
  readonly reason: string | null;
  readonly taskType: TaskType | null;
  readonly topic: string | null;
  readonly level: InterventionLevel | null;
  readonly interventionId: string | null;
  readonly timestamp: string;
}

/** One reconstructed reasoning episode. */
export interface CognitiveEpisode {
  readonly episodeId: string;
  readonly sessionId: string;
  readonly status: EpisodeStatus;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly closeReason: string | null;
  readonly trigger: EpisodeTrigger | null;
  readonly hypothesis: { readonly text: string; readonly taskType: TaskType | null; readonly timestamp: string } | null;
  readonly decision: { readonly owner: 'user'; readonly topic: string | null; readonly timestamp: string } | null;
  /** Every intervention issued inside this episode, in order of issuance. */
  readonly interventionIds: readonly string[];
  /** `teaching_back.requested`: the directive went live, i.e. work was delivered. */
  readonly implementationOutcome: { readonly topic: string | null; readonly timestamp: string } | null;
  readonly teachingBack: { readonly result: TeachingBackResult; readonly topic: string | null; readonly timestamp: string } | null;
  readonly knowledgeGaps: readonly { readonly topic: string | null; readonly result: TeachingBackResult; readonly timestamp: string }[];
  readonly events: readonly EpisodeEventRef[];
}

/** Aggregate view over reconstructed episodes. */
export interface EpisodeSummary {
  readonly total: number;
  readonly open: number;
  readonly completed: number;
  readonly abandoned: number;
  /** completed / (completed + abandoned); `null` while nothing has ended yet. */
  readonly completionRate: number | null;
}

interface MutableEpisode {
  episodeId: string;
  sessionId: string;
  status: EpisodeStatus;
  startedAt: string;
  endedAt: string | null;
  closeReason: string | null;
  trigger: EpisodeTrigger | null;
  hypothesis: CognitiveEpisode['hypothesis'];
  decision: CognitiveEpisode['decision'];
  interventionIds: string[];
  implementationOutcome: CognitiveEpisode['implementationOutcome'];
  teachingBack: CognitiveEpisode['teachingBack'];
  knowledgeGaps: { topic: string | null; result: TeachingBackResult; timestamp: string }[];
  events: EpisodeEventRef[];
}

/** Whether an event type participates in episode reconstruction. */
function isEpisodeEvent(event: CognitiveEvent): boolean {
  return typeof event.episodeId === 'string' && event.episodeId !== '';
}

/** Rebuild every cognitive episode from the raw event stream, in log order. */
export function reconstructEpisodes(events: readonly CognitiveEvent[]): CognitiveEpisode[] {
  const episodes = new Map<string, MutableEpisode>();
  const openBySession = new Map<string, string>();

  const abandon = (episodeId: string, reason: string, at: string): void => {
    const episode = episodes.get(episodeId);
    if (!episode || episode.status !== 'open') return;
    episode.status = 'abandoned';
    episode.endedAt = at;
    episode.closeReason = reason;
  };

  for (const event of events) {
    const sessionId = event.sessionId;
    if (event.type === 'session.ended') {
      const open = openBySession.get(sessionId);
      if (open) {
        abandon(open, 'session-ended', event.timestamp);
        openBySession.delete(sessionId);
      }
      continue;
    }
    if (!isEpisodeEvent(event)) continue;

    const episodeId = String(event.episodeId);
    let episode = episodes.get(episodeId);
    if (!episode) {
      // A different episode in the same session silently supersedes the open
      // one. The writer normally records `episode.closed`; tolerating its
      // absence keeps logs written before the terminator existed readable.
      const previous = openBySession.get(sessionId);
      if (previous && previous !== episodeId) abandon(previous, 'superseded', event.timestamp);
      episode = {
        episodeId,
        sessionId,
        status: 'open',
        startedAt: event.timestamp,
        endedAt: null,
        closeReason: null,
        trigger: null,
        hypothesis: null,
        decision: null,
        interventionIds: [],
        implementationOutcome: null,
        teachingBack: null,
        knowledgeGaps: [],
        events: [],
      };
      episodes.set(episodeId, episode);
      openBySession.set(sessionId, episodeId);
    }

    episode.events.push({
      id: event.id,
      type: event.type,
      timestamp: event.timestamp,
      interventionId: event.interventionId ?? null,
    });
    if (event.interventionId && !episode.interventionIds.includes(event.interventionId)) {
      episode.interventionIds.push(event.interventionId);
    }

    switch (event.type) {
      case 'intervention.triggered':
        episode.trigger ??= {
          eventType: 'intervention.triggered',
          reason: event.payload.reason,
          taskType: event.payload.taskType,
          topic: event.payload.topic,
          level: event.payload.level,
          interventionId: event.interventionId ?? null,
          timestamp: event.timestamp,
        };
        break;
      case 'hypothesis.submitted':
        episode.hypothesis = {
          text: event.payload.text,
          taskType: event.payload.taskType,
          timestamp: event.timestamp,
        };
        episode.trigger ??= {
          eventType: 'hypothesis.submitted',
          reason: null,
          taskType: event.payload.taskType,
          topic: null,
          level: null,
          interventionId: event.interventionId ?? null,
          timestamp: event.timestamp,
        };
        break;
      case 'decision.recorded':
        episode.decision = { owner: event.payload.owner, topic: event.payload.topic, timestamp: event.timestamp };
        break;
      case 'teaching_back.requested':
        episode.implementationOutcome = { topic: event.payload.topic, timestamp: event.timestamp };
        episode.trigger ??= {
          eventType: 'teaching_back.requested',
          reason: event.payload.reason,
          taskType: event.payload.taskType,
          topic: event.payload.topic,
          level: event.payload.level,
          interventionId: event.interventionId ?? null,
          timestamp: event.timestamp,
        };
        break;
      case 'teaching_back.completed':
        episode.teachingBack = {
          result: event.payload.result,
          topic: event.payload.topic,
          timestamp: event.timestamp,
        };
        break;
      case 'knowledge_gap.detected':
        episode.knowledgeGaps.push({
          topic: event.payload.topic,
          result: event.payload.result,
          timestamp: event.timestamp,
        });
        break;
      case 'episode.closed':
        episode.status = event.payload.outcome;
        episode.endedAt = event.timestamp;
        episode.closeReason = event.payload.reason;
        if (openBySession.get(sessionId) === episodeId) openBySession.delete(sessionId);
        break;
      default:
        break;
    }
  }

  return [...episodes.values()];
}

/** Index reconstructed episodes by id, for O(1) joins from an event. */
export function episodeIndex(events: readonly CognitiveEvent[]): Map<string, CognitiveEpisode> {
  return new Map(reconstructEpisodes(events).map((episode) => [episode.episodeId, episode]));
}

/** The episode one event belongs to, if its `episodeId` was reconstructed. */
export function episodeOfEvent(
  index: ReadonlyMap<string, CognitiveEpisode>,
  event: CognitiveEvent,
): CognitiveEpisode | null {
  return event.episodeId ? index.get(event.episodeId) ?? null : null;
}

/** Aggregate counts over reconstructed episodes. */
export function summarizeEpisodes(episodes: readonly CognitiveEpisode[]): EpisodeSummary {
  let open = 0;
  let completed = 0;
  let abandoned = 0;
  for (const episode of episodes) {
    if (episode.status === 'open') open += 1;
    else if (episode.status === 'completed') completed += 1;
    else abandoned += 1;
  }
  const ended = completed + abandoned;
  return {
    total: episodes.length,
    open,
    completed,
    abandoned,
    completionRate: ended > 0 ? Number((completed / ended).toFixed(3)) : null,
  };
}
