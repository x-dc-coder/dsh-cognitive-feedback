import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CognitiveController } from '../dist/cognitive/controller.js';
import { MemorySink } from '../dist/storage/memory-sink.js';

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

  // The directive is live and recorded as soon as the high-value work completes.
  assert.match(controller.renderSection('s1'), /Teaching back/);
  assert.ok((await sink.readAll()).some((e) => e.type === 'teaching_back.requested'));

  await controller.completeTeachingBack('s1', 'partially_correct', 'refactor');
  const types = (await sink.readAll()).map((e) => e.type);
  assert.ok(types.includes('teaching_back.completed'));
  assert.ok(types.includes('knowledge_gap.detected'));
});

test('teaching back renders, is answered, and can fire again later', async () => {
  const { controller, sink } = await makeController();
  await controller.handle('s1', msg('Refactor the storage layer so we can support three backends.'));
  await controller.handle('s1', msg('I think the storage interface leaks backend details.'));
  await controller.handle('s1', { sessionId: 's1', kind: 'assistant_message', text: 'Implemented.' });

  // The directive goes live the moment the high-value work completes — it does
  // not wait for another user message.
  assert.match(controller.renderSection('s1'), /Teaching back/);
  const requested = (await sink.readAll()).find((e) => e.type === 'teaching_back.requested');
  assert.ok(requested, 'a live directive must be recorded immediately');
  assert.equal(controller.lightUsed, 1, 'and it must consume budget');

  // Any user message while it is live is the answer.
  await controller.handle('s1', msg('It works because one interface now hides the three adapters behind a single contract.'));
  const events = await sink.readAll();
  const completed = events.find((e) => e.type === 'teaching_back.completed');
  // V0.1 observes that an answer was given; it does not grade it.
  assert.equal(completed?.payload.result, 'unassessed');
  assert.equal(controller.session('s1').engine.snapshot().teachingBackPending, false);

  // Regression: lastActionType stayed 'teaching_back' forever, so every later
  // high-value task silently stopped producing a check.
  await controller.handle('s1', msg('Now benchmark a new adaptive partitioning strategy for the VRP experiment.'));
  await controller.handle('s1', msg('I expect adaptive partitioning to cut latency because static buckets skew.'));
  await controller.handle('s1', { sessionId: 's1', kind: 'assistant_message', text: 'Done.' });
  assert.match(controller.renderSection('s1'), /Teaching back/, 'a later high-value task must still be able to ask');
  assert.equal(
    (await sink.readAll()).filter((e) => e.type === 'teaching_back.requested').length,
    2,
    'the second high-value task must also be recorded',
  );
});

test('handle degrades instead of rejecting on a hostile signal', async () => {
  const { controller } = await makeController();
  const hostile = { sessionId: 's1', kind: 'user_message', get text() { throw new Error('boom'); } };
  let action;
  await assert.doesNotReject(async () => {
    action = await controller.handle('s1', hostile);
  });
  assert.deepEqual(action, { type: 'none' }, 'the public API must uphold fail-open');
});

test('completeTeachingBack never rejects, even with a bogus result', async () => {
  const { controller, sink } = await makeController();
  sink.failWith = 'disk full';
  await assert.doesNotReject(() => controller.completeTeachingBack('s1', 'nonsense', 'topic'));
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

test('a spent gate budget degrades the next gate instead of re-issuing it', async () => {
  const { controller } = await makeController({ strongPerDay: 1 });
  const first = await controller.handle('s1', msg('Refactor the storage layer so we can support three backends.'));
  assert.equal(first.type, 'reasoning_gate');
  await controller.handle('s1', msg('I think the storage interface leaks backend details.'));
  const second = await controller.handle('s1', msg('Design a new schema for the events table.'));
  // Issue #9: the budget degrades a user-owned signal to the strongest
  // intervention still allowed (a non-blocking challenge) rather than silence.
  assert.deepEqual(second, { type: 'prompt', level: 2 });
  assert.match(controller.renderSection('s1'), /Challenge/);
  assert.equal(controller.strongUsed, 1, 'the second gate was never issued');
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