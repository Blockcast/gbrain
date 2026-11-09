/**
 * Code-index freshness signal — the age half of the code-* trust contract.
 *
 * `code-graph-readiness.ts` answers "is the symbol graph BUILT?". This module
 * answers the orthogonal question "and HOW OLD is the code it was built from?".
 * Both are needed, and a caller holding only the first is misled in a specific,
 * measurable way:
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
 * The fix is to put the index's age on the envelope — including, and
 * especially, on the zero-result path, which is the case that needs it most.
 *
 * ---------------------------------------------------------------------------
 * WHY TWO TIMESTAMPS, AND WHY `last_sync_at` ALONE IS THE WRONG ONE
 * ---------------------------------------------------------------------------
 *
 * `sources.last_sync_at` does NOT record when a source was last synced. It
 * records when a sync last INGESTED A NEW COMMIT. Its only two writers are in
 * `writeSyncAnchor` (`src/commands/sync.ts`), both inside the
 * `which === 'last_commit'` branch, so both run only on a commit advance; the
 * `up_to_date` early return (`lastCommit === headCommit`) exits without
 * touching the column.
 *
 * So a quiet but healthy repo — syncing every 15 minutes, no commits for three
 * weeks — carries a three-week-old `last_sync_at` while being perfectly caught
 * up. Reported as "last synced three weeks ago" that is simply FALSE, and it
 * is byte-identical to the frozen, broken-sync brain this signal exists to
 * detect. A signal that cannot separate those two cases does not do its job,
 * and it raises a false alarm on every quiet repo.
 *
 * This codebase has already paid for that lesson once: `source-health.ts`
 * (v0.41.32.0) moved OFF raw `now - last_sync_at` precisely because it
 * "false-flagged quiet, caught-up repos as SEVERE", and the column it moved to
 * is `sources.newest_content_at` — the git committer time of the HEAD commit
 * that was indexed, written atomically with `last_sync_at` in the same UPDATE.
 *
 * Hence two timestamps, in two different clock domains, each named for what it
 * actually is:
 *
 *   - `oldest_content_at`      — git committer clock. "The newest code I hold
 *                                 was committed at T." TRUE on a quiet repo and
 *                                 on a frozen one alike, and it is the figure a
 *                                 caller compares against the repo's own HEAD
 *                                 time to decide whether the index is behind.
 *                                 This is the primary signal.
 *   - `oldest_commit_sync_at`  — DB clock. "A sync last took in new code at T."
 *                                 Useful for diagnosing a stuck pipeline;
 *                                 NEVER read as "last checked for new code".
 *
 * Neither is a staleness verdict, because gbrain cannot know how fast someone
 * else's codebase moves. Both are facts; the caller judges.
 *
 * ---------------------------------------------------------------------------
 * Three further choices, each with a wrong-but-tempting alternative:
 *
 *   1. TIMESTAMPS, never a pre-computed age. An age is correct only at the
 *      instant it is serialized; a cached or relayed envelope then carries a
 *      number that silently freezes. The caller subtracts against its own
 *      clock and the answer stays honest however long the envelope lives.
 *
 *   2. The OLDEST contributing source, never the newest. A mixed-source answer
 *      is only as trustworthy as its stalest contributor; reporting the newest
 *      would make such an answer look fresher than any row actually in it.
 *
 *   3. A NULL timestamp is UNKNOWN, and is counted rather than skipped. SQL
 *      `MIN()` drops NULLs, so a scope holding an undatable source would
 *      otherwise report the oldest *known* timestamp and hide the unbounded one
 *      behind it — reintroducing, inside the fix, exactly the "clean confident
 *      answer over missing data" defect the fix exists to remove. Each
 *      timestamp therefore carries its own undatable count.
 *
 * `basis` distinguishes the two questions the timestamps can answer, which are
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
 * signal never breaks the command it annotates. Pre-v109 brains lack
 * `newest_content_at` entirely; that is detected by column name and degrades to
 * the ingest clock alone rather than losing the whole signal.
 */

import type { BrainEngine } from './engine.ts';
import { isUndefinedColumnError } from './utils.ts';

export interface CodeIndexFreshness {
  /**
   * ISO-8601 committer time of the newest commit indexed, taken from the
   * STALEST source behind this answer (`MIN(sources.newest_content_at)`).
   *
   * This is the CONTENT vintage: "the newest code behind this answer was
   * committed at T". Compare it against the repository's own HEAD time to
   * decide whether the index is behind. `null` means no contributing source
   * records one — see `content_undatable_count`.
   */
  oldest_content_at: string | null;
  /**
   * How many sources in scope have no recorded content date (never had a
   * commit-advancing sync since v0.41.32.0, or are on a pre-v109 brain).
   * Non-zero means `oldest_content_at` is a lower bound on age, not the answer.
   */
  content_undatable_count: number;
  /**
   * ISO-8601 instant at which the stalest source behind this answer last
   * INGESTED A NEW COMMIT (`MIN(sources.last_sync_at)`).
   *
   * ⚠ This is NOT "last synced" and NOT "last checked for new code". The column
   * is written only when `last_commit` advances, so a healthy repo with no new
   * commits keeps an old value here forever. Use it to diagnose a stuck sync
   * pipeline, never to date the content — that is `oldest_content_at`.
   */
  oldest_commit_sync_at: string | null;
  /**
   * How many sources in scope have never ingested a commit
   * (`last_sync_at IS NULL`), so their true age is unbounded.
   */
  never_synced_count: number;
  /** How many sources the figures above cover. */
  source_count: number;
  /** Which question the timestamps answer. See the module header. */
  basis: 'contributing' | 'scope' | 'unavailable';
}

/** Scope for a freshness probe. Omit `sourceId` (or set `allSources`) for brain-wide. */
export interface FreshnessScope {
  sourceId?: string;
  allSources?: boolean;
}

const UNAVAILABLE: CodeIndexFreshness = {
  oldest_content_at: null,
  content_undatable_count: 0,
  oldest_commit_sync_at: null,
  never_synced_count: 0,
  source_count: 0,
  basis: 'unavailable',
};

interface SourceSyncRow {
  id: string;
  last_sync_at: Date | string | null;
  /** Absent entirely on pre-v109 brains; see `selectSourceRows`. */
  newest_content_at?: Date | string | null;
}

/** Normalize a driver timestamp (Date on pg, string on PGLite) to ISO-8601. */
function toIso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Reduce source rows to the envelope. Exported for direct unit testing of the
 * NULL arms, which are the half a `MIN()`-shaped implementation gets wrong.
 */
export function summarizeSourceRows(
  rows: readonly SourceSyncRow[],
  basis: 'contributing' | 'scope',
): CodeIndexFreshness {
  let oldestSync: number | null = null;
  let oldestSyncIso: string | null = null;
  let neverSynced = 0;
  let oldestContent: number | null = null;
  let oldestContentIso: string | null = null;
  let contentUndatable = 0;

  for (const row of rows) {
    // Unparseable is treated as unrecorded: both mean "cannot date this".
    const syncIso = toIso(row.last_sync_at);
    if (syncIso === null) {
      neverSynced++;
    } else {
      const ms = new Date(syncIso).getTime();
      if (oldestSync === null || ms < oldestSync) {
        oldestSync = ms;
        oldestSyncIso = syncIso;
      }
    }

    const contentIso = toIso(row.newest_content_at);
    if (contentIso === null) {
      contentUndatable++;
    } else {
      const ms = new Date(contentIso).getTime();
      if (oldestContent === null || ms < oldestContent) {
        oldestContent = ms;
        oldestContentIso = contentIso;
      }
    }
  }

  return {
    oldest_content_at: oldestContentIso,
    content_undatable_count: contentUndatable,
    oldest_commit_sync_at: oldestSyncIso,
    never_synced_count: neverSynced,
    source_count: rows.length,
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
 * Issue a sources SELECT that carries `newest_content_at`, degrading to the
 * historical column set on pre-v109 brains that lack it.
 *
 * Mirrors the forward-reference guard in `sources-load.ts`: the column is added
 * by migration without backfill, so both "column missing" (old brain) and
 * "column NULL" (no commit-advancing sync since v0.41.32.0) are live states.
 * The first must not take the whole signal down with it — losing the content
 * clock is survivable, losing the envelope is the defect this module exists to
 * fix.
 */
async function selectSourceRows(
  engine: BrainEngine,
  columns: string,
  contentColumn: string,
  fromTail: string,
  params?: unknown[],
): Promise<SourceSyncRow[]> {
  const run = (cols: string) =>
    engine.executeRaw<SourceSyncRow>(
      `SELECT ${cols} FROM sources ${fromTail}`,
      params,
    );
  try {
    // Aliased so the row shape is identical whether or not the caller's query
    // qualifies its columns with a table alias.
    return await run(`${columns}, ${contentColumn} AS newest_content_at`);
  } catch (err) {
    if (isUndefinedColumnError(err, 'newest_content_at')) return await run(columns);
    throw err;
  }
}

/**
 * Resolve the freshness signal for a code-* command.
 *
 * Pass `contributingSourceIds` from the returned rows whenever the answer is
 * non-empty — that attributes the timestamps to the data actually served. When
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
      const rows = await selectSourceRows(
        engine,
        'id, last_sync_at',
        'newest_content_at',
        `WHERE id IN (${placeholders})`,
        [...contributing],
      );
      // A source id present on a page but absent from `sources` cannot be
      // dated on either clock. Count it in both undatable arms rather than
      // dropping it, so the envelope never under-reports how much of the
      // answer is undatable.
      const missing = contributing.length - rows.length;
      const summary = summarizeSourceRows(rows, 'contributing');
      return missing > 0
        ? {
            ...summary,
            source_count: summary.source_count + missing,
            never_synced_count: summary.never_synced_count + missing,
            content_undatable_count: summary.content_undatable_count + missing,
          }
        : summary;
    }

    const scopedSourceId = opts.allSources ? undefined : opts.sourceId;
    if (scopedSourceId) {
      const rows = await selectSourceRows(
        engine,
        'id, last_sync_at',
        'newest_content_at',
        'WHERE id = $1',
        [scopedSourceId],
      );
      return summarizeSourceRows(rows, 'scope');
    }

    // Brain-wide zero-result path. Restrict to sources that actually hold code
    // pages: including code-free sources (a markdown-only mount, the bootstrap
    // `default` row) would put an undatable source into every brain-wide miss
    // and drown the signal in noise.
    const rows = await selectSourceRows(
      engine,
      's.id, s.last_sync_at',
      's.newest_content_at',
      `s
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
 * saying.
 *
 * States INSTANTS and lets the reader judge: a threshold baked in here would be
 * a policy frozen into a tool response, where no caller can correct it and
 * every brain would inherit this module's guess about what "too old" means.
 *
 * The wording is deliberately literal about which clock each figure is on. An
 * earlier draft rendered the ingest clock as "oldest last synced <t>", which is
 * false on any quiet repo — see the module header.
 */
export function freshnessHint(f: CodeIndexFreshness): string | null {
  if (f.basis === 'unavailable') {
    return 'Index age unavailable (DB error). Treat this result as undated.';
  }
  if (f.source_count === 0) return null;
  const scope = f.basis === 'contributing' ? 'Answered from' : 'Searched';
  const plural = f.source_count === 1 ? 'source' : 'sources';
  const parts: string[] = [`${scope} ${f.source_count} ${plural}.`];

  if (f.oldest_content_at) {
    parts.push(`Newest code indexed was committed ${f.oldest_content_at} (stalest source).`);
  }
  if (f.content_undatable_count > 0) {
    parts.push(
      `${f.content_undatable_count} of ${f.source_count} cannot date their content — true index age is unbounded.`,
    );
  }
  if (f.oldest_commit_sync_at) {
    parts.push(`Stalest source last ingested a new commit ${f.oldest_commit_sync_at}.`);
  }
  if (f.never_synced_count > 0) {
    parts.push(`${f.never_synced_count} of ${f.source_count} have never ingested a commit.`);
  }
  // Only the leading scope sentence: nothing datable, nothing worth printing.
  return parts.length > 1 ? parts.join(' ') : null;
}
