/**
 * Embedding backend selection.
 *
 * Two backends share one interface so retrieval code never branches:
 *  - `hashed` (default): dependency-free hashed character n-grams, always
 *    available, deterministic, no network;
 *  - `remote`: any OpenAI-compatible `/embeddings` endpoint, which is the only
 *    way to get true synonym recall (FR-21).
 *
 * The remote backend is opt-in through environment variables so the plugin
 * never phones home by itself:
 *   OMNI_EMBED_URL    e.g. https://api.example.com/v1/embeddings
 *   OMNI_EMBED_MODEL  e.g. text-embedding-3-small
 *   OMNI_EMBED_KEY    bearer token (optional for local servers)
 */

export const HASHED_DIM = 512;

export function backendConfig(env = process.env) {
  const url = String(env.OMNI_EMBED_URL ?? '').trim();
  if (!url) return { kind: 'hashed', dim: HASHED_DIM };
  return {
    kind: 'remote',
    url,
    model: String(env.OMNI_EMBED_MODEL ?? 'text-embedding-3-small'),
    key: String(env.OMNI_EMBED_KEY ?? ''),
    timeoutMs: Number(env.OMNI_EMBED_TIMEOUT_MS ?? 10_000),
  };
}

/** L2-normalise in place and return the same array. */
export function normalize(vector) {
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < vector.length; i += 1) vector[i] /= norm;
  }
  return vector;
}

/**
 * Embed a batch of texts through an OpenAI-compatible endpoint.
 * Returns one Float32Array per input, in order.
 */
export async function embedRemote(texts, config, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 10_000);
  try {
    const response = await fetchImpl(config.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.key ? { authorization: `Bearer ${config.key}` } : {}),
      },
      body: JSON.stringify({ model: config.model, input: texts }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`embeddings responded ${response.status}`);
    const payload = await response.json();
    const data = Array.isArray(payload?.data) ? payload.data : null;
    if (!data || data.length !== texts.length) throw new Error('embeddings response shape mismatch');
    return data.map(item => {
      if (!Array.isArray(item?.embedding) || item.embedding.length === 0) {
        throw new Error('embeddings response missing vector');
      }
      return normalize(Float32Array.from(item.embedding));
    });
  } finally {
    clearTimeout(timer);
  }
}
