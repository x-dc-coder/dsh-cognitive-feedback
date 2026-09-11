import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTopic } from '../dist/cognitive/classify.js';
import { topicLearningStates, countRecurringTopics, openRecurringTopics } from '../dist/projection/learning.js';
import { makeEvent, newCorrelationId } from '../dist/events/factory.js';
import { CognitiveController } from '../dist/cognitive/controller.js';
import { MemorySink } from '../dist/storage/memory-sink.js';

const NOW = Date.parse('2026-09-11T12:00:00.000Z');

const gap = (topic, timestamp, origin = 'skipped_answer', sessionId = 's1') =>
  makeEvent('knowledge_gap.detected', { topic, result: 'skipped', origin }, { sessionId, timestamp });

const teachingBack = (topic, result, evidence, timestamp, sessionId = 's1') =>
  makeEvent(
    'teaching_back.completed',
    { result, topic, ...(evidence ? { evidence } : {}) },
    { sessionId, timestamp },
  );

const evidence = (causal, mechanism) => ({
  assessment: 'evidence_extracted',
  result: 'unassessed',
  answered: true,
  wordCount: 40,
  lengthBand: 'adequate',
  causalExplanation: causal,
  mechanismExplanation: mechanism,
  keyConceptReferenced: true,
  uncertaintyAcknowledged: false,
  confidence: null,
  signals: [],
});

test('topic normalization is deterministic and folds word order', () => {
  assert.equal(normalizeTopic('refactor-storage-layer'), normalizeTopic('storage-layer-refactor'));
  assert.equal(normalizeTopic('Storage Refactor'), 'refactor-storage');
  assert.equal(normalizeTopic(''), '');
  assert.equal(normalizeTopic('the the the'), 'the');
  assert.equal(normalizeTopic('A'.repeat(200)), 'a'.repeat(16));
  assert.ok(normalizeTopic('x'.repeat(400)).length <= 64);
});

test('repeated gaps on the same normalized topic aggregate into one state', () => {
  const events = [
    gap('refactor-storage-layer', '2026-09-01T00:00:00.000Z'),
    gap('storage-layer-refactor', '2026-09-05T00:00:00.000Z', 'explicit_uncertainty', 's2'),
  ];
  const states = topicLearningStates(events, { now: NOW, windowMs: 30 * 86400000 });
  assert.equal(states.length, 1);
  const [topic] = states;
  assert.equal(topic.topic, 'layer-refactor-storage');
  assert.equal(topic.gapCount, 2, 'two spellings, one topic');
  assert.equal(topic.recurrence, 'recurring');
  assert.equal(topic.recentGaps, 2);
  assert.deepEqual([...topic.sessions].sort(), ['s1', 's2']);
  assert.deepEqual(topic.origins, { skipped_answer: 1, explicit_uncertainty: 1 });
  assert.equal(topic.resolved, false);
});

test('a single gap is one-off, not recurring', () => {
  const states = topicLearningStates([gap('cache-staleness', '2026-09-01T00:00:00.000Z')], { now: NOW });
  assert.equal(states[0].recurrence, 'one_off');
  assert.equal(countRecurringTopics(states), 0);
});

test('recency is window-relative, recurrence is not', () => {
  const events = [
    gap('old-topic', '2026-01-01T00:00:00.000Z'),
    gap('old-topic', '2026-02-01T00:00:00.000Z'),
  ];
  const [topic] = topicLearningStates(events, { now: NOW, windowMs: 1 * 86400000 });
  assert.equal(topic.gapCount, 2, 'both gaps still count');
  assert.equal(topic.recentGaps, 0, 'neither is inside the window');
  assert.equal(topic.recurrence, 'recurring');
});

test('a later strong explanation resolves the topic; a weak one does not', () => {
  const events = [
    gap('queue-offset', '2026-09-01T00:00:00.000Z'),
    gap('queue-offset', '2026-09-02T00:00:00.000Z'),
    teachingBack('queue-offset', 'unassessed', evidence(false, false), '2026-09-03T00:00:00.000Z'),
  ];
  assert.equal(topicLearningStates(events, { now: NOW })[0].resolved, false, 'evidence-free answer is not a resolution');

  const strong = [
    ...events.slice(0, 2),
    teachingBack('queue-offset', 'unassessed', evidence(true, true), '2026-09-03T00:00:00.000Z'),
  ];
  const [resolved] = topicLearningStates(strong, { now: NOW });
  assert.equal(resolved.resolved, true);
  assert.equal(resolved.lastTeachingBack.mechanismExplanation, true);

  // A gap AFTER the strong explanation reopens the topic.
  const reopened = [...strong, gap('queue-offset', '2026-09-10T00:00:00.000Z')];
  assert.equal(topicLearningStates(reopened, { now: NOW })[0].resolved, false);
  assert.deepEqual(openRecurringTopics(topicLearningStates(reopened, { now: NOW })).map((t) => t.topic), ['offset-queue']);
});

test('a skipped teaching back is never a resolution signal', () => {
  const events = [
    gap('deadlock', '2026-09-01T00:00:00.000Z'),
    gap('deadlock', '2026-09-02T00:00:00.000Z'),
    teachingBack('deadlock', 'skipped', evidence(true, true), '2026-09-03T00:00:00.000Z'),
  ];
  assert.equal(topicLearningStates(events, { now: NOW })[0].resolved, false);
});

test('the projection never carries answer or hypothesis text', () => {
  const control = new CognitiveController({ config: {}, sink: new MemorySink(), logger: () => {}, now: () => new Date('2026-09-11T00:00:00.000Z') });
  const events = [
    makeEvent('hypothesis.submitted', { text: 'SECRET_HYPOTHESIS', authorship: 'user', taskType: 'debugging' }, { sessionId: 's1' }),
    ...Array.from({ length: 2 }, () => gap('worker-duplicate', '2026-09-01T00:00:00.000Z')),
  ];
  void control;
  const states = topicLearningStates(events, { now: NOW });
  assert.equal(JSON.stringify(states).includes('SECRET_HYPOTHESIS'), false);
  assert.deepEqual(Object.keys(states[0]).sort(), [
    'firstGapAt',
    'gapCount',
    'lastGapAt',
    'lastTeachingBack',
    'origins',
    'rawTopics',
    'recentGaps',
    'recurrence',
    'resolved',
    'results',
    'sessions',
    'topic',
  ]);
});

test('gaps recorded by the controller aggregate end to end', async () => {
  const sink = new MemorySink();
  const controller = new CognitiveController({ config: {}, sink, logger: () => {}, now: () => new Date('2026-09-11T00:00:00.000Z') });
  await controller.start();
  const runCycle = async (sessionId, topicText) => {
    await controller.handle(sessionId, { sessionId, kind: 'user_message', text: topicText });
    await controller.handle(sessionId, { sessionId, kind: 'user_message', text: 'I think the storage interface leaks backend details.' });
    await controller.handle(sessionId, { sessionId, kind: 'assistant_message', text: 'Implemented.' });
    await controller.handle(sessionId, { sessionId, kind: 'user_message', text: 'skip' });
  };
  await runCycle('s1', 'Refactor the storage layer so we can support three backends.');
  await runCycle('s2', 'Refactor the storage layer so we can support three backends.');

  const states = topicLearningStates(await sink.readAll(), { now: Date.now() });
  const topic = states.find((state) => state.gapCount > 0);
  assert.ok(topic, 'the controller recorded gaps');
  assert.equal(topic.recurrence, 'recurring', 'the same topic was skipped twice');
  assert.equal(topic.sessions.length, 2);
  assert.equal(topic.origins.skipped_answer, 2);
});

test('correlation ids are never used as topics', () => {
  const id = newCorrelationId('ep');
  assert.equal(normalizeTopic(id), normalizeTopic(id).toLowerCase());
  assert.ok(normalizeTopic(id).length <= 64);
});
