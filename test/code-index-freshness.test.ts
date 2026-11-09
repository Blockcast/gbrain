/**
 * Code-index freshness — pure reducers + fail-open contract (no DB).
 *
 * `code-graph-readiness.test.ts` pins "is the graph BUILT". This pins "and
 * WHEN was the code behind it last pulled", which is the question that makes
 * `{count: 0, status: 'ready'}` safe to act on.
 *
 * Deliberately DB-free so the load-bearing reduction — oldest-wins, and the
 * NULL arm that a `MIN()`-shaped implementation silently drops — is pinned
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

describe('summarizeSourceRows', () => {
  test('reports the OLDEST contributor, not the newest', () => {
    const f = summarizeSourceRows(
      [{ id: 'a', last_sync_at: FRESH }, { id: 'b', last_sync_at: STALE }],
      'contributing',
    );
    expect(f.oldest_indexed_at).toBe(STALE);
    expect(f.source_count).toBe(2);
    expect(f.never_synced_count).toBe(0);
    expect(f.basis).toBe('contributing');
  });

  test('a never-synced contributor is COUNTED, not dropped the way MIN() drops NULL', () => {
    const f = summarizeSourceRows(
      [{ id: 'a', last_sync_at: FRESH }, { id: 'b', last_sync_at: null }],
      'contributing',
    );
    // The known timestamp is only a LOWER BOUND once an undatable source is in
    // the answer — surfacing that is the entire reason this arm exists.
    expect(f.oldest_indexed_at).toBe(FRESH);
    expect(f.never_synced_count).toBe(1);
    expect(f.source_count).toBe(2);
  });

  test('all contributors never-synced → null timestamp but non-zero source_count', () => {
    const f = summarizeSourceRows([{ id: 'a', last_sync_at: null }], 'scope');
    expect(f.oldest_indexed_at).toBeNull();
    expect(f.source_count).toBe(1);
    expect(f.never_synced_count).toBe(1);
  });

  test('empty input is distinguishable from all-null input', () => {
    const f = summarizeSourceRows([], 'scope');
    expect(f.oldest_indexed_at).toBeNull();
    expect(f.source_count).toBe(0);
    expect(f.never_synced_count).toBe(0);
  });

  test('accepts Date objects (postgres driver) as well as strings (PGLite)', () => {
    const f = summarizeSourceRows([{ id: 'a', last_sync_at: new Date(STALE) }], 'contributing');
    expect(f.oldest_indexed_at).toBe(STALE);
  });

  test('an unparseable timestamp is undatable, never silently fresh', () => {
    const f = summarizeSourceRows([{ id: 'a', last_sync_at: 'not-a-date' }], 'contributing');
    expect(f.oldest_indexed_at).toBeNull();
    expect(f.never_synced_count).toBe(1);
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
    expect(f.oldest_indexed_at).toBeNull();
  });

  test('unavailable is DISTINGUISHABLE from "nothing is stale"', async () => {
    const err = await resolveCodeIndexFreshness(brokenEngine, {});
    const clean = await resolveCodeIndexFreshness(emptyEngine, { sourceId: 'no-such-source' });
    // Both carry a null timestamp and zero sources; only `basis` separates
    // "the probe failed" from "the scope is genuinely empty". Without that
    // split, a failed probe renders exactly like a clean, fresh brain.
    expect(err.oldest_indexed_at).toBeNull();
    expect(clean.oldest_indexed_at).toBeNull();
    expect(err.basis).toBe('unavailable');
    expect(clean.basis).toBe('scope');
  });
});

describe('freshnessHint', () => {
  test('names the instant rather than judging it against a baked-in threshold', () => {
    const hint = freshnessHint({
      oldest_indexed_at: STALE, source_count: 2, never_synced_count: 0, basis: 'contributing',
    });
    expect(hint).toContain(STALE);
    expect(hint).toContain('Answered from');
  });

  test('a scope-basis hint says "Searched", not "Answered from"', () => {
    const hint = freshnessHint({
      oldest_indexed_at: STALE, source_count: 1, never_synced_count: 0, basis: 'scope',
    });
    expect(hint).toContain('Searched');
  });

  test('never-synced sources are called out as unbounded', () => {
    const hint = freshnessHint({
      oldest_indexed_at: STALE, source_count: 2, never_synced_count: 1, basis: 'scope',
    });
    expect(hint).toContain('unbounded');
  });

  test('unavailable says so; an empty scope stays quiet', () => {
    expect(freshnessHint({
      oldest_indexed_at: null, source_count: 0, never_synced_count: 0, basis: 'unavailable',
    })).toContain('unavailable');
    expect(freshnessHint({
      oldest_indexed_at: null, source_count: 0, never_synced_count: 0, basis: 'scope',
    })).toBeNull();
  });
});
