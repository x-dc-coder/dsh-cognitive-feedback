/**
 * dsh-cognitive-feedback — a lightweight cognitive-feedback plugin for DSH.
 *
 * V0.1 provides four capabilities (README.md):
 *   1. Dynamic Cognitive Prompt — an agent-scoped system-prompt section.
 *   2. Reasoning Gate — a directive that pauses via ask_user_question.
 *   3. Teaching Back — a post-task explanation check.
 *   4. Cognitive Event Log — append-only JSONL.
 *
 * Fail open: any feature failure downgrades to normal DSH behavior and never
 * blocks coding (ARCHITECTURE.md §5).
 *
 * @module dsh-cognitive-feedback
 */
import { installAdapter } from './dsh-adapter.js';

export const name = 'cognitive-feedback';

/**
 * No static `inject` declaration on purpose.
 *
 * Cordis treats an array/object `inject` as a *required* dependency gate: an
 * entry whose service never resolves stays pending and makes the whole profile
 * fail to boot. Prompt injection is therefore wired through the documented
 * optional pattern `ctx.inject(['systemPrompt'], cb)` inside the adapter, so
 * the plugin always activates and simply records events when the host has no
 * system-prompt service.
 */

/**
 * @param {any} ctx
 * @param {Record<string, unknown>} [config]
 */
export function apply(ctx, config) {
  const adapter = installAdapter(ctx, config ?? {});
  ctx.on?.('dispose', () => adapter.dispose());
  return adapter;
}

export { installAdapter } from './dsh-adapter.js';
export { CognitiveController } from './controller.js';
export { StateEngine, createState } from './state.js';
export { decide, DEFAULT_CONFIG, activeIntervention } from './policy.js';
export { renderCognitiveSection, createSectionRenderer, fingerprint } from './prompt.js';
export { analyzeMessage, classifyTask, hasHypothesis, isRoutine, topicKey } from './classify.js';
export { makeEvent, countRecentInterventions } from './events.js';
export { JsonlSink } from './storage/jsonl-sink.js';
export { MemorySink } from './storage/memory-sink.js';