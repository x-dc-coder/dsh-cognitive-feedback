import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderCognitiveSection, createSectionRenderer, fingerprint, SECTION_NAME } from '../dist/prompt/renderer.js';
import { createState } from '../dist/cognitive/state.js';

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

test('rendering is deterministic across distinct but equal states', () => {
  const make = () => stateWith({ taskType: 'architecture', currentTopic: 'refactor-storage', pendingGate: true, lastGateTopic: 'refactor-storage' });
  assert.equal(renderCognitiveSection(make()), renderCognitiveSection(make()));
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

test('user-authored text is never echoed back into the section', () => {
  // The section must not reflect raw user input (which may contain secrets)
  // back into the system prompt.
  for (const secret of ['SECRET_TOKEN_alpha', 'password=hunter2', 'sk-live-abcdef123456']) {
    const state = stateWith({
      taskType: 'architecture',
      currentTopic: 'refactor-storage',
      pendingGate: true,
      lastGateTopic: 'refactor-storage',
      currentHypothesis: secret,
      lastUserText: secret,
    });
    assert.equal(renderCognitiveSection(state).includes(secret), false, secret);
  }
});