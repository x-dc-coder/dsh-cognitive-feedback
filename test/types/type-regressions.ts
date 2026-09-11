/**
 * Type-level regressions.
 *
 * This file is compiled by \`npm run typecheck\` (tsconfig.typecheck.json) and
 * is never executed. Each \`@ts-expect-error\` fails the build if the rejection it
 * asserts stops happening, so a widening of these types is caught rather than
 * silently accepted.
 *
 * Covers the three cases the TypeScript migration issue calls out: a wrong
 * event payload, an unknown event type, and an illegal state transition.
 */
import { makeEvent } from '../../src/events/factory.js';
import { parseCognitiveEvent } from '../../src/events/queries.js';
import type { CognitiveEvent, CognitiveEventType } from '../../src/events/types.js';
import { createState } from '../../src/cognitive/state.js';
import { activeIntervention, decide } from '../../src/cognitive/policy.js';
import { renderCognitiveSection } from '../../src/prompt/renderer.js';

// 1. A known event type with the WRONG payload is rejected.
// @ts-expect-error -- 'session.started' requires { project: string | null }
makeEvent('session.started', { level: 3 }, { sessionId: 's' });

// 2. An UNKNOWN event type is rejected.
// @ts-expect-error -- 'session.exploded' is not part of the event vocabulary
makeEvent('session.exploded', {}, { sessionId: 's' });

// 3. An out-of-range intervention level is rejected.
// @ts-expect-error -- level must be 0 | 1 | 2 | 3
makeEvent('intervention.triggered', { level: 9, reason: 'x', taskType: null, topic: null }, { sessionId: 's' });

// 4. The matching payload compiles.
const wellFormed = makeEvent(
  'intervention.triggered',
  { level: 3, reason: 'architecture', taskType: 'architecture', topic: null },
  { sessionId: 's' },
);
void wellFormed;

// 5. Narrowing on 'type' yields the matching payload shape.
function describe(event: CognitiveEvent): string {
  switch (event.type) {
    case 'intervention.triggered':
      return `level ${event.payload.level}`;
    case 'teaching_back.completed':
      return event.payload.result;
    case 'decision.recorded':
      return event.payload.owner;
    default:
      return event.type;
  }
}
void describe;

// 6. Parsed input narrows from 'unknown' to a fully typed event.
const parsed = parseCognitiveEvent(JSON.parse('{"schemaVersion":1}'));
if (parsed !== null) {
  const type: CognitiveEventType = parsed.type;
  void type;
}

// 7. An illegal state transition is rejected.
const state = createState('s');
// @ts-expect-error -- 'chaotic' is not a CognitiveMode
state.mode = 'chaotic';
state.mode = 'research';
state.stateVersion = 3;
void state;

// 8. An invalid task type is rejected.
// @ts-expect-error -- 'gardening' is not a TaskType
state.taskType = 'gardening';

// 9. PolicyAction is a union: 'prompt' carries a level, 'teaching_back' does not.
const action = decide(state);
if (action.type === 'prompt') {
  const level: 1 | 2 = action.level;
  void level;
}
if (action.type === 'teaching_back') {
  // @ts-expect-error -- the teaching_back variant has no 'level' field
  void action.level;
}

// 10. ActiveIntervention narrows by kind.
const active = activeIntervention(state);
if (active !== null && active.kind === 'gate') {
  const reason: string = active.reason;
  void reason;
}
// @ts-expect-error -- a gate has no 'result' field
void active?.result;

// 11. The renderer returns a string for a fully typed state.
const rendered: string = renderCognitiveSection(state);
void rendered;
