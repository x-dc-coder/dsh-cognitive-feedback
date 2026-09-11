import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installAdapter } from '../dist/dsh-adapter.js';
import { CognitiveController } from '../dist/cognitive/controller.js';

/**
 * The DSH integration boundary is where both real defects of this project
 * lived (a Cordis inject gate that blocked profile boot, and the
 * prompt-assembly ordering bug), so it must be covered by tests rather than
 * only by live runs.
 *
 * These tests drive `installAdapter` through a fake Cordis context that records
 * subscriptions, section registrations, and warnings.
 */
function makeFakeCtx(options = {}) {
  /** @type {Map<string, Function[]>} */
  const listeners = new Map();
  /** @type {any[]} */
  const sections = [];
  const warnings = [];
  /** @type {string[][]} */
  const injectCalls = [];
  /** Every property touched on the context, to prove no tool surface is used. */
  const touched = new Set();
  const thrown = new Set(options.throwOn ?? []);

  const record = (event, handler) => {
    if (thrown.has(event)) throw new Error(`subscription refused: ${event}`);
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push(handler);
    return () => {
      const list = listeners.get(event) ?? [];
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    };
  };

  const scoped = {
    on: record,
    systemPrompt: {
      section(definition) {
        sections.push(definition);
        return () => {
          const index = sections.indexOf(definition);
          if (index >= 0) sections.splice(index, 1);
        };
      },
    },
  };

  const ctx = {
    on: record,
    systemPrompt: scoped.systemPrompt,
    inject(deps, callback) {
      injectCalls.push(deps);
      if (thrown.has('inject')) throw new Error('inject refused');
      callback(scoped);
    },
    logger: { warn: (message) => warnings.push(message) },
  };

  return {
    ctx,
    sections,
    warnings,
    injectCalls,
    touched,
    listeners,
    /** Dispatch an event to every current listener. */
    emit(event, ...args) {
      for (const handler of [...(listeners.get(event) ?? [])]) handler(...args);
    },
    /** Let the adapter's asynchronous startup settle. */
    async settle() {
      for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

/** A minimal stand-in for a DSH Agent handle. */
function makeAgent(id) {
  const agentSections = [];
  return {
    id,
    sections: agentSections,
    ctx: {
      systemPrompt: {
        section(definition) {
          agentSections.push(definition);
          return () => {};
        },
      },
    },
  };
}

test('the host fallback and the agent-scoped section share ONE name', async () => {
  // DSH shadows sections BY NAME ONLY. Registering the fallback under a
  // distinct name (e.g. "cognitive-feedback:global") means it is NOT shadowed
  // and BOTH render, injecting the directive twice into the same prompt. That
  // shipped once: a real prompt contained the block twice, and only a
  // cardinality check (not a presence check) exposes it.
  const fake = makeFakeCtx();
  const controller = installAdapter(fake.ctx, { eventsPath: ':memory:' });
  await fake.settle();

  const agent = makeAgent('session-1');
  fake.emit('agent/created', { agent });

  const names = [...fake.sections, ...agent.sections].map((section) => section.name);
  assert.ok(names.length >= 2, 'both the fallback and the agent-scoped section must be registered');
  assert.equal(new Set(names).size, 1, `all registrations must share one name, got ${JSON.stringify(names)}`);
});

test('an active intervention renders exactly one COGNITIVE FEEDBACK block', async () => {
  const fake = makeFakeCtx();
  const controller = installAdapter(fake.ctx, { eventsPath: ':memory:' });
  await fake.settle();
  const agent = makeAgent('session-1');
  fake.emit('agent/created', { agent });

  const section = agent.sections[0];
  const text = section.text();
  assert.equal(text, '', 'inactive state contributes nothing');

  fake.emit('session/event', { id: 'session-1' }, {
    type: 'agent/inbox/spliced',
    data: { target: 'next-turn', start: 0, inserted: [{ content: [{ type: 'text', text: 'Refactor the storage layer so we can support three backends.' }], source: { kind: 'user' } }] },
  });

  // Cardinality, not presence: presence is what let the duplication through.
  const blocks = (section.text().match(/\[COGNITIVE FEEDBACK\]/g) ?? []).length;
  assert.equal(blocks, 1, 'the directive must appear exactly once');
});

test('the plugin registers no tools, so the tool schema set never changes', async () => {
  const fake = makeFakeCtx();
  const controller = installAdapter(fake.ctx, { eventsPath: ':memory:' });
  await fake.settle();

  // Cache safety depends on this: a tool-schema change prevents provider cache
  // reuse from the first altered token. The plugin must only ever ask for the
  // system-prompt service.
  assert.deepEqual(fake.injectCalls, [['systemPrompt']]);
  const serialized = JSON.stringify(fake.injectCalls) + JSON.stringify(fake.sections.map((s) => s.name));
  assert.doesNotMatch(serialized, /tool/i);
});

test('installAdapter wires the observation and injection surfaces', async () => {
  const fake = makeFakeCtx();
  const controller = installAdapter(fake.ctx, { eventsPath: ':memory:', sectionOrder: 700 });
  await fake.settle();

  // One global fallback section at the configured order.
  assert.equal(fake.sections.length, 1);
  assert.equal(fake.sections[0].order, 700);
  // The fallback shares the canonical name so the agent-scoped registration
  // shadows it (see the dedicated shadowing test).
  assert.equal(fake.sections[0].name, 'cognitive-feedback');

  // An agent gets its own scoped section at the same order.
  const agent = makeAgent('session-abc');
  fake.emit('agent/created', { agent });
  assert.equal(agent.sections.length, 1);
  assert.equal(agent.sections[0].order, 700);
  assert.equal(agent.sections[0].name, 'cognitive-feedback');
});

test('a request spliced into the inbox reaches the section during the same assembly', async () => {
  const fake = makeFakeCtx();
  const controller = installAdapter(fake.ctx, { eventsPath: ':memory:' });
  await fake.settle();

  const agent = makeAgent('session-1');
  fake.emit('agent/created', { agent });
  const section = agent.sections[0];

  assert.equal(section.text(), '', 'no intervention before any request');

  // The inbox splice is what lands before the step's prompt assembly.
  fake.emit('session/event', { id: 'session-1' }, {
    type: 'agent/inbox/spliced',
    data: {
      target: 'next-turn',
      start: 0,
      inserted: [{ role: 'user', content: [{ type: 'text', text: 'Refactor the storage layer so we can support three backends.' }], source: { kind: 'user' } }],
    },
  });

  assert.match(section.text(), /COGNITIVE FEEDBACK/);
  assert.match(section.text(), /an architecture decision/);
  assert.equal(controller.strongUsed, 1);
});

test('the same request delivered twice is decided once', async () => {
  const fake = makeFakeCtx();
  const controller = installAdapter(fake.ctx, { eventsPath: ':memory:' });
  await fake.settle();

  const text = 'Refactor the storage layer so we can support three backends.';
  const splice = { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [{ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }] } };
  const logged = { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } };

  fake.emit('session/event', { id: 'session-1' }, splice);
  fake.emit('session/event', { id: 'session-1' }, logged);

  assert.equal(controller.strongUsed, 1, 'a duplicate delivery must not double-charge the budget');
  const events = await controller.sink.readAll();
  assert.equal(events.filter((e) => e.type === 'intervention.triggered').length, 1);
});

test('every registration goes through ctx, so the framework owns cleanup', async () => {
  // The Harness lifecycle contract disposes ctx registrations on unload, so the
  // plugin exposes no dispose() and keeps no private disposer list. This test
  // pins that contract: installAdapter returns the controller itself, and the
  // subscriptions are all visible on the ctx it was given.
  const fake = makeFakeCtx();
  const controller = installAdapter(fake.ctx, { eventsPath: ':memory:' });
  await fake.settle();

  assert.ok(controller instanceof CognitiveController, 'returns the controller, not a lifecycle handle');
  assert.equal(typeof controller.dispose, 'undefined', 'no private disposal surface');
  for (const event of ['session/created', 'session/disposed', 'session/event']) {
    assert.ok(fake.listeners.has(event), `subscribed via ctx.on: ${event}`);
  }
});

test('a failing subscription is logged, not thrown', async () => {
  const fake = makeFakeCtx({ throwOn: ['session/event'] });
  assert.doesNotThrow(() => {
    installAdapter(fake.ctx, { eventsPath: ':memory:' });
  });
  await fake.settle();
  assert.ok(fake.warnings.some((w) => w.includes('session/event')), `expected a warning, got ${JSON.stringify(fake.warnings)}`);
});

test('an unavailable systemPrompt service degrades instead of throwing', async () => {
  const fake = makeFakeCtx({ throwOn: ['inject'] });
  assert.doesNotThrow(() => {
    installAdapter(fake.ctx, { eventsPath: ':memory:' });
  });
  await fake.settle();
  assert.equal(fake.sections.length, 0, 'no section is registered without the service');
  assert.ok(fake.warnings.some((w) => w.includes('systemPrompt')));
});

test('a hostile event payload cannot escape into the host dispatcher', async () => {
  const fake = makeFakeCtx();
  const controller = installAdapter(fake.ctx, { eventsPath: ':memory:' });
  await fake.settle();

  // An accessor that throws must be contained by the listener guard: a throw
  // escaping into DSH dispatch would break coding, which fail-open forbids.
  assert.doesNotThrow(() => fake.emit('session/event', { id: 's1' }, { get type() { throw new Error('boom'); } }));
  assert.doesNotThrow(() => fake.emit('session/event', { get id() { throw new Error('boom'); } }, { type: 'turn/end' }));
  assert.doesNotThrow(() => fake.emit('session/created', { get id() { throw new Error('boom'); } }));
  assert.ok(fake.warnings.length > 0, 'contained failures are logged');
});

test('a failing session/created subscription still leaves the plugin usable', async () => {
  const fake = makeFakeCtx({ throwOn: ['session/created'] });
  installAdapter(fake.ctx, { eventsPath: ':memory:' });
  await fake.settle();
  assert.ok(fake.warnings.length > 0);
});