/**
 * Cognitive Controller -- the thin orchestrator.
 *
 * Holds one StateEngine per session, applies the policy, records events, and
 * exposes the section text for the prompt builder. Contains no
 * provider-specific DSH API details.
 *
 * ## Timing contract (critical for injection)
 *
 * DSH assembles the system prompt for a step after the step's input is spliced
 * into the agent inbox, but the harness logs `system/message` before
 * `user/message`. A signal handled only when `user/message` arrives would
 * therefore miss the assembly it was meant to influence.
 *
 * The adapter feeds signals from `agent/inbox/spliced` (which lands first), and
 * `ingest()` performs **all** state and policy mutation synchronously. Only
 * event persistence is deferred, so the section renderer always observes the
 * post-decision state during the same assembly.
 *
 * ## Correlation
 *
 * Every event that belongs to a reasoning unit carries `episodeId` and/or
 * `interventionId`. Both are minted here, at the moment the unit begins, and
 * travel with the state until the unit is resolved or abandoned -- never
 * inferred later from topic strings or timestamps. See `EVENT_SCHEMA.md`.
 *
 * Fail-open: `handle` and `completeTeachingBack` degrade to a warning rather
 * than rejecting, on top of the per-operation guards below.
 *
 * @module dsh-cognitive-feedback/cognitive/controller
 */
import { StateEngine, type CognitiveState, type TeachingBackResult } from './state.js';
import { assessTeachingBack, extractTeachingBackEvidence } from './teaching-back.js';
import { DEFAULT_CONFIG, decide, activeIntervention, actionLevel, type ActiveIntervention, type CognitiveConfig, type PolicyAction } from './policy.js';
import type { CognitiveSignal } from './signal.js';
import { createSectionRenderer, type SectionRenderer } from '../prompt/renderer.js';
import { makeEvent, newCorrelationId } from '../events/factory.js';
import { countRecentInterventions } from '../events/queries.js';
import type { CognitiveEventType, EventCorrelation, PreparedEvent } from '../events/types.js';
import type { CognitiveEventSink } from '../storage/sink.js';

/** Task types whose completion warrants a teaching-back check. */
const HIGH_VALUE_TASKS: ReadonlySet<string> = new Set(['architecture', 'research', 'debugging']);

/**
 * Re-exported for callers that only need the coarse grade; the deterministic
 * evidence extraction itself lives in `teaching-back.ts`.
 */
export { assessTeachingBack };

/** Result of a synchronous ingest step. */
export interface IngestResult {
  readonly action: PolicyAction;
  readonly events: readonly PreparedEvent[];
}

/** Controller options. */
export interface ControllerOptions {
  readonly config?: Partial<CognitiveConfig> | undefined;
  readonly sink: CognitiveEventSink;
  readonly project?: string | undefined;
  readonly logger?: ((msg: string, error?: unknown) => void) | undefined;
  readonly now?: (() => Date) | undefined;
}

interface SessionEntry {
  readonly engine: StateEngine;
  readonly renderer: SectionRenderer;
}

/** Build a correlation object that omits fields that are not set. */
function correlation(episodeId: string | undefined, interventionId?: string | undefined): EventCorrelation {
  return {
    ...(episodeId ? { episodeId } : {}),
    ...(interventionId ? { interventionId } : {}),
  };
}

export class CognitiveController {
  readonly config: CognitiveConfig;
  private readonly sink: CognitiveEventSink;
  private readonly project: string | undefined;
  private readonly logger: (msg: string, error?: unknown) => void;
  private readonly now: () => Date;
  readonly sessions = new Map<string, SessionEntry>();
  strongUsed = 0;
  lightUsed = 0;
  started = false;
  warnings = 0;

  constructor(options: ControllerOptions) {
    this.config = { ...DEFAULT_CONFIG, ...(options.config ?? {}) };
    this.sink = options.sink;
    this.project = options.project;
    this.logger = options.logger ?? (() => {});
    this.now = options.now ?? (() => new Date());
  }

  /** Load the persisted budget window. Never throws. */
  async start(): Promise<void> {
    try {
      const events = await this.sink.readAll();
      const now = this.now().getTime();
      this.strongUsed = countRecentInterventions(events, { now, strongOnly: true });
      // ingest() charges a strong intervention ONLY to strongUsed, so the light
      // counter must exclude them too -- otherwise a restart silently inflates
      // lightUsed and suppresses challenges/teaching-backs.
      const total = countRecentInterventions(events, { now, strongOnly: false });
      this.lightUsed = Math.max(0, total - this.strongUsed);
    } catch (error) {
      this.warn('could not load persisted budget; using in-memory counts', error);
    }
    this.started = true;
  }

  warn(msg: string, error?: unknown): void {
    this.warnings += 1;
    try {
      this.logger(msg, error);
    } catch {
      /* logging must never throw */
    }
  }

  /** The per-session state entry, created on first use. */
  session(sessionId: string): SessionEntry {
    const key = String(sessionId ?? 'unknown');
    let entry = this.sessions.get(key);
    if (!entry) {
      entry = {
        engine: new StateEngine(key),
        renderer: createSectionRenderer({ config: this.config }),
      };
      this.sessions.set(key, entry);
    }
    return entry;
  }

  /**
   * Apply one signal **synchronously**: update state, run the policy, and
   * mutate state to reflect the decision. Returns the action plus the events
   * the caller should persist.
   */
  ingest(sessionId: string, signal: CognitiveSignal): IngestResult {
    // A disabled plugin is fully inert: no state, no policy, no events. This
    // makes enabled: false a true control arm in live comparisons.
    if (!this.config.enabled) return { action: { type: 'none' }, events: [] };

    const { engine } = this.session(sessionId);
    const before = engine.snapshot();

    // The same request can arrive twice: once from the inbox splice and once
    // from the logged user/message. Decide only on the first delivery.
    if (signal.kind === 'user_message' && signal.text && signal.text === before.lastUserText) {
      return { action: { type: 'none' }, events: [] };
    }

    engine.update(signal);
    let state = engine.snapshot();
    const events: PreparedEvent[] = [];

    /** The open episode id, opening one on demand. */
    const ensureEpisode = (): string => {
      let id = engine.snapshot().currentEpisodeId;
      if (!id) {
        id = newCorrelationId('ep');
        engine.openEpisode(id);
      }
      return id;
    };

    if (signal.kind === 'session_started') {
      events.push({ type: 'session.started', payload: { project: this.project ?? null } });
      return { action: { type: 'none' }, events };
    }

    // A state transition dropped the open episode: a topic change abandoned it,
    // or the session ended with it still open. Recording the terminator here is
    // what makes "interrupted episode" reconstructable from the log alone.
    if (before.currentEpisodeId && state.currentEpisodeId !== before.currentEpisodeId) {
      events.push({
        type: 'episode.closed',
        payload: {
          outcome: 'abandoned',
          reason: signal.kind === 'session_ended' ? 'session-ended' : 'topic-changed',
        },
        ...correlation(before.currentEpisodeId, before.currentInterventionId),
      });
    }

    if (signal.kind === 'session_ended') {
      events.push({ type: 'session.ended', payload: { interventions: this.strongUsed + this.lightUsed } });
      // Prune the per-session entry: a long-lived host creates one session per
      // conversation, so retaining them forever is an unbounded leak.
      this.sessions.delete(String(sessionId));
      return { action: { type: 'none' }, events };
    }

    // A user reply while a teaching-back directive is live is that directive's
    // answer. The directive stays live from the moment it is issued until a
    // user message arrives, so that message IS the answer by construction -- no
    // topic comparison, which would always differ because any reply yields a
    // new topic key.
    if (signal.kind === 'user_message' && before.teachingBackPending && before.lastActionType === 'teaching_back') {
      const topic = before.completedHighValueTopic ?? null;
      // Deterministic evidence, never a correctness grade: see teaching-back.ts.
      const evidence = extractTeachingBackEvidence(signal.text, { topic });
      const result = evidence.result;
      const episodeId = before.currentEpisodeId;
      const interventionId = before.currentInterventionId;
      events.push({
        type: 'teaching_back.completed',
        payload: { result, topic, evidence },
        ...correlation(episodeId, interventionId),
      });
      engine.recordTeachingBack(result);
      // A gap is either a missing answer, or the user saying outright that they
      // are unsure. A merely brief answer is NOT a gap -- that would be a
      // correctness judgment the extractor is not allowed to make.
      if (result === 'skipped') {
        events.push({
          type: 'knowledge_gap.detected',
          payload: { topic, result, origin: 'skipped_answer' },
          ...correlation(episodeId, interventionId),
        });
      } else if (evidence.uncertaintyAcknowledged) {
        events.push({
          type: 'knowledge_gap.detected',
          payload: { topic, result, origin: 'explicit_uncertainty' },
          ...correlation(episodeId, interventionId),
        });
      }
      // The answer terminates the episode: the cycle trigger -> hypothesis ->
      // implementation -> teaching-back is complete.
      if (episodeId) {
        events.push({
          type: 'episode.closed',
          payload: { outcome: 'completed', reason: 'teaching-back-completed' },
          ...correlation(episodeId, interventionId),
        });
      }
      engine.closeEpisode();
      state = engine.snapshot();
    }

    // A newly authored hypothesis (stated directly or as a gate answer). It
    // resolves whatever intervention was waiting for it.
    if (signal.kind === 'user_message' && state.currentHypothesis && before.currentHypothesis !== state.currentHypothesis) {
      const episodeId = ensureEpisode();
      const resolvedInterventionId = engine.snapshot().currentInterventionId;
      events.push({
        type: 'hypothesis.submitted',
        payload: {
          text: String(state.currentHypothesis).slice(0, 500),
          authorship: 'user',
          taskType: state.taskType ?? null,
        },
        ...correlation(episodeId, resolvedInterventionId),
      });
      events.push({
        type: 'decision.recorded',
        payload: { owner: 'user', topic: state.currentTopic ?? null },
        ...correlation(episodeId, resolvedInterventionId),
      });
      engine.resolveIntervention();
      state = engine.snapshot();
    }

    // High-value work with a user hypothesis reached an assistant step -> the
    // directive goes live NOW and renders from the next assembly on. A live
    // directive must be recorded and charged here, not later: emitting from
    // decide() meant a simply-shown intervention could go unlogged and
    // unbudgeted until the next user message.
    if (
      signal.kind === 'assistant_message' &&
      state.currentHypothesis &&
      HIGH_VALUE_TASKS.has(String(state.taskType)) &&
      !state.teachingBackPending &&
      state.lastActionType !== 'teaching_back'
    ) {
      const episodeId = ensureEpisode();
      const interventionId = newCorrelationId('iv');
      engine.beginIntervention(interventionId);
      engine.markHighValueCompleted(state.currentTopic);
      events.push({
        type: 'teaching_back.requested',
        payload: {
          level: 1,
          reason: state.currentTopic ?? null,
          taskType: state.taskType ?? null,
          topic: state.currentTopic ?? null,
        },
        ...correlation(episodeId, interventionId),
      });
      this.lightUsed += 1;
      engine.recordAction({ type: 'teaching_back', reason: state.currentTopic ?? 'task' }, state.currentTopic);
      state = engine.snapshot();
    }

    if (signal.kind !== 'user_message') return { action: { type: 'none' }, events };

    const action = decide(engine.snapshot(), {
      config: this.config,
      budget: { strongUsed: this.strongUsed, lightUsed: this.lightUsed },
    });

    // Only these two are reachable: teaching back is state-driven and is
    // recorded above, the moment its directive goes live.
    if (action.type === 'prompt' || action.type === 'reasoning_gate') {
      const level = actionLevel(action);
      const episodeId = ensureEpisode();
      const interventionId = newCorrelationId('iv');
      engine.beginIntervention(interventionId);
      events.push({
        type: 'intervention.triggered',
        payload: {
          level,
          reason: action.type === 'reasoning_gate' ? action.reason : 'debugging',
          taskType: state.taskType ?? null,
          topic: state.currentTopic ?? null,
        },
        ...correlation(episodeId, interventionId),
      });
      // Deliberate ordering: the intervention HAS been issued (it is in the
      // prompt for this assembly), so it consumes budget even if the log write
      // later fails. Un-charging it would let a broken sink defeat the budget.
      if (level >= 3) this.strongUsed += 1;
      else this.lightUsed += 1;
      // Synchronous: the section renderer must see this state in the SAME assembly.
      engine.recordAction(action, state.currentTopic);
    }
    return { action, events };
  }

  /** Persist prepared events. Failures are warned, never thrown. */
  async persist(sessionId: string, events: readonly PreparedEvent[]): Promise<void> {
    for (const event of events) {
      try {
        await this.sink.append(
          makeEvent(event.type, event.payload as never, {
            sessionId,
            project: this.project,
            now: this.now,
            episodeId: event.episodeId,
            interventionId: event.interventionId,
          }),
        );
      } catch (error) {
        this.warn(`event persistence failed (${event.type})`, error);
      }
    }
  }

  /**
   * Ingest + persist in one call. Used by tests and any caller happy to await.
   * Public API: the fail-open promise must hold here too, not only inside the
   * adapter's listener wrapper.
   */
  async handle(sessionId: string, signal: CognitiveSignal): Promise<PolicyAction> {
    try {
      const { action, events } = this.ingest(sessionId, signal);
      await this.persist(sessionId, events);
      return action;
    } catch (error) {
      this.warn('signal handling failed; continuing without intervention', error);
      return { type: 'none' };
    }
  }

  /** Teaching-back outcome, supplied when a host observes one directly. */
  async completeTeachingBack(sessionId: string, result: TeachingBackResult, topic?: string | undefined): Promise<void> {
    // enabled: false must be inert on every public path, not only on ingest.
    if (!this.config.enabled) return;
    try {
      const { engine } = this.session(sessionId);
      const before = engine.snapshot();
      engine.recordTeachingBack(result);
      const resolvedTopic = topic ?? before.completedHighValueTopic ?? null;
      const episodeId = before.currentEpisodeId;
      const interventionId = before.currentInterventionId;
      await this.persist(sessionId, [
        { type: 'teaching_back.completed', payload: { result, topic: resolvedTopic }, ...correlation(episodeId, interventionId) },
      ]);
      // A gap is a wrong or missing explanation. 'unassessed' is neither: the
      // user did explain, V0.1 just cannot grade it.
      if (result === 'incorrect' || result === 'partially_correct' || result === 'skipped') {
        await this.persist(sessionId, [
          {
            type: 'knowledge_gap.detected',
            payload: {
              topic: resolvedTopic,
              result,
              origin: result === 'skipped' ? 'skipped_answer' : 'graded_low',
            },
            ...correlation(episodeId, interventionId),
          },
        ]);
      }
      if (episodeId) {
        await this.persist(sessionId, [
          {
            type: 'episode.closed',
            payload: { outcome: 'completed', reason: 'teaching-back-completed' },
            ...correlation(episodeId, interventionId),
          },
        ]);
      }
      engine.closeEpisode();
    } catch (error) {
      this.warn('teaching-back recording failed; continuing', error);
    }
  }

  /**
   * The system-prompt section text for one session. Memoized on a stable
   * fingerprint, so repeated assemblies with unchanged state are byte-identical.
   */
  renderSection(sessionId: string): string {
    if (!this.config.enabled) return '';
    try {
      const { engine, renderer } = this.session(sessionId);
      return renderer.render(engine.snapshot());
    } catch (error) {
      this.warn('prompt construction failed; omitting intervention', error);
      return '';
    }
  }

  /** The intervention currently rendered for one session, if any. */
  currentIntervention(sessionId: string): ActiveIntervention | null {
    if (!this.config.enabled) return null;
    return activeIntervention(this.session(sessionId).engine.snapshot());
  }

  /** Raw state snapshot for one session (tests and diagnostics). */
  stateOf(sessionId: string): CognitiveState {
    return this.session(sessionId).engine.snapshot();
  }

  /** Every event type this controller can emit. */
  static readonly eventTypes: readonly CognitiveEventType[] = [
    'session.started',
    'session.ended',
    'episode.closed',
    'intervention.triggered',
    'hypothesis.submitted',
    'decision.recorded',
    'teaching_back.requested',
    'teaching_back.completed',
    'knowledge_gap.detected',
  ];
}
