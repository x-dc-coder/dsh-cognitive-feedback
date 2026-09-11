/**
 * Cognitive Controller — the thin orchestrator.
 *
 * Holds one StateEngine per session, applies the policy, records events, and
 * exposes the section text for the prompt builder. Contains no
 * provider-specific DSH API details (ARCHITECTURE.md §2).
 *
 * ## Timing contract (critical for injection)
 *
 * DSH assembles the system prompt for a step **after** the step's input is
 * spliced into the agent inbox, but the harness logs \`system/message\` before
 * \`user/message\`. A signal handled only when \`user/message\` arrives would
 * therefore miss the assembly it was meant to influence.
 *
 * The adapter feeds signals from \`agent/inbox/spliced\` (which lands first), and
 * \`ingest()\` performs **all** state and policy mutation synchronously. Only
 * event persistence is deferred, so the section renderer always observes the
 * post-decision state during the same assembly.
 *
 * Fail-open contract: every operation that can throw is caught by the adapter
 * or degrades internally, so a cognitive-feature failure can never turn into a
 * coding failure.
 *
 * @module dsh-cognitive-feedback/controller
 */
import { StateEngine } from './state.js';
import { DEFAULT_CONFIG, decide, activeIntervention } from './policy.js';
import { createSectionRenderer } from './prompt.js';
import { makeEvent, countRecentInterventions } from './events.js';

/** Task types whose completion warrants a teaching-back check. */
const HIGH_VALUE_TASKS = new Set(['architecture', 'research', 'debugging']);

export class CognitiveController {
  /**
   * @param {{ config?: Partial<typeof DEFAULT_CONFIG>, sink: import('./storage/sink.js').CognitiveEventSink, project?: string, logger?: (msg: string, error?: unknown) => void, now?: () => Date }} options
   */
  constructor(options) {
    this.config = { ...DEFAULT_CONFIG, ...(options.config ?? {}) };
    this.sink = options.sink;
    this.project = options.project;
    this.logger = options.logger ?? (() => {});
    this.now = options.now ?? (() => new Date());
    /** @type {Map<string, { engine: StateEngine, renderer: ReturnType<typeof createSectionRenderer> }>} */
    this.sessions = new Map();
    this.strongUsed = 0;
    this.lightUsed = 0;
    this.started = false;
    this.warnings = 0;
  }

  /** Load the persisted budget window. Never throws. */
  async start() {
    try {
      const events = await this.sink.readAll();
      const now = this.now().getTime();
      this.strongUsed = countRecentInterventions(events, { now, strongOnly: true });
      // ingest() charges a strong intervention ONLY to strongUsed, so the light
      // counter must exclude them too — otherwise a restart silently inflates
      // lightUsed and suppresses challenges/teaching-backs.
      const total = countRecentInterventions(events, { now, strongOnly: false });
      this.lightUsed = Math.max(0, total - this.strongUsed);
    } catch (error) {
      this.warn('could not load persisted budget; using in-memory counts', error);
    }
    this.started = true;
  }

  /** @param {string} msg @param {unknown} [error] */
  warn(msg, error) {
    this.warnings += 1;
    try {
      this.logger(msg, error);
    } catch {
      /* logging must never throw */
    }
  }

  /** @param {string} sessionId */
  session(sessionId) {
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
   * that the caller should persist.
   *
   * @param {string} sessionId
   * @param {import('./types.js').CognitiveSignal} signal
   * @returns {{ action: import('./types.js').PolicyAction, events: Array<{ type: import('./types.js').CognitiveEventType, payload: Record<string, unknown> }> }}
   */
  ingest(sessionId, signal) {
    // A disabled plugin is fully inert: no state, no policy, no events. This
    // makes `enabled: false` a true control arm in live comparisons.
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
    /** @type {Array<{ type: import('./types.js').CognitiveEventType, payload: Record<string, unknown> }>} */
    const events = [];

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

    // A newly authored hypothesis (stated directly or as a gate answer).
    if (signal.kind === 'user_message' && state.currentHypothesis && before.currentHypothesis !== state.currentHypothesis) {
      events.push({
        type: 'hypothesis.submitted',
        payload: { text: String(state.currentHypothesis).slice(0, 500), authorship: 'user', taskType: state.taskType ?? null },
      });
      events.push({ type: 'decision.recorded', payload: { owner: 'user', topic: state.currentTopic ?? null } });
    }

    // High-value work with a user hypothesis reached an assistant step → the
    // next assembly renders the teaching-back directive.
    if (signal.kind === 'assistant_message' && state.currentHypothesis && HIGH_VALUE_TASKS.has(String(state.taskType)) && !state.teachingBackPending && state.lastActionType !== 'teaching_back') {
      engine.markHighValueCompleted(state.currentTopic);
    }

    if (signal.kind !== 'user_message') return { action: { type: 'none' }, events };

    const action = decide(engine.snapshot(), {
      config: this.config,
      budget: { strongUsed: this.strongUsed, lightUsed: this.lightUsed },
    });

    if (action.type !== 'none') {
      const level = action.type === 'reasoning_gate' ? 3 : action.type === 'teaching_back' ? 1 : action.level;
      events.push({
        type: action.type === 'teaching_back' ? 'teaching_back.requested' : 'intervention.triggered',
        payload: {
          level,
          reason: action.reason ?? (action.type === 'prompt' ? 'debugging' : 'unknown'),
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

  /**
   * Persist prepared events. Failures are warned, never thrown.
   * @param {string} sessionId
   * @param {Array<{ type: import('./types.js').CognitiveEventType, payload: Record<string, unknown> }>} events
   */
  async persist(sessionId, events) {
    for (const event of events) {
      try {
        await this.sink.append(makeEvent(event.type, event.payload, { sessionId, project: this.project, now: this.now }));
      } catch (error) {
        this.warn(`event persistence failed (${event.type})`, error);
      }
    }
  }

  /**
   * Ingest + persist in one call. Used by tests and any caller happy to await.
   * @param {string} sessionId
   * @param {import('./types.js').CognitiveSignal} signal
   * @returns {Promise<import('./types.js').PolicyAction>}
   */
  async handle(sessionId, signal) {
    const { action, events } = this.ingest(sessionId, signal);
    await this.persist(sessionId, events);
    return action;
  }

  /**
   * Teaching-back outcome, supplied by the adapter when it can observe one.
   * @param {string} sessionId
   * @param {'correct'|'partially_correct'|'incorrect'|'skipped'} result
   * @param {string} [topic]
   */
  async completeTeachingBack(sessionId, result, topic) {
    // `enabled: false` must be inert on every public path, not only on ingest.
    if (!this.config.enabled) return;

    const { engine } = this.session(sessionId);
    engine.recordTeachingBack(result);
    const resolvedTopic = topic ?? engine.snapshot().completedHighValueTopic ?? null;
    await this.persist(sessionId, [{ type: 'teaching_back.completed', payload: { result, topic: resolvedTopic } }]);
    if (result !== 'correct') {
      await this.persist(sessionId, [{ type: 'knowledge_gap.detected', payload: { topic: resolvedTopic, result } }]);
    }
  }

  /**
   * The system-prompt section text for one session. Memoized on a stable
   * fingerprint, so repeated assemblies with unchanged state are byte-identical.
   * @param {string} sessionId
   * @returns {string}
   */
  renderSection(sessionId) {
    if (!this.config.enabled) return '';
    try {
      const { engine, renderer } = this.session(sessionId);
      return renderer.render(engine.snapshot());
    } catch (error) {
      this.warn('prompt construction failed; omitting intervention', error);
      return '';
    }
  }

  /** @param {string} sessionId */
  currentIntervention(sessionId) {
    if (!this.config.enabled) return null;
    return activeIntervention(this.session(sessionId).engine.snapshot());
  }
}