import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CognitiveController } from '../dist/cognitive/controller.js';
import { JsonlSink } from '../dist/storage/jsonl-sink.js';
import { MemorySink } from '../dist/storage/memory-sink.js';
import { parseCognitiveEvent, indexByCorrelation, eventsForIntervention, eventsForEpisode } from '../dist/events/queries.js';

async function makeController(config = {}, sink = new MemorySink()) {
  const warnings = [];
  const controller = new CognitiveController({
    config,
    sink,
    logger: (msg) => warnings.push(msg),
    now: () => new Date('2026-09-11T00:00:00.000Z'),
  });
  await controller.start();
  return { controller, sink, warnings };
}

const msg = (text, sessionId = 's1') => ({ sessionId, kind: 'user_message', text });
const ARCH = 'Refactor the storage layer so we can support three backends.';
const HYPOTHESIS = 'I think the storage interface leaks backend details.';

test('one intervention lifecycle carries one stable intervention id', async () => {
  const { controller, sink } = await makeController();
  const gate = await controller.handle('s1', msg(ARCH));
  assert.equal(gate.type, 'reasoning_gate');

  const triggered = (await sink.readAll()).find((e) => e.type === 'intervention.triggered');
  assert.match(triggered.interventionId, /^iv_/);
  assert.match(triggered.episodeId, /^ep_/, 'the trigger opens the episode it belongs to');

  await controller.handle('s1', msg(HYPOTHESIS));
  const events = await sink.readAll();
  const hypothesis = events.find((e) => e.type === 'hypothesis.submitted');
  const decision = events.find((e) => e.type === 'decision.recorded');

  // The answer resolves the same intervention that asked the question.
  assert.equal(hypothesis.interventionId, triggered.interventionId);
  assert.equal(decision.interventionId, triggered.interventionId);
  assert.equal(hypothesis.episodeId, triggered.episodeId);
  assert.equal(decision.episodeId, triggered.episodeId);
});

test('related events can be joined by id without topic or timestamp heuristics', async () => {
  const { controller, sink } = await makeController();
  await controller.handle('s1', msg(ARCH));
  await controller.handle('s1', msg(HYPOTHESIS));

  const events = await sink.readAll();
  const interventionId = events.find((e) => e.type === 'intervention.triggered').interventionId;

  // The request topic and the answer topic are deliberately different strings;
  // the join must not depend on them, nor on the (identical) test clock.
  const joined = eventsForIntervention(events, interventionId).map((e) => e.type);
  assert.deepEqual(joined, ['intervention.triggered', 'hypothesis.submitted', 'decision.recorded']);

  const index = indexByCorrelation(events, 'interventionId');
  assert.equal(index.get(interventionId).length, 3);
  assert.equal(new Set(events.map((e) => e.timestamp)).size, 1, 'all events share one timestamp, so time cannot join them');
});

test('an interrupted intervention is closed as an abandoned episode', async () => {
  const { controller, sink } = await makeController();
  // A debugging signal yields a level-2 challenge, which does NOT lock the
  // session into a pending gate -- so the user can simply move on.
  await controller.handle('s1', msg('The worker sometimes processes the same job twice. Fix it.'));
  const triggered = (await sink.readAll()).find((e) => e.type === 'intervention.triggered');
  assert.equal(triggered.payload.level, 2);

  await controller.handle('s1', msg('Add a --verbose flag to the CLI.'));

  const closed = (await sink.readAll()).find((e) => e.type === 'episode.closed');
  assert.ok(closed, 'abandonment must be recorded, not merely inferred at read time');
  assert.equal(closed.payload.outcome, 'abandoned');
  assert.equal(closed.payload.reason, 'topic-changed');
  assert.equal(closed.interventionId, triggered.interventionId, 'the abandoned intervention is named');
  assert.equal(closed.episodeId, triggered.episodeId);

  const state = controller.stateOf('s1');
  assert.equal(state.currentEpisodeId, undefined);
  assert.equal(state.currentInterventionId, undefined);
});

test('a session end abandons the open episode and names the reason', async () => {
  const { controller, sink } = await makeController();
  await controller.handle('s1', msg('Design a new schema for the events table.'));
  await controller.handle('s1', { sessionId: 's1', kind: 'session_ended' });

  const events = await sink.readAll();
  const closed = events.find((e) => e.type === 'episode.closed');
  assert.equal(closed.payload.reason, 'session-ended');
  assert.deepEqual(
    events.map((e) => e.type),
    ['intervention.triggered', 'episode.closed', 'session.ended'],
    'the terminator is written before the session ends',
  );
});

test('a teaching-back check is its own intervention inside the same episode', async () => {
  const { controller, sink } = await makeController();
  await controller.handle('s1', msg(ARCH));
  await controller.handle('s1', msg(HYPOTHESIS));
  await controller.handle('s1', { sessionId: 's1', kind: 'assistant_message', text: 'Implemented.' });

  await controller.handle('s1', msg('It works because one interface now hides the three adapters behind one contract.'));

  const events = await sink.readAll();
  const requested = events.find((e) => e.type === 'teaching_back.requested');
  const completed = events.find((e) => e.type === 'teaching_back.completed');
  const closed = events.find((e) => e.type === 'episode.closed');

  assert.match(requested.interventionId, /^iv_/);
  assert.notEqual(requested.interventionId, events.find((e) => e.type === 'intervention.triggered').interventionId);
  assert.equal(completed.interventionId, requested.interventionId, 'the answer resolves the teaching-back intervention');
  assert.equal(closed.interventionId, requested.interventionId);
  assert.equal(closed.episodeId, requested.episodeId);
  assert.equal(closed.payload.outcome, 'completed');

  // Trigger, hypothesis, and teaching back all belong to one reasoning unit.
  const episodeId = events.find((e) => e.type === 'intervention.triggered').episodeId;
  const episodeEvents = eventsForEpisode(events, episodeId).map((e) => e.type);
  assert.deepEqual(episodeEvents, [
    'intervention.triggered',
    'hypothesis.submitted',
    'decision.recorded',
    'teaching_back.requested',
    'teaching_back.completed',
    'episode.closed',
  ]);
});

test('simultaneous sessions never share correlation ids', async () => {
  const { controller, sink } = await makeController();
  await Promise.all([
    controller.handle('s1', msg(ARCH, 's1')),
    controller.handle('s2', msg(ARCH, 's2')),
  ]);
  await Promise.all([
    controller.handle('s1', msg(HYPOTHESIS, 's1')),
    controller.handle('s2', msg(HYPOTHESIS, 's2')),
  ]);

  const events = await sink.readAll();
  const triggers = events.filter((e) => e.type === 'intervention.triggered');
  assert.equal(triggers.length, 2);
  assert.notEqual(triggers[0].interventionId, triggers[1].interventionId);
  assert.notEqual(triggers[0].episodeId, triggers[1].episodeId);

  for (const trigger of triggers) {
    const joined = eventsForIntervention(events, trigger.interventionId);
    assert.equal(joined.length, 3, 'each intervention joins only its own lifecycle');
    assert.ok(joined.every((e) => e.sessionId === trigger.sessionId));
  }
});

test('correlation survives a JSONL round trip', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'cog-corr-')), 'events.jsonl');
  const { controller } = await makeController({}, new JsonlSink(path));
  await controller.handle('s1', msg(ARCH));
  await controller.handle('s1', msg(HYPOTHESIS));

  const reread = await new JsonlSink(path).readAll();
  const joined = eventsForIntervention(reread, reread[0].interventionId).map((e) => e.type);
  assert.deepEqual(joined, ['intervention.triggered', 'hypothesis.submitted', 'decision.recorded']);
});

test('events without correlation stay readable, malformed correlation does not', () => {
  const legacy = parseCognitiveEvent({
    schemaVersion: 1,
    id: 'evt_legacy',
    timestamp: '2026-09-11T00:00:00.000Z',
    sessionId: 's1',
    type: 'intervention.triggered',
    payload: { level: 3, reason: 'architecture', taskType: 'architecture', topic: null },
  });
  assert.ok(legacy, 'a pre-correlation event must remain readable');
  assert.equal(legacy.episodeId, undefined);

  for (const key of ['episodeId', 'interventionId']) {
    const broken = {
      schemaVersion: 1,
      id: 'evt_broken',
      timestamp: '2026-09-11T00:00:00.000Z',
      sessionId: 's1',
      [key]: 42,
      type: 'session.started',
      payload: { project: null },
    };
    assert.equal(parseCognitiveEvent(broken), null, `a non-string ${key} must be rejected`);
  }
});

test('correlation never reaches the system prompt', async () => {
  const { controller } = await makeController();
  await controller.handle('s1', msg(ARCH));
  const rendered = controller.renderSection('s1');
  const state = controller.stateOf('s1');
  assert.equal(rendered.includes(state.currentEpisodeId), false);
  assert.equal(rendered.includes(state.currentInterventionId), false);
});
