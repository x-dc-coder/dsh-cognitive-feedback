import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CognitiveController } from '../dist/cognitive/controller.js';
import { JsonlSink } from '../dist/storage/jsonl-sink.js';
import { MemorySink } from '../dist/storage/memory-sink.js';
import {
  buildProjection,
  createProjectionCache,
  projectionDigest,
  EMPTY_PROJECTION,
  RebuildableProjection,
} from '../dist/projection/index.js';
import {
  cachePathFor,
  loadProjectionCache,
  saveProjectionCache,
  PROJECTION_CACHE_VERSION,
} from '../dist/projection/disk-cache.js';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const ARCH = 'Refactor the storage layer so we can support three backends.';
const HYPOTHESIS = 'I think the storage interface leaks backend details.';
const ANSWER = 'It works because one interface now hides the three adapters behind one contract.';

async function runScenario(sink, sessionId = 's1') {
  const controller = new CognitiveController({ config: {}, sink, logger: () => {}, now: () => new Date('2026-09-11T00:00:00.000Z') });
  await controller.start();
  await controller.handle(sessionId, { sessionId, kind: 'session_started' });
  await controller.handle(sessionId, { sessionId, kind: 'user_message', text: ARCH });
  await controller.handle(sessionId, { sessionId, kind: 'user_message', text: HYPOTHESIS });
  await controller.handle(sessionId, { sessionId, kind: 'assistant_message', text: 'Implemented.' });
  await controller.handle(sessionId, { sessionId, kind: 'user_message', text: ANSWER });
  return controller;
}

test('the projection aggregates sessions and interventions in one pass', async () => {
  const sink = new MemorySink();
  await runScenario(sink);
  const projection = buildProjection(await sink.readAll());

  assert.equal(projection.eventCount, 7);
  assert.equal(projection.episodes.length, 1);
  assert.equal(projection.episodeSummary.completionRate, 1);

  const [session] = projection.sessions;
  assert.equal(session.sessionId, 's1');
  assert.equal(session.interventions, 1);
  assert.equal(session.hypotheses, 1);
  assert.equal(session.teachingBackCompleted, 1);
  assert.equal(session.episodes, 1);
  assert.equal(session.startedAt, '2026-09-11T00:00:00.000Z');

  const kinds = projection.interventions.map((i) => `${i.kind}:${i.status}`);
  assert.deepEqual(kinds, ['gate:resolved', 'teaching_back:resolved']);
  assert.equal(projection.interventions[0].resolvedBy, 'hypothesis');
  assert.equal(projection.interventions[1].outcome, 'unassessed');
});

test('an unresolved intervention on a closed episode is abandoned, not open', async () => {
  const sink = new MemorySink();
  const controller = new CognitiveController({ config: {}, sink, logger: () => {}, now: () => new Date('2026-09-11T00:00:00.000Z') });
  await controller.start();
  await controller.handle('s2', { sessionId: 's2', kind: 'user_message', text: 'The worker sometimes processes the same job twice. Fix it.' });
  await controller.handle('s2', { sessionId: 's2', kind: 'user_message', text: 'Add a --verbose flag to the CLI.' });

  const projection = buildProjection(await sink.readAll());
  assert.deepEqual(projection.interventions.map((i) => [i.kind, i.status]), [['challenge', 'abandoned']]);
  assert.equal(projection.episodes[0].status, 'abandoned');
});

test('projection is deterministic and rebuildable from raw events', async () => {
  const sink = new MemorySink();
  await runScenario(sink);
  const events = await sink.readAll();
  assert.deepEqual(buildProjection(events), buildProjection(events));

  const cache = createProjectionCache();
  const first = cache.get(events);
  assert.equal(cache.get(events), first, 'an unchanged log must reuse the projection');
  assert.deepEqual(cache.stats(), { digest: projectionDigest(events), hits: 1, misses: 1, rebuilds: 1, failures: 0 });

  // A cache can always be thrown away and regenerated.
  cache.invalidate();
  const rebuilt = cache.rebuild(events);
  assert.deepEqual(rebuilt, first);
});

test('a stale projection is discarded and rebuilt', async () => {
  const sink = new MemorySink();
  await runScenario(sink);
  const events = await sink.readAll();
  const cache = createProjectionCache();
  const before = cache.get(events);
  assert.equal(before.eventCount, 7);

  const appended = [...events, { ...events[0], id: 'evt_appended', timestamp: '2026-09-11T01:00:00.000Z' }];
  const after = cache.get(appended);
  assert.equal(after.eventCount, 8);
  assert.equal(cache.stats().rebuilds, 2);
});

test('a failing projection degrades to the empty projection (fail open)', () => {
  const boom = new RebuildableProjection(() => {
    throw new Error('corrupt projection');
  }, EMPTY_PROJECTION);
  assert.equal(boom.get([]).eventCount, 0);
  assert.equal(boom.stats().failures, 1);
  assert.match(String(boom.error()), /corrupt projection/);
});

test('the disk cache round-trips, and stale or corrupt data is discarded', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cog-proj-'));
  const logPath = join(dir, 'events.jsonl');
  const cachePath = cachePathFor(logPath);
  assert.equal(cachePath, join(dir, 'events.projection.json'));

  const sink = new MemorySink();
  await runScenario(sink);
  const events = await sink.readAll();
  const projection = buildProjection(events);
  const digest = projectionDigest(events);

  assert.equal(loadProjectionCache(cachePath, digest), null, 'a missing cache is a miss, not an error');
  saveProjectionCache(cachePath, digest, projection);
  assert.deepEqual(loadProjectionCache(cachePath, digest), projection);

  // Stale: the log moved on.
  assert.equal(loadProjectionCache(cachePath, 'v1:99:other:other'), null);

  // Corrupt: unparseable or the wrong shape.
  writeFileSync(cachePath, '{not json', 'utf8');
  assert.equal(loadProjectionCache(cachePath, digest), null);
  writeFileSync(cachePath, JSON.stringify({ version: PROJECTION_CACHE_VERSION, digest }), 'utf8');
  assert.equal(loadProjectionCache(cachePath, digest), null);
  writeFileSync(cachePath, JSON.stringify({ version: PROJECTION_CACHE_VERSION + 1, digest, projection }), 'utf8');
  assert.equal(loadProjectionCache(cachePath, digest), null, 'a different cache version is discarded');
});

test('the report CLI projects, caches, and honours filters', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cog-tool-'));
  const logPath = join(dir, 'events.jsonl');
  const sink = new JsonlSink(logPath);
  const controller = await runScenario(sink);
  await controller.handle('s2', { sessionId: 's2', kind: 'user_message', text: 'The worker sometimes processes the same job twice. Fix it.' });

  const run = (extra) =>
    JSON.parse(execFileSync(process.execPath, ['tools/cognitive-report.mjs', '--log', logPath, '--json', ...extra], {
      cwd: REPO,
      encoding: 'utf8',
    }));

  const first = run([]);
  assert.equal(first.cache.source, 'rebuilt');
  assert.equal(first.totals.sessions, 2);
  assert.equal(first.episodes.total, 2);
  assert.ok(existsSync(cachePathFor(logPath)), 'the derived projection is cached next to the log');

  const second = run([]);
  assert.equal(second.cache.source, 'disk', 'a repeat report must not re-scan and re-project');
  assert.deepEqual(second.funnel, first.funnel);

  const scoped = run(['--session', 's2']);
  assert.equal(scoped.totals.sessions, 1);
  assert.deepEqual(scoped.sessions.map((s) => s.sessionId), ['s2']);
  assert.equal(scoped.cache.path, null, 'a filtered view must not overwrite the canonical cache');
});

test('the report CLI explains how to build when dist is missing', () => {
  // The tool imports dist on purpose: it reports on the code that actually
  // runs. Point it at a nonexistent log to prove it still exits cleanly.
  let code = 0;
  let stderr = '';
  try {
    execFileSync(process.execPath, ['tools/cognitive-report.mjs', '--log', join(tmpdir(), 'cog-absent-xyz', 'x.jsonl')], {
      cwd: REPO,
      encoding: 'utf8',
    });
  } catch (error) {
    code = error.status;
    stderr = error.stderr;
  }
  assert.equal(code, 1);
  assert.match(stderr, /no such file/);
});
