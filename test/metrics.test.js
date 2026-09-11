import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEvent } from '../dist/events/factory.js';
import { JsonlSink } from '../dist/storage/jsonl-sink.js';
import { computeMetrics, comparePeriods, rate } from '../dist/projection/metrics.js';

const at = (seconds) => new Date(Date.UTC(2026, 8, 10, 12, 0, seconds)).toISOString();

/** Build a correlated event. */
const ev = (type, payload, options) =>
  makeEvent(type, payload, {
    sessionId: options.sessionId,
    timestamp: options.timestamp,
    ...(options.id ? { id: options.id } : {}),
    ...(options.episodeId ? { episodeId: options.episodeId } : {}),
    ...(options.interventionId ? { interventionId: options.interventionId } : {}),
  });

const strongEvidence = {
  assessment: 'evidence_extracted',
  result: 'unassessed',
  answered: true,
  wordCount: 40,
  lengthBand: 'adequate',
  causalExplanation: true,
  mechanismExplanation: true,
  keyConceptReferenced: true,
  uncertaintyAcknowledged: false,
  confidence: null,
  signals: ['causal', 'mechanism'],
};

/** One completed episode and one abandoned episode, plus a quiet session. */
function makeLog() {
  return [
    // s1: gate -> hypothesis -> teaching back -> completed
    ev('intervention.triggered', { level: 3, reason: 'architecture', taskType: 'architecture', topic: 'storage' }, { sessionId: 's1', episodeId: 'ep_a', interventionId: 'iv_1', timestamp: at(0) }),
    ev('hypothesis.submitted', { text: 'because X', authorship: 'user', taskType: 'architecture' }, { sessionId: 's1', episodeId: 'ep_a', interventionId: 'iv_1', timestamp: at(5) }),
    ev('decision.recorded', { owner: 'user', topic: 'storage' }, { sessionId: 's1', episodeId: 'ep_a', interventionId: 'iv_1', timestamp: at(5) }),
    ev('teaching_back.requested', { level: 1, reason: 'storage', taskType: 'architecture', topic: 'storage' }, { sessionId: 's1', episodeId: 'ep_a', interventionId: 'iv_2', timestamp: at(6) }),
    ev('teaching_back.completed', { result: 'unassessed', topic: 'storage', evidence: strongEvidence }, { sessionId: 's1', episodeId: 'ep_a', interventionId: 'iv_2', timestamp: at(10) }),
    ev('episode.closed', { outcome: 'completed', reason: 'teaching-back-completed' }, { sessionId: 's1', episodeId: 'ep_a', interventionId: 'iv_2', timestamp: at(10) }),
    // s2: challenge abandoned
    ev('intervention.triggered', { level: 2, reason: 'debugging', taskType: 'debugging', topic: 'worker' }, { sessionId: 's2', episodeId: 'ep_b', interventionId: 'iv_3', timestamp: at(20) }),
    ev('episode.closed', { outcome: 'abandoned', reason: 'topic-changed' }, { sessionId: 's2', episodeId: 'ep_b', interventionId: 'iv_3', timestamp: at(30) }),
    // s3: no intervention, two gaps on one topic
    ev('session.started', { project: null }, { sessionId: 's3', timestamp: at(40), id: 'evt_s3_start' }),
    ev('knowledge_gap.detected', { topic: 'cache-staleness', result: 'skipped', origin: 'skipped_answer' }, { sessionId: 's3', timestamp: at(41) }),
    ev('knowledge_gap.detected', { topic: 'staleness-cache', result: 'unassessed', origin: 'explicit_uncertainty' }, { sessionId: 's3', timestamp: at(42) }),
  ];
}

test('metrics are grouped as exposure, response, outcome and utilization', () => {
  const m = computeMetrics(makeLog(), { now: Date.parse(at(60)) });

  assert.deepEqual(m.window, { from: at(0), to: at(42), events: 11, sessions: 3 });

  assert.equal(m.exposure.interventionsIssued, 3);
  assert.equal(m.exposure.gates, 1);
  assert.equal(m.exposure.challenges, 1);
  assert.equal(m.exposure.teachingBackRequests, 1);
  assert.equal(m.exposure.episodesOpened, 2);
  assert.equal(m.exposure.interventionsPerSession, 1);
  assert.deepEqual(m.exposure.byReason, { architecture: 1, debugging: 1, storage: 1 });

  assert.equal(m.response.hypothesesSubmitted, 1);
  assert.equal(m.response.decisionsRecorded, 1);
  assert.equal(m.response.gateAnsweredRate, 1);
  assert.equal(m.response.teachingBackResponseRate, 1);

  assert.equal(m.outcome.episodesCompleted, 1);
  assert.equal(m.outcome.episodesAbandoned, 1);
  assert.equal(m.outcome.episodesOpen, 0);
  assert.equal(m.outcome.episodeCompletionRate, 0.5);
  assert.equal(m.outcome.knowledgeGapsDetected, 2);
  assert.deepEqual(m.outcome.knowledgeGapsByOrigin, { skipped_answer: 1, explicit_uncertainty: 1 });
  assert.equal(m.outcome.recurringGapTopics, 1, 'two spellings of one topic');
  assert.equal(m.outcome.openRecurringGapTopics, 1);
  // iv_1 resolved after 5s, iv_2 after 4s; iv_3 was abandoned and has no latency.
  assert.equal(m.outcome.medianDecisionLatencyMs, 4500);

  assert.equal(m.utilization.sessionsWithIntervention, 2);
  assert.equal(m.utilization.interventionFreeSessions, 1);
  assert.equal(m.utilization.episodesPerSession, 0.667);
});

test('a missing denominator is null, never zero-inflated', () => {
  const m = computeMetrics([ev('session.started', { project: null }, { sessionId: 's1', timestamp: at(0), id: 'e1' })]);
  assert.equal(m.exposure.interventionsIssued, 0);
  assert.equal(m.response.gateAnsweredRate, null);
  assert.equal(m.response.teachingBackResponseRate, null);
  assert.equal(m.outcome.episodeCompletionRate, null);
  assert.equal(m.outcome.medianDecisionLatencyMs, null);
  assert.equal(rate(0, 0), null);
  assert.equal(rate(1, 4), 0.25);
});

test('metrics come from persisted events, not from runtime state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cog-metrics-'));
  const path = join(dir, 'events.jsonl');
  const writer = new JsonlSink(path);
  for (const event of makeLog()) await writer.append(event);

  const events = await new JsonlSink(path).readAll();
  assert.equal(events.length, 11);
  assert.deepEqual(computeMetrics(events, { now: Date.parse(at(60)) }), computeMetrics(makeLog(), { now: Date.parse(at(60)) }));
});

test('a baseline period can be compared with a feedback period, with its caveat', () => {
  const comparison = comparePeriods(makeLog(), at(15), { now: Date.parse(at(60)) });
  assert.equal(comparison.baseline.window.events, 6, 'everything before the split');
  assert.equal(comparison.feedback.window.events, 5);
  assert.equal(comparison.baseline.response.gateAnsweredRate, 1);
  assert.equal(comparison.feedback.exposure.interventionsIssued, 1);
  // baseline: 2 interventions over 1 session; feedback: 1 over 2 sessions.
  assert.equal(comparison.delta.interventionsPerSession, -1.5);
  assert.match(comparison.caveat, /not evidence that the plugin caused it/);
});

test('an empty log produces a well-formed, all-null metric set', () => {
  const m = computeMetrics([], { now: Date.parse(at(0)) });
  assert.deepEqual(m.window, { from: null, to: null, events: 0, sessions: 0 });
  assert.equal(m.exposure.interventionsPerSession, 0);
  assert.equal(m.utilization.episodesPerSession, 0);
  assert.equal(m.response.gateAnsweredRate, null);
});

test('a pre-correlation log still reports exposure, and names what cannot be joined', () => {
  const legacy = [
    makeEvent('intervention.triggered', { level: 3, reason: 'architecture', taskType: 'architecture', topic: null }, { sessionId: 's1', timestamp: at(0) }),
    makeEvent('hypothesis.submitted', { text: 'the seam leaks', authorship: 'user', taskType: 'architecture' }, { sessionId: 's1', timestamp: at(5) }),
  ];
  const m = computeMetrics(legacy, { now: Date.parse(at(60)) });
  assert.equal(m.exposure.interventionsIssued, 1, 'exposure is counted from raw events');
  assert.equal(m.exposure.gates, 1);
  assert.equal(m.exposure.uncorrelatedIssues, 1);
  assert.deepEqual(m.exposure.byReason, { architecture: 1 });
  assert.equal(m.response.hypothesesSubmitted, 1);
  assert.equal(m.response.gateAnsweredRate, null, 'a gate with no id cannot be joined to its answer');
});

test('comparePeriods rejects an unusable split point', () => {
  assert.throws(() => comparePeriods(makeLog(), 'not-a-date'), /ISO timestamp/);
});
