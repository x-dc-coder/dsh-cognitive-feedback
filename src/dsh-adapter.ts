/**
 * DSH Adapter -- the ONLY place that knows about DSH-specific APIs.
 *
 * Everything above this layer works without DSH, so the core stays
 * unit-testable and a baseline bump only requires edits here.
 *
 * ## Why the inbox splice is the request signal
 *
 * A step's system prompt is assembled after its input is spliced into the agent
 * inbox, but the log records \`system/message\` before \`user/message\`. Feeding the
 * controller only from \`user/message\` would therefore miss the assembly the
 * intervention was meant to influence. The adapter takes the request from
 * \`agent/inbox/spliced\` -- which lands first -- and treats the later
 * \`user/message\` as a duplicate the controller de-duplicates.
 *
 * ## Cache safety
 *
 * The adapter registers NO tools and never changes the tool schema set. Only
 * the cognitive section's text can change, and only when the state fingerprint
 * changes.
 *
 * @module dsh-cognitive-feedback/dsh-adapter
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import { CognitiveController, type ControllerOptions } from './cognitive/controller.js';
import type { CognitiveSignal } from './cognitive/signal.js';
import type { CognitiveConfig } from './cognitive/policy.js';
import { SECTION_NAME } from './prompt/renderer.js';
import { JsonlSink } from './storage/jsonl-sink.js';
import { MemorySink } from './storage/memory-sink.js';
import type { CognitiveEventSink } from './storage/sink.js';

/**
 * \`Agent.ctx\` is the agent's scoped Cordis context. It is documented in the
 * dsh-agent README ("registrations made through it -- tools, prompt sections,
 * variables, event listeners -- apply to that agent alone") but is NOT part of
 * the public \`Agent\` interface, which declares only \`id\`
 * (dsh-agent/lib/types/types.d.ts:11).
 *
 * The scoped context therefore has no official type at the 0.1.5-rc.1
 * baseline. This assertion is the minimum needed, is confined to this adapter,
 * and exists solely to register an agent-scoped prompt section. If the harness
 * later declares \`ctx\` on \`Agent\`, delete this and use the official type.
 */
type AgentWithScopedContext = Agent & { readonly ctx: Context };

/** Adapter options: the plugin's own config surface. */
export type AdapterConfig = Partial<CognitiveConfig>;

/** What \`installAdapter\` returns. */
export interface AdapterHandle {
  readonly controller: CognitiveController;
  dispose(): void;
}

/** Resolve the default event store path from the DSH home convention. */
export function resolveEventsPath(config: Partial<CognitiveConfig> = {}): string {
  if (config.eventsPath) return String(config.eventsPath);
  const home = process.env['DSH_HOME'] || join(homedir(), '.dsh');
  return join(home, 'cognitive-feedback', 'events.jsonl');
}

/** Extract model-visible text from a model-content value. */
function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((part): part is { type: 'text'; text: string } =>
        typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text' && typeof (part as { text?: unknown }).text === 'string',
      )
      .map((part) => part.text)
      .join('\n');
  }
  return '';
}

/** Extract text from a message-shaped payload (\`{ content }`). */
function extractText(data: { content?: unknown } | undefined): string {
  return textFromContent(data?.content);
}

/** Only a real human prompt is a cognitive signal; injected context is not. */
function isUserAuthored(message: { source?: { kind?: string } } | undefined): boolean {
  const kind = message?.source?.kind;
  return kind === undefined || kind === 'user';
}

/**
 * Map one native Session V3 event to a cognitive signal, or null when the event
 * is not a cognitive signal.
 *
 * The parameter is typed as \`SessionEvent\`, but every field is still read
 * defensively: the value arrives from the harness at runtime, and the adapter is
 * the boundary where an unexpected shape must degrade rather than throw.
 */
export function mapSessionEvent(sessionId: string, event: SessionEvent): CognitiveSignal | null {
  const type = event?.type;

  // The request, delivered before the step's prompt assembly.
  if (type === 'agent/inbox/spliced') {
    const inserted = Array.isArray(event.data?.inserted) ? event.data.inserted : [];
    const texts = inserted.filter(isUserAuthored).map(extractText).filter(Boolean);
    if (!texts.length) return null;
    return { sessionId, kind: 'user_message', text: texts.join('\n') };
  }

  if (type === 'user/message') {
    if (!isUserAuthored(event.data)) return null;
    const text = extractText(event.data);
    if (!text) return null;
    return { sessionId, kind: 'user_message', text };
  }
  if (type === 'assistant/message') {
    // An assistant message carries its content under \`message\`, not at the top
    // level. The old JS read the top level, so the text was always empty -- it
    // never mattered (the controller ignores assistant text), but the correct
    // location is used now that the compiler can see it.
    // Optional chaining is deliberate: the static type says `message` is always
    // present, but this is a runtime boundary and a malformed payload must
    // degrade to empty text rather than throw into DSH's dispatcher. The
    // adapter tests feed exactly such a payload.
    return { sessionId, kind: 'assistant_message', text: textFromContent(event.data.message?.content) };
  }
  if (type === 'turn/start') return { sessionId, kind: 'turn_start' };
  if (type === 'turn/end') return { sessionId, kind: 'turn_end' };
  if (type === 'tool/result') return { sessionId, kind: 'tool_result' };
  return null;
}

/**
 * Install the cognitive-feedback adapter on a Cordis context.
 */
export function installAdapter(ctx: Context, config: AdapterConfig = {}): AdapterHandle {
  const merged: Partial<CognitiveConfig> = { ...config };
  const logger = (msg: string, error?: unknown): void => {
    const detail = error instanceof Error ? ` -- ${error.message}` : '';
    try {
      ctx.logger.warn(`[cognitive-feedback] ${msg}${detail}`);
    } catch {
      /* logging must never throw */
    }
  };

  const sink: CognitiveEventSink =
    merged.eventsPath === ':memory:' ? new MemorySink() : new JsonlSink(resolveEventsPath(merged));
  const controllerOptions: ControllerOptions = {
    config: merged,
    sink,
    project: process.env['DSH_PROJECT'] || undefined,
    logger,
  };
  const controller = new CognitiveController(controllerOptions);

  const disposers: Array<() => void> = [];
  const pending: Array<() => void> = [];
  let ready = false;

  // Load the persisted budget window, then flush queued signals.
  const started = controller.start().then(() => {
    ready = true;
    for (const run of pending.splice(0)) run();
  });

  /**
   * Wrap one event callback so a hostile or malformed payload can never escape
   * into DSH's dispatch. The subscription-level try/catch below only covers
   * registration; a throw inside a listener would otherwise propagate into the
   * host and break coding -- exactly what fail-open forbids.
   */
  const guarded = <A extends unknown[]>(label: string, callback: (...args: A) => void) =>
    (...args: A): void => {
      try {
        callback(...args);
      } catch (error) {
        controller.warn(`listener failed (${label}); ignored`, error);
      }
    };

  /**
   * Ingest synchronously so the section renderer sees the decision during the
   * same assembly; persist the resulting events off the critical path.
   */
  const ingest = (sessionId: string, signal: CognitiveSignal): void => {
    const run = (): void => {
      try {
        const { events } = controller.ingest(sessionId, signal);
        if (events.length) {
          void controller.persist(sessionId, events).catch((error) => controller.warn('event persistence failed', error));
        }
      } catch (error) {
        controller.warn('signal handling failed', error);
      }
    };
    if (ready) run();
    else pending.push(run);
  };

  try {
    disposers.push(
      ctx.on(
        'session/created',
        guarded('session/created', (session: Session) => {
          const sessionId = String(session?.id ?? session);
          ingest(sessionId, { sessionId, kind: 'session_started' });
        }),
      ),
    );
  } catch (error) {
    logger('cannot subscribe to session/created', error);
  }

  try {
    disposers.push(
      ctx.on(
        'session/disposed',
        guarded('session/disposed', (session: Session) => {
          const sessionId = String(session?.id ?? session);
          ingest(sessionId, { sessionId, kind: 'session_ended' });
        }),
      ),
    );
  } catch (error) {
    logger('cannot subscribe to session/disposed', error);
  }

  try {
    disposers.push(
      ctx.on(
        'session/event',
        guarded('session/event', (session: Session, event: SessionEvent) => {
          const sessionId = String(session?.id ?? session);
          const signal = mapSessionEvent(sessionId, event);
          if (signal) ingest(sessionId, signal);
        }),
      ),
    );
  } catch (error) {
    logger('cannot subscribe to session/event', error);
  }

  // --- Injection: one agent-scoped section, no tool registration -----------
  try {
    ctx.inject(['systemPrompt'], (scoped: Context) => {
      disposers.push(
        scoped.on(
          'agent/created',
          guarded('agent/created', (payload: { agent: Agent }) => {
            try {
              const { agent } = payload;
              const sessionId = String(agent?.id ?? agent);
              controller.session(sessionId);
              (agent as AgentWithScopedContext).ctx.systemPrompt.section({
                name: SECTION_NAME,
                order: merged.sectionOrder ?? 700,
                text: () => controller.renderSection(sessionId),
              });
            } catch (error) {
              logger('section registration failed; interventions disabled for this agent', error);
            }
          }),
        ),
      );

      // Fallback for hosts that do not emit agent/created before the first
      // assembly: render only when exactly one session is known.
      //
      // It MUST use the same section name as the agent-scoped registration.
      // DSH shadows by NAME only, so a distinct name would not be shadowed and
      // BOTH would render -- injecting the directive twice.
      //
      // Note on `ctx.inject`: it establishes a dependency on 'systemPrompt' for
      // the calling fiber. The callback runs when that service is present; when
      // it is absent the fiber stays pending and the plugin continues to observe
      // and log events without prompt injection.
      try {
        scoped.systemPrompt.section({
          name: SECTION_NAME,
          order: merged.sectionOrder ?? 700,
          text: () => {
            if (controller.sessions.size !== 1) return '';
            const [only] = [...controller.sessions.keys()];
            return only === undefined ? '' : controller.renderSection(only);
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
    dispose: (): void => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          /* disposal must never throw */
        }
      }
      void started.catch(() => {});
    },
  };
}