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
 * Follows the Harness plugin paradigm: \`name\`, a \`Config\` schema, and \`apply\`.
 * Every registration goes through \`ctx\` (\`ctx.on\`, \`ctx.inject\`,
 * \`ctx.systemPrompt.section\`), so the framework disposes all of them on unload
 * and this plugin keeps no private lifecycle bookkeeping.
 *
 * @module dsh-cognitive-feedback
 */
import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { DEFAULT_CONFIG } from './cognitive/policy.js';
import { installAdapter, type AdapterConfig } from './dsh-adapter.js';

export const name = 'cognitive-feedback';

/**
 * The plugin's configuration surface.
 *
 * Defaults live on the schema below, which is the single source of truth for
 * them: the core reads \`DEFAULT_CONFIG\` and the schema derives from the same
 * constants, so the two cannot drift.
 */
export interface Config {
  /** Master switch. When false the plugin is fully inert. */
  enabled: boolean;
  /** Max level-3 (reasoning gate) interventions per rolling 24h. */
  strongPerDay: number;
  /** Max level-1/2 (nudge/challenge) interventions per rolling 24h. */
  lightPerDay: number;
  /** Emit a teaching-back check after high-value work. */
  teachingBack: boolean;
  /** System-prompt section order; free slot between TEAM_POLICY(600) and PTC_ONLY(800). */
  sectionOrder: number;
  /** Include the directive to pause via the ask_user_question tool. */
  useAskUserTool: boolean;
  /** Event log path. Empty resolves \`$DSH_HOME/cognitive-feedback/events.jsonl\`. */
  eventsPath: string;
}

/**
 * Validated configuration. Cordis runs this while the plugin loads, fills the
 * defaults, and fails the load on invalid values -- so \`apply\` always receives a
 * complete, checked object.
 */
export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(DEFAULT_CONFIG.enabled),
  strongPerDay: Schema.number().default(DEFAULT_CONFIG.strongPerDay),
  lightPerDay: Schema.number().default(DEFAULT_CONFIG.lightPerDay),
  teachingBack: Schema.boolean().default(DEFAULT_CONFIG.teachingBack),
  sectionOrder: Schema.number().default(DEFAULT_CONFIG.sectionOrder),
  useAskUserTool: Schema.boolean().default(DEFAULT_CONFIG.useAskUserTool),
  eventsPath: Schema.string().default(''),
});

/**
 * No static \`inject\` declaration on purpose.
 *
 * Cordis treats an array/object \`inject\` as a *required* dependency gate: an
 * entry whose service never resolves stays PENDING and makes the whole profile
 * fail to boot (observed live against rc.1). Prompt injection is therefore
 * wired through the framework's own optional-registration pattern,
 * \`ctx.inject(['systemPrompt'], cb)\` inside the adapter, so the plugin always
 * activates and simply records events when the host has no system-prompt service.
 */
export function apply(ctx: Context, config: Config): void {
  installAdapter(ctx, {
    ...config,
    eventsPath: config.eventsPath === '' ? null : config.eventsPath,
  } satisfies AdapterConfig);
}

export { installAdapter, mapSessionEvent, resolveEventsPath, type AdapterConfig } from './dsh-adapter.js';
export { CognitiveController, assessTeachingBack, type ControllerOptions, type IngestResult } from './cognitive/controller.js';
export {
  extractTeachingBackEvidence,
  type AnswerLengthBand,
  type ConfidenceLevel,
  type TeachingBackAssessment,
  type TeachingBackEvidence,
  type TeachingBackEvidenceOptions,
} from './cognitive/teaching-back.js';
export { StateEngine, createState, type CognitiveState, type CognitiveMode, type InterventionLevel, type TeachingBackResult } from './cognitive/state.js';
export { decide, activeIntervention, actionLevel, DEFAULT_CONFIG, type PolicyAction, type CognitiveConfig, type ActiveIntervention, type InterventionBudget } from './cognitive/policy.js';
export { renderCognitiveSection, createSectionRenderer, fingerprint, SECTION_NAME, type SectionRenderer, type RendererOptions } from './prompt/renderer.js';
export { analyzeMessage, classifyTask, hasHypothesis, isRoutine, topicKey, type TaskType, type MessageAnalysis } from './cognitive/classify.js';
export type { CognitiveSignal, SignalKind } from './cognitive/signal.js';
export { makeEvent, newCorrelationId, type EventMeta } from './events/factory.js';
export {
  countRecentInterventions,
  parseCognitiveEvent,
  isCognitiveEventType,
  indexByCorrelation,
  eventsForIntervention,
  eventsForEpisode,
  type CorrelationField,
  type InterventionWindowOptions,
} from './events/queries.js';
export {
  SCHEMA_VERSION,
  COGNITIVE_EVENT_TYPES,
  type CognitiveEvent,
  type CognitiveEventType,
  type CognitiveEventPayloadMap,
  type EpisodeOutcome,
  type EventCorrelation,
  type KnowledgeGapOrigin,
  type PreparedEvent,
  type UnknownCognitiveEvent,
} from './events/types.js';
export {
  reconstructEpisodes,
  episodeIndex,
  episodeOfEvent,
  summarizeEpisodes,
  type CognitiveEpisode,
  type EpisodeEventRef,
  type EpisodeStatus,
  type EpisodeSummary,
  type EpisodeTrigger,
} from './projection/episodes.js';
export { NO_MEMORY, createMemorySource, type CognitiveMemorySource } from './projection/memory.js';
export {
  buildProjection,
  createProjectionCache,
  projectionDigest,
  RebuildableProjection,
  EMPTY_PROJECTION,
  cachePathFor,
  loadProjectionCache,
  saveProjectionCache,
  PROJECTION_CACHE_VERSION,
  aggregateSessions,
  aggregateInterventions,
  type CognitiveProjection,
  type InterventionAggregate,
  type InterventionKind,
  type InterventionStatus,
  type ProjectionCacheFile,
  type ProjectionCacheStats,
  type SessionAggregate,
} from './projection/index.js';
export { JsonlSink } from './storage/jsonl-sink.js';
export { MemorySink } from './storage/memory-sink.js';
export type { CognitiveEventSink } from './storage/sink.js';
