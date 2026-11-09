/**
 * Code-index freshness — engine-backed scoping (PGLite).
 *
 * Companion to `code-index-freshness.test.ts`, which pins the pure reducers
 * with no DB. This file pins what only a real engine can answer:
 *   - contributing attribution against the real `sources` table
 *   - the brain-wide scope probe excluding code-FREE sources
 *   - a page pointing at an absent `sources` row being undatable, not fresh
 *   - the zero-result path carrying the field at all (the whole point)
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importCodeFile } from '../src/core/import-file.ts';
import { findCodeDef } from '../src/commands/code-def.ts';
import { resolveCodeIndexFreshness } from '../src/core/code-index-freshness.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM content_chunks');
  await engine.executeRaw('DELETE FROM pages');
  await engine.executeRaw(`DELETE FROM sources WHERE id <> 'default'`);
  await engine.executeRaw(`UPDATE sources SET last_sync_at = NULL WHERE id = 'default'`);
});

const SAMPLE = `export function alpha(x: number): number {
  return beta(x) + 1;
}
`;

const FRESH = '2026-11-01T00:00:00.000Z';
const STALE = '2026-06-24T00:00:00.000Z';

async function addSource(id: string, lastSyncAt: string | null): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, last_sync_at) VALUES ($1, $2, $3)`,
    [id, id, lastSyncAt],
  );
}

/** Import a code file and park it on a specific source. */
async function addCodeOn(sourceId: string, path: string): Promise<void> {
  await importCodeFile(engine, path, SAMPLE, { noEmbed: true, sourceId });
}



describe('resolveCodeIndexFreshness — contributing basis', () => {
  test('oldest of the contributing sources, ignoring a fresher non-contributor', async () => {
    await addSource('stale-src', STALE);
    await addSource('fresh-src', FRESH);
    await addSource('uninvolved', '2026-11-09T00:00:00.000Z');
    const f = await resolveCodeIndexFreshness(engine, {
      contributingSourceIds: ['fresh-src', 'stale-src'],
    });
    expect(f.basis).toBe('contributing');
    expect(f.oldest_indexed_at).toBe(STALE);
    expect(f.source_count).toBe(2);
  });

  test('a contributing source absent from `sources` is undatable, not fresh', async () => {
    await addSource('known', FRESH);
    const f = await resolveCodeIndexFreshness(engine, {
      contributingSourceIds: ['known', 'ghost-source'],
    });
    expect(f.source_count).toBe(2);
    expect(f.never_synced_count).toBe(1);
    expect(f.oldest_indexed_at).toBe(FRESH);
  });
});

describe('resolveCodeIndexFreshness — scope basis (the zero-result path)', () => {
  test('brain-wide miss reports the oldest source that HOLDS CODE', async () => {
    await addSource('stale-code', STALE);
    await addSource('fresh-code', FRESH);
    await addCodeOn('stale-code', 'src/a.ts');
    await addCodeOn('fresh-code', 'src/b.ts');

    const f = await resolveCodeIndexFreshness(engine, { contributingSourceIds: [] });
    expect(f.basis).toBe('scope');
    expect(f.oldest_indexed_at).toBe(STALE);
    expect(f.source_count).toBe(2);
  });

  test('a code-FREE source is excluded, so it cannot drown the signal', async () => {
    // `default` is never-synced and holds no code here. Counting it would put
    // never_synced_count >= 1 on every brain-wide miss and make the field noise.
    await addSource('has-code', FRESH);
    await addCodeOn('has-code', 'src/a.ts');

    const f = await resolveCodeIndexFreshness(engine, { contributingSourceIds: [] });
    expect(f.source_count).toBe(1);
    expect(f.never_synced_count).toBe(0);
    expect(f.oldest_indexed_at).toBe(FRESH);
  });

  test('scoped sourceId reports that source alone', async () => {
    await addSource('stale-code', STALE);
    await addSource('fresh-code', FRESH);
    await addCodeOn('stale-code', 'src/a.ts');
    await addCodeOn('fresh-code', 'src/b.ts');

    const f = await resolveCodeIndexFreshness(engine, { sourceId: 'fresh-code' });
    expect(f.basis).toBe('scope');
    expect(f.source_count).toBe(1);
    expect(f.oldest_indexed_at).toBe(FRESH);
  });

  test('allSources overrides a scoped sourceId and goes brain-wide', async () => {
    await addSource('stale-code', STALE);
    await addSource('fresh-code', FRESH);
    await addCodeOn('stale-code', 'src/a.ts');
    await addCodeOn('fresh-code', 'src/b.ts');

    const f = await resolveCodeIndexFreshness(engine, {
      sourceId: 'fresh-code', allSources: true,
    });
    expect(f.oldest_indexed_at).toBe(STALE);
    expect(f.source_count).toBe(2);
  });

  test('nothing in scope → zero sources, null timestamp, still basis scope', async () => {
    const f = await resolveCodeIndexFreshness(engine, { sourceId: 'no-such-source' });
    expect(f.basis).toBe('scope');
    expect(f.source_count).toBe(0);
    expect(f.oldest_indexed_at).toBeNull();
  });
});

// ───────────────────── the defect this exists to close ─────────────────────

describe('code_def envelope carries index age on BOTH paths', () => {
  beforeEach(async () => {
    await addSource('stale-code', STALE);
    await addCodeOn('stale-code', 'src/a.ts');
  });

  test('HIT: per-result source_id is projected and attributes the answer', async () => {
    const defs = await findCodeDef(engine, 'alpha');
    expect(defs.length).toBeGreaterThan(0);
    expect(defs[0]!.source_id).toBe('stale-code');

    const f = await resolveCodeIndexFreshness(engine, {
      contributingSourceIds: defs.map((d) => d.source_id),
    });
    expect(f.basis).toBe('contributing');
    expect(f.oldest_indexed_at).toBe(STALE);
  });

  test('MISS: a symbol that does not exist still reports how stale the search was', async () => {
    // This is the exact shape that used to return {count: 0, status: 'ready'}
    // with nothing to tell "no such symbol" from "indexed before it existed".
    const defs = await findCodeDef(engine, 'SymbolThatDoesNotExist');
    expect(defs.length).toBe(0);

    const f = await resolveCodeIndexFreshness(engine, {
      contributingSourceIds: defs.map((d) => d.source_id),
    });
    expect(f.basis).toBe('scope');
    expect(f.oldest_indexed_at).toBe(STALE);
    expect(f.source_count).toBe(1);
  });
});
