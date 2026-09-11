import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapSessionEvent, resolveEventsPath } from '../lib/dsh-adapter.js';

test('a real human prompt maps to a user_message signal', () => {
  const signal = mapSessionEvent('s1', {
    type: 'user/message',
    data: { content: [{ type: 'text', text: 'Refactor the storage layer.' }], source: { kind: 'user' } },
  });
  assert.deepEqual(signal, { sessionId: 's1', kind: 'user_message', text: 'Refactor the storage layer.' });
});

test('an inbox splice carries the request before prompt assembly', () => {
  const signal = mapSessionEvent('s1', {
    type: 'agent/inbox/spliced',
    data: {
      target: 'next-turn',
      start: 0,
      inserted: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Refactor the storage layer so we can support three backends.' }],
          source: { kind: 'user' },
        },
      ],
    },
  });
  assert.deepEqual(signal, {
    sessionId: 's1',
    kind: 'user_message',
    text: 'Refactor the storage layer so we can support three backends.',
  });
});

test('an inbox splice that only removes messages is not a signal', () => {
  assert.equal(mapSessionEvent('s1', { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } }), null);
});

test('an inbox splice of synthetic input is not a signal', () => {
  assert.equal(
    mapSessionEvent('s1', {
      type: 'agent/inbox/spliced',
      data: { target: 'next-turn', start: 0, inserted: [{ content: [{ type: 'text', text: 'notice' }], source: { kind: 'plugin', plugin: 'x' } }] },
    }),
    null,
  );
});

test('synthetic injected context is not a cognitive signal', () => {
  const signal = mapSessionEvent('s1', {
    type: 'user/message',
    data: { content: [{ type: 'text', text: 'AGENTS.md content' }], source: { kind: 'plugin', plugin: 'x' } },
  });
  assert.equal(signal, null);
});

test('assistant messages and turn boundaries map', () => {
  assert.equal(mapSessionEvent('s1', { type: 'assistant/message', data: { content: [{ type: 'text', text: 'done' }] } }).kind, 'assistant_message');
  assert.equal(mapSessionEvent('s1', { type: 'turn/end', data: { turn: 1, reason: 'success' } }).kind, 'turn_end');
  assert.equal(mapSessionEvent('s1', { type: 'turn/start', data: { turn: 1 } }).kind, 'turn_start');
});

test('unrelated events map to null', () => {
  assert.equal(mapSessionEvent('s1', { type: 'step/end', data: {} }), null);
  assert.equal(mapSessionEvent('s1', {}), null);
  // A tool-only assistant step still has empty assistant text; it is a real
  // completion signal for the teaching-back trigger, so it must not be dropped.
  assert.deepEqual(mapSessionEvent('s1', { type: 'assistant/message', data: {} }), {
    sessionId: 's1',
    kind: 'assistant_message',
    text: '',
  });
});

test('the default events path follows the DSH home convention', () => {
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = '/tmp/dsh-home-test';
  try {
    assert.equal(resolveEventsPath({}), '/tmp/dsh-home-test/cognitive-feedback/events.jsonl');
    assert.equal(resolveEventsPath({ eventsPath: '/custom/events.jsonl' }), '/custom/events.jsonl');
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
});