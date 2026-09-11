import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderCognitiveSection, createSectionRenderer, fingerprint, SECTION_NAME } from '../dist/prompt/renderer.js';
import { createState } from '../dist/cognitive/state.js';
import { CognitiveController } from '../dist/cognitive/controller.js';
import { MemorySink } from '../dist/storage/memory-sink.js';
import { makeEvent } from '../dist/events/factory.js';
import { buildProjection } from '../dist/projection/index.js';

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
  const state = stateWith({
    taskType: 'debugging',
    currentTopic: 'duplicate-jobs',
    lastActionType: 'prompt',
    lastActionTopic: 'duplicate-jobs',
    interventionLevel: 2,
  });
  assert.match(renderCognitiveSection(state), /Challenge/);
});

test('a level-1 nudge renders as a non-blocking reminder, not a challenge', () => {
  const state = stateWith({
    taskType: 'implementation',
    currentTopic: 'pagination-helper',
    lastActionType: 'prompt',
    lastActionTopic: 'pagination-helper',
    interventionLevel: 1,
  });
  const text = renderCognitiveSection(state);
  assert.match(text, /Nudge/);
  assert.match(text, /does not block/);
  assert.doesNotMatch(text, /Challenge/);
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

test('the live renderer cannot reach the event log (static import boundary)', () => {
  // The boundary is enforced structurally, not by convention: renderer.ts may
  // depend on cognitive state, and on nothing that reads persisted history.
  const source = readFileSync(fileURLToPath(new URL('../src/prompt/renderer.ts', import.meta.url)), 'utf8');
  const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
  assert.ok(imports.length > 0, 'the renderer imports something');
  for (const specifier of imports) {
    assert.match(specifier, /^\.\.\/cognitive\//, `renderer must not import ${specifier}`);
  }
  assert.doesNotMatch(source, /node:fs|storage\/|projection\/|JsonlSink|parseCognitiveEvent/);
});

test('history cannot change an otherwise identical live prompt', async () => {
  // 200 historical gaps across an old session: a projection of them is real,
  // and none of it may reach the current prompt.
  const historical = [];
  for (let i = 0; i < 200; i += 1) {
    historical.push(
      makeEvent(
        'knowledge_gap.detected',
        { topic: `historical-topic-${i}`, result: 'skipped', origin: 'skipped_answer' },
        { sessionId: 'old-session', timestamp: `2026-08-01T00:00:${String(i % 60).padStart(2, '0')}.000Z` },
      ),
    );
  }
  const projection = buildProjection(historical);
  assert.equal(projection.sessions.length, 1);
  assert.equal(projection.sessions[0].eventCount, 200);

  const now = () => new Date('2026-09-11T00:00:00.000Z');
  const quiet = new CognitiveController({ config: {}, sink: new MemorySink(), logger: () => {}, now });
  const noisy = new CognitiveController({ config: {}, sink: new MemorySink(historical), logger: () => {}, now });
  await quiet.start();
  await noisy.start();

  const signals = [
    { sessionId: 's1', kind: 'user_message', text: 'Refactor the storage layer so we can support three backends.' },
    { sessionId: 's1', kind: 'user_message', text: 'I think the storage interface leaks backend details.' },
  ];
  for (const signal of signals) {
    await quiet.handle('s1', signal);
    await noisy.handle('s1', signal);
    assert.equal(
      noisy.renderSection('s1'),
      quiet.renderSection('s1'),
      `history must be invisible to the prompt after "${signal.text.slice(0, 24)}..."`,
    );
  }

  // The gate rendered the same text it would have with no history at all.
  assert.equal(quiet.renderSection('s1'), '', 'the answered gate cleared the directive in both arms');
  for (let i = 0; i < 200; i += 1) {
    assert.equal(noisy.renderSection('s1').includes(`historical-topic-${i}`), false);
  }
});

test('a directive renders identically for equal states built from different histories', () => {
  const makeState = () => stateWith({ taskType: 'architecture', currentTopic: 'refactor-storage', pendingGate: true, lastGateTopic: 'refactor-storage' });
  assert.equal(renderCognitiveSection(makeState()), renderCognitiveSection(makeState()));
  assert.match(renderCognitiveSection(makeState()), /Reasoning gate/);
});

test('every directive is bounded, whatever the state contains', () => {
  const hostileTopic = 'a'.repeat(100_000);
  const states = [
    stateWith({ taskType: 'architecture', currentTopic: 'refactor-storage', pendingGate: true, lastGateTopic: 'refactor-storage' }),
    stateWith({ taskType: 'debugging', currentTopic: 'duplicate-jobs', lastActionType: 'prompt', lastActionTopic: 'duplicate-jobs' }),
    stateWith({ taskType: 'architecture', currentTopic: 'refactor-storage', teachingBackPending: true, completedHighValueTopic: 'refactor-storage' }),
    stateWith({ taskType: 'architecture', currentTopic: hostileTopic, pendingGate: true, lastGateTopic: hostileTopic }),
    stateWith({ taskType: 'architecture', currentTopic: hostileTopic, teachingBackPending: true, completedHighValueTopic: hostileTopic }),
  ];
  for (const state of states) {
    const text = renderCognitiveSection(state);
    assert.ok(text.length > 0);
    assert.ok(text.length <= 1200, `section too long: ${text.length}`);
  }
});