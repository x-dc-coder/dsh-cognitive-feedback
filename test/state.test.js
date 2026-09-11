import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StateEngine, createState } from '../lib/state.js';

test('createState starts in normal mode with no intervention', () => {
  const s = createState('s1');
  assert.equal(s.mode, 'normal');
  assert.equal(s.interventionLevel, 0);
  assert.equal(s.pendingGate, false);
});

test('an unchanged signal keeps the same state reference (cache-stable)', () => {
  const engine = new StateEngine('s1');
  engine.update({ sessionId: 's1', kind: 'user_message', text: 'Refactor the storage layer for three backends' });
  const a = engine.snapshot();
  const b = engine.update({ sessionId: 's1', kind: 'tool_result' });
  assert.equal(a, b, 'non-user signals must not bump state');
  const c = engine.update({ sessionId: 's1', kind: 'user_message', text: 'Refactor the storage layer for three backends' });
  assert.equal(b, c, 'repeating the same user message must not bump state');
});

test('a new topic invalidates the previous hypothesis', () => {
  const engine = new StateEngine('s1');
  engine.update({ sessionId: 's1', kind: 'user_message', text: 'I think the storage abstraction is wrong.' });
  assert.ok(engine.snapshot().currentHypothesis);
  engine.update({ sessionId: 's1', kind: 'user_message', text: 'Also benchmark the partitioning strategy.' });
  assert.equal(engine.snapshot().currentHypothesis, undefined);
});

test('a pending gate turns the next user message into the hypothesis', () => {
  const engine = new StateEngine('s1');
  engine.update({ sessionId: 's1', kind: 'user_message', text: 'Refactor the storage layer for three backends' });
  engine.recordAction({ type: 'reasoning_gate', reason: 'architecture' }, engine.snapshot().currentTopic);
  assert.equal(engine.snapshot().pendingGate, true);
  engine.update({ sessionId: 's1', kind: 'user_message', text: 'I think the storage interface leaks backend details.' });
  assert.equal(engine.snapshot().pendingGate, false);
  assert.match(engine.snapshot().currentHypothesis, /leaks backend details/);
});

test('stateVersion only advances on real change', () => {
  const engine = new StateEngine('s1');
  const v0 = engine.snapshot().stateVersion;
  engine.update({ sessionId: 's1', kind: 'tool_result' });
  assert.equal(engine.snapshot().stateVersion, v0);
  engine.update({ sessionId: 's1', kind: 'user_message', text: 'Debug the worker.' });
  assert.ok(engine.snapshot().stateVersion > v0);
});
