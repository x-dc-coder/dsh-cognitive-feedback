/**
 * Longitudinal metrics over persisted cognitive events.
 *
 * The plugin's value is cumulative, so one interaction proves nothing. These
 * metrics are computed **only** from events on disk -- never from hidden runtime
 * state -- and are grouped the way an experiment should be read:
 *
 * | Group | Question it answers |
 * |---|---|
 * | `exposure` | how often did the plugin interrupt? |
 * | `response` | did the user answer the intervention? |
 * | `outcome` | where did reasoning episodes end up? |
 * | `utilization` | how many sessions were touched at all? |
 *
 * An exposure that never produces a response is noise; a response rate without
 * an outcome says nothing about reasoning. Read them together.
 *
 * **They are descriptive, not causal.** A falling intervention rate after some
 * change is not evidence that reasoning improved: sample sizes are tiny, the
 * baseline is not controlled, and many unrelated things move at once. The
 * `caveat` field travels with a period comparison for exactly that reason.
 *
 * @module dsh-cognitive-feedback/projection/metrics
 */
import type { CognitiveEvent } from '../events/types.js';
import { reconstructEpisodes, summarizeEpisodes, type EpisodeSummary } from './episodes.js';
import { aggregateSessions, aggregateInterventions, type InterventionAggregate } from './aggregations.js';
import { topicLearningStates, countRecurringTopics, openRecurringTopics } from './learning.js';

/** The time span a metric set was computed over. */
export interface MetricsWindow {
  readonly from: string | null;
  readonly to: string | null;
  readonly events: number;
  readonly sessions: number;
}

/** How often the plugin intervened. */
export interface ExposureMetrics {
  /** Issued interventions counted from raw events: triggers + teaching-back requests. */
  readonly interventionsIssued: number;
  readonly gates: number;
  readonly challenges: number;
  readonly teachingBackRequests: number;
  readonly episodesOpened: number;
  readonly sessionsObserved: number;
  readonly interventionsPerSession: number;
  readonly byReason: Readonly<Record<string, number>>;
  /**
   * Issued interventions with no `interventionId`: a log written before
   * correlation existed. They are counted as exposure but cannot be joined to a
   * response, so they are excluded from the response denominators and named here
   * rather than silently dropped.
   */
  readonly uncorrelatedIssues: number;
}

/** Whether the user engaged with the interventions. */
export interface ResponseMetrics {
  readonly hypothesesSubmitted: number;
  readonly decisionsRecorded: number;
  readonly gatesAnswered: number;
  /** Gates that carry an `interventionId` and can therefore be joined to an answer. */
  readonly correlatedGates: number;
  readonly gateAnsweredRate: number | null;
  /** Every teaching-back issue, correlated or not. */
  readonly teachingBackRequested: number;
  readonly correlatedTeachingBacks: number;
  readonly teachingBackCompleted: number;
  readonly teachingBackResponseRate: number | null;
}

/** Where reasoning episodes ended up. */
export interface OutcomeMetrics {
  readonly episodesCompleted: number;
  readonly episodesAbandoned: number;
  readonly episodesOpen: number;
  readonly episodeCompletionRate: number | null;
  readonly knowledgeGapsDetected: number;
  readonly knowledgeGapsByOrigin: Readonly<Record<string, number>>;
  readonly recurringGapTopics: number;
  readonly openRecurringGapTopics: number;
  /** Median time from issuing an intervention to the answer that resolved it. */
  readonly medianDecisionLatencyMs: number | null;
}

/** Coverage, so a rate is never read without its denominator. */
export interface UtilizationMetrics {
  readonly interventionFreeSessions: number;
  readonly sessionsWithIntervention: number;
  readonly episodesPerSession: number;
}

/** One metric set. */
export interface CognitiveMetrics {
  readonly window: MetricsWindow;
  readonly exposure: ExposureMetrics;
  readonly response: ResponseMetrics;
  readonly outcome: OutcomeMetrics;
  readonly utilization: UtilizationMetrics;
}

/** Options for metric computation. */
export interface MetricsOptions {
  /** Reference time in epoch milliseconds; defaults to now. */
  readonly now?: number;
  /** Recency window passed to the topic projection. */
  readonly windowMs?: number;
}

/** Median of a numeric list; `null` for an empty list. */
function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? null;
  const lower = sorted[middle - 1];
  const upper = sorted[middle];
  if (lower === undefined || upper === undefined) return null;
  return Math.round((lower + upper) / 2);
}

/** A ratio rounded to three decimals, or `null` when the denominator is zero. */
export function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? Number((numerator / denominator).toFixed(3)) : null;
}

/** Count events by type in one pass. */
function countByType(events: readonly CognitiveEvent[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const event of events) counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
  return counts;
}

/** Compute the metric set for one event stream. */
export function computeMetrics(events: readonly CognitiveEvent[], options: MetricsOptions = {}): CognitiveMetrics {
  const now = options.now ?? Date.now();
  const counts = countByType(events);
  const episodes = reconstructEpisodes(events);
  const episodeSummary: EpisodeSummary = summarizeEpisodes(episodes);
  const sessions = aggregateSessions(events);
  const interventions: InterventionAggregate[] = aggregateInterventions(events);
  const topics = topicLearningStates(events, { now, ...(options.windowMs !== undefined ? { windowMs: options.windowMs } : {}) });

  const gates = interventions.filter((intervention) => intervention.kind === 'gate');
  const challenges = interventions.filter((intervention) => intervention.kind === 'challenge');
  const teachingBacks = interventions.filter((intervention) => intervention.kind === 'teaching_back');
  const answeredGates = gates.filter((intervention) => intervention.resolvedBy === 'hypothesis');
  const completedTeachingBacks = teachingBacks.filter((intervention) => intervention.resolvedBy === 'teaching_back');

  const triggerEvents = events.filter((event) => event.type === 'intervention.triggered');
  const rawGates = triggerEvents.filter((event) => (event.type === 'intervention.triggered' ? event.payload.level >= 3 : false)).length;
  const rawChallenges = triggerEvents.length - rawGates;
  const rawTeachingBacks = counts.get('teaching_back.requested') ?? 0;

  // Raw as well, for the same reason as exposure: the issued event carries the
  // reason, whether or not the log predates correlation.
  const byReason: Record<string, number> = {};
  for (const event of events) {
    if (event.type !== 'intervention.triggered' && event.type !== 'teaching_back.requested') continue;
    const reason = event.payload.reason ?? 'unknown';
    byReason[reason] = (byReason[reason] ?? 0) + 1;
  }

  const knowledgeGapsByOrigin: Record<string, number> = {};
  for (const event of events) {
    if (event.type !== 'knowledge_gap.detected') continue;
    const origin = event.payload.origin ?? 'unknown';
    knowledgeGapsByOrigin[origin] = (knowledgeGapsByOrigin[origin] ?? 0) + 1;
  }

  const latencies: number[] = [];
  for (const intervention of interventions) {
    if (!intervention.resolvedAt) continue;
    const issued = Date.parse(intervention.issuedAt);
    const resolved = Date.parse(intervention.resolvedAt);
    if (Number.isFinite(issued) && Number.isFinite(resolved) && resolved >= issued) latencies.push(resolved - issued);
  }

  const sessionsObserved = sessions.length;
  const withIntervention = sessions.filter((session) => session.interventions > 0).length;
  const sortedEvents = events.length
    ? { from: events[0]?.timestamp ?? null, to: events[events.length - 1]?.timestamp ?? null }
    : { from: null, to: null };

  return {
    window: { ...sortedEvents, events: events.length, sessions: sessionsObserved },
    exposure: {
      // Exposure is counted from raw events so a pre-correlation log still
      // reports how often the plugin intervened.
      interventionsIssued: rawGates + rawChallenges + rawTeachingBacks,
      gates: rawGates,
      challenges: rawChallenges,
      teachingBackRequests: rawTeachingBacks,
      episodesOpened: episodeSummary.total,
      sessionsObserved,
      interventionsPerSession:
        sessionsObserved > 0 ? Number(((rawGates + rawChallenges + rawTeachingBacks) / sessionsObserved).toFixed(3)) : 0,
      byReason,
      uncorrelatedIssues: rawGates + rawChallenges + rawTeachingBacks - interventions.length,
    },
    response: {
      hypothesesSubmitted: counts.get('hypothesis.submitted') ?? 0,
      decisionsRecorded: counts.get('decision.recorded') ?? 0,
      gatesAnswered: answeredGates.length,
      correlatedGates: gates.length,
      gateAnsweredRate: rate(answeredGates.length, gates.length),
      teachingBackRequested: rawTeachingBacks,
      correlatedTeachingBacks: teachingBacks.length,
      teachingBackCompleted: completedTeachingBacks.length,
      teachingBackResponseRate: rate(completedTeachingBacks.length, teachingBacks.length),
    },
    outcome: {
      episodesCompleted: episodeSummary.completed,
      episodesAbandoned: episodeSummary.abandoned,
      episodesOpen: episodeSummary.open,
      episodeCompletionRate: episodeSummary.completionRate,
      knowledgeGapsDetected: counts.get('knowledge_gap.detected') ?? 0,
      knowledgeGapsByOrigin,
      recurringGapTopics: countRecurringTopics(topics),
      openRecurringGapTopics: openRecurringTopics(topics).length,
      medianDecisionLatencyMs: median(latencies),
    },
    utilization: {
      interventionFreeSessions: sessionsObserved - withIntervention,
      sessionsWithIntervention: withIntervention,
      episodesPerSession: sessionsObserved > 0 ? Number((episodeSummary.total / sessionsObserved).toFixed(3)) : 0,
    },
  };
}

/** A baseline/feedback comparison, with the caution that belongs with it. */
export interface MetricsComparison {
  readonly splitAt: string;
  readonly baseline: CognitiveMetrics;
  readonly feedback: CognitiveMetrics;
  readonly delta: {
    readonly interventionsPerSession: number | null;
    readonly gateAnsweredRate: number | null;
    readonly teachingBackResponseRate: number | null;
    readonly episodeCompletionRate: number | null;
    readonly knowledgeGapsPerSession: number | null;
  };
  /** Always shown with a comparison; correlation is not causation. */
  readonly caveat: string;
}

const COMPARISON_CAVEAT =
  'Descriptive only: a change between periods is not evidence that the plugin caused it. ' +
  'Sample sizes are small, the baseline is not controlled, and other work moves at the same time. ' +
  'Report the numbers next to the raw log, never instead of it.';

/** Numeric delta, or `null` when either side has no denominator. */
function delta(after: number | null, before: number | null): number | null {
  return after === null || before === null ? null : Number((after - before).toFixed(3));
}

/** Compare the events before and after a split point. */
export function comparePeriods(
  events: readonly CognitiveEvent[],
  splitAt: string,
  options: MetricsOptions = {},
): MetricsComparison {
  const split = Date.parse(splitAt);
  if (!Number.isFinite(split)) throw new Error('comparePeriods requires an ISO timestamp');
  const baselineEvents = events.filter((event) => Date.parse(event.timestamp) < split);
  const feedbackEvents = events.filter((event) => Date.parse(event.timestamp) >= split);
  const baseline = computeMetrics(baselineEvents, options);
  const feedback = computeMetrics(feedbackEvents, options);
  const gapsPerSession = (metrics: CognitiveMetrics): number | null =>
    metrics.window.sessions > 0
      ? Number((metrics.outcome.knowledgeGapsDetected / metrics.window.sessions).toFixed(3))
      : null;
  return {
    splitAt,
    baseline,
    feedback,
    delta: {
      interventionsPerSession: delta(feedback.exposure.interventionsPerSession, baseline.exposure.interventionsPerSession),
      gateAnsweredRate: delta(feedback.response.gateAnsweredRate, baseline.response.gateAnsweredRate),
      teachingBackResponseRate: delta(feedback.response.teachingBackResponseRate, baseline.response.teachingBackResponseRate),
      episodeCompletionRate: delta(feedback.outcome.episodeCompletionRate, baseline.outcome.episodeCompletionRate),
      knowledgeGapsPerSession: delta(gapsPerSession(feedback), gapsPerSession(baseline)),
    },
    caveat: COMPARISON_CAVEAT,
  };
}
