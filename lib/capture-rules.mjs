/**
 * Deterministic candidate extraction for transcript capture.
 *
 * No model is called: every capture path must be cheap enough to run on each
 * turn, and a false positive is safe because candidates stay pending until a
 * human or host accepts them. The rules live here so the store and the host
 * adapters share exactly one definition.
 */
export const MAX_CANDIDATES_PER_CHUNK = 3;

const CANDIDATE_HINT = /(记住|记一下|记下|以后|下次|今后|始终|总是|默认|约定|决定|规则|偏好|习惯|务必|必须|不要|禁止|避免|注意|踩坑|根因|解决|正确做法|结论|教训|remember|always|never|must|prefer|decision|convention|lesson|root cause)/gi;
const CANDIDATE_BROAD = /(问题|错误|失败|成功|步骤|配置|版本|路径|端口|命令|测试|部署|安装|升级|回滚|备份|方案|方法|建议|重要|关键|应该|需要|不能|记得|告诉|请)/gi;

// Intl.Segmenter handles both CJK punctuation and English periods. The old
// line-only regex never split "Remember this. Always back up." and dropped
// long English transcripts as one >400-character sentence.
const SENTENCE_SEGMENTER = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter('en', { granularity: 'sentence' })
  : null;

function splitSentences(line) {
  if (SENTENCE_SEGMENTER) {
    return [...SENTENCE_SEGMENTER.segment(line)].map(part => part.segment);
  }
  return line.split(/(?<=[。！？!?；;])\s*/u);
}

export function candidateSentences(text) {
  const clean = String(text ?? '').replace(/```[\s\S]*?```/gu, ' ');
  const out = [];
  for (const line of clean.split(/\r?\n/)) {
    const normalized = line.replace(/^[\s>*#\-+•\d.、)）]+/u, '').trim();
    if (!normalized) continue;
    for (const raw of splitSentences(normalized)) {
      const sentence = raw.replace(/\s+/g, ' ').trim();
      if (sentence.length < 8 || sentence.length > 400) continue;
      if (/^https?:\/\//i.test(sentence)) continue;
      if (/^[a-z0-9_\-./\\]+$/i.test(sentence)) continue;
      out.push(sentence);
    }
  }
  return [...new Set(out)];
}

export function extractCandidateTexts(text, role) {
  if (role !== 'user' && role !== 'assistant') return [];
  const result = [];
  for (const sentence of candidateSentences(text)) {
    const hints = sentence.match(CANDIDATE_HINT) ?? [];
    if (!hints.length) continue;
    const broad = sentence.match(CANDIDATE_BROAD) ?? [];
    if (role === 'assistant' && hints.length < 2 && broad.length < 2) continue;
    if (/[?？]\s*$/u.test(sentence) && hints.length < 2) continue;
    const score = Math.min(0.95, 0.5 + hints.length * 0.12 + broad.length * 0.04 + (role === 'user' ? 0.08 : 0));
    result.push({ text: sentence, confidence: Number(score.toFixed(2)) });
    if (result.length >= MAX_CANDIDATES_PER_CHUNK) break;
  }
  return result;
}
