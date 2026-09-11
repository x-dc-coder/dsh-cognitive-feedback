import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, DEFAULT_CONFIG, activeIntervention } from '../lib/policy.js';
import { createState } from '../lib/state.js';

/** @param {Partial<ReturnType<typeof createState>>} patch */
const stateWith = (patch) => ({ ...createState('s1'), ...patch });

test('routine task produces no intervention', () => {
  const state = stateWith({ taskType: 'implementation', currentTopic: 'add-flag' });
  assert.deepEqual(decide(state), { type: 'none' });
});

test('architecture task without a hypothesis produces a reasoning gate', () => {
  const state = stateWith({ taskType: 'architecture', currentTopic: 'refactor-storage' });
  assert.deepEqual(decide(state), { type: 'reasoning_gate', reason: 'architecture' });
});

test('research task without a hypothesis produces a reasoning gate', () => {
  const state = stateWith({ taskType: 'research', currentTopic: 'benchmark-partitioning' });
  assert.deepEqual(decide(state), { type: 'reasoning_gate', reason: 'research' });
});

test('an existing hypothesis suppresses the gate', () => {
  const state = stateWith({ taskType: 'architecture', currentTopic: 'refactor-storage', currentHypothesis: 'the interface leaks backends' });
  assert.deepEqual(decide(state), { type: 'none' });
});

test('high-uncertainty debugging produces a level-2 challenge', () => {
  const state = stateWith({ taskType: 'debugging', currentTopic: 'duplicate-jobs' });
  assert.deepEqual(decide(state), { type: 'prompt', level: 2 });
});

test('intervention budget exhaustion suppresses strong interventions', () => {
  const state = stateWith({ taskType: 'architecture', currentTopic: 'refactor-storage' });
  assert.deepEqual(decide(state, { budget: { strongUsed: 5, lightUsed: 0 } }), { type: 'none' });
});

test('intervention budget exhaustion suppresses light interventions', () => {
  const state = stateWith({ taskType: 'debugging', currentTopic: 'duplicate-jobs' });
  assert.deepEqual(decide(state, { budget: { strongUsed: 0, lightUsed: 10 } }), { type: 'none' });
});

test('a pending gate is not re-issued', () => {
  const state = stateWith({ taskType: 'architecture', currentTopic: 'refactor-storage', pendingGate: true, lastGateTopic: 'refactor-storage' });
  assert.deepEqual(decide(state), { type: 'none' });
  assert.deepEqual(activeIntervention(state), { kind: 'gate', reason: 'refactor-storage' });
});

test('disabled config yields no intervention', () => {
  const state = stateWith({ taskType: 'architecture', currentTopic: 'x' });
  assert.deepEqual(decide(state, { config: { ...DEFAULT_CONFIG, enabled: false } }), { type: 'none' });
});

test('a high-value task with a hypothesis yields teaching back', () => {
  const state = stateWith({
    taskType: 'architecture',
    currentTopic: 'refactor-storage',
    currentHypothesis: 'the interface leaks backends',
    teachingBackPending: true,
    completedHighValueTopic: 'refactor-storage',
  });
  assert.deepEqual(decide(state), { type: 'teaching_back', reason: 'refactor-storage' });
});