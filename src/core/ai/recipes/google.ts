import type { Recipe } from '../types.ts';

export const google: Recipe = {
  id: 'google',
  name: 'Google Gemini',
  tier: 'native',
  implementation: 'native-google',
  auth_env: {
    required: ['GOOGLE_GENERATIVE_AI_API_KEY'],
    setup_url: 'https://aistudio.google.com/apikey',
  },
  touchpoints: {
    embedding: {
      models: ['gemini-embedding-001'],
      default_dims: 768,
      dims_options: [768, 1536, 3072],
      cost_per_1m_tokens_usd: 0.15,
      price_last_verified: '2026-04-20',
      // gemini-embedding-001 caps each input at 2048 tokens and — unlike most
      // providers — effectively accepts only ONE text per request (the
      // batchEmbedContents batch size is 1; excess tokens error when
      // AUTO_TRUNCATE=false). gbrain batches by token budget, not item count,
      // so this can't enforce the 1-item rule outright, but a conservative
      // 2048-token cap (1 char ≈ 1 token dense content, 0.5 utilization —
      // same assumption as the voyage recipe) keeps any single request under
      // the per-text limit and arms the gateway's recursive-halving safety
      // net. Sources: https://ai.google.dev/api/embeddings ;
      // langchain-ai/langchainjs#8490 (single-input batch limit).
      max_batch_tokens: 2_048,
      chars_per_token: 1,
      safety_factor: 0.5,
    },
    expansion: {
      models: ['gemini-2.0-flash', 'gemini-2.0-flash-lite'],
      cost_per_1m_tokens_usd: 0.10,
      price_last_verified: '2026-04-20',
    },
    chat: {
      models: ['gemini-2.0-flash-exp', 'gemini-2.0-flash', 'gemini-1.5-pro'],
      supports_tools: true,
      supports_subagent_loop: true,
      supports_prompt_cache: false,
      max_context_tokens: 1000000, // Gemini 1.5 Pro
      cost_per_1m_input_usd: 0.30,
      cost_per_1m_output_usd: 1.20,
      price_last_verified: '2026-04-20',
    },
  },
  setup_hint: 'Get an API key at https://aistudio.google.com/apikey, then `export GOOGLE_GENERATIVE_AI_API_KEY=...`',
};
