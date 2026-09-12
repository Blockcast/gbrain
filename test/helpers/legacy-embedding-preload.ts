/**
 * Pre-test setup: opt the gateway into legacy 1536-d / OpenAI defaults
 * so tests written before v0.37 (with hardcoded `new Float32Array(1536)`
 * fixtures) keep working without per-file edits.
 *
 * v0.37 fix wave changed the canonical gateway defaults to
 * `zeroentropyai:zembed-1` / 1280-d (matching the system default chosen
 * in v0.36.0). Tests that don't explicitly configure the gateway
 * previously got 1536-d schemas via the stale `getPGLiteSchema()`
 * default; v0.37 fixed that so the schema tracks the gateway default
 * (1280 out of the box). Tests with 1536-d fixtures need the schema to
 * stay at 1536 — this preload pins it.
 *
 * Imported by `bunfig.toml` via `preload = ["./test/helpers/legacy-embedding-preload.ts"]`.
 *
 * Tests that need a different embedding shape (the new v0.37 tests,
 * future ZE-1280 tests, or specific-provider tests) should call
 * `configureGateway()` explicitly in their own beforeAll, which
 * overwrites this preload.
 */
import { configureGateway, getEmbeddingDimensions } from '../../src/core/ai/gateway.ts';
import { beforeEach } from 'bun:test';

const LEGACY_CONFIG = {
  embedding_model: 'openai:text-embedding-3-large',
  embedding_dimensions: 1536,
} as const;

function applyLegacy() {
  configureGateway({
    embedding_model: LEGACY_CONFIG.embedding_model,
    embedding_dimensions: LEGACY_CONFIG.embedding_dimensions,
    env: { ...process.env },
  });
}

if (process.env.GBRAIN_DEBUG_PRELOAD === '1') {
  console.error('[legacy-embedding-preload] applying OpenAI/1536');
}

// Initial application — covers tests that don't reset the gateway.
applyLegacy();

// Only re-apply when the gateway slot is EMPTY. Tests that explicitly
// configured a different model in their own beforeAll get to keep it.
function applyLegacyIfUnset() {
  try {
    getEmbeddingDimensions();
  } catch {
    applyLegacy();
  }
}

// Per-test re-application — handles tests that call `resetGateway()`
// in their setup/teardown. Bun's preload allows registering global
// hooks; this fires before every test in every file in the shard.
//
// ⚠ THIS DOES NOT COVER A FILE'S OWN `beforeAll` (BLO-33491). Bun runs a
// file's root `beforeAll` BEFORE the first `beforeEach`, and a preload
// `beforeAll` registers once for the run, not once per file. So a file whose
// `afterAll` calls `resetGateway()` leaves the slot EMPTY for the NEXT file's
// `beforeAll`, where `initSchema()` silently falls back to the production
// default (ZE/1280) and sizes `facts.embedding` at 1280 — then this hook
// restores 1536 and the file's hardcoded 1536-d fixtures fail
// CheckExpectedDim ("expected 1280 dimensions, not 1536").
//
// A test that BUILDS A SCHEMA in its own `beforeAll` and uses 1536-d fixtures
// must therefore call `configureGateway()` itself before `initSchema()`
// rather than relying on this preload. `test/facts-engine.test.ts` is the
// worked example. The failure is order-dependent, so re-sharding moves it
// between files instead of surfacing it.
beforeEach(applyLegacyIfUnset);
