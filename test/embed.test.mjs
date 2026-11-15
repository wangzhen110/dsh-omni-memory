import test from 'node:test';
import assert from 'node:assert/strict';
import { DIM, tokenize, embedText, dot, toBlob, fromBlob } from '../lib/embed.mjs';

test('tokenize splits CJK into bigrams and keeps latin words', () => {
  const tokens = tokenize('插件报错 error_code');
  assert.ok(tokens.includes('插件'));
  assert.ok(tokens.includes('件报'));
  assert.ok(tokens.includes('报错'));
  assert.ok(tokens.includes('error_code'));
});

test('embedText is deterministic', () => {
  const a = embedText('同样的输入产生同样的向量');
  const b = embedText('同样的输入产生同样的向量');
  assert.deepEqual([...a], [...b]);
});

test('embedText returns a normalised vector of the declared dimension', () => {
  const vector = embedText('向量维度与归一化');
  assert.equal(vector.length, DIM);
  let norm = 0;
  for (const value of vector) norm += value * value;
  assert.ok(Math.abs(Math.sqrt(norm) - 1) < 1e-6);
});

test('empty text yields a zero vector instead of NaN', () => {
  const vector = embedText('');
  assert.equal(vector.length, DIM);
  assert.ok([...vector].every(value => value === 0));
});

test('similar text scores higher than unrelated text', () => {
  const base = embedText('插件崩溃是因为会话投影被顶掉');
  const near = embedText('插件崩溃 会话投影 顶掉');
  const far = embedText('今天天气不错适合出门散步');
  assert.ok(dot(base, near) > dot(base, far));
});

test('dot of a vector with itself is 1', () => {
  const vector = embedText('自相似度');
  assert.ok(Math.abs(dot(vector, vector) - 1) < 1e-6);
});

test('blob round trip preserves the vector', () => {
  const vector = embedText('二进制往返');
  const restored = fromBlob(toBlob(vector));
  assert.deepEqual([...restored], [...vector]);
});
