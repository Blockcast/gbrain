/**
 * Code-index freshness — pure reducers + fail-open contract (no DB).
 *
 * `code-graph-readiness.test.ts` pins "is the graph BUILT". This pins "and HOW
 * OLD is the code behind it", which is the question that makes
 * `{count: 0, status: 'ready'}` safe to act on.
 *
 * Deliberately DB-free so the load-bearing reduction — oldest-wins, and the
 * NULL arms that a `MIN()`-shaped implementation silently drops — is pinned
 * everywhere the suite runs, including hosts where the PGLite WASM runtime
 * cannot start. Engine-backed scoping lives in
 * `code-index-freshness-engine.test.ts`.
 */

import { describe, test, expect } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import {
  resolveCodeIndexFreshness,
  summarizeSourceRows,
  distinctSourceIds,
  freshnessHint,
} from '../src/core/code-index-freshness.ts';

const FRESH = '2026-11-01T00:00:00.000Z';
const STALE = '2026-06-24T00:00:00.000Z';

/** An engine whose every query throws — the fail-open probe. */
const brokenEngine = {
  kind: 'pglite',
  executeRaw: async () => { throw new Error('boom'); },
} as unknown as BrainEngine;

/** An engine that answers every query with no rows — an empty scope. */
const emptyEngine = {
  kind: 'pglite',
  executeRaw: async () => [],
} as unknown as BrainEngine;

describe('summarizeSourceRows — content clock', () => {
  test('reports the OLDEST contributor, not the newest', () => {
    const f = summarizeSourceRows(
      [
        { id: 'a', last_sync_at: FRESH, newest_content_at: FRESH },
        { id: 'b', last_sync_at: STALE, newest_content_at: STALE },
      ],
      'contributing',
    );
    expect(f.oldest_content_at).toBe(STALE);
    expect(f.oldest_commit_sync_at).toBe(STALE);
    expect(f.source_count).toBe(2);
    expect(f.content_undatable_count).toBe(0);
    expect(f.never_synced_count).toBe(0);
    expect(f.basis).toBe('contributing');
  });

  test('the two clocks are reduced INDEPENDENTLY — the stalest content and the stalest ingest need not be the same source', () => {
    const f = summarizeSourceRows(
      [
        { id: 'a', last_sync_at: FRESH, newest_content_at: STALE },
        { id: 'b', last_sync_at: STALE, newest_content_at: FRESH },
      ],
      'contributing',
    );
    expect(f.oldest_content_at).toBe(STALE);
    expect(f.oldest_commit_sync_at).toBe(STALE);
  });

  test('an undatable content column is COUNTED, not dropped the way MIN() drops NULL', () => {
    const f = summarizeSourceRows(
      [
        { id: 'a', last_sync_at: FRESH, newest_content_at: FRESH },
        // Pre-v109 brain, or no commit-advancing sync since v0.41.32.0.
        { id: 'b', last_sync_at: FRESH, newest_content_at: null },
      ],
      'contributing',
    );
    // The known timestamp is only a LOWER BOUND once an undatable source is in
    // the answer — surfacing that is the entire reason this arm exists.
    expect(f.oldest_content_at).toBe(FRESH);
    expect(f.content_undatable_count).toBe(1);
    expect(f.never_synced_count).toBe(0);
    expect(f.source_count).toBe(2);
  });

  test('a row with no content column at all (pre-v109 SELECT) is undatable on the content clock only', () => {
    const f = summarizeSourceRows([{ id: 'a', last_sync_at: STALE }], 'contributing');
    expect(f.oldest_content_at).toBeNull();
    expect(f.content_undatable_count).toBe(1);
    // The ingest clock still works, so the envelope is degraded, not dark.
    expect(f.oldest_commit_sync_at).toBe(STALE);
    expect(f.never_synced_count).toBe(0);
  });

  test('a never-synced contributor is counted on the ingest clock', () => {
    const f = summarizeSourceRows(
      [
        { id: 'a', last_sync_at: FRESH, newest_content_at: FRESH },
        { id: 'b', last_sync_at: null, newest_content_at: null },
      ],
      'contributing',
    );
    expect(f.oldest_commit_sync_at).toBe(FRESH);
    expect(f.never_synced_count).toBe(1);
    expect(f.content_undatable_count).toBe(1);
    expect(f.source_count).toBe(2);
  });

  test('all contributors undatable → null timestamps but non-zero source_count', () => {
    const f = summarizeSourceRows([{ id: 'a', last_sync_at: null, newest_content_at: null }], 'scope');
    expect(f.oldest_content_at).toBeNull();
    expect(f.oldest_commit_sync_at).toBeNull();
    expect(f.source_count).toBe(1);
    expect(f.never_synced_count).toBe(1);
    expect(f.content_undatable_count).toBe(1);
  });

  test('empty input is distinguishable from all-null input', () => {
    const f = summarizeSourceRows([], 'scope');
    expect(f.oldest_content_at).toBeNull();
    expect(f.source_count).toBe(0);
    expect(f.never_synced_count).toBe(0);
    expect(f.content_undatable_count).toBe(0);
  });

  test('accepts Date objects (postgres driver) as well as strings (PGLite)', () => {
    const f = summarizeSourceRows(
      [{ id: 'a', last_sync_at: new Date(STALE), newest_content_at: new Date(STALE) }],
      'contributing',
    );
    expect(f.oldest_content_at).toBe(STALE);
    expect(f.oldest_commit_sync_at).toBe(STALE);
  });

  test('an unparseable timestamp is undatable, never silently fresh', () => {
    const f = summarizeSourceRows(
      [{ id: 'a', last_sync_at: 'not-a-date', newest_content_at: 'not-a-date' }],
      'contributing',
    );
    expect(f.oldest_content_at).toBeNull();
    expect(f.oldest_commit_sync_at).toBeNull();
    expect(f.never_synced_count).toBe(1);
    expect(f.content_undatable_count).toBe(1);
  });
});

describe('distinctSourceIds', () => {
  test('dedupes and drops null/undefined/empty', () => {
    expect(distinctSourceIds(['a', 'a', null, undefined, '', 'b']).sort()).toEqual(['a', 'b']);
  });
});

describe('resolveCodeIndexFreshness — fail-open (CRITICAL regression)', () => {
  test('DB error → basis unavailable, never throws', async () => {
    const f = await resolveCodeIndexFreshness(brokenEngine, { contributingSourceIds: ['a'] });
    expect(f.basis).toBe('unavailable');
    expect(f.oldest_content_at).toBeNull();
    expect(f.oldest_commit_sync_at).toBeNull();
  });

  test('unavailable is DISTINGUISHABLE from "nothing is stale"', async () => {
    const err = await resolveCodeIndexFreshness(brokenEngine, {});
    const clean = await resolveCodeIndexFreshness(emptyEngine, { sourceId: 'no-such-source' });
    // Both carry null timestamps and zero sources; only `basis` separates
    // "the probe failed" from "the scope is genuinely empty". Without that
    // split, a failed probe renders exactly like a clean, fresh brain.
    expect(err.oldest_content_at).toBeNull();
    expect(clean.oldest_content_at).toBeNull();
    expect(err.basis).toBe('unavailable');
    expect(clean.basis).toBe('scope');
  });
});

describe('freshnessHint', () => {
  const quietRepo = {
    oldest_content_at: STALE,
    content_undatable_count: 0,
    oldest_commit_sync_at: STALE,
    never_synced_count: 0,
    source_count: 1,
    basis: 'contributing' as const,
  };

  test('names the instant rather than judging it against a baked-in threshold', () => {
    const hint = freshnessHint({ ...quietRepo, source_count: 2 });
    expect(hint).toContain(STALE);
    expect(hint).toContain('Answered from');
  });

  /**
   * REGRESSION PIN (the v0.42.52.0 review finding).
   *
   * `sources.last_sync_at` advances ONLY when a sync ingests a new commit —
   * `writeSyncAnchor` is its only writer and the `up_to_date` early return in
   * `sync.ts` never touches it. So a quiet but healthy repo, synced minutes
   * ago with no new commits for months, carries a months-old value here.
   *
   * Rendering that as "last synced <months ago>" is simply FALSE, and it reads
   * byte-identically to the frozen, broken-sync brain this signal exists to
   * detect. The hint must describe the CONTENT, and must describe the ingest
   * clock as ingest.
   *
   * `source-health.ts` (v0.41.32.0) already moved off raw `now - last_sync_at`
   * for exactly this reason; this pins that the code-* envelope does not
   * reintroduce it.
   */
  test('never claims "last synced" — the quiet-repo false alarm', () => {
    const hint = freshnessHint(quietRepo) ?? '';
    expect(hint).not.toContain('last synced');
    expect(hint).not.toContain('last sync ');
    // The content clock is stated as content.
    expect(hint).toContain('Newest code indexed was committed');
    // The ingest clock is stated as ingest, never as a check.
    expect(hint).toContain('last ingested a new commit');
    expect(hint).not.toContain('last checked');
  });

  test('a scope-basis hint says "Searched", not "Answered from"', () => {
    const hint = freshnessHint({ ...quietRepo, basis: 'scope' });
    expect(hint).toContain('Searched');
  });

  test('undatable content is called out as unbounded', () => {
    const hint = freshnessHint({
      ...quietRepo,
      oldest_content_at: STALE,
      content_undatable_count: 1,
      source_count: 2,
      basis: 'scope',
    });
    expect(hint).toContain('unbounded');
  });

  test('unavailable says so; an empty scope stays quiet', () => {
    expect(freshnessHint({
      oldest_content_at: null, content_undatable_count: 0, oldest_commit_sync_at: null,
      never_synced_count: 0, source_count: 0, basis: 'unavailable',
    })).toContain('unavailable');
    expect(freshnessHint({
      oldest_content_at: null, content_undatable_count: 0, oldest_commit_sync_at: null,
      never_synced_count: 0, source_count: 0, basis: 'scope',
    })).toBeNull();
  });

  test('a scope with sources but nothing datable stays quiet rather than printing a bare count', () => {
    expect(freshnessHint({
      oldest_content_at: null, content_undatable_count: 0, oldest_commit_sync_at: null,
      never_synced_count: 0, source_count: 3, basis: 'scope',
    })).toBeNull();
  });
});
