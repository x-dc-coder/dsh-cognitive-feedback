/**
 * DSH Adapter — the ONLY place that knows about DSH-specific APIs.
 *
 * Everything above this layer (state, policy, prompt, events, storage) works
 * without DSH, so the core stays unit-testable (AGENTS.md §7) and a baseline
 * bump only requires edits here (docs/dsh-integration.md).
 *
 * Verified against DSH 0.1.5-rc.1:
 *  - \`ctx.systemPrompt.section({ name, order, text })\` (agent-scoped when
 *    registered through \`agent.ctx\`);
 *  - \`ctx.on('session/event', (session, event) => …)\`;
 *  - \`ctx.on('agent/created', ({ agent }) => …)\`.
 *
 * ## Why the inbox splice is the request signal
 *
 * A step's system prompt is assembled after its input is spliced into the agent
 * inbox, but the log records \`system/message\` before \`user/message\`. Feeding the
 * controller only from \`user/message\` would therefore miss the assembly the
 * intervention was meant to influence (observed live: section rendered empty on
 * the only step). The adapter therefore takes the request from
 * \`agent/inbox/spliced\` — which lands before assembly — and treats the later
 * \`user/message\` as a duplicate the controller de-duplicates.
 *
 * Cache safety: the adapter registers NO tools and never changes the tool
 * schema set. Only the cognitive section's text can change, and only when the
 * state fingerprint changes.
 *
 * @module dsh-cognitive-feedback/dsh-adapter
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CognitiveController } from './controller.js';
import { DEFAULT_CONFIG } from './policy.js';
import { SECTION_NAME } from './prompt.js';
import { JsonlSink } from './storage/jsonl-sink.js';
import { MemorySink } from './storage/memory-sink.js';

/** Resolve the default event store path from the DSH home convention. */
export function resolveEventsPath(config) {
  if (config?.eventsPath) return String(config.eventsPath);
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'cognitive-feedback', 'events.jsonl');
}

/**
 * Extract model-visible text from a message-like payload.
 * @param {any} data
 * @returns {string}
 */
function extractText(data) {
  const content = data?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n');
  }
  return '';
}

/** Only a real human prompt is a cognitive signal; injected context is not. */
function isUserAuthored(message) {
  const kind = message?.source?.kind;
  return kind === undefined || kind === 'user';
}

/**
 * Map one native Session V3 event to a cognitive signal, or null when the
 * event is not a cognitive signal.
 *
 * @param {string} sessionId
 * @param {any} event
 * @returns {import('./types.js').CognitiveSignal | null}
 */
export function mapSessionEvent(sessionId, event) {
  const type = event?.type;
  const data = event?.data ?? event;
  if (typeof type !== 'string') return null;

  // The request, delivered before the step's prompt assembly.
  if (type === 'agent/inbox/spliced') {
    const inserted = Array.isArray(data?.inserted) ? data.inserted : [];
    const texts = inserted.filter(isUserAuthored).map(extractText).filter(Boolean);
    if (!texts.length) return null;
    return { sessionId, kind: 'user_message', text: texts.join('\n') };
  }

  if (type === 'user/message') {
    if (!isUserAuthored(data)) return null;
    const text = extractText(data);
    if (!text) return null;
    return { sessionId, kind: 'user_message', text };
  }
  if (type === 'assistant/message') {
    return { sessionId, kind: 'assistant_message', text: extractText(data) };
  }
  if (type === 'turn/start') return { sessionId, kind: 'turn_start' };
  if (type === 'turn/end') return { sessionId, kind: 'turn_end' };
  if (type === 'tool/result') return { sessionId, kind: 'tool_result' };
  return null;
}

/**
 * Install the cognitive-feedback adapter on a Cordis context.
 *
 * @param {any} ctx
 * @param {Record<string, unknown>} [config]
 * @returns {{ controller: CognitiveController, dispose: () => void }}
 */
export function installAdapter(ctx, config = {}) {
  const merged = { ...DEFAULT_CONFIG, ...config };
  const logger = (msg, error) => {
    const detail = error instanceof Error ? ` — ${error.message}` : '';
    try {
      ctx?.logger?.warn?.(`[cognitive-feedback] ${msg}${detail}`);
    } catch {
      /* logging must never throw */
    }
  };

  const sink = merged.eventsPath === ':memory:' ? new MemorySink() : new JsonlSink(resolveEventsPath(merged));
  const controller = new CognitiveController({
    config: merged,
    sink,
    project: process.env.DSH_PROJECT || undefined,
    logger,
  });

  const disposers = [];
  const pending = [];
  let ready = false;

  // Load the persisted budget window, then flush queued signals.
  const started = controller.start().then(() => {
    ready = true;
    for (const run of pending.splice(0)) run();
  });

  /**
   * Ingest synchronously so the section renderer sees the decision during the
   * same assembly; persist the resulting events off the critical path.
   */
  const ingest = (sessionId, signal) => {
    const run = () => {
      try {
        const { events } = controller.ingest(sessionId, signal);
        if (events.length) {
          Promise.resolve(controller.persist(sessionId, events)).catch((error) =>
            controller.warn('event persistence failed', error),
          );
        }
      } catch (error) {
        controller.warn('signal handling failed', error);
      }
    };
    if (ready) run();
    else pending.push(run);
  };

  // --- Observation: session lifecycle + the session event firehose ---------
  try {
    disposers.push(
      ctx.on('session/created', (session) => {
        const sessionId = String(session?.id ?? session);
        ingest(sessionId, { sessionId, kind: 'session_started' });
      }),
    );
  } catch (error) {
    logger('cannot subscribe to session/created', error);
  }

  try {
    disposers.push(
      ctx.on('session/disposed', (session) => {
        const sessionId = String(session?.id ?? session);
        ingest(sessionId, { sessionId, kind: 'session_ended' });
      }),
    );
  } catch (error) {
    logger('cannot subscribe to session/disposed', error);
  }

  try {
    disposers.push(
      ctx.on('session/event', (session, event) => {
        const sessionId = String(session?.id ?? session);
        const signal = mapSessionEvent(sessionId, event);
        if (signal) ingest(sessionId, signal);
      }),
    );
  } catch (error) {
    logger('cannot subscribe to session/event', error);
  }

  // --- Injection: one agent-scoped section, no tool registration -----------
  try {
    ctx.inject(['systemPrompt'], (scoped) => {
      disposers.push(
        scoped.on('agent/created', ({ agent }) => {
          try {
            const sessionId = String(agent?.id ?? agent);
            controller.session(sessionId);
            agent.ctx.systemPrompt.section({
              name: SECTION_NAME,
              order: merged.sectionOrder,
              text: () => controller.renderSection(sessionId),
            });
          } catch (error) {
            logger('section registration failed; interventions disabled for this agent', error);
          }
        }),
      );

      // Fallback for hosts that do not emit agent/created before the first
      // assembly: render only when exactly one session is known.
      //
      // It MUST use the same section name as the agent-scoped registration.
      // DSH shadows by NAME only, so a distinct name (e.g. `${SECTION_NAME}:global`)
      // would not be shadowed and BOTH would render — injecting the directive
      // twice. This was a real defect: a live prompt contained the block twice.
      try {
        scoped.systemPrompt.section({
          name: SECTION_NAME,
          order: merged.sectionOrder,
          text: () => {
            if (controller.sessions.size !== 1) return '';
            const [only] = [...controller.sessions.keys()];
            return controller.renderSection(only);
          },
        });
      } catch (error) {
        logger('global section registration failed', error);
      }
    });
  } catch (error) {
    logger('systemPrompt service unavailable; prompt injection disabled', error);
  }

  return {
    controller,
    dispose: () => {
      for (const dispose of disposers) {
        try {
          dispose?.();
        } catch {
          /* disposal must never throw */
        }
      }
      started.catch(() => {});
    },
  };
}