import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractTeachingBackEvidence, assessTeachingBack } from '../dist/cognitive/teaching-back.js';
import { CognitiveController } from '../dist/cognitive/controller.js';
import { MemorySink } from '../dist/storage/memory-sink.js';

const STRONG =
  'The duplicate is caused by two consumers reading the same queue slot, because the visibility timeout ' +
  'expires before the handler commits its offset. The fix works by moving the offset commit inside the ' +
  'same transaction as the side effect.';
const WEAK = 'It works because I fixed it.';
const UNRELATED =
  'The weather in the north was pleasant all week and the train ran on schedule for once, which made the ' +
  'trip feel short even though the route itself is long.';

async function makeController() {
  const sink = new MemorySink();
  const controller = new CognitiveController({
    config: {},
    sink,
    logger: () => {},
    now: () => new Date('2026-09-11T00:00:00.000Z'),
  });
  await controller.start();
  return { controller, sink };
}

const msg = (text) => ({ sessionId: 's1', kind: 'user_message', text });

test('a strong explanation yields causal, mechanism and concept evidence', () => {
  const evidence = extractTeachingBackEvidence(STRONG, { topic: 'worker-duplicate-processing' });
  assert.equal(evidence.assessment, 'evidence_extracted');
  assert.equal(evidence.result, 'unassessed', 'evidence is not a correctness grade');
  assert.equal(evidence.answered, true);
  assert.equal(evidence.causalExplanation, true);
  assert.equal(evidence.mechanismExplanation, true);
  assert.equal(evidence.keyConceptReferenced, true);
  assert.equal(evidence.uncertaintyAcknowledged, false);
  assert.ok(evidence.wordCount > 30);
  assert.equal(evidence.lengthBand, 'adequate');
  assert.deepEqual(evidence.signals, ['causal', 'mechanism', 'key-concept', 'length:adequate']);
});

test('a weak explanation is recorded as weak evidence, not as failure', () => {
  const evidence = extractTeachingBackEvidence(WEAK, { topic: 'worker-duplicate-processing' });
  assert.equal(evidence.result, 'unassessed');
  assert.equal(evidence.causalExplanation, true, '"because" is a stated cause');
  assert.equal(evidence.mechanismExplanation, false);
  assert.equal(evidence.keyConceptReferenced, false);
  assert.equal(evidence.lengthBand, 'brief');
  assert.equal(evidence.signals.includes('mechanism'), false);
});

test('no answer and explicit skip are both skipped, with no invented evidence', () => {
  for (const text of [undefined, '', '   ', 'short', 'skip', 'no idea', 'idk', 'n/a', 'dunno']) {
    const evidence = extractTeachingBackEvidence(text, { topic: 'anything' });
    assert.equal(evidence.assessment, 'skipped', JSON.stringify(text));
    assert.equal(evidence.result, 'skipped');
    assert.equal(evidence.answered, false);
    assert.equal(evidence.causalExplanation, false);
    assert.equal(evidence.mechanismExplanation, false);
    assert.equal(evidence.keyConceptReferenced, false);
    assert.equal(evidence.confidence, null);
  }
  assert.equal(assessTeachingBack(STRONG), 'unassessed');
  assert.equal(assessTeachingBack('skip'), 'skipped');
});

test('an unrelated but long answer is answered and empty of evidence', () => {
  const evidence = extractTeachingBackEvidence(UNRELATED, { topic: 'queue-offset-commit' });
  assert.equal(evidence.assessment, 'evidence_extracted', 'a real answer was given');
  assert.equal(evidence.result, 'unassessed');
  assert.equal(evidence.causalExplanation, false);
  assert.equal(evidence.mechanismExplanation, false);
  assert.equal(evidence.keyConceptReferenced, false);
  assert.equal(evidence.lengthBand, 'adequate');
});

test('user-expressed confidence is recorded, never inferred as correctness', () => {
  const high = extractTeachingBackEvidence(
    "I'm confident that the fix works because the offset commit now happens inside the transaction.",
    { topic: 'offset' },
  );
  assert.equal(high.confidence, 'high');
  assert.equal(high.uncertaintyAcknowledged, false);

  const medium = extractTeachingBackEvidence('It probably works because the lock is held for the whole update.', {
    topic: 'lock',
  });
  assert.equal(medium.confidence, 'medium');

  const low = extractTeachingBackEvidence(
    "I'm not sure why it works, but maybe the cache is stale and the queue drains slowly.",
    { topic: 'cache' },
  );
  assert.equal(low.confidence, 'low');
  assert.equal(low.uncertaintyAcknowledged, true);
});

test('the raw answer is never copied into the evidence', () => {
  const marker = 'SECRET_MARKER_XYZ';
  const evidence = extractTeachingBackEvidence(`${marker} works because a single consumer drains the queue.`, {
    topic: 'queue',
  });
  assert.equal(JSON.stringify(evidence).includes(marker), false);
  assert.deepEqual(Object.keys(evidence).sort(), [
    'answered',
    'assessment',
    'causalExplanation',
    'confidence',
    'keyConceptReferenced',
    'lengthBand',
    'mechanismExplanation',
    'result',
    'signals',
    'uncertaintyAcknowledged',
    'wordCount',
  ]);
});

test('extraction is deterministic', () => {
  assert.deepEqual(
    extractTeachingBackEvidence(STRONG, { topic: 'worker-duplicate-processing' }),
    extractTeachingBackEvidence(STRONG, { topic: 'worker-duplicate-processing' }),
  );
});

test('teaching_back.completed carries structured evidence end to end', async () => {
  const { controller, sink } = await makeController();
  await controller.handle('s1', msg('Refactor the storage layer so we can support three backends.'));
  await controller.handle('s1', msg('I think the storage interface leaks backend details.'));
  await controller.handle('s1', { sessionId: 's1', kind: 'assistant_message', text: 'Implemented.' });
  await controller.handle('s1', msg(STRONG));

  const completed = (await sink.readAll()).find((e) => e.type === 'teaching_back.completed');
  assert.ok(completed.payload.evidence, 'the coarse grade alone is no longer enough');
  assert.equal(completed.payload.evidence.causalExplanation, true);
  assert.equal(completed.payload.evidence.mechanismExplanation, true);
  assert.equal(completed.payload.result, 'unassessed');
  assert.equal(completed.payload.evidence.result, completed.payload.result);

  // A confident, complete explanation is not a knowledge gap.
  assert.equal((await sink.readAll()).some((e) => e.type === 'knowledge_gap.detected'), false);
});

test('explicit uncertainty is the only weak answer that records a gap', async () => {
  const { controller, sink } = await makeController();
  await controller.handle('s1', msg('Refactor the storage layer so we can support three backends.'));
  await controller.handle('s1', msg('I think the storage interface leaks backend details.'));
  await controller.handle('s1', { sessionId: 's1', kind: 'assistant_message', text: 'Implemented.' });
  await controller.handle('s1', msg(WEAK));

  const events = await sink.readAll();
  assert.ok(events.find((e) => e.type === 'teaching_back.completed').payload.evidence.mechanismExplanation === false);
  assert.equal(
    events.some((e) => e.type === 'knowledge_gap.detected'),
    false,
    'a brief answer is evidence, not a correctness judgment',
  );

  const skipped = await makeController();
  await skipped.controller.handle('s1', msg('Refactor the storage layer so we can support three backends.'));
  await skipped.controller.handle('s1', msg('I think the storage interface leaks backend details.'));
  await skipped.controller.handle('s1', { sessionId: 's1', kind: 'assistant_message', text: 'Implemented.' });
  await skipped.controller.handle('s1', msg('skip'));
  const gap = (await skipped.sink.readAll()).find((e) => e.type === 'knowledge_gap.detected');
  assert.equal(gap.payload.origin, 'skipped_answer');
  assert.equal(gap.payload.result, 'skipped');
});

test('a host-supplied grade is still accepted and labelled', async () => {
  const { controller, sink } = await makeController();
  await controller.completeTeachingBack('s1', 'partially_correct', 'refactor');
  const events = await sink.readAll();
  assert.equal(events.find((e) => e.type === 'teaching_back.completed').payload.result, 'partially_correct');
  assert.equal(events.find((e) => e.type === 'knowledge_gap.detected').payload.origin, 'graded_low');
});
