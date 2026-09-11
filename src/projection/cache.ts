/**
 * A rebuildable projection cache.
 *
 * The raw JSONL log stays authoritative; a projection is only a derived view.
 * That makes the cache policy simple and safe:
 *
 * - a **stale** projection (the log changed) is discarded and rebuilt;
 * - a **failed** rebuild never propagates -- the caller gets the empty
 *   projection and the error is recorded, because a read-side feature must never
 *   break a coding session;
 * - an **explicit** rebuild is always available, so a caller that suspects
 *   corruption can throw the derived data away and regenerate it.
 *
 * @module dsh-cognitive-feedback/projection/cache
 */
import type { CognitiveEvent } from '../events/types.js';

/**
 * A cheap content fingerprint of the log.
 *
 * Count plus first/last identity catches appends (the only mutation an
 * append-only log permits) without hashing the whole file on every read.
 */
export function projectionDigest(events: readonly CognitiveEvent[]): string {
  if (!events.length) return 'v1:0';
  const first = events[0];
  const last = events[events.length - 1];
  return `v1:${events.length}:${first?.id ?? ''}:${last?.id ?? ''}`;
}

/** Cache counters, for diagnostics and tests. */
export interface ProjectionCacheStats {
  readonly digest: string | null;
  readonly hits: number;
  readonly misses: number;
  readonly rebuilds: number;
  readonly failures: number;
}

/** Build a stale-or-missing projection once, and reuse it until the log changes. */
export class RebuildableProjection<T> {
  private readonly build: (events: readonly CognitiveEvent[]) => T;
  private readonly fallback: T;
  private cachedDigest: string | null = null;
  private cached: T | null = null;
  private hits = 0;
  private misses = 0;
  private rebuilds = 0;
  private failures = 0;
  private lastError: unknown = null;

  constructor(build: (events: readonly CognitiveEvent[]) => T, fallback: T) {
    this.build = build;
    this.fallback = fallback;
  }

  /** The projection for this event stream, rebuilding only when the digest moved. */
  get(events: readonly CognitiveEvent[]): T {
    const digest = projectionDigest(events);
    if (this.cached && this.cachedDigest === digest) {
      this.hits += 1;
      return this.cached;
    }
    this.misses += 1;
    return this.rebuild(events);
  }

  /** Discard and regenerate unconditionally. */
  rebuild(events: readonly CognitiveEvent[]): T {
    this.rebuilds += 1;
    try {
      const projection = this.build(events);
      this.cached = projection;
      this.cachedDigest = projectionDigest(events);
      this.lastError = null;
      return projection;
    } catch (error) {
      // Fail open: discard the derived data and hand back the empty projection.
      this.failures += 1;
      this.lastError = error;
      this.cached = null;
      this.cachedDigest = null;
      return this.fallback;
    }
  }

  /** Drop the cached projection; the next get() rebuilds it. */
  invalidate(): void {
    this.cached = null;
    this.cachedDigest = null;
  }

  stats(): ProjectionCacheStats {
    return {
      digest: this.cachedDigest,
      hits: this.hits,
      misses: this.misses,
      rebuilds: this.rebuilds,
      failures: this.failures,
    };
  }

  error(): unknown {
    return this.lastError;
  }
}
