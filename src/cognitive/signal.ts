/**
 * The normalized signal the DSH adapter produces and the cognitive core
 * consumes.
 *
 * It lives in the core rather than the adapter so the dependency direction
 * stays adapter -> core: policy and state code must never import DSH types.
 *
 * @module dsh-cognitive-feedback/cognitive/signal
 */

/** The kinds of normalized signal the adapter can emit. */
export type SignalKind =
  | 'user_message'
  | 'assistant_message'
  | 'tool_result'
  | 'turn_start'
  | 'turn_end'
  | 'session_started'
  | 'session_ended';

/** One normalized runtime signal, free of any DSH type. */
export interface CognitiveSignal {
  readonly sessionId: string;
  readonly kind: SignalKind;
  readonly text?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}
