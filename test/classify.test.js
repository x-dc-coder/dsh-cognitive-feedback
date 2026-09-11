import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeMessage, classifyTask, hasHypothesis, isRoutine, topicKey } from '../lib/classify.js';

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