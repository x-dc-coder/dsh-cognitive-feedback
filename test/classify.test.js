import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeMessage, classifyTask, hasHypothesis, isRoutine, topicKey } from '../dist/cognitive/classify.js';

test('routine work is detected and classified as implementation', () => {
  for (const text of [
    'Add a --verbose flag to the CLI.',
    'Just implement the boilerplate for me.',
    'Fix the typo in the docs.',
    'Write tests for the parser.',
  ]) {
    assert.equal(isRoutine(text), true, text);
    assert.equal(analyzeMessage(text).taskType, 'implementation', text);
  }
});

test('architecture, debugging, research and explanation are classified', () => {
  assert.equal(classifyTask('Refactor the storage layer so we can support three backends.'), 'architecture');
  assert.equal(classifyTask('Design a new schema for the events table.'), 'architecture');
  assert.equal(classifyTask('The worker sometimes processes the same job twice. It crashes.'), 'debugging');
  assert.equal(classifyTask('Why does the worker hang on shutdown?'), 'debugging');
  assert.equal(classifyTask('Let us benchmark a new adaptive partitioning strategy.'), 'research');
  assert.equal(classifyTask('What is a Cordis service?'), 'explanation');
});

test('a plain request defaults to implementation', () => {
  assert.equal(classifyTask('Print the current time.'), 'implementation');
});

test('evaluation and selection tasks are treated as high-value', () => {
  // An independent functional review found these slipped through as plain
  // implementation, even though COGNITIVE_MODEL.md lists selection as
  // high-value cognitive debt.
  for (const text of [
    'Investigate whether Redis or Postgres is better for this workload',
    'Could you look into the best caching approach?',
    'Which is better for this workload, Redis or Postgres?',
    'Compare the two approaches for the storage layer',
    'What are the trade-offs between the two designs?',
    'Help me decide whether to use a queue or a log',
  ]) {
    const taskType = classifyTask(text);
    assert.ok(taskType === 'research' || taskType === 'architecture', `${taskType}: ${text}`);
  }
});

test('the new selection patterns do not over-trigger on routine work', () => {
  for (const text of [
    'Add a --verbose flag to the CLI.',
    'Fix the typo in README.',
    'Rename the refactor variable.',
    'Write tests for the parser.',
    'Just implement the boilerplate.',
    'Rename the architecture.md file to architecture-old.md',
    'Print the current time.',
    'Format the JSON output.',
  ]) {
    // The effective classification is what matters: routine precedence runs in
    // analyzeMessage, not in the raw classifyTask.
    assert.equal(analyzeMessage(text).taskType, 'implementation', text);
  }

  // "Rename the architecture.md file ..." contains a high-value keyword, so the
  // raw classifier still sees architecture; routine precedence is what must win
  // end to end. This is the case an independent review checked live.
  const keywordBait = 'Rename the architecture.md file to architecture-old.md';
  assert.equal(isRoutine(keywordBait), true);
  assert.equal(classifyTask(keywordBait), 'architecture');
  assert.equal(analyzeMessage(keywordBait).taskType, 'implementation');
});

test('user-authored hypotheses are detected', () => {
  assert.equal(hasHypothesis('I think the race condition is caused by two workers.'), true);
  assert.equal(hasHypothesis('My hypothesis is that the cache is stale.'), true);
  assert.equal(hasHypothesis('Fix it.'), false);
});

test('topic keys are bounded even for hostile input', () => {
  // The key is the one user-derived string that can reach the system prompt.
  // An uncapped key let a single multi-megabyte token inflate the section.
  const huge = 'a'.repeat(2_000_000);
  const key = topicKey(`Refactor ${huge} please`);
  assert.ok(key.length <= 64, `topic key must be capped, got ${key.length}`);
  assert.ok(topicKey('Refactor the storage layer for three backends').length <= 64);
});

test('topic keys are deterministic and ignore noise', () => {
  const a = topicKey('Refactor the storage layer for three backends');
  const b = topicKey('Refactor the storage layer for three backends');
  assert.equal(a, b);
  assert.notEqual(a, topicKey('Debug the worker duplicate processing'));
});