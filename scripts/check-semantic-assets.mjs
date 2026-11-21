import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The release must carry the model and the WASM runtime inside the package:
// a missing or truncated file silently turns semantic search off for users.
const EXPECTED = [
  ['models/bge-small-zh-v1.5/model_int8.onnx', 23_903_394],
  ['models/bge-small-zh-v1.5/tokenizer.json', 439_125],
  ['models/bge-small-zh-v1.5/tokenizer_config.json', 367],
  ['models/bge-small-zh-v1.5/config.json', 716],
  ['models/bge-small-zh-v1.5/MODEL-CARD.md', null],
  ['lib/vendor/ort.wasm.bundle.min.mjs', 77_024],
  ['lib/vendor/ort-wasm-simd-threaded.wasm', 14_848_852],
  ['lib/vendor/ort-wasm-simd-threaded.mjs', 24_738],
  ['lib/vendor/tokenizers.min.mjs', 36_601],
  ['lib/vendor/ONNXRUNTIME-LICENSE.txt', null],
  ['lib/vendor/TOKENIZERS-LICENSE.txt', 11_357],
];

let bytes = 0;
const errors = [];
for (const [relative, expected] of EXPECTED) {
  const file = path.join(root, ...relative.split('/'));
  if (!existsSync(file)) {
    errors.push(`missing ${relative}`);
    continue;
  }
  const size = statSync(file).size;
  bytes += size;
  if (expected !== null && size !== expected) errors.push(`${relative}: expected ${expected} bytes, got ${size}`);
}

if (errors.length) {
  console.error(`semantic assets failed:\n- ${errors.join('\n- ')}`);
  process.exit(1);
}
console.log(`semantic assets OK: ${EXPECTED.length} files, ${(bytes / 1024 / 1024).toFixed(1)} MB`);
