/**
 * #779 + #121 adjacent fixes (Commit 9 of v0.32 wave).
 *
 * Coverage:
 *  - Recipes with `embedding.no_batch_cap: true` suppress the
 *    missing-max_batch_tokens startup warning (#779)
 *  - The warning MECHANISM still fires for a recipe that declares an
 *    embedding touchpoint but forgets the cap (regression guard). Every
 *    SHIPPED recipe is now capped or opts out (google/gemini included), so
 *    this is exercised through `shouldWarnMissingBatchTokens` with a
 *    synthetic capless recipe rather than a real one.
 *  - google now declares max_batch_tokens → stays silent even when configured.
 *  - listRecipes returns expected dynamic-cap recipes (ollama, litellm,
 *    llama-server) all flagged
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import {
  configureGateway,
  resetGateway,
  shouldWarnMissingBatchTokens,
} from '../../src/core/ai/gateway.ts';
import { listRecipes, getRecipe } from '../../src/core/ai/recipes/index.ts';
import type { EmbeddingTouchpoint, Recipe } from '../../src/core/ai/types.ts';

describe('v0.32 #779: no_batch_cap suppresses the missing-max_batch_tokens warning', () => {
  let warnSpy: ReturnType<typeof mock>;
  let realWarn: typeof console.warn;

  beforeAll(() => {
    realWarn = console.warn;
    warnSpy = mock(() => {});
    console.warn = warnSpy as any;
  });

  afterAll(() => {
    console.warn = realWarn;
    resetGateway();
  });

  test('Ollama, LiteLLM, llama-server all declare no_batch_cap: true', () => {
    for (const id of ['ollama', 'litellm', 'llama-server']) {
      const r = getRecipe(id);
      expect(r, `${id} not registered`).toBeDefined();
      expect(
        r!.touchpoints.embedding?.no_batch_cap,
        `${id} should declare no_batch_cap: true`,
      ).toBe(true);
    }
  });

  test('configureGateway does NOT warn for ollama/litellm/llama-server', () => {
    warnSpy.mockClear();
    resetGateway();
    configureGateway({ env: {} });
    const messages = warnSpy.mock.calls.map(c => String(c[0] ?? ''));
    for (const id of ['ollama', 'litellm', 'llama-server']) {
      expect(
        messages.some(m => m.includes(`"${id}"`)),
        `should NOT warn for ${id}`,
      ).toBe(false);
    }
  });

  test('warning mechanism still fires for a synthetic capless recipe (guardrail armed)', () => {
    // Every SHIPPED recipe is now capped or opts out (google/gemini included),
    // so the registry has no live capless fixture. Exercise the guardrail
    // directly with a synthetic recipe that inherits the embedding touchpoint
    // but forgets max_batch_tokens — the exact v0.27 Voyage-backfill footgun
    // this warning exists to catch — plus the suppression paths.
    const base: EmbeddingTouchpoint = { models: ['synthetic-embed-001'], default_dims: 768 };
    const mk = (id: string, embedding: EmbeddingTouchpoint | undefined): Recipe => ({
      id,
      name: `synthetic ${id}`,
      tier: 'openai-compat',
      implementation: 'openai-compatible',
      touchpoints: { embedding },
    });

    // Forgets the cap → warns.
    expect(shouldWarnMissingBatchTokens(mk('acme-embed', { ...base }))).toBe(true);
    // Declares a cap → silent.
    expect(shouldWarnMissingBatchTokens(mk('acme-embed', { ...base, max_batch_tokens: 8192 }))).toBe(false);
    // Explicit dynamic-cap opt-out → silent.
    expect(shouldWarnMissingBatchTokens(mk('acme-embed', { ...base, no_batch_cap: true }))).toBe(false);
    // OpenAI canonical fast path → silent even without a cap.
    expect(shouldWarnMissingBatchTokens(mk('openai', { ...base }))).toBe(false);
    // No embedding touchpoint at all → silent.
    expect(shouldWarnMissingBatchTokens(mk('chat-only', undefined))).toBe(false);
  });

  test('google now declares max_batch_tokens → no missing-cap warning even when configured', () => {
    warnSpy.mockClear();
    resetGateway();
    configureGateway({ env: {} });
    let messages = warnSpy.mock.calls.map(c => String(c[0] ?? ''));
    expect(
      messages.some(m => m.includes('"google"') && m.includes('without max_batch_tokens')),
      'google should not warn while OpenAI default is configured',
    ).toBe(false);

    // gemini-embedding-001 has a real per-text cap (2048 tokens, ~1 text/req);
    // the google recipe now declares max_batch_tokens, so configuring it must
    // NOT trip the guardrail. Regression guard on the cap itself.
    warnSpy.mockClear();
    resetGateway();
    configureGateway({
      embedding_model: 'google:gemini-embedding-001',
      embedding_dimensions: 768,
      env: { GOOGLE_GENERATIVE_AI_API_KEY: 'fake' },
    });
    messages = warnSpy.mock.calls.map(c => String(c[0] ?? ''));
    expect(
      messages.some(m => m.includes('"google"') && m.includes('without max_batch_tokens')),
      'google must stay silent now that it declares max_batch_tokens',
    ).toBe(false);
  });

  test('every recipe with empty models[] declares user_provided_models OR has openai-fast-path', () => {
    // Cross-cutting invariant: contracts should not silently disagree.
    for (const r of listRecipes()) {
      const e = r.touchpoints.embedding;
      if (!e) continue;
      if (e.models.length === 0) {
        expect(
          e.user_provided_models === true || r.id === 'litellm',
          `${r.id} has empty models[] — must declare user_provided_models: true`,
        ).toBe(true);
      }
    }
  });
});
