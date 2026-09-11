/**
 * Prompt Builder — renders the cognitive-feedback system-prompt section.
 *
 * Cache discipline (docs/testing.md):
 *  - rendering is a pure function of a small state fingerprint;
 *  - identical fingerprints render byte-identical text;
 *  - an inactive state renders the empty string, contributing nothing.
 *
 * @module dsh-cognitive-feedback/prompt
 */
import { activeIntervention } from './policy.js';

export const SECTION_NAME = 'cognitive-feedback';

/**
 * A stable, minimal fingerprint of everything the rendering depends on.
 * Two states with the same fingerprint MUST render identical text.
 *
 * @param {import('./types.js').CognitiveState & Record<string, any>} state
 * @returns {string}
 */
export function fingerprint(state) {
  const active = activeIntervention(state);
  if (!active) return 'none';
  return `${active.kind}|${active.reason}|${active.topic ?? state.currentTopic ?? ''}`;
}

/**
 * Render the cognitive section text. Returns '' when no intervention is active.
 *
 * @param {import('./types.js').CognitiveState & Record<string, any>} state
 * @param {{ config?: { useAskUserTool?: boolean } }} [options]
 * @returns {string}
 */
export function renderCognitiveSection(state, options = {}) {
  const active = activeIntervention(state);
  if (!active) return '';
  const useTool = options.config?.useAskUserTool !== false;

  if (active.kind === 'gate') {
    const reason =
      active.reason === 'architecture'
        ? 'an architecture decision'
        : active.reason === 'research'
          ? 'a research decision'
          : 'a design decision';
    const ask = useTool
      ? 'Use the `ask_user_question` tool (question id `cognitive-gate`) so the turn pauses for their answer.'
      : 'Ask the user directly, then wait for their answer before implementing.';
    return [
      '[COGNITIVE FEEDBACK]',
      `Reasoning gate — ${reason} is about to be made.`,
      'Before implementing, get the user\'s own thinking first:',
      '1. what problem they believe exists;',
      '2. their proposed design or hypothesis;',
      '3. why they expect it to work.',
      ask,
      'Then you may challenge, refine, or validate it — but do not implement until they answer.',
      '[/COGNITIVE FEEDBACK]',
    ].join('\n');
  }

  if (active.kind === 'challenge') {
    return [
      '[COGNITIVE FEEDBACK]',
      'Challenge — the cause of this problem is not yet stated.',
      'Ask the user for their current hypothesis and the evidence behind it before proposing a fix.',
      'You remain free to revise it once evidence contradicts it.',
      '[/COGNITIVE FEEDBACK]',
    ].join('\n');
  }

  if (active.kind === 'teaching_back') {
    return [
      '[COGNITIVE FEEDBACK]',
      `Teaching back — the solution for "${active.reason}" is in place.`,
      'Ask the user to explain, in 2-5 sentences, why this solution works and one limitation it has.',
      'Record their answer as a teaching-back result; do not treat a skipped answer as failure.',
      '[/COGNITIVE FEEDBACK]',
    ].join('\n');
  }

  return '';
}

/**
 * Memoizing renderer. Re-renders only when the fingerprint changes, so
 * repeated assemblies with unchanged state return the identical string and the
 * prompt prefix stays reusable.
 *
 * @param {{ config?: { useAskUserTool?: boolean } }} [options]
 */
export function createSectionRenderer(options = {}) {
  let lastKey = null;
  let lastText = '';
  return {
    /**
     * @param {import('./types.js').CognitiveState & Record<string, any>} state
     * @returns {string}
     */
    render(state) {
      const key = fingerprint(state);
      if (key === lastKey) return lastText;
      lastKey = key;
      lastText = renderCognitiveSection(state, options);
      return lastText;
    },
    /** Introspection for tests. */
    stats() {
      return { lastKey, length: lastText.length };
    },
  };
}