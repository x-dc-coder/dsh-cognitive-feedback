/**
 * Session and intervention aggregation -- derived, rebuildable, single pass.
 *
 * Both are built from the raw event stream and hold **references only**: no
 * event is mutated, and nothing here is consulted by the live prompt. A reader
 * that needs one session or one intervention asks the projection instead of
 * re-scanning the file per query.
 *
 * @module dsh-cognitive-feedback/projection/aggregations
 */
import type { CognitiveEvent } from '../events/types.js';
import type { InterventionLevel, TeachingBackResult } from '../cognitive/state.js';
import { reconstructEpisodes } from './episodes.js';

/** One session, aggregated from its events. */
export interface SessionAggregate {
  readonly sessionId: string;
  readonly project: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly lastEventAt: string | null;
  readonly eventCount: number;
  readonly interventions: number;
  readonly hypotheses: number;
  readonly decisions: number;
  readonly teachingBackRequested: number;
  readonly teachingBackCompleted: number;
  readonly knowledgeGaps: number;
  readonly episodes: number;
}

/** What a reconstructed intervention did. */
export type InterventionStatus = 'resolved' | 'abandoned' | 'open';

/** What kind of intervention an id names. */
export type InterventionKind = 'gate' | 'challenge' | 'teaching_back';

/** One intervention lifecycle, reconstructed by joining on `interventionId`. */
export interface InterventionAggregate {
  readonly interventionId: string;
  readonly sessionId: string;
  readonly episodeId: string | null;
  readonly kind: InterventionKind;
  readonly level: InterventionLevel | null;
  readonly reason: string | null;
  readonly topic: string | null;
  readonly issuedAt: string;
  readonly issuedEventId: string;
  readonly resolvedAt: string | null;
  readonly resolvedBy: 'hypothesis' | 'teaching_back' | null;
  readonly status: InterventionStatus;
  readonly outcome: TeachingBackResult | null;
}

/** Aggregate every session present in the log, in first-seen order. */
export function aggregateSessions(events: readonly CognitiveEvent[]): SessionAggregate[] {
  const episodesPerSession = new Map<string, number>();
  for (const episode of reconstructEpisodes(events)) {
    episodesPerSession.set(episode.sessionId, (episodesPerSession.get(episode.sessionId) ?? 0) + 1);
  }

  const sessions = new Map<string, {
    project: string | null;
    startedAt: string | null;
    endedAt: string | null;
    lastEventAt: string | null;
    eventCount: number;
    interventions: number;
    hypotheses: number;
    decisions: number;
    teachingBackRequested: number;
    teachingBackCompleted: number;
    knowledgeGaps: number;
  }>();

  for (const event of events) {
    let session = sessions.get(event.sessionId);
    if (!session) {
      session = {
        project: event.project ?? null,
        startedAt: null,
        endedAt: null,
        lastEventAt: null,
        eventCount: 0,
        interventions: 0,
        hypotheses: 0,
        decisions: 0,
        teachingBackRequested: 0,
        teachingBackCompleted: 0,
        knowledgeGaps: 0,
      };
      sessions.set(event.sessionId, session);
    }
    session.eventCount += 1;
    session.lastEventAt = event.timestamp;
    if (event.project && !session.project) session.project = event.project;
    switch (event.type) {
      case 'session.started':
        session.startedAt ??= event.timestamp;
        break;
      case 'session.ended':
        session.endedAt = event.timestamp;
        break;
      case 'intervention.triggered':
        session.interventions += 1;
        break;
      case 'hypothesis.submitted':
        session.hypotheses += 1;
        break;
      case 'decision.recorded':
        session.decisions += 1;
        break;
      case 'teaching_back.requested':
        session.teachingBackRequested += 1;
        break;
      case 'teaching_back.completed':
        session.teachingBackCompleted += 1;
        break;
      case 'knowledge_gap.detected':
        session.knowledgeGaps += 1;
        break;
      default:
        break;
    }
  }

  return [...sessions.entries()].map(([sessionId, session]) => ({
    sessionId,
    ...session,
    episodes: episodesPerSession.get(sessionId) ?? 0,
  }));
}

/** Reconstruct one intervention lifecycle from the events that carry its id. */
export function aggregateInterventions(events: readonly CognitiveEvent[]): InterventionAggregate[] {
  const episodeStatus = new Map(reconstructEpisodes(events).map((episode) => [episode.episodeId, episode.status]));
  const interventions = new Map<string, InterventionAggregate>();
  const order: string[] = [];

  for (const event of events) {
    const id = event.interventionId;
    if (!id) continue;
    let record = interventions.get(id);
    if (!record) {
      // A teaching-back check is issued by its own event; a gate/challenge by
      // intervention.triggered. Anything else carrying the id is a resolution.
      const isIssued = event.type === 'intervention.triggered' || event.type === 'teaching_back.requested';
      if (!isIssued) continue;
      const level = event.type === 'intervention.triggered' ? event.payload.level : event.payload.level;
      record = {
        interventionId: id,
        sessionId: event.sessionId,
        episodeId: event.episodeId ?? null,
        kind: event.type === 'teaching_back.requested' ? 'teaching_back' : level >= 3 ? 'gate' : 'challenge',
        level,
        reason: event.payload.reason,
        topic: event.payload.topic,
        issuedAt: event.timestamp,
        issuedEventId: event.id,
        resolvedAt: null,
        resolvedBy: null,
        status: 'open',
        outcome: null,
      };
      interventions.set(id, record);
      order.push(id);
    } else if (!record.resolvedAt) {
      if (event.type === 'hypothesis.submitted' || event.type === 'decision.recorded') {
        record = { ...record, resolvedAt: event.timestamp, resolvedBy: 'hypothesis', status: 'resolved' };
        interventions.set(id, record);
      } else if (event.type === 'teaching_back.completed') {
        record = {
          ...record,
          resolvedAt: event.timestamp,
          resolvedBy: 'teaching_back',
          status: 'resolved',
          outcome: event.payload.result,
        };
        interventions.set(id, record);
      }
    }
  }

  return order.map((id) => {
    const record = interventions.get(id);
    if (!record || record.status !== 'open') return record;
    const status = record.episodeId && episodeStatus.get(record.episodeId) === 'open' ? 'open' : 'abandoned';
    return { ...record, status };
  }).filter((record): record is InterventionAggregate => record !== undefined);
}
