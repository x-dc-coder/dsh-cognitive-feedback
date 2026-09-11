import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CognitiveController } from '../dist/cognitive/controller.js';
import { MemorySink } from '../dist/storage/memory-sink.js';
import { makeEvent } from '../dist/events/factory.js';
import { reconstructEpisodes, episodeIndex, episodeOfEvent, summarizeEpisodes } from '../dist/projection/episodes.js';

const TS = '2026-09-11T00:00:00.000Z';

async function makeController(config = {}, sink = new MemorySink()) {
  const controller = new CognitiveController({
    config,
    sink,
    logger: () => {},
    now: () => new Date(TS),
  });
  await controller.start();
  return { controller, sink };
}

const msg = (text, sessionId = 's1') => ({ sessionId, kind: 'user_message', text });
const ARCH = 'Refactor the storage layer so we can support three backends.';
const HYPOTHESIS = 'I think the storage interface leaks backend details.';
const ANSWER = 'It works because one interface now hides the three adapters behind one contract.';

/** Build one correlated event for synthetic reconstructions. */
const ev = (type, payload, options = {}) =>
  makeEvent(type, payload, {
    sessionId: options.sessionId ?? 's1',
    timestamp: options.timestamp ?? TS,
    ...(options.id ? { id: options.id } : {}),
    ...(options.episodeId ? { episodeId: options.episodeId } : {}),
    ...(options.interventionId ? { interventionId: options.interventionId } : {}),
  });

test('a completed episode reconstructs the full lifecycle in order', async () => {
  const { controller, sink } = await makeController();
  await controller.handle('s1', msg(ARCH));
  await controller.handle('s1', msg(HYPOTHESIS));
  await controller.handle('s1', { sessionId: 's1', kind: 'assistant_message', text: 'Implemented.' });
  await controller.handle('s1', msg(ANSWER));

  const episodes = reconstructEpisodes(await sink.readAll());
  assert.equal(episodes.length, 1);
  const episode = episodes[0];
  assert.equal(episode.status, 'completed');
  assert.equal(episode.closeReason, 'teaching-back-completed');
  assert.ok(episode.startedAt);
  assert.ok(episode.endedAt);
  assert.equal(episode.trigger.eventType, 'intervention.triggered');
  assert.equal(episode.trigger.reason, 'architecture');
  assert.equal(episode.trigger.level, 3);
  assert.ok(episode.hypothesis.text.includes('leaks backend details'));
  assert.equal(episode.decision.owner, 'user');
  assert.ok(episode.implementationOutcome, 'teaching_back.requested is the implementation outcome');
  assert.equal(episode.teachingBack.result, 'unassessed');
  assert.equal(episode.interventionIds.length, 2, 'gate + teaching back');
  assert.deepEqual(
    episode.events.map((e) => e.type),
    [
      'intervention.triggered',
      'hypothesis.submitted',
      'decision.recorded',
      'teaching_back.requested',
      'teaching_back.completed',
      'episode.closed',
    ],
  );
});

test('an interrupted episode is abandoned with its reason', async () => {
  const { controller, sink } = await makeController();
  await controller.handle('s1', msg('The worker sometimes processes the same job twice. Fix it.'));
  await controller.handle('s1', msg('Add a --verbose flag to the CLI.'));

  const [episode] = reconstructEpisodes(await sink.readAll());
  assert.equal(episode.status, 'abandoned');
  assert.equal(episode.closeReason, 'topic-changed');
  assert.equal(episode.teachingBack, null, 'no teaching back ever happened');
  assert.equal(episode.implementationOutcome, null);
});

test('reconstruction is deterministic and follows append order, not timestamps', () => {
  const events = [
    ev('intervention.triggered', { level: 3, reason: 'architecture', taskType: 'architecture', topic: 't' }, { episodeId: 'ep_a', interventionId: 'iv_1' }),
    ev('hypothesis.submitted', { text: 'because X', authorship: 'user', taskType: 'architecture' }, { episodeId: 'ep_a', interventionId: 'iv_1' }),
    ev('episode.closed', { outcome: 'abandoned', reason: 'topic-changed' }, { episodeId: 'ep_a', interventionId: 'iv_1' }),
  ];
  const first = reconstructEpisodes(events);
  const second = reconstructEpisodes(events);
  assert.deepEqual(first, second, 'the same bytes must always reconstruct the same episodes');
  assert.deepEqual(first[0].events.map((e) => e.type), events.map((e) => e.type));

  // Equal millisecond timestamps cannot be used to order anything.
  assert.equal(new Set(events.map((e) => e.timestamp)).size, 1);
});

test('a missing terminator is tolerated: superseded and session-ended', () => {
  const events = [
    ev('intervention.triggered', { level: 3, reason: 'architecture', taskType: 'architecture', topic: 'a' }, { episodeId: 'ep_1', interventionId: 'iv_1' }),
    // No episode.closed for ep_1: a new episode in the same session supersedes it.
    ev('intervention.triggered', { level: 2, reason: 'debugging', taskType: 'debugging', topic: 'b' }, { episodeId: 'ep_2', interventionId: 'iv_2' }),
    ev('session.ended', { interventions: 2 }, { id: 'evt_end' }),
  ];
  const episodes = reconstructEpisodes(events);
  assert.deepEqual(episodes.map((e) => [e.episodeId, e.status, e.closeReason]), [
    ['ep_1', 'abandoned', 'superseded'],
    ['ep_2', 'abandoned', 'session-ended'],
  ]);
});

test('multi-session episodes stay separate and index cleanly', () => {
  const events = [
    ev('intervention.triggered', { level: 3, reason: 'architecture', taskType: 'architecture', topic: 'a' }, { sessionId: 's1', episodeId: 'ep_1', interventionId: 'iv_1' }),
    ev('intervention.triggered', { level: 3, reason: 'research', taskType: 'research', topic: 'b' }, { sessionId: 's2', episodeId: 'ep_2', interventionId: 'iv_2' }),
    ev('teaching_back.completed', { result: 'unassessed', topic: 'b' }, { sessionId: 's2', episodeId: 'ep_2', interventionId: 'iv_2' }),
    ev('episode.closed', { outcome: 'completed', reason: 'teaching-back-completed' }, { sessionId: 's2', episodeId: 'ep_2', interventionId: 'iv_2' }),
    ev('episode.closed', { outcome: 'abandoned', reason: 'session-ended' }, { sessionId: 's1', episodeId: 'ep_1', interventionId: 'iv_1' }),
  ];
  const episodes = reconstructEpisodes(events);
  assert.deepEqual(episodes.map((e) => [e.episodeId, e.sessionId, e.status]), [
    ['ep_1', 's1', 'abandoned'],
    ['ep_2', 's2', 'completed'],
  ]);
  const index = episodeIndex(events);
  assert.equal(episodeOfEvent(index, events[1]).sessionId, 's2');
  assert.deepEqual(summarizeEpisodes(episodes), { total: 2, open: 0, completed: 1, abandoned: 1, completionRate: 0.5 });
});

test('pre-episode logs reconstruct no episodes instead of failing', () => {
  const legacy = [
    makeEvent('session.started', { project: null }, { sessionId: 's1' }),
    makeEvent('intervention.triggered', { level: 3, reason: 'architecture', taskType: 'architecture', topic: null }, { sessionId: 's1' }),
  ];
  assert.deepEqual(reconstructEpisodes(legacy), []);
});

test('knowledge gaps attach to the episode that produced them', async () => {
  const { controller, sink } = await makeController();
  await controller.handle('s1', msg(ARCH));
  await controller.handle('s1', msg(HYPOTHESIS));
  await controller.handle('s1', { sessionId: 's1', kind: 'assistant_message', text: 'Implemented.' });
  await controller.handle('s1', msg('skip'));

  const [episode] = reconstructEpisodes(await sink.readAll());
  assert.equal(episode.teachingBack.result, 'skipped');
  assert.equal(episode.knowledgeGaps.length, 1);
  assert.equal(episode.closeReason, 'teaching-back-completed');
});

test('no episode history ever reaches the live system prompt', async () => {
  const { controller, sink } = await makeController();
  await controller.handle('s1', msg(ARCH));
  await controller.handle('s1', msg(HYPOTHESIS));
  await controller.handle('s1', { sessionId: 's1', kind: 'assistant_message', text: 'Implemented.' });
  await controller.handle('s1', msg(ANSWER));

  const historical = reconstructEpisodes(await sink.readAll());
  assert.equal(historical.length, 1);

  // Rendering is a pure function of the current state; a projection built from
  // the whole history cannot change it.
  const before = controller.renderSection('s1');
  void reconstructEpisodes(await sink.readAll());
  assert.equal(controller.renderSection('s1'), before);
  assert.equal(before.includes(historical[0].episodeId), false);
});
