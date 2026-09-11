/**
 * Deterministic task classifier. No LLM, no ML — regex heuristics only, so
 * policy stays unit-testable without DSH (AGENTS.md §7).
 *
 * Design bias: **be conservative**. A false "routine" is harmless; a false
 * high-value intervention is annoying and erodes trust (COGNITIVE_MODEL.md §7).
 *
 * @module dsh-cognitive-feedback/classify
 */

/** Signals that the work is mechanical and should pass through untouched. */
const ROUTINE_PATTERNS = [
  /\bboilerplate\b/i,
  /\bjust implement\b/i,
  /\bscaffold\b/i,
  /\brename\b/i,
  /\btypo\b/i,
  /\bformat(ting)?\b/i,
  /\bcrud\b/i,
  /\badd\s+(a\s+)?--?[\w-]+\s+flag\b/i,
  /\bwrite\s+(unit\s+)?tests?\b/i,
  /\bgenerate\s+(the\s+)?(fixtures?|mocks?)\b/i,
  /\bcopy\s+(this|the)\s+(template|snippet)\b/i,
];

/** High-value task patterns, most specific first. */
const TASK_PATTERNS = [
  { taskType: 'research', patterns: [
    /\bresearch\b/i,
    /\bexperiments?\b/i,
    /\bhypothes(is|es)\b/i,
    /\bbenchmark\b/i,
    /\bevaluat(e|ion)\b[^.]*\b(approach|strateg|method|model|algorithm)/i,
    /\bablations?\b/i,
    /论文|实验|假设|研究/,
  ] },
  { taskType: 'architecture', patterns: [
    /\barchitect(ure|ural)?\b/i,
    /\brefactor\b[^.]*\b(storage|data|layer|module|api|schema|core|abstraction|backends?)/i,
    /\bdesign\b[^.]*\b(system|api|schema|abstraction|module|service|protocol|layer)/i,
    /\babstractions?\b/i,
    /\bmigrate\b[^.]*\b(to|from|the)\b/i,
    /\b(support|add)\b[^.]*\b(three|multiple|several|pluggable)\b[^.]*\b(backends?|stores?|providers?|strateg)/i,
    /\b(choose|pick|select)\b[^.]*\b(framework|database|storage|protocol|library|stack)\b/i,
    /\barchitectural\s+decision\b/i,
  ] },
  { taskType: 'debugging', patterns: [
    /\bdebug(ging)?\b/i,
    /\broot\s*cause\b/i,
    /\bwhy\s+(does|is|did|do)\b[^.]*\b(fail|crash|break|hang|slow|wrong)/i,
    /\b(fails?|failing|failure|crash(es|ing)?|hangs?|deadlock|race\s+condition|flaky|regression)\b/i,
    /\bnot\s+work(ing)?\b/i,
    /\bbug\b/i,
    // Symptom-shaped reports (docs/examples.md Example 3). These describe
    // misbehaviour without naming a cause, which is exactly the case the
    // challenge intervention exists for.
    /\b(duplicat(e|es|ed|ing)|twice|double[- ]?(process|count|send|submit|charge)\b)/i,
    /\b(wrong|incorrect|unexpected(ly)?|stale|garbled|corrupt(ed)?|missing)\s+(result|output|value|total|answer|behaviou?r|data|record)/i,
    /\bsometimes\b[^.]*\b(process|return|fail|send|write|read|hang|drop|miss|duplicate|twice|wrong|skip)/i,
  ] },
  { taskType: 'explanation', patterns: [
  /^\s*(what|why|how)\b/i,
    /\bexplain\b/i,
    /\bdescribe\s+how\b/i,
  ] },
];

/** Signals that a user has already stated a causal hypothesis or design intent. */
const HYPOTHESIS_PATTERNS = [
  /\bi\s+think\b/i,
  /\bmy\s+hypothes(is|es)\b/i,
  /\bi\s+(suspect|believe|expect)\b/i,
  /\bthe\s+(cause|problem|issue)\s+is\b/i,
  /\bcaused\s+by\b/i,
  /\bproposed?\s+(design|approach|direction)\b/i,
  /\bmy\s+(plan|proposal|approach)\s+is\b/i,
  /\bwe\s+should\s+(use|build|adopt)\b/i,
];

/**
 * @param {string} text
 * @returns {boolean}
 */
export function isRoutine(text) {
  const t = String(text ?? '');
  return ROUTINE_PATTERNS.some((re) => re.test(t));
}

/**
 * Classify one user message into a task type.
 * @param {string} text
 * @returns {import('./types.js').TaskType}
 */
export function classifyTask(text) {
  const t = String(text ?? '');
  if (!t.trim()) return 'implementation';
  for (const group of TASK_PATTERNS) {
    if (group.patterns.some((re) => re.test(t))) return group.taskType;
  }
  return 'implementation';
}

/**
 * Whether the text contains a user-authored hypothesis or proposed direction.
 * @param {string} text
 * @returns {boolean}
 */
export function hasHypothesis(text) {
  const t = String(text ?? '');
  return HYPOTHESIS_PATTERNS.some((re) => re.test(t));
}

/**
 * A short, stable topic key for change detection. Deterministic for the same
 * input so prompt rendering stays cache-stable.
 * @param {string} text
 * @returns {string}
 */
export function topicKey(text) {
  const words = String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 6);
  return words.join('-');
}

/**
 * Classify a user message in one call.
 * @param {string} text
 * @returns {{ taskType: import('./types.js').TaskType, routine: boolean, hypothesis: boolean, topic: string }}
 */
export function analyzeMessage(text) {
  const routine = isRoutine(text);
  const taskType = routine ? 'implementation' : classifyTask(text);
  return {
    taskType,
    routine,
    hypothesis: hasHypothesis(text),
    topic: topicKey(text),
  };
}