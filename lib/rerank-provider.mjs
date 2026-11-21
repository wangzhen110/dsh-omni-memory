/**
 * Optional cross-encoder reranker. It is deliberately not a required
 * dependency: a local/self-hosted endpoint (Jina, Cohere, SiliconFlow, vLLM,
 * LM Studio or any compatible service) is selected by environment variables.
 * No URL means no rerank call and zero latency.
 */
const PRESETS = {
  cohere: { url: 'https://api.cohere.com/v2/rerank', model: 'rerank-v3.5' },
  jina: { url: 'https://api.jina.ai/v1/rerank', model: 'jina-reranker-v2-base-multilingual' },
  siliconflow: { url: 'https://api.siliconflow.cn/v1/rerank', model: 'BAAI/bge-reranker-v2-m3' },
};

export function rerankConfig(env = process.env) {
  const provider = String(env.OMNI_RERANK_PROVIDER ?? '').trim().toLowerCase();
  const preset = PRESETS[provider] ?? null;
  const url = String(env.OMNI_RERANK_URL ?? '').trim() || preset?.url || '';
  if (!url) return { kind: 'none' };
  return {
    kind: 'remote',
    url,
    model: String(env.OMNI_RERANK_MODEL ?? preset?.model ?? 'BAAI/bge-reranker-v2-m3'),
    key: String(env.OMNI_RERANK_KEY ?? env.OMNI_RERANK_API_KEY ?? ''),
    timeoutMs: Math.max(500, Math.min(30_000, Number(env.OMNI_RERANK_TIMEOUT_MS ?? 5000))),
  };
}

/**
 * Returns one relevance score per input document, in input order. Providers
 * expose `results: [{ index, relevance_score }]`; a missing result is 0.
 */
export async function rerankRemote(query, documents, config = rerankConfig(), fetchImpl = globalThis.fetch) {
  if (config.kind !== 'remote') return null;
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 5000);
  try {
    const response = await fetchImpl(config.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.key ? { authorization: `Bearer ${config.key}` } : {}),
      },
      body: JSON.stringify({
        model: config.model,
        query,
        documents,
        top_n: documents.length,
        return_documents: false,
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`rerank responded ${response.status}`);
    const payload = await response.json();
    const results = Array.isArray(payload?.results) ? payload.results : Array.isArray(payload?.data) ? payload.data : [];
    const scores = new Array(documents.length).fill(0);
    for (const item of results) {
      const index = Number(item?.index);
      const score = Number(item?.relevance_score ?? item?.score ?? 0);
      if (Number.isInteger(index) && index >= 0 && index < scores.length && Number.isFinite(score)) {
        scores[index] = score;
      }
    }
    return scores;
  } finally {
    clearTimeout(timer);
  }
}
