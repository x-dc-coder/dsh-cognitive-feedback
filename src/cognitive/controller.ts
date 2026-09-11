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
 * into the agent inbox, but the harness logs \`system/message\` before
 * \`user/message\`. A signal handled only when \`user/message\` arrives would
 * therefore miss the assembly it was meant to influence.
 *
 * The adapter feeds signals from \`agent/inbox/spliced\` (which lands first), and
 * \`ingest()\` performs **all** state and policy mutation synchronously. Only
 * event persistence is deferred, so the section renderer always observes the
 * post-decision state during the same assembly.
 *
 * Fail-open: \`handle\` and \`completeTeachingBack\` degrade to a warning rather
 * than rejecting, on top of the per-operation guards below.
 *
 * @module dsh-cognitive-feedback/cognitive/controller
 */
import { StateEngine, type CognitiveState, type TeachingBackResult } from './state.js';
import { DEFAULT_CONFIG, decide, activeIntervention, actionLevel, type ActiveIntervention, type CognitiveConfig, type PolicyAction } from './policy.js';
import type { CognitiveSignal } from './signal.js';
import { createSectionRenderer, type SectionRenderer } from '../prompt/renderer.js';
import { makeEvent } from '../events/factory.js';
import { countRecentInterventions } from '../events/queries.js';
import type { CognitiveEventType, PreparedEvent } from '../events/types.js';
import type { CognitiveEventSink } from '../storage/sink.js';

/** Task types whose completion warrants a teaching-back check. */
const HIGH_VALUE_TASKS: ReadonlySet<string> = new Set(['architecture', 'research', 'debugging']);

/**
 * Deterministic stand-in for a teaching-back evaluator.
 *
 * V0.1 deliberately does NOT judge whether an explanation is correct -- that
 * needs semantic understanding it does not have, and guessing would put a fake
 * signal in the log. It records only what it can observe: whether an answer was
 * given (\`unassessed\`) or not (\`skipped\`).
 */
export function assessTeachingBack(text: string | undefined): 'unassessed' | 'skipped' {
  const value = String(text ?? '').trim();
  if (value.length < 25) return 'skipped';
  if (/^(skip|no idea|idk|n\/?a|pass|dunno)\b/i.test(value)) return 'skipped';
  return 'unassessed';
}

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
    const state = engine.snapshot();
    const events: PreparedEvent[] = [];

    if (signal.kind === 'session_started') {
      events.push({ type: 'session.started', payload: { project: this.project ?? null } });
      return { action: { type: 'none' }, events };
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
      const result = assessTeachingBack(signal.text);
      const topic = before.completedHighValueTopic ?? null;
      events.push({ type: 'teaching_back.completed', payload: { result, topic } });
      engine.recordTeachingBack(result);
      if (result === 'skipped') {
        events.push({ type: 'knowledge_gap.detected', payload: { topic, result } });
      }
    }

    // A newly authored hypothesis (stated directly or as a gate answer).
    if (signal.kind === 'user_message' && state.currentHypothesis && before.currentHypothesis !== state.currentHypothesis) {
      events.push({
        type: 'hypothesis.submitted',
        payload: {
          text: String(state.currentHypothesis).slice(0, 500),
          authorship: 'user',
          taskType: state.taskType ?? null,
        },
      });
      events.push({ type: 'decision.recorded', payload: { owner: 'user', topic: state.currentTopic ?? null } });
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
      engine.markHighValueCompleted(state.currentTopic);
      events.push({
        type: 'teaching_back.requested',
        payload: {
          level: 1,
          reason: state.currentTopic ?? null,
          taskType: state.taskType ?? null,
          topic: state.currentTopic ?? null,
        },
      });
      this.lightUsed += 1;
      engine.recordAction({ type: 'teaching_back', reason: state.currentTopic ?? 'task' }, state.currentTopic);
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
      events.push({
        type: 'intervention.triggered',
        payload: {
          level,
          reason: action.type === 'reasoning_gate' ? action.reason : 'debugging',
          taskType: state.taskType ?? null,
          topic: state.currentTopic ?? null,
        },
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
          makeEvent(event.type, event.payload as never, { sessionId, project: this.project, now: this.now }),
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
      engine.recordTeachingBack(result);
      const resolvedTopic = topic ?? engine.snapshot().completedHighValueTopic ?? null;
      await this.persist(sessionId, [{ type: 'teaching_back.completed', payload: { result, topic: resolvedTopic } }]);
      // A gap is a wrong or missing explanation. 'unassessed' is neither: the
      // user did explain, V0.1 just cannot grade it.
      if (result === 'incorrect' || result === 'partially_correct' || result === 'skipped') {
        await this.persist(sessionId, [{ type: 'knowledge_gap.detected', payload: { topic: resolvedTopic, result } }]);
      }
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
    'intervention.triggered',
    'hypothesis.submitted',
    'decision.recorded',
    'teaching_back.requested',
    'teaching_back.completed',
    'knowledge_gap.detected',
  ];
}