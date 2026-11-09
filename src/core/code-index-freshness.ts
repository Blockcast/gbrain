/**
 * Code-index freshness signal — the age half of the code-* trust contract.
 *
 * `code-graph-readiness.ts` answers "is the symbol graph BUILT?". This module
 * answers the orthogonal question "and WHEN was the code it was built from last
 * pulled?". Both are needed, and a caller holding only the first is misled in a
 * specific, measurable way:
 *
 *   code_def(symbol) → {count: 0, status: 'ready', ready: true, defs: []}
 *
 * is returned byte-identically when the symbol does not exist and when the
 * index simply predates it. `status: 'ready'` is computed from "do code chunks
 * exist in scope", which is true of a snapshot taken an hour ago and equally
 * true of one taken five months ago. So the one field a caller would check to
 * validate the instrument AFFIRMS it, and an agent that would have re-grepped
 * on a bare empty result stops on this one.
 *
 * The fix is to put the indexed-at instant on the envelope — including, and
 * especially, on the zero-result path, which is the case that needs it most.
 *
 * Three deliberate choices, each of which has a wrong-but-tempting alternative:
 *
 *   1. A TIMESTAMP, never a pre-computed age. An age is correct only at the
 *      instant it is serialized; a cached or relayed envelope then carries a
 *      number that silently freezes. The caller subtracts against its own
 *      clock and the answer stays honest however long the envelope lives.
 *
 *   2. The OLDEST contributing source, never the newest. A mixed-source answer
 *      is only as trustworthy as its stalest contributor; reporting the newest
 *      would make such an answer look fresher than any row actually in it.
 *
 *   3. `last_sync_at IS NULL` is UNKNOWN, and is reported separately rather
 *      than skipped. SQL `MIN()` drops NULLs, so a scope holding a never-synced
 *      source would otherwise report the oldest *known* timestamp and hide the
 *      unbounded one behind it — reintroducing, inside the fix, exactly the
 *      "clean confident answer over missing data" defect the fix exists to
 *      remove. `never_synced_count` is that arm, surfaced.
 *
 * `basis` distinguishes the two questions the timestamp can answer, which are
 * NOT the same and must not be conflated by the caller:
 *   - `contributing` — these sources produced the rows you are holding.
 *   - `scope`        — nothing was returned, so this describes the sources that
 *                      WERE searched, i.e. how stale the miss might be.
 *   - `unavailable`  — the probe itself failed. Supplementary signals must
 *                      never fail a command, but "I could not tell" must also
 *                      never render as "nothing is stale".
 *
 * Cost: one query against `sources` (a tenancy table, tens of rows), with an
 * `EXISTS` correlated subquery on the scope path that short-circuits on the
 * first matching page and rides `idx_pages_source_id`. Mirrors the EXISTS
 * discipline in `code-graph-readiness.ts` for the same reason: the bootstrap
 * schema has no `page_kind` index, so `COUNT(*)` would scan.
 *
 * Fail-open: any DB error yields `basis: 'unavailable'` so a supplementary
 * signal never breaks the command it annotates.
 */

import type { BrainEngine } from './engine.ts';

export interface CodeIndexFreshness {
  /**
   * ISO-8601 instant at which the OLDEST source behind this answer was last
   * synced, or `null` when no contributing source has a recorded sync time.
   * `null` is disambiguated by `source_count` / `never_synced_count`:
   * `source_count === 0` means nothing was in scope; otherwise every source in
   * scope is never-synced.
   */
  oldest_indexed_at: string | null;
  /** How many sources the figure above covers. */
  source_count: number;
  /**
   * How many of those have no recorded sync (`last_sync_at IS NULL`). Non-zero
   * means the true worst case is UNBOUNDED and `oldest_indexed_at` is a lower
   * bound on staleness, not the answer.
   */
  never_synced_count: number;
  /** Which question the timestamp answers. See the module header. */
  basis: 'contributing' | 'scope' | 'unavailable';
}

/** Scope for a freshness probe. Omit `sourceId` (or set `allSources`) for brain-wide. */
export interface FreshnessScope {
  sourceId?: string;
  allSources?: boolean;
}

const UNAVAILABLE: CodeIndexFreshness = {
  oldest_indexed_at: null,
  source_count: 0,
  never_synced_count: 0,
  basis: 'unavailable',
};

interface SourceSyncRow {
  id: string;
  last_sync_at: Date | string | null;
}

/** Normalize a driver timestamp (Date on pg, string on PGLite) to ISO-8601. */
function toIso(value: Date | string | null): string | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Reduce source rows to the envelope. Exported for direct unit testing of the
 * NULL arm, which is the half that a `MIN()`-shaped implementation gets wrong.
 */
export function summarizeSourceRows(
  rows: readonly SourceSyncRow[],
  basis: 'contributing' | 'scope',
): CodeIndexFreshness {
  let oldest: number | null = null;
  let oldestIso: string | null = null;
  let neverSynced = 0;
  for (const row of rows) {
    const iso = toIso(row.last_sync_at);
    if (iso === null) {
      // Unparseable is treated as unrecorded: both mean "cannot date this".
      neverSynced++;
      continue;
    }
    const ms = new Date(iso).getTime();
    if (oldest === null || ms < oldest) {
      oldest = ms;
      oldestIso = iso;
    }
  }
  return {
    oldest_indexed_at: oldestIso,
    source_count: rows.length,
    never_synced_count: neverSynced,
    basis,
  };
}

/** Collapse a result set's per-row source ids to the distinct, non-null set. */
export function distinctSourceIds(
  ids: readonly (string | null | undefined)[],
): string[] {
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id === 'string' && id.length > 0) seen.add(id);
  }
  return [...seen];
}

/**
 * Resolve the freshness signal for a code-* command.
 *
 * Pass `contributingSourceIds` from the returned rows whenever the answer is
 * non-empty — that attributes the timestamp to the data actually served. When
 * it is empty (the zero-result path, or a surface whose rows carry no source
 * attribution) the probe falls back to the SCOPE that was searched and reports
 * `basis: 'scope'`.
 *
 * Never throws: a DB error yields `basis: 'unavailable'`.
 */
export async function resolveCodeIndexFreshness(
  engine: BrainEngine,
  opts: { contributingSourceIds?: readonly (string | null | undefined)[] } & FreshnessScope = {},
): Promise<CodeIndexFreshness> {
  try {
    const contributing = distinctSourceIds(opts.contributingSourceIds ?? []);
    if (contributing.length > 0) {
      // Explicit placeholders rather than `= ANY($1)`: the array-binding form
      // is not used anywhere else in this codebase and the two engines differ
      // in how they marshal JS arrays. The list is bounded by the result limit.
      const placeholders = contributing.map((_, i) => `$${i + 1}`).join(', ');
      const rows = await engine.executeRaw<SourceSyncRow>(
        `SELECT id, last_sync_at FROM sources WHERE id IN (${placeholders})`,
        [...contributing],
      );
      // A source id present on a page but absent from `sources` cannot be
      // dated. Count it as never-synced rather than dropping it, so the
      // envelope never under-reports how much of the answer is undatable.
      const missing = contributing.length - rows.length;
      const summary = summarizeSourceRows(rows, 'contributing');
      return missing > 0
        ? {
            ...summary,
            source_count: summary.source_count + missing,
            never_synced_count: summary.never_synced_count + missing,
          }
        : summary;
    }

    const scopedSourceId = opts.allSources ? undefined : opts.sourceId;
    if (scopedSourceId) {
      const rows = await engine.executeRaw<SourceSyncRow>(
        `SELECT id, last_sync_at FROM sources WHERE id = $1`,
        [scopedSourceId],
      );
      return summarizeSourceRows(rows, 'scope');
    }

    // Brain-wide zero-result path. Restrict to sources that actually hold code
    // pages: including code-free sources (a markdown-only mount, the bootstrap
    // `default` row) would put a never-synced source into every brain-wide
    // miss and drown the signal in noise.
    const rows = await engine.executeRaw<SourceSyncRow>(
      `SELECT s.id, s.last_sync_at
         FROM sources s
        WHERE EXISTS (
          SELECT 1 FROM pages p
           WHERE p.source_id = s.id AND p.page_kind = 'code'
        )`,
    );
    return summarizeSourceRows(rows, 'scope');
  } catch {
    // Supplementary signal: never fail the command on a freshness DB error.
    return UNAVAILABLE;
  }
}

/**
 * Human-facing one-liner for CLI output, or null when there is nothing worth
 * saying. Deliberately states the INSTANT and lets the reader judge: a
 * threshold baked in here would be a policy frozen into a tool response, where
 * no caller can correct it and every brain would inherit this module's guess
 * about what "too old" means.
 */
export function freshnessHint(f: CodeIndexFreshness): string | null {
  if (f.basis === 'unavailable') {
    return 'Index age unavailable (DB error). Treat this result as undated.';
  }
  if (f.source_count === 0) return null;
  const scope = f.basis === 'contributing' ? 'Answered from' : 'Searched';
  const parts: string[] = [];
  if (f.oldest_indexed_at) {
    const plural = f.source_count === 1 ? 'source' : 'sources';
    parts.push(`${scope} ${f.source_count} ${plural}; oldest last synced ${f.oldest_indexed_at}.`);
  }
  if (f.never_synced_count > 0) {
    parts.push(
      `${f.never_synced_count} of ${f.source_count} have never recorded a sync — true index age is unbounded.`,
    );
  }
  return parts.length > 0 ? parts.join(' ') : null;
}
