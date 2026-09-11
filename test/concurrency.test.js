import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CognitiveController } from '../dist/cognitive/controller.js';
import { JsonlSink } from '../dist/storage/jsonl-sink.js';

const msg = (sessionId, text) => ({ sessionId, kind: 'user_message', text });

test('concurrent sessions persist well-formed, non-interleaved JSONL', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'cog-conc-')), 'events.jsonl');
  const sink = new JsonlSink(path);
  const controller = new CognitiveController({ config: {}, sink, logger: () => {} });
  await controller.start();

  // Two independent sessions decided and persisted without awaiting in between.
  await Promise.all([
    controller.handle('s1', msg('s1', 'Refactor the storage layer so we can support three backends.')),
    controller.handle('s2', msg('s2', 'Benchmark a new adaptive partitioning strategy.')),
  ]);

  // The reader already drops malformed lines, so also check the raw file: a
  // torn write would show up as a line that does not parse.
  const rawLines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  assert.equal(rawLines.length, 2, 'one intervention event per session');
  for (const line of rawLines) assert.doesNotThrow(() => JSON.parse(line), line);

  const events = await sink.readAll();
  assert.deepEqual(events.map((e) => e.sessionId).sort(), ['s1', 's2']);
  assert.ok(events.every((e) => e.type === 'intervention.triggered'));
  assert.equal(controller.strongUsed, 2, 'both gates consume budget');
});
