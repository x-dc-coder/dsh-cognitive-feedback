/**
 * Prompt Builder -- renders the cognitive-feedback system-prompt section.
 *
 * Cache discipline: rendering is a pure function of a small state fingerprint;
 * identical fingerprints render byte-identical text; an inactive state renders
 * the empty string, contributing nothing.
 *
 * @module dsh-cognitive-feedback/prompt/renderer
 */
import { activeIntervention, type CognitiveConfig } from '../cognitive/policy.js';
import type { CognitiveState } from '../cognitive/state.js';

/** Name the section registers under. All registrations MUST share it. */
export const SECTION_NAME = 'cognitive-feedback';

/** Renderer options. */
export interface RendererOptions {
  readonly config?: Pick<CognitiveConfig, 'useAskUserTool'> | undefined;
}

/**
 * Hard cap on any state-derived string interpolated into the section.
 *
 * `currentTopic` is normally already bounded by `topicKey()`, but the renderer is
 * a public, directly callable function: the section's bound must not depend on
 * every caller having sanitized the state first.
 */
const MAX_REASON_LENGTH = 64;

/** A single-line, length-capped rendering of a state-derived label. */
function boundedReason(reason: string | undefined): string {
  if (!reason) return '';
  return String(reason)
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, MAX_REASON_LENGTH);
}

/**
 * A stable, minimal fingerprint of everything the rendering depends on. Two
 * states with the same fingerprint MUST render identical text.
 */
export function fingerprint(state: CognitiveState): string {
  const active = activeIntervention(state);
  if (!active) return 'none';
  return `${active.kind}|${active.reason}|${active.topic ?? state.currentTopic ?? ''}`;
}

/** Render the cognitive section text. Returns '' when no intervention is active. */
export function renderCognitiveSection(state: CognitiveState, options: RendererOptions = {}): string {
  const active = activeIntervention(state);
  if (!active) return '';
  const useTool = options.config?.useAskUserTool !== false;

  if (active.kind === 'gate') {
    const reason =
      active.reason === 'architecture'
        ? 'an architecture decision'
        : active.reason === 'research'
          ? 'a research decision'
          : active.reason === 'debugging' || active.reason === 'root-cause'
            ? 'a root-cause decision'
            : 'a design decision';
    const ask = useTool
      ? 'Use the `ask_user_question` tool (question id `cognitive-gate`) so the turn pauses for their answer.'
      : 'Ask the user directly, then wait for their answer before implementing.';
    return [
      '[COGNITIVE FEEDBACK]',
      `Reasoning gate -- ${reason} is about to be made.`,
      "Before implementing, get the user's own thinking first:",
      '1. what problem they believe exists;',
      '2. their proposed design or hypothesis;',
      '3. why they expect it to work.',
      ask,
      'Then you may challenge, refine, or validate it -- but do not implement until they answer.',
      '[/COGNITIVE FEEDBACK]',
    ].join('\n');
  }

  if (active.kind === 'nudge') {
    // Level 1: a light, explicitly non-blocking reminder. It must never be
    // phrased as a question the agent has to wait for.
    return [
      '[COGNITIVE FEEDBACK]',
      'Nudge -- before implementing, name the main assumption this rests on and how you would check it.',
      'Keep it brief; this does not block the task. Continue once the assumption is stated.',
      '[/COGNITIVE FEEDBACK]',
    ].join('\n');
  }

  if (active.kind === 'challenge') {
    return [
      '[COGNITIVE FEEDBACK]',
      'Challenge -- the cause of this problem is not yet stated.',
      'Ask the user for their current hypothesis and the evidence behind it before proposing a fix.',
      'You remain free to revise it once evidence contradicts it.',
      '[/COGNITIVE FEEDBACK]',
    ].join('\n');
  }

  const label = boundedReason(active.reason);
  return [
    '[COGNITIVE FEEDBACK]',
    // reason here is a topic key derived from user text: topicKey() already
    // caps it at six lowercase [a-z0-9-] words. boundedReason() re-applies the
    // cap so the section stays bounded even for a direct caller that did not.
    label
      ? `Teaching back -- the solution for "${label}" is in place.`
      : 'Teaching back -- the solution is in place.',
    'Ask the user to explain, in 2-5 sentences, why this solution works and one limitation it has.',
    'Record their answer as a teaching-back result; do not treat a skipped answer as failure.',
    '[/COGNITIVE FEEDBACK]',
  ].join('\n');
}

/** A memoizing renderer and its introspection hook. */
export interface SectionRenderer {
  render(state: CognitiveState): string;
  stats(): { lastKey: string | null; length: number };
}

/**
 * Memoizing renderer. Re-renders only when the fingerprint changes, so
 * repeated assemblies with unchanged state return the identical string and the
 * prompt prefix stays reusable.
 */
export function createSectionRenderer(options: RendererOptions = {}): SectionRenderer {
  let lastKey: string | null = null;
  let lastText = '';
  return {
    render(state: CognitiveState): string {
      const key = fingerprint(state);
      if (key === lastKey) return lastText;
      lastKey = key;
      lastText = renderCognitiveSection(state, options);
      return lastText;
    },
    stats() {
      return { lastKey, length: lastText.length };
    },
  };
}
