/** Provider presets: optional convenience, never required. */
const PRESETS = {
  openai: { url: 'https://api.openai.com/v1/embeddings', model: 'text-embedding-3-small' },
  dashscope: { url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings', model: 'text-embedding-v3' },
  zhipu: { url: 'https://open.bigmodel.cn/api/paas/v4/embeddings', model: 'embedding-3' },
  siliconflow: { url: 'https://api.siliconflow.cn/v1/embeddings', model: 'BAAI/bge-m3' },
  // Local, OpenAI-compatible embedding servers. No model is bundled; the
  // service is opt-in and the hashed fallback stays the zero-setup default.
  ollama: { url: 'http://127.0.0.1:11434/v1/embeddings', model: 'nomic-embed-text' },
  lmstudio: { url: 'http://127.0.0.1:1234/v1/embeddings', model: 'nomic-embed-text-v1.5' },
};

export const HASHED_DIM = 512;

export function backendConfig(env = process.env) {
  const provider = String(env.OMNI_EMBED_PROVIDER ?? '').trim().toLowerCase();
  const preset = PRESETS[provider] ?? null;
  const url = String(env.OMNI_EMBED_URL ?? '').trim() || preset?.url || '';
  if (!url) return { kind: 'hashed', dim: HASHED_DIM };
  return {
    kind: 'remote',
    url,
    model: String(env.OMNI_EMBED_MODEL ?? preset?.model ?? 'text-embedding-3-small'),
    key: String(env.OMNI_EMBED_KEY ?? ''),
    timeoutMs: Number(env.OMNI_EMBED_TIMEOUT_MS ?? 10_000),
    batch: Math.max(1, Math.min(512, Number(env.OMNI_EMBED_BATCH ?? 64))),
    retries: Math.max(0, Math.min(5, Number(env.OMNI_EMBED_RETRIES ?? 2))),
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

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function embedBatch(texts, config, fetchImpl) {
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
    if (!response.ok) {
      const error = new Error(`embeddings responded ${response.status}`);
      error.retryable = response.status === 429 || response.status >= 500;
      throw error;
    }
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

/**
 * Embed a batch of texts through an OpenAI-compatible endpoint.
 *
 * Requests are split into `batch` inputs (providers cap the array size), and a
 * 429/5xx is retried with backoff. 4xx other than 429 is treated as permanent:
 * a bad key or model will not get better by retrying.
 */
export async function embedRemote(texts, config, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
  const batch = Math.max(1, Number(config.batch ?? 64));
  const retries = Math.max(0, Number(config.retries ?? 2));
  const out = [];
  for (let offset = 0; offset < texts.length; offset += batch) {
    const slice = texts.slice(offset, offset + batch);
    let attempt = 0;
    for (;;) {
      try {
        out.push(...await embedBatch(slice, config, fetchImpl));
        break;
      } catch (error) {
        const retryable = error?.retryable === true || (error?.name === 'AbortError');
        if (!retryable || attempt >= retries) throw error;
        await sleep(250 * (3 ** attempt));
        attempt += 1;
      }
    }
  }
  return out;
}
