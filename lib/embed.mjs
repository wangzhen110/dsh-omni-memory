/**
 * Deterministic, dependency-free text embedding.
 *
 * Why not a transformer here: the plugin must load in a host that cannot assume
 * a 500 MB model download or a native runtime. This module provides the vector
 * half of the retrieval with a hashed character n-gram model, which is a mature
 * technique for CJK (no word segmentation required) and is cheap enough to run
 * on every write. A true semantic backend can replace it behind the same two
 * functions without touching callers.
 *
 * Properties that matter for tests:
 *  - same input → identical vector (no randomness, no clock);
 *  - output is L2-normalised, so cosine is a plain dot product;
 *  - CJK is split into character bigrams, latin/digit runs stay whole tokens.
 */

export const DIM = 512;

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

const CJK = /[\u4e00-\u9fff\u3400-\u4dbf]/;

/** Split text into weighted tokens: CJK bigrams plus latin/digit words. */
export function tokenize(text) {
  const lowered = String(text ?? '').toLowerCase();
  const tokens = [];
  const latin = [];
  let cjkRun = '';

  const flushLatin = () => {
    if (latin.length) {
      const word = latin.join('');
      if (word.length >= 2) tokens.push(word);
      latin.length = 0;
    }
  };
  const flushCjk = () => {
    if (cjkRun.length === 1) tokens.push(cjkRun);
    for (let i = 0; i + 1 < cjkRun.length; i += 1) tokens.push(cjkRun.slice(i, i + 2));
    cjkRun = '';
  };

  for (const char of lowered) {
    if (CJK.test(char)) {
      flushLatin();
      cjkRun += char;
    } else if (/[a-z0-9_\-.]/.test(char)) {
      flushCjk();
      latin.push(char);
    } else {
      flushLatin();
      flushCjk();
    }
  }
  flushLatin();
  flushCjk();
  return tokens;
}

/** Hashed sublinear TF vector, L2 normalised. */
export function embedText(text) {
  const vector = new Float32Array(DIM);
  const counts = new Map();
  for (const token of tokenize(text)) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  for (const [token, count] of counts) {
    const hash = fnv1a(token);
    const index = hash % DIM;
    const sign = (hash >>> 31) === 0 ? 1 : -1;
    vector[index] += sign * (1 + Math.log(count));
  }
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < DIM; i += 1) vector[i] /= norm;
  }
  return vector;
}

/** Dot product of two L2-normalised vectors (equals cosine similarity). */
export function dot(a, b) {
  let sum = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) sum += a[i] * b[i];
  return sum;
}

export function toBlob(vector) {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

export function fromBlob(blob, dim = DIM) {
  const buffer = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  const vector = new Float32Array(dim);
  const view = new Float32Array(buffer.buffer, buffer.byteOffset, Math.min(dim, buffer.byteLength / 4));
  vector.set(view);
  return vector;
}
