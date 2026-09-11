/**
 * A JSON projection cache on disk, next to the event log.
 *
 * Rebuilding a projection from a large JSONL file is cheap but not free, and the
 * report tool is run repeatedly. The cache is therefore:
 *
 * - **keyed by the log digest**, so any append invalidates it;
 * - **versioned**, so a schema change retires old cache files;
 * - **never fatal**: a corrupt, stale, unreadable or unwritable cache is simply
 *   discarded and the projection is rebuilt from the raw log.
 *
 * The raw JSONL remains the only source of truth; deleting the cache file must
 * never lose information.
 *
 * @module dsh-cognitive-feedback/projection/disk-cache
 */
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import type { CognitiveProjection } from './index.js';

/** Cache file format version. Bump when `CognitiveProjection` changes shape. */
export const PROJECTION_CACHE_VERSION = 1;

/** Shape of `$DSH_HOME/cognitive-feedback/events.projection.json`. */
export interface ProjectionCacheFile {
  readonly version: typeof PROJECTION_CACHE_VERSION;
  readonly digest: string;
  readonly projection: CognitiveProjection;
}

/** The cache path that belongs to one event log path. */
export function cachePathFor(logPath: string): string {
  const stem = logPath.endsWith('.jsonl') ? logPath.slice(0, -'.jsonl'.length) : logPath;
  return `${stem}.projection.json`;
}

/**
 * Read a cache file if -- and only if -- it matches the current log digest.
 * Returns `null` for missing, stale, corrupt or differently-versioned data.
 */
export function loadProjectionCache(path: string, digest: string): CognitiveProjection | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ProjectionCacheFile> | null;
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.version !== PROJECTION_CACHE_VERSION) return null;
    if (parsed.digest !== digest) return null;
    if (!parsed.projection || typeof parsed.projection !== 'object') return null;
    return parsed.projection;
  } catch {
    return null;
  }
}

/**
 * Write a cache file atomically (temp + rename) and never throw. A read-only
 * home directory is a reason to skip caching, not to fail a report.
 */
export function saveProjectionCache(path: string, digest: string, projection: CognitiveProjection): void {
  const payload: ProjectionCacheFile = { version: PROJECTION_CACHE_VERSION, digest, projection };
  const temporary = `${path}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(payload)}\n`, 'utf8');
    renameSync(temporary, path);
  } catch {
    try {
      unlinkSync(temporary);
    } catch {
      /* best effort */
    }
  }
}
