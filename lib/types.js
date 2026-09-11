/**
 * Shared JSDoc type vocabulary for the cognitive-feedback plugin.
 *
 * These are compile-time documentation only; the plugin ships as plain ESM
 * JavaScript with zero runtime dependencies so it stays testable without a
 * build step and without a dependency graph (AGENTS.md §3).
 *
 * @module dsh-cognitive-feedback/types
 */

/**
 * The task shape inferred from a user message by the deterministic classifier.
 * @typedef {'implementation'|'debugging'|'architecture'|'research'|'explanation'} TaskType
 */

/**
 * Intervention intensity, proportional to uncertainty and cognitive value.
 * @typedef {0|1|2|3} InterventionLevel
 */

/**
 * Which cognitive mode the session is in.
 * @typedef {'normal'|'learning'|'challenge'|'research'} CognitiveMode
 */

/**
 * Short-lived state driving current behavior. Never a long-term user profile.
 * @typedef {object} CognitiveState
 * @property {CognitiveMode} mode
 * @property {TaskType} [taskType]
 * @property {InterventionLevel} interventionLevel
 * @property {number} recentDecisionOutsourcing
 * @property {number} recentUnexplainedImplementations
 * @property {string} [currentTopic]
 * @property {string} [currentHypothesis]
 * @property {number} stateVersion  Monotonic version; bumps only on real change.
 * @property {string} [sessionId]
 */

/**
 * One high-value decision that the policy chose to act on.
 * @typedef {{ type: 'none' }
 *   | { type: 'prompt', level: 1|2 }
 *   | { type: 'reasoning_gate', reason: string }
 *   | { type: 'teaching_back', reason: string }} PolicyAction
 */

/**
 * Normalized signal produced by the DSH adapter; policy code never sees raw
 * Session V3 structures.
 * @typedef {object} CognitiveSignal
 * @property {string} sessionId
 * @property {'user_message'|'assistant_message'|'tool_result'|'turn_start'|'turn_end'|'session_started'|'session_ended'} kind
 * @property {string} [text]
 * @property {Record<string, unknown>} [metadata]
 */

/**
 * Event type vocabulary, mapped from native DSH events (see EVENT_SCHEMA.md).
 * @typedef {'session.started'|'intervention.triggered'|'hypothesis.submitted'|'decision.recorded'|'teaching_back.requested'|'teaching_back.completed'|'knowledge_gap.detected'|'session.ended'} CognitiveEventType
 *
 * `hypothesis.challenged` is deliberately NOT part of the V0.1 vocabulary: the
 * implementation never emits it, and declaring unemitted members overstates the
 * contract. It belongs in ROADMAP.md until something produces it.
 */

/**
 * Versioned, append-only cognitive event.
 * @typedef {object} CognitiveEvent
 * @property {1} schemaVersion
 * @property {string} id
 * @property {string} timestamp
 * @property {string} sessionId
 * @property {string} [project]
 * @property {CognitiveEventType} type
 * @property {Record<string, unknown>} payload
 */

export const SCHEMA_VERSION = 1;

export {};