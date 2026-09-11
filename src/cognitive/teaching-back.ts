/**
 * Teaching Back -- deterministic evidence extraction.
 *
 * V0.1 recorded only that an answer arrived (`unassessed`) or did not
 * (`skipped`). That is honest but nearly empty: the log cannot distinguish a
 * two-word brush-off from a real explanation of mechanism.
 *
 * V0.2 extracts **structured evidence**, never a correctness grade. Every field
 * below is observable by a deterministic rule over the answer text:
 *
 * - does it state a cause (`because`, `caused by`, `so that`, ...)?
 * - does it state a mechanism (`works by`, `by using`, `implemented by`, ...)?
 * - does it reference a concrete concept (a code identifier, or a topic token)?
 * - does the user themselves flag uncertainty ("I'm not sure", "unclear")?
 * - what confidence did the user express, and how long was the answer?
 *
 * What it deliberately does NOT do: decide whether the explanation is *true*.
 * Regex heuristics cannot establish semantic correctness, and a fabricated
 * "correct" in the log would poison the very evidence base this project exists
 * to keep trustworthy. `result` therefore stays `unassessed`/`skipped`, and
 * `assessment` is labelled `evidence_extracted` -- evidence, not judgment.
 *
 * Privacy: the answer text is never copied into the event. Only booleans,
 * counts and short signal labels leave this function.
 *
 * @module dsh-cognitive-feedback/cognitive/teaching-back
 */
import type { TeachingBackResult } from './state.js';

/** What the extractor could do with the answer. */
export type TeachingBackAssessment = 'evidence_extracted' | 'skipped';

/** Confidence the *user* expressed, not a judgment of the answer. */
export type ConfidenceLevel = 'low' | 'medium' | 'high';

/** Coarse completeness band derived from answer length. */
export type AnswerLengthBand = 'brief' | 'adequate' | 'detailed';

/** Structured, deterministic evidence about one teaching-back answer. */
export interface TeachingBackEvidence {
  /** `skipped` means there was no answer to examine. */
  readonly assessment: TeachingBackAssessment;
  /** The coarse compatibility grade. Never `correct`: this is not a judge. */
  readonly result: TeachingBackResult;
  readonly answered: boolean;
  readonly wordCount: number;
  readonly lengthBand: AnswerLengthBand;
  readonly causalExplanation: boolean;
  readonly mechanismExplanation: boolean;
  readonly keyConceptReferenced: boolean;
  readonly uncertaintyAcknowledged: boolean;
  readonly confidence: ConfidenceLevel | null;
  /** Short stable labels, in a fixed order, for reporting. */
  readonly signals: readonly string[];
}

/** An explicit refusal to answer. */
const SKIP_PATTERN = /^(skip|no idea|idk|n\/?a|pass|dunno)\b/i;

/** A stated cause or consequence. */
const CAUSAL_PATTERN =
  /\b(because|since|therefore|thus|hence|so that|due to|caused by|as a result|leads? to|results? in|which is why|the reason (?:is|it))\b/i;

/** A stated mechanism ("how", not just "why"). */
const MECHANISM_PATTERN =
  /\b(works? by|by (?:using|adding|moving|wrapping|splitting|hiding|delegating|replacing|introducing|removing|centralising|centralizing)|mechanism|how it works|implemented by|through (?:a|an|the)|step(?:s)?\b)/i;

/** The user flags that they do not know. */
const UNCERTAINTY_PATTERN =
  /\b(not sure|unsure|uncertain|unclear|don'?t know|do not know|no idea|not confident|i guess|might|maybe|perhaps|probably not)\b/i;

/** The user asserts confidence. */
const HIGH_CONFIDENCE_PATTERN = /\b(i'?m (?:confident|sure)|definitely|certainly|certain that|confident that)\b/i;

/** The user hedges without doubting. */
const HEDGE_PATTERN = /\b(probably|likely|i (?:think|believe|expect)|should|seems?|appears?)\b/i;

/** A concrete code-like concept, e.g. `CognitiveController` or `refactorStorage`. */
const CODE_CONCEPT_PATTERN = /[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*|\b[A-Z][a-z]+[A-Z]\w*|`[^`]+`/;

/** The minimum answer length that can be examined at all. */
const MIN_ANSWER_LENGTH = 25;

/** Options for one extraction. */
export interface TeachingBackEvidenceOptions {
  /** The topic key the teaching-back check was about, for concept matching. */
  readonly topic?: string | null | undefined;
}

/**
 * Whether an answer was given at all. Kept as its own export because it is the
 * V0.1 contract and other callers depend on the coarse result alone.
 */
export function assessTeachingBack(text: string | undefined): 'unassessed' | 'skipped' {
  return evidenceResult(String(text ?? ''));
}

function evidenceResult(value: string): 'unassessed' | 'skipped' {
  if (value.length < MIN_ANSWER_LENGTH) return 'skipped';
  if (SKIP_PATTERN.test(value)) return 'skipped';
  return 'unassessed';
}

/** Coarse length band. Thresholds are deliberately wide; they are not a grade. */
function lengthBandFor(wordCount: number): AnswerLengthBand {
  if (wordCount < 12) return 'brief';
  if (wordCount <= 45) return 'adequate';
  return 'detailed';
}

/** Whether the answer names something concrete: a code identifier or a topic word. */
function referencesKeyConcept(value: string, topic: string | null | undefined): boolean {
  if (CODE_CONCEPT_PATTERN.test(value)) return true;
  if (!topic) return false;
  const tokens = topic
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 3);
  if (!tokens.length) return false;
  const lower = value.toLowerCase();
  return tokens.some((token) => lower.includes(token));
}

/** Extract structured evidence from one teaching-back answer. */
export function extractTeachingBackEvidence(
  text: string | undefined,
  options: TeachingBackEvidenceOptions = {},
): TeachingBackEvidence {
  const value = String(text ?? '').trim();
  const result = evidenceResult(value);
  const answered = result !== 'skipped';

  const wordCount = value ? value.split(/\s+/).filter(Boolean).length : 0;
  const lengthBand = lengthBandFor(wordCount);

  if (!answered) {
    return {
      assessment: 'skipped',
      result,
      answered: false,
      wordCount,
      lengthBand,
      causalExplanation: false,
      mechanismExplanation: false,
      keyConceptReferenced: false,
      uncertaintyAcknowledged: false,
      confidence: null,
      signals: [`length:${lengthBand}`],
    };
  }

  const causalExplanation = CAUSAL_PATTERN.test(value);
  const mechanismExplanation = MECHANISM_PATTERN.test(value);
  const keyConceptReferenced = referencesKeyConcept(value, options.topic);
  const uncertaintyAcknowledged = UNCERTAINTY_PATTERN.test(value);

  let confidence: ConfidenceLevel | null = null;
  if (uncertaintyAcknowledged) confidence = 'low';
  else if (HIGH_CONFIDENCE_PATTERN.test(value)) confidence = 'high';
  else if (HEDGE_PATTERN.test(value)) confidence = 'medium';

  const signals: string[] = [];
  if (causalExplanation) signals.push('causal');
  if (mechanismExplanation) signals.push('mechanism');
  if (keyConceptReferenced) signals.push('key-concept');
  if (uncertaintyAcknowledged) signals.push('uncertainty');
  if (confidence) signals.push(`confidence:${confidence}`);
  signals.push(`length:${lengthBand}`);

  return {
    assessment: 'evidence_extracted',
    result,
    answered: true,
    wordCount,
    lengthBand,
    causalExplanation,
    mechanismExplanation,
    keyConceptReferenced,
    uncertaintyAcknowledged,
    confidence,
    signals,
  };
}
