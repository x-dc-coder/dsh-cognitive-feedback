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
import type { CognitiveEvent, CognitiveEventType, PreparedEvent } from '../../src/events/types.js';
import { createState, type TeachingBackResult } from '../../src/cognitive/state.js';
import { activeIntervention, decide } from '../../src/cognitive/policy.js';
import { renderCognitiveSection } from '../../src/prompt/renderer.js';
import { extractTeachingBackEvidence, type TeachingBackEvidence } from '../../src/cognitive/teaching-back.js';
import { normalizeTopic, topicKey } from '../../src/cognitive/classify.js';
import { buildProjection, type CognitiveProjection } from '../../src/projection/index.js';
import { computeMetrics, type CognitiveMetrics } from '../../src/projection/metrics.js';
import { reconstructEpisodes, type CognitiveEpisode } from '../../src/projection/episodes.js';
import { topicLearningStates, type TopicLearningState } from '../../src/projection/learning.js';

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

// 12. Correlation fields are typed and additive on any event type.
const correlatedEvent: CognitiveEvent = makeEvent(
  'session.started',
  { project: null },
  { sessionId: 's', episodeId: 'ep_1', interventionId: 'iv_1' },
);
const correlatedPrepared: PreparedEvent = {
  type: 'episode.closed',
  payload: { outcome: 'completed', reason: 'teaching-back-completed' },
  episodeId: 'ep_1',
};
void correlatedEvent;
void correlatedPrepared;
// @ts-expect-error -- an episode correlation id must be a string
makeEvent('session.started', { project: null }, { sessionId: 's', episodeId: 42 });
// @ts-expect-error -- 'outcome' only accepts completed | abandoned
makeEvent('episode.closed', { outcome: 'maybe', reason: 'x' }, { sessionId: 's' });
// @ts-expect-error -- a gap origin must be one of the known labels
makeEvent('knowledge_gap.detected', { topic: null, result: 'skipped', origin: 'made-up' }, { sessionId: 's' });

// 13. Teaching-back evidence is a typed, read-only extraction.
const evidence: TeachingBackEvidence = extractTeachingBackEvidence('because the seam moved', { topic: 'seam' });
const assessment: 'evidence_extracted' | 'skipped' = evidence.assessment;
const coarse: TeachingBackResult = evidence.result;
void assessment;
void coarse;
// @ts-expect-error -- evidence never claims correctness
evidence.result = 'correct';
// @ts-expect-error -- the evidence shape has no raw answer field
void evidence.text;

// 14. Projection and metrics return fully typed read models.
const projection: CognitiveProjection = buildProjection([]);
const episodes: readonly CognitiveEpisode[] = projection.episodes;
const metrics: CognitiveMetrics = computeMetrics([]);
const topics: readonly TopicLearningState[] = topicLearningStates([]);
void episodes;
void metrics;
void topics;
// @ts-expect-error -- a metric set has no hidden runtime state to read
void metrics.runtimeState;

// 15. Topic keys normalize to a bounded string, and stay distinct from topicKey().
const normalized: string = normalizeTopic(topicKey('Refactor the storage layer'));
void normalized;
