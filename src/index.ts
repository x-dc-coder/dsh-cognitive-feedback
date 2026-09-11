/**
 * dsh-cognitive-feedback -- a lightweight cognitive-feedback plugin for DSH.
 *
 * V0.1 provides four capabilities:
 *   1. Dynamic Cognitive Prompt -- an agent-scoped system-prompt section.
 *   2. Reasoning Gate -- a directive that pauses via ask_user_question.
 *   3. Teaching Back -- a post-task explanation check.
 *   4. Cognitive Event Log -- append-only JSONL.
 *
 * Fail open: any feature failure downgrades to normal DSH behavior and never
 * blocks coding.
 *
 * @module dsh-cognitive-feedback
 */
import type { Context } from '@deepseek-ai/cordis';
import { installAdapter, type AdapterConfig, type AdapterHandle } from './dsh-adapter.js';

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
export function apply(ctx: Context, config: AdapterConfig = {}): AdapterHandle {
  const adapter = installAdapter(ctx, config);
  // Cordis has no 'dispose' event. Registering the teardown as a scoped effect
  // ties it to the plugin's own fiber, so it runs when the plugin unloads.
  try {
    ctx.effect(() => () => adapter.dispose());
  } catch {
    /* disposal must never throw at load time */
  }
  return adapter;
}

export { installAdapter, mapSessionEvent, resolveEventsPath, type AdapterConfig, type AdapterHandle } from './dsh-adapter.js';
export { CognitiveController, assessTeachingBack, type ControllerOptions, type IngestResult } from './cognitive/controller.js';
export { StateEngine, createState, type CognitiveState, type CognitiveMode, type InterventionLevel, type TeachingBackResult } from './cognitive/state.js';
export { decide, activeIntervention, actionLevel, DEFAULT_CONFIG, type PolicyAction, type CognitiveConfig, type ActiveIntervention, type InterventionBudget } from './cognitive/policy.js';
export { renderCognitiveSection, createSectionRenderer, fingerprint, SECTION_NAME, type SectionRenderer, type RendererOptions } from './prompt/renderer.js';
export { analyzeMessage, classifyTask, hasHypothesis, isRoutine, topicKey, type TaskType, type MessageAnalysis } from './cognitive/classify.js';
export type { CognitiveSignal, SignalKind } from './cognitive/signal.js';
export { makeEvent, type EventMeta } from './events/factory.js';
export { countRecentInterventions, parseCognitiveEvent, isCognitiveEventType, type InterventionWindowOptions } from './events/queries.js';
export { SCHEMA_VERSION, COGNITIVE_EVENT_TYPES, type CognitiveEvent, type CognitiveEventType, type CognitiveEventPayloadMap, type PreparedEvent, type UnknownCognitiveEvent } from './events/types.js';
export { JsonlSink } from './storage/jsonl-sink.js';
export { MemorySink } from './storage/memory-sink.js';
export type { CognitiveEventSink } from './storage/sink.js';
