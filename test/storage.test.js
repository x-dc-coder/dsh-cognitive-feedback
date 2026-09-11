import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlSink } from '../lib/storage/jsonl-sink.js';
import { MemorySink } from '../lib/storage/memory-sink.js';
import { makeEvent } from '../lib/events.js';
import { SCHEMA_VERSION } from '../lib/types.js';

const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'cog-')), 'events.jsonl');

test('every event carries the schema version and a unique id', () => {
  const a = makeEvent('session.started', {}, { sessionId: 's1' });
  const b = makeEvent('session.started', {}, { sessionId: 's1' });
  assert.equal(a.schemaVersion, SCHEMA_VERSION);
  assert.notEqual(a.id, b.id);
  assert.ok(!Number.isNaN(Date.parse(a.timestamp)));
});

test('JSONL sink appends and reads back', async () => {
  const sink = new JsonlSink(tmpFile());
  await sink.append(makeEvent('session.started', {}, { sessionId: 's1' }));
  await sink.append(makeEvent('intervention.triggered', { level: 3 }, { sessionId: 's1' }));
  const events = await sink.readAll();
  assert.equal(events.length, 2);
  assert.equal(events[1].payload.level, 3);
});

test('JSONL output is append-only', async () => {
  const path = tmpFile();
  const sink = new JsonlSink(path);
  await sink.append(makeEvent('session.started', { n: 1 }, { sessionId: 's1' }));
  const first = readFileSync(path, 'utf8');
  await sink.append(makeEvent('session.ended', { n: 2 }, { sessionId: 's1' }));
  const second = readFileSync(path, 'utf8');
  assert.ok(second.startsWith(first), 'earlier bytes must never be rewritten');
});

test('a malformed persistence line does not crash the reader', async () => {
  const path = tmpFile();
  const sink = new JsonlSink(path);
  await sink.append(makeEvent('session.started', {}, { sessionId: 's1' }));
  appendFileSync(path, '{not json}\n', 'utf8');
  await sink.append(makeEvent('session.ended', {}, { sessionId: 's1' }));
  const events = await sink.readAll();
  assert.equal(events.length, 2);
});

test('reading a missing file yields an empty log', async () => {
  const sink = new JsonlSink(join(tmpdir(), 'cog-absent', 'events.jsonl'));
  assert.deepEqual(await sink.readAll(), []);
});

test('MemorySink can inject a failure for fail-open tests', async () => {
  const sink = new MemorySink();
  sink.failWith = 'disk full';
  await assert.rejects(() => sink.append(makeEvent('session.started', {}, { sessionId: 's1' })));
  await sink.append(makeEvent('session.started', {}, { sessionId: 's1' }));
  assert.equal((await sink.readAll()).length, 1);
});
