#!/usr/bin/env node
/**
 * Hook placement guard for client.js.
 *
 * React hooks may only run at the top level of a component. A useState inside a
 * useEffect callback throws "Invalid hook call" at mount and takes the whole
 * panel down (that is exactly how the persona release white-screened). This
 * script walks every `React.useEffect(() => {` body with a brace counter and
 * fails if a hook call appears inside it.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const source = readFileSync(path.join(root, 'client.js'), 'utf8');
const lines = source.split('\n');

const hook = /React\.use(State|Ref|Memo|Callback|Effect|Reducer|Context)\s*[.(]/;
const failures = [];

lines.forEach((line, index) => {
  if (!/React\.useEffect\s*\(\s*\(\s*\)\s*=>\s*\{/.test(line)) return;
  let depth = 0;
  let started = false;
  for (let cursor = index; cursor < lines.length; cursor += 1) {
    const text = lines[cursor];
    for (const char of text) {
      if (char === '{') { depth += 1; started = true; }
      else if (char === '}') depth -= 1;
    }
    if (cursor > index && started && depth <= 0) break;
    if (cursor > index && hook.test(text)) {
      failures.push({ effect: index + 1, hook: cursor + 1, text: text.trim() });
      break;
    }
  }
});

if (failures.length) {
  for (const failure of failures) {
    console.error(`FAIL hook inside useEffect: effect at line ${failure.effect}, hook at line ${failure.hook}: ${failure.text}`);
  }
  process.exit(1);
}
console.log('ok   client hooks are at component top level');
