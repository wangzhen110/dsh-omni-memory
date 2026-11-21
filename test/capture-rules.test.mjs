import test from 'node:test';
import assert from 'node:assert/strict';
import { candidateSentences, extractCandidateTexts } from '../lib/capture-rules.mjs';

test('candidateSentences strips code fences, bullets and duplicates', () => {
  const text = '```js\nconst secret = 1;\n```\n- 记住：以后都用 Node 24。\n记住：以后都用 Node 24。\nhttps://example.com';
  const sentences = candidateSentences(text);
  assert.ok(sentences.includes('记住：以后都用 Node 24。'));
  assert.equal(sentences.filter(line => line === '记住：以后都用 Node 24。').length, 1);
  assert.ok(!sentences.some(line => line.includes('https://')));
});

test('user hints produce candidates but weak questions do not', () => {
  assert.equal(extractCandidateTexts('以后所有测试都必须先跑 npm run check。', 'user').length, 1);
  assert.equal(extractCandidateTexts('要不要试试新的方案？', 'user').length, 0);
});

test('assistant text needs a stronger signal than user text', () => {
  assert.equal(extractCandidateTexts('建议先备份配置。', 'assistant').length, 0);
  assert.equal(extractCandidateTexts('结论：必须先备份配置，否则回滚会失败。', 'assistant').length, 1);
});

test('extraction is capped at three per chunk and ignores non-dialogue roles', () => {
  const text = Array.from({ length: 6 }, (_, i) => `记住：规则 ${i} 必须保留。`).join('\n');
  assert.equal(extractCandidateTexts(text, 'user').length, 3);
  assert.equal(extractCandidateTexts(text, 'system').length, 0);
});
