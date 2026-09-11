import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEvent } from '../dist/events/factory.js';
import { countRecentInterventions } from '../dist/events/queries.js';

/** Build an intervention event at an exact time. */
const interventionAt = (iso, level) => ({
  schemaVersion: 1,
  id: iso,
  timestamp: iso,
  sessionId: 's1',
  type: 'intervention.triggered',
  payload: { level },
});

test('the intervention budget uses a rolling 24-hour window', () => {
  const now = Date.parse('2026-09-11T12:00:00.000Z');
  const events = [
    interventionAt('2026-09-11T11:00:00.000Z', 3), // 1h ago  → inside
    interventionAt('2026-09-10T13:00:00.000Z', 3), // 23h ago → inside
    interventionAt('2026-09-10T11:00:00.000Z', 3), // 25h ago → outside
  ];
  assert.equal(countRecentInterventions(events, { now, strongOnly: true }), 2);
  assert.equal(countRecentInterventions(events, { now }), 2);
});

test('strong-only counting ignores light interventions', () => {
  const now = Date.parse('2026-09-11T12:00:00.000Z');
  const events = [
    interventionAt('2026-09-11T11:00:00.000Z', 3),
    interventionAt('2026-09-11T11:30:00.000Z', 2),
    interventionAt('2026-09-11T11:45:00.000Z', 1),
  ];
  assert.equal(countRecentInterventions(events, { now, strongOnly: true }), 1);
  assert.equal(countRecentInterventions(events, { now, strongOnly: false }), 3);
});

test('only intervention.triggered events count, and malformed timestamps are ignored', () => {
  const now = Date.parse('2026-09-11T12:00:00.000Z');
  const events = [
    makeEvent('session.started', {}, { sessionId: 's1' }),
    { schemaVersion: 1, id: 'x', timestamp: 'not-a-date', sessionId: 's1', type: 'intervention.triggered', payload: { level: 3 } },
    interventionAt('2026-09-11T11:00:00.000Z', 3),
  ];
  assert.equal(countRecentInterventions(events, { now, strongOnly: true }), 1);
});
