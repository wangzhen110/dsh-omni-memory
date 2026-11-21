import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The release must carry the model and the WASM runtime inside the package:
// a missing, truncated or tampered file silently turns semantic search off for
// users. Size catches truncation; SHA-256 catches a swapped payload of the same
// length, which a size check alone can never see.
const EXPECTED = [
  ['models/bge-small-zh-v1.5/model_int8.onnx', 23_903_394, 'b9837c19ce154ff0726d398ee77abbc03a7faf0476c6f93016c84e531be7ebb5'],
  ['models/bge-small-zh-v1.5/tokenizer.json', 439_125, '48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26'],
  ['models/bge-small-zh-v1.5/tokenizer_config.json', 367, 'e6f3b96db926a37d4039995fbf5ad17de158dfb8f6343d607e4dbaad18d75f5a'],
  ['models/bge-small-zh-v1.5/config.json', 716, 'd4193ead3a810fd694fa8a31d7fc72fbaebc0668b603e398734bf2f6538ff42f'],
  ['models/bge-small-zh-v1.5/MODEL-CARD.md', null, 'c48a4eeea77f6b1d38b48ec1c5b8d4f86d5550cc43fa345a0db1b2ca1d082369'],
  ['lib/vendor/ort.wasm.bundle.min.mjs', 77_024, '51bd7168175767324ab0acfcfc4ca94a096a3826e3ebac9ccc4f195eb865f8dd'],
  ['lib/vendor/ort-wasm-simd-threaded.wasm', 14_848_852, '4b884c203b0fa48d057be3332c65513ff85aa3c5bddd6946acc0fab7ecda001d'],
  ['lib/vendor/ort-wasm-simd-threaded.mjs', 24_738, '30ed0b5cd1182ede931fea448afb567d4dc705ec957af09f108a2be5f770dac3'],
  ['lib/vendor/tokenizers.min.mjs', 36_601, '258e46332101335ce8d95aed7745b19ac3b46d37f3e159a89cf894c2ea9b1d3a'],
  ['lib/vendor/ONNXRUNTIME-LICENSE.txt', null, '2f07c72751aed99790b8a4869cf2311df85a860b22ded05fa22803587a48922c'],
  ['lib/vendor/TOKENIZERS-LICENSE.txt', 11_357, 'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4'],
];

let bytes = 0;
const errors = [];
for (const [relative, expectedSize, expectedHash] of EXPECTED) {
  const file = path.join(root, ...relative.split('/'));
  if (!existsSync(file)) {
    errors.push(`missing ${relative}`);
    continue;
  }
  const size = statSync(file).size;
  bytes += size;
  if (expectedSize !== null && size !== expectedSize) errors.push(`${relative}: expected ${expectedSize} bytes, got ${size}`);
  const hash = createHash('sha256').update(readFileSync(file)).digest('hex');
  if (hash !== expectedHash) errors.push(`${relative}: expected sha256 ${expectedHash}, got ${hash}`);
}

if (errors.length) {
  console.error(`semantic assets failed:\n- ${errors.join('\n- ')}`);
  process.exit(1);
}
console.log(`semantic assets OK: ${EXPECTED.length} files, ${(bytes / 1024 / 1024).toFixed(1)} MiB`);
