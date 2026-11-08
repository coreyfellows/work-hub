/**
 * Claude API list prices, USD per million tokens, to estimate what a session's usage would cost at API
 * rates. Source: the claude-api skill's model table and prompt-caching economics (cached 2026-10-06):
 * cache writes are 1.25x input for the 5-minute TTL and 2x for 1-hour; reads per model. Haiku 5.5's
 * rate is for prompts up to 100K tokens (longer prompts cost 5x). Subscription (OAuth) users aren't
 * billed per token, so this is an "API-equivalent" figure, not a bill. Update when prices change.
 */

interface Rate {
  input: number;
  output: number;
  cacheRead: number;
}

const RATES: Record<string, Rate> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01 },
};

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
}

/** Cost of one response at API list prices, or null for a model without a known rate. */
export function costOf(model: string, u: Usage): number | null {
  const r = RATES[model.replace(/\[.*\]$/, '')];
  if (!r) return null;
  const write1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const write5m = u.cache_creation ? (u.cache_creation.ephemeral_5m_input_tokens ?? 0) : (u.cache_creation_input_tokens ?? 0);
  const perM =
    (u.input_tokens ?? 0) * r.input +
    (u.output_tokens ?? 0) * r.output +
    write5m * r.input * 1.25 +
    write1h * r.input * 2 +
    (u.cache_read_input_tokens ?? 0) * r.cacheRead;
  return perM / 1_000_000;
}
