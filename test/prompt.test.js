import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderCognitiveSection, createSectionRenderer, fingerprint, SECTION_NAME } from '../lib/prompt.js';
import { createState } from '../lib/state.js';

/** @param {Partial<ReturnType<typeof createState>>} patch */
const stateWith = (patch) => ({ ...createState('s1'), ...patch });

test('an inactive state renders an empty section', () => {
  assert.equal(renderCognitiveSection(stateWith({ taskType: 'implementation' })), '');
  assert.equal(renderCognitiveSection(createState('s1')), '');
});

test('a reasoning gate renders a bounded, delimited directive', () => {
  const state = stateWith({ taskType: 'architecture', currentTopic: 'refactor-storage', pendingGate: true, lastGateTopic: 'refactor-storage' });
  const text = renderCognitiveSection(state);
  assert.match(text, /^\[COGNITIVE FEEDBACK\]/);
  assert.match(text, /\[\/COGNITIVE FEEDBACK\]$/);
  assert.match(text, /ask_user_question/);
  assert.ok(text.length <= 1200, `section too long: ${text.length}`);
});

test('the gate label matches the task type (regression)', () => {
  // A real injected prompt rendered an architecture gate as "a research
  // decision" because the renderer compared a topic slug against a task type.
  const architecture = stateWith({ taskType: 'architecture', currentTopic: 'refactor-storage', pendingGate: true, lastGateTopic: 'refactor-storage' });
  assert.match(renderCognitiveSection(architecture), /an architecture decision/);
  assert.doesNotMatch(renderCognitiveSection(architecture), /research decision/);

  const research = stateWith({ taskType: 'research', currentTopic: 'benchmark', pendingGate: true, lastGateTopic: 'benchmark' });
  assert.match(renderCognitiveSection(research), /a research decision/);
});

test('a challenge renders for high-uncertainty debugging', () => {
  const state = stateWith({ taskType: 'debugging', currentTopic: 'duplicate-jobs', lastActionType: 'prompt', lastActionTopic: 'duplicate-jobs' });
  assert.match(renderCognitiveSection(state), /Challenge/);
});

test('teaching back renders for a pending high-value task', () => {
  const state = stateWith({ taskType: 'architecture', currentTopic: 'refactor-storage', teachingBackPending: true, completedHighValueTopic: 'refactor-storage' });
  assert.match(renderCognitiveSection(state), /Teaching back/);
});

test('rendering is deterministic for the same state', () => {
  const state = stateWith({ taskType: 'architecture', currentTopic: 'refactor-storage', pendingGate: true, lastGateTopic: 'refactor-storage' });
  assert.equal(renderCognitiveSection(state), renderCognitiveSection(state));
});

test('the renderer memoizes on a stable fingerprint', () => {
  const renderer = createSectionRenderer();
  const state = stateWith({ taskType: 'architecture', currentTopic: 'refactor-storage', pendingGate: true, lastGateTopic: 'refactor-storage' });
  const first = renderer.render(state);
  const second = renderer.render({ ...state });
  assert.equal(first, second);
  assert.equal(fingerprint(state), fingerprint({ ...state }));
  assert.equal(renderer.stats().lastKey.startsWith('gate|'), true);
});

test('the fingerprint changes only when the active intervention changes', () => {
  const base = stateWith({ taskType: 'architecture', currentTopic: 'refactor-storage', pendingGate: true, lastGateTopic: 'refactor-storage' });
  const noise = { ...base, recentDecisionOutsourcing: 99, stateVersion: 42 };
  assert.equal(fingerprint(base), fingerprint(noise), 'unrelated state must not change the fingerprint');
  // The fingerprint tracks the intervention's subject (currentTopic).
  const changed = { ...base, currentTopic: 'other-topic' };
  assert.notEqual(fingerprint(base), fingerprint(changed));
});

test('no secrets are inserted into the section', () => {
  const state = stateWith({
    taskType: 'architecture',
    currentTopic: 'topic',
    pendingGate: true,
    lastGateTopic: 'topic',
    currentHypothesis: 'SECRET_TOKEN_should_not_appear',
  });
  assert.equal(renderCognitiveSection(state).includes('SECRET_TOKEN'), false);
});