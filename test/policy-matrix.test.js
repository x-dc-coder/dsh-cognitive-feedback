import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decidePolicy, activeIntervention, DEFAULT_CONFIG } from '../dist/cognitive/policy.js';
import { StateEngine } from '../dist/cognitive/state.js';
import { analyzeMessage, isHighImpactDebugging } from '../dist/cognitive/classify.js';
import { CognitiveController } from '../dist/cognitive/controller.js';
import { MemorySink } from '../dist/storage/memory-sink.js';

/** Decide for one user message, from a fresh session. */
const decideFor = (text, options = {}) => {
  const engine = new StateEngine('s1');
  engine.update({ sessionId: 's1', kind: 'user_message', text });
  return decidePolicy(engine.snapshot(), options);
};

const budget = (strongUsed, lightUsed) => ({ budget: { strongUsed, lightUsed } });

/**
 * The decision matrix from issue #9, as data.
 *
 * kind / ownership / level / blocking / reason -- every column the policy must
 * be able to explain.
 */
const MATRIX = [
  ['Add a `--verbose` flag to the CLI.', 'none', 'agent', 0, false, 'routine'],
  ['Rename the UserService to AccountService.', 'none', 'agent', 0, false, 'routine'],
  ['Fix the typo in README.', 'none', 'agent', 0, false, 'routine'],
  ['Implement the pagination helper for the list endpoint.', 'nudge', 'shared', 1, false, 'implementation'],
  ['Add retry handling to the HTTP client.', 'nudge', 'shared', 1, false, 'implementation'],
  ['The worker sometimes processes the same job twice. Fix it.', 'challenge', 'shared', 2, false, 'debugging'],
  ['Refactor the storage layer so we can support three backends.', 'reasoning_gate', 'user', 3, true, 'architecture'],
  ['Design a new schema for the events table.', 'reasoning_gate', 'user', 3, true, 'architecture'],
  ['Migrate the queue to a new abstraction.', 'reasoning_gate', 'user', 3, true, 'architecture'],
  ['Investigate whether Redis or Postgres is better for this workload', 'reasoning_gate', 'user', 3, true, 'research'],
  ['Which is better for this workload, Redis or Postgres?', 'reasoning_gate', 'user', 3, true, 'research'],
  ['Production sometimes drops payment records. Find the root cause.', 'reasoning_gate', 'user', 3, true, 'root-cause'],
  ['The cache sometimes returns stale results in production. Debug it.', 'reasoning_gate', 'user', 3, true, 'root-cause'],
];

test('the decision matrix maps task shape to ownership, level and blocking', () => {
  for (const [text, kind, ownership, level, blocking, reason] of MATRIX) {
    const decision = decideFor(text);
    assert.equal(decision.kind, kind, text);
    assert.equal(decision.ownership, ownership, text);
    assert.equal(decision.level, level, text);
    assert.equal(decision.blocking, blocking, text);
    assert.equal(decision.reason, reason, text);
    assert.ok(decision.rationale.length > 0, text);
    assert.equal(decision.action.type === 'reasoning_gate', blocking, text);
  }
});

test('ownership separates "needs support" from "needs the user", not task type alone', () => {
  // Both are debugging; only the high-impact + high-uncertainty one blocks.
  assert.equal(decideFor('The worker sometimes processes the same job twice. Fix it.').ownership, 'shared');
  assert.equal(decideFor('Production sometimes drops payment records. Find the root cause.').ownership, 'user');
  // Both are implementation; only the routine one is agent-owned.
  assert.equal(decideFor('Rename the UserService to AccountService.').ownership, 'agent');
  assert.equal(decideFor('Implement the pagination helper for the list endpoint.').ownership, 'shared');
});

test('a user-owned decision stops blocking once the user has stated a hypothesis', () => {
  const engine = new StateEngine('s1');
  engine.update({ sessionId: 's1', kind: 'user_message', text: 'Refactor the storage layer so we can support three backends.' });
  assert.equal(decidePolicy(engine.snapshot()).kind, 'reasoning_gate');
  engine.update({ sessionId: 's1', kind: 'user_message', text: 'I think the storage interface leaks backend details.' });
  const after = decidePolicy(engine.snapshot());
  assert.equal(after.kind, 'none', 'the same decision must not be gated twice');
});

test('a pending gate is never re-issued, and the ownership stays with the user', () => {
  const engine = new StateEngine('s1');
  engine.update({ sessionId: 's1', kind: 'user_message', text: 'Refactor the storage layer so we can support three backends.' });
  engine.recordAction({ type: 'reasoning_gate', reason: 'architecture' }, engine.snapshot().currentTopic);
  const decision = decidePolicy(engine.snapshot());
  assert.equal(decision.kind, 'none');
  assert.equal(decision.ownership, 'user');
  assert.equal(decision.reason, 'gate-pending');
});

test('budget exhaustion degrades down the ownership ladder, never up', () => {
  const text = 'Refactor the storage layer so we can support three backends.';
  assert.equal(decideFor(text, budget(0, 0)).kind, 'reasoning_gate');
  assert.equal(decideFor(text, budget(5, 0)).kind, 'challenge');
  assert.equal(decideFor(text, budget(5, 10)).kind, 'none');
  assert.equal(decideFor(text, budget(5, 0)).ownership, 'shared', 'a degraded gate is not user-owned');
  assert.equal(decideFor(text, budget(5, 10)).action.type, 'none');
});

test('a disabled plugin decides nothing at all', () => {
  const decision = decideFor('Refactor the storage layer so we can support three backends.', {
    config: { ...DEFAULT_CONFIG, enabled: false },
  });
  assert.equal(decision.kind, 'none');
  assert.equal(decision.reason, 'disabled');
});

test('high-impact debugging requires BOTH impact and uncertainty', () => {
  assert.equal(isHighImpactDebugging('Production sometimes drops payment records.'), true);
  assert.equal(isHighImpactDebugging('The parser fails on empty input.'), false, 'impact without uncertainty stays a challenge');
  assert.equal(isHighImpactDebugging('It sometimes returns a stale value.'), false, 'uncertainty without impact stays a challenge');
  assert.equal(analyzeMessage('Add a `--verbose` flag to the CLI.').routine, true);
  assert.equal(analyzeMessage('Implement the pagination helper.').highImpactDebugging, false);
});

test('the three levels render distinct, non-blocking-or-blocking text', () => {
  const nudge = decideFor('Implement the pagination helper for the list endpoint.');
  const challenge = decideFor('The worker sometimes processes the same job twice. Fix it.');
  assert.equal(nudge.level, 1);
  assert.equal(challenge.level, 2);
  assert.equal(nudge.blocking, false);
  assert.equal(challenge.blocking, false);
});

test('the recorded event carries the ownership and value it was decided from', async () => {
  const sink = new MemorySink();
  const controller = new CognitiveController({
    config: {},
    sink,
    logger: () => {},
    now: () => new Date('2026-09-11T00:00:00.000Z'),
  });
  await controller.start();

  await controller.handle('s1', { sessionId: 's1', kind: 'user_message', text: 'Refactor the storage layer so we can support three backends.' });
  const gate = (await sink.readAll()).find((e) => e.type === 'intervention.triggered');
  assert.equal(gate.payload.ownership, 'user');
  assert.equal(gate.payload.value, 'high');
  assert.equal(gate.payload.level, 3);
  assert.equal(gate.payload.reason, 'architecture');

  await controller.handle('s1', { sessionId: 's1', kind: 'user_message', text: 'I think the storage interface leaks backend details.' });
  await controller.handle('s2', { sessionId: 's2', kind: 'user_message', text: 'The worker sometimes processes the same job twice. Fix it.' });
  const challenge = (await sink.readAll()).find((e) => e.sessionId === 's2' && e.type === 'intervention.triggered');
  assert.equal(challenge.payload.ownership, 'shared');
  assert.equal(challenge.payload.level, 2);

  await controller.handle('s3', { sessionId: 's3', kind: 'user_message', text: 'Implement the pagination helper for the list endpoint.' });
  const nudge = (await sink.readAll()).find((e) => e.sessionId === 's3' && e.type === 'intervention.triggered');
  assert.equal(nudge.payload.ownership, 'shared');
  assert.equal(nudge.payload.value, 'medium');
  assert.equal(nudge.payload.level, 1);
  assert.match(controller.renderSection('s3'), /Nudge/);

  assert.deepEqual(activeIntervention(controller.stateOf('s3')), {
    kind: 'nudge',
    reason: 'implementation',
    topic: 'implement-pagination-helper-list-endpoint',
  });
});
