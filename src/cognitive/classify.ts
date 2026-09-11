/**
 * Deterministic task classifier. No LLM, no ML -- regex heuristics only, so
 * policy stays unit-testable without DSH.
 *
 * Design bias: **be conservative**. A false "routine" is harmless; a false
 * high-value intervention is annoying and erodes trust.
 *
 * @module dsh-cognitive-feedback/cognitive/classify
 */

/** The task shape inferred from a user message. */
export type TaskType = 'implementation' | 'debugging' | 'architecture' | 'research' | 'explanation';

/** Signals that the work is mechanical and should pass through untouched. */
const ROUTINE_PATTERNS: readonly RegExp[] = [
  /\bboilerplate\b/i,
  /\bjust implement\b/i,
  /\bscaffold\b/i,
  /\brename\b/i,
  /\btypo\b/i,
  /\bformat(ting)?\b/i,
  /\bcrud\b/i,
  // Tolerate punctuation/backticks around the flag ("Add a \`--verbose\` flag"):
  // docs/examples.md Example 1 spells it that way, and the ownership model
  // makes a mis-classification here visible as a spurious nudge.
  /\badd\s+(?:a\s+)?[^\w\s]*--?[\w-]+[^\w\s]*\s+flag\b/i,
  /\bwrite\s+(unit\s+)?tests?\b/i,
  /\bgenerate\s+(the\s+)?(fixtures?|mocks?)\b/i,
  /\bcopy\s+(this|the)\s+(template|snippet)\b/i,
];

interface TaskPatternGroup {
  readonly taskType: TaskType;
  readonly patterns: readonly RegExp[];
}

/** High-value task patterns, most specific first. */
const TASK_PATTERNS: readonly TaskPatternGroup[] = [
  {
    taskType: 'research',
    patterns: [
      /\bresearch\b/i,
      /\bexperiments?\b/i,
      /\bhypothes(is|es)\b/i,
      /\bbenchmark\b/i,
      /\bevaluat(e|ion)\b[^.]*\b(approach|strateg|method|model|algorithm)/i,
      /\bablations?\b/i,
      /论文|实验|假设|研究/,
      // Evaluation and selection phrasings. COGNITIVE_MODEL.md lists
      // "architecture selection" and "algorithm selection" as high-value
      // cognitive debt, but explicit research vocabulary alone missed
      // "Investigate whether Redis or Postgres is better". Each pattern below
      // requires a choice/evaluation context so ordinary comparisons do not
      // over-trigger.
      /\b(investigate|look\s+into|figure\s+out|find\s+out|determine)\b[^.]*\b(whether|which|better|best|approach|option|strateg|cache|database|store|framework|design|method)/i,
      /\b(compare|comparison|trade-?offs?|versus|vs\.?)\b[^.]*\b(approach|option|design|architect|database|store|cache|framework|librar|strateg|method|model|backend|provider|scheme)/i,
      /\bwhich\b[^.]*\b(better|best|faster|cheaper|simpler|preferable|more\s+suitable)\b/i,
      /\bbest\s+(approach|way|option|strateg|choice|design)\b/i,
      /\bdecide\s+(whether|between|which)\b/i,
      /\bpros\s+and\s+cons\b/i,
    ],
  },
  {
    taskType: 'architecture',
    patterns: [
      /\barchitect(ure|ural)?\b/i,
      /\brefactor\b[^.]*\b(storage|data|layer|module|api|schema|core|abstraction|backends?)/i,
      /\bdesign\b[^.]*\b(system|api|schema|abstraction|module|service|protocol|layer)/i,
      /\babstractions?\b/i,
      /\bmigrate\b[^.]*\b(to|from|the)\b/i,
      /\b(support|add)\b[^.]*\b(three|multiple|several|pluggable)\b[^.]*\b(backends?|stores?|providers?|strateg)/i,
      /\b(choose|pick|select)\b[^.]*\b(framework|database|storage|protocol|library|stack)\b/i,
      /\barchitectural\s+decision\b/i,
    ],
  },
  {
    taskType: 'debugging',
    patterns: [
      /\bdebug(ging)?\b/i,
      /\broot\s*cause\b/i,
      /\bwhy\s+(does|is|did|do)\b[^.]*\b(fail|crash|break|hang|slow|wrong)/i,
      /\b(fails?|failing|failure|crash(es|ing)?|hangs?|deadlock|race\s+condition|flaky|regression)\b/i,
      /\bnot\s+work(ing)?\b/i,
      /\bbug\b/i,
      // Symptom-shaped reports (docs/examples.md Example 3): misbehaviour
      // without a named cause is exactly what the challenge is for.
      /\b(duplicat(e|es|ed|ing)|twice|double[- ]?(process|count|send|submit|charge)\b)/i,
      /\b(wrong|incorrect|unexpected(ly)?|stale|garbled|corrupt(ed)?|missing)\s+(result|output|value|total|answer|behaviou?r|data|record)/i,
      /\bsometimes\b[^.]*\b(process|return|fail|send|write|read|hang|drop|miss|duplicate|twice|wrong|skip)/i,
    ],
  },
  {
    taskType: 'explanation',
    patterns: [/^\s*(what|why|how)\b/i, /\bexplain\b/i, /\bdescribe\s+how\b/i],
  },
];

/** Signals that a user has already stated a causal hypothesis or design intent. */
const HYPOTHESIS_PATTERNS: readonly RegExp[] = [
  /\bi\s+think\b/i,
  /\bmy\s+hypothes(is|es)\b/i,
  /\bi\s+(suspect|believe|expect)\b/i,
  /\bthe\s+(cause|problem|issue)\s+is\b/i,
  /\bcaused\s+by\b/i,
  /\bproposed?\s+(design|approach|direction)\b/i,
  /\bmy\s+(plan|proposal|approach)\s+is\b/i,
  /\bwe\s+should\s+(use|build|adopt)\b/i,
];

/** Whether the text describes mechanical work. */
export function isRoutine(text: string): boolean {
  return ROUTINE_PATTERNS.some((re) => re.test(text));
}

/** Classify one user message into a task type. */
export function classifyTask(text: string): TaskType {
  if (!text.trim()) return 'implementation';
  for (const group of TASK_PATTERNS) {
    if (group.patterns.some((re) => re.test(text))) return group.taskType;
  }
  return 'implementation';
}

/** Whether the text contains a user-authored hypothesis or proposed direction. */
export function hasHypothesis(text: string): boolean {
  return HYPOTHESIS_PATTERNS.some((re) => re.test(text));
}

/**
 * A short, stable topic key for change detection.
 *
 * BOUNDED: this key is the one user-derived string that can reach the system
 * prompt (the teaching-back branch). Without caps a single multi-megabyte
 * token produced a multi-megabyte section -- a context-pressure vector.
 */
export function topicKey(text: string): string {
  const TOKEN_CAP = 16;
  const TOTAL_CAP = 64;
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 3)
    .slice(0, 6)
    .map((word) => word.slice(0, TOKEN_CAP));
  return words.join('-').slice(0, TOTAL_CAP);
}

/**
 * Canonicalize a topic key for cross-event aggregation.
 *
 * `topicKey()` keeps word order: it is a change-detection key, and "storage
 * refactor" vs "refactor storage" being different keys is desirable there. A
 * knowledge-gap projection asks the opposite question -- is this the same
 * *topic* seen again? -- so tokens are lowercased, deduped, capped and **sorted**
 * to make the two spellings identical.
 */
export function normalizeTopic(topic: string): string {
  if (!topic) return '';
  const tokens = String(topic)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0)
    .map((token) => token.slice(0, 16))
    .filter((token, index, all) => all.indexOf(token) === index)
    .sort();
  return tokens.join('-').slice(0, 64);
}

/**
 * Signals that a debugging task has **high impact**: something a wrong fix can
 * make materially worse than the bug itself.
 */
const HIGH_IMPACT_PATTERN =
  /\b(production|prod\b|data (?:loss|corruption)|corrupt(?:ed|ion)?|security|race condition|deadlock|memory leak|outage|payment|billing|financial|customer data|revenue)\b/i;

/**
 * Signals that the cause is **not understood**: the symptom moves, so the user's
 * own reasoning is the missing piece.
 */
const HIGH_UNCERTAINTY_PATTERN =
  /\b(sometimes|intermittent(?:ly)?|flaky|non-?deterministic|occasionally|sporadic|random(?:ly)?|race|deadlock)\b/i;

/**
 * Whether a debugging task is BOTH high-impact and high-uncertainty.
 *
 * The ownership model treats that combination as user-owned (a reasoning gate).
 * Ordinary bugs stay a non-blocking challenge, so the plugin does not become
 * "ask the user before every fix" (issue #9's debug rule).
 */
export function isHighImpactDebugging(text: string): boolean {
  return HIGH_IMPACT_PATTERN.test(text) && HIGH_UNCERTAINTY_PATTERN.test(text);
}

/** The classifier's verdict for one user message. */
export interface MessageAnalysis {
  readonly taskType: TaskType;
  readonly routine: boolean;
  readonly hypothesis: boolean;
  readonly topic: string;
  /** High-impact AND high-uncertainty debugging: a user-owned root cause. */
  readonly highImpactDebugging: boolean;
}

/** Classify a user message in one call. */
export function analyzeMessage(text: string): MessageAnalysis {
  const routine = isRoutine(text);
  return {
    taskType: routine ? 'implementation' : classifyTask(text),
    routine,
    hypothesis: hasHypothesis(text),
    topic: topicKey(text),
    highImpactDebugging: !routine && isHighImpactDebugging(text),
  };
}
