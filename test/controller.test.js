import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CognitiveController } from '../lib/controller.js';
import { MemorySink } from '../lib/storage/memory-sink.js';

/** Build a controller wired to an in-memory sink. */
async function makeController(config = {}) {
  const sink = new MemorySink();
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

const msg = (text) => ({ sessionId: 's1', kind: 'user_message', text });

test('an architecture request triggers a reasoning gate and records an event', async () => {
  const { controller, sink } = await makeController();
  await controller.handle('s1', { sessionId: 's1', kind: 'session_started' });
  const action = await controller.handle('s1', msg('Refactor the storage layer so we can support three backends.'));

  assert.deepEqual(action, { type: 'reasoning_gate', reason: 'architecture' });
  const events = await sink.readAll();
  assert.deepEqual(events.map((e) => e.type), ['session.started', 'intervention.triggered']);
  assert.equal(events[1].payload.level, 3);
  assert.ok(controller.renderSection('s1').includes('COGNITIVE FEEDBACK'));
});

test('a routine request stays silent', async () => {
  const { controller, sink } = await makeController();
  const action = await controller.handle('s1', msg('Add a --verbose flag to the CLI.'));
  assert.deepEqual(action, { type: 'none' });
  assert.deepEqual(await sink.readAll(), []);
  assert.equal(controller.renderSection('s1'), '');
});

test('the gate answer is recorded as a user-authored hypothesis', async () => {
  const { controller, sink } = await makeController();
  await controller.handle('s1', msg('Refactor the storage layer so we can support three backends.'));
  await controller.handle('s1', msg('I think the storage interface leaks backend details.'));

  const types = (await sink.readAll()).map((e) => e.type);
  assert.ok(types.includes('intervention.triggered'));
  assert.ok(types.includes('hypothesis.submitted'));
  assert.ok(types.includes('decision.recorded'));
});

test('a completed high-value task yields teaching back and a recorded outcome', async () => {
  const { controller, sink } = await makeController();
  await controller.handle('s1', msg('Refactor the storage layer so we can support three backends.'));
  await controller.handle('s1', msg('I think the storage interface leaks backend details.'));
  await controller.handle('s1', { sessionId: 's1', kind: 'assistant_message', text: 'Implemented.' });

  const action = await controller.handle('s1', msg('Thanks, that looks good.'));
  assert.equal(action.type, 'teaching_back');

  await controller.completeTeachingBack('s1', 'partially_correct', 'refactor');
  const types = (await sink.readAll()).map((e) => e.type);
  assert.ok(types.includes('teaching_back.requested'));
  assert.ok(types.includes('teaching_back.completed'));
  assert.ok(types.includes('knowledge_gap.detected'));
});

test('a disabled plugin is fully inert on every public path', async () => {
  const { controller, sink } = await makeController({ enabled: false });
  await controller.handle('s1', { sessionId: 's1', kind: 'session_started' });
  const action = await controller.handle('s1', msg('Refactor the storage layer so we can support three backends.'));
  assert.deepEqual(action, { type: 'none' });
  // Every other path must be inert too, not just handle().
  await controller.completeTeachingBack('s1', 'incorrect', 'topic');
  assert.deepEqual(await sink.readAll(), [], 'a disabled plugin must not write any event');
  assert.equal(controller.renderSection('s1'), '');
});

test('a sink failure never breaks the caller (fail open)', async () => {
  const { controller, sink, warnings } = await makeController();
  sink.failWith = 'disk full';
  const action = await controller.handle('s1', msg('Refactor the storage layer so we can support three backends.'));
  assert.equal(action.type, 'reasoning_gate', 'policy still runs when persistence fails');
  assert.ok(warnings.length > 0, 'the failure is warned, not thrown');
  assert.equal(controller.renderSection('s1').includes('COGNITIVE FEEDBACK'), true);
});

test('a pending gate is not re-issued before the user answers', async () => {
  const { controller } = await makeController();
  const first = await controller.handle('s1', msg('Refactor the storage layer so we can support three backends.'));
  assert.equal(first.type, 'reasoning_gate');
  // A second high-value request while the gate is unanswered must stay silent.
  const second = await controller.handle('s1', msg('Design a new schema for the events table.'));
  assert.equal(second.type, 'none');
  assert.equal(controller.strongUsed, 1, 'only the first gate was issued');
});

test('the persisted log restores the daily budget across restarts', async () => {
  const { controller, sink } = await makeController();
  const topics = [
    'Refactor the storage layer for three backends',
    'Design a new schema for events',
    'Migrate the queue to a new abstraction',
  ];
  for (const topic of topics) {
    await controller.handle('s1', msg(topic)); // gate
    await controller.handle('s1', msg('I think the current abstraction leaks backend details.')); // answer
  }
  assert.equal(controller.strongUsed, 3);

  // A fresh controller over the same persisted events must see the same budget.
  const restarted = new CognitiveController({ config: {}, sink, now: () => new Date('2026-09-11T01:00:00.000Z') });
  await restarted.start();
  assert.equal(restarted.strongUsed, 3);
});

test('the budget suppresses further gates once exhausted', async () => {
  const { controller } = await makeController({ strongPerDay: 1 });
  const first = await controller.handle('s1', msg('Refactor the storage layer so we can support three backends.'));
  assert.equal(first.type, 'reasoning_gate');
  await controller.handle('s1', msg('I think the storage interface leaks backend details.'));
  const second = await controller.handle('s1', msg('Design a new schema for the events table.'));
  assert.equal(second.type, 'none', 'the budget must stop the second gate');
});

test('a restart charges strong interventions only to the strong budget', async () => {
  const { controller, sink } = await makeController();
  // Two architecture gates (level 3) and answers, no light interventions.
  await controller.handle('s1', msg('Refactor the storage layer for three backends.'));
  await controller.handle('s1', msg('I think the storage interface leaks backend details.'));
  await controller.handle('s1', msg('Design a new schema for the events table.'));
  assert.equal(controller.strongUsed, 2);
  assert.equal(controller.lightUsed, 0);

  const restarted = new CognitiveController({ config: {}, sink, now: () => new Date('2026-09-11T01:00:00.000Z') });
  await restarted.start();
  assert.equal(restarted.strongUsed, 2);
  // Regression: start() used to count every intervention into lightUsed, so a
  // restart let level-3 gates silently eat the light budget.
  assert.equal(restarted.lightUsed, 0, 'level-3 gates must not consume the light budget after a restart');
});

test('a disposed session is pruned from the session map', async () => {
  const { controller } = await makeController();
  await controller.handle('s1', msg('Refactor the storage layer for three backends.'));
  assert.equal(controller.sessions.size, 1);

  await controller.handle('s1', { sessionId: 's1', kind: 'session_ended' });
  // Regression: a long-lived host creates one session per conversation, so an
  // unpruned map grows without bound.
  assert.equal(controller.sessions.size, 0);
});

test('sessions keep independent cognitive state', async () => {
  const { controller } = await makeController();
  await controller.handle('s1', msg('Refactor the storage layer so we can support three backends.'));
  const s2 = await controller.handle('s2', { sessionId: 's2', kind: 'user_message', text: 'The worker sometimes processes the same job twice. Fix it.' });

  assert.equal(s2.type, 'prompt', 's2 must be decided on its own merits');
  assert.match(controller.renderSection('s1'), /Reasoning gate/);
  assert.match(controller.renderSection('s2'), /Challenge/);
});

test('a persistence failure does not un-issue the intervention or refund the budget', async () => {
  const { controller, sink, warnings } = await makeController();
  // MemorySink fails only the next append, so the gate write is lost.
  sink.failWith = 'disk full';
  const action = await controller.handle('s1', msg('Refactor the storage layer so we can support three backends.'));

  assert.equal(action.type, 'reasoning_gate', 'the decision still applies');
  assert.equal(controller.strongUsed, 1, 'the issued intervention consumes budget even when the log write fails');
  assert.match(controller.renderSection('s1'), /COGNITIVE FEEDBACK/, 'the directive is still injected');
  assert.ok(warnings.some((w) => w.includes('persistence failed')), `expected a warning, got ${JSON.stringify(warnings)}`);
});