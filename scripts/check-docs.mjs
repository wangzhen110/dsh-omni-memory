#!/usr/bin/env node
/**
 * Documentation consistency gate.
 *
 * Every review that found drift found it the same way: the docs claimed a
 * version / test count / route count that the code no longer had. This script
 * fails `npm run check` when the two disagree, so drift cannot ship silently.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = file => readFileSync(path.join(root, file), 'utf8');

const pkg = JSON.parse(read('package.json'));
const index = read('index.js');
const readme = read('README.md');
const design = read('docs/DESIGN.md');
const changelog = read('docs/CHANGELOG.md');

const tools = [...new Set([...index.matchAll(/name:\s*'(memory_[a-z]+)'/g)].map(match => match[1]))].sort();
const routes = [...new Set([...index.matchAll(/path:\s*'\/omni-memory\/([a-z]+)'/g)].map(match => match[1]))].sort();
const adrCount = readdirSync(path.join(root, 'docs', 'ADR')).filter(file => file.endsWith('.md')).length;

let tests = 0;
for (const file of readdirSync(path.join(root, 'test')).filter(name => name.endsWith('.test.mjs'))) {
  tests += (readFileSync(path.join(root, 'test', file), 'utf8').match(/^test\(/gm) ?? []).length;
}

const failures = [];
const check = (label, ok, detail) => {
  if (ok) {
    console.log(`ok   ${label}`);
    return;
  }
  failures.push(`${label}: ${detail}`);
  console.log(`FAIL ${label}: ${detail}`);
};

check('package version equals DESIGN', design.includes(`| 插件版本 | ${pkg.version} |`), `DESIGN does not claim ${pkg.version}`);
check('README badge test count', readme.includes(`tests-${tests}%2F${tests}`), `README badge is not ${tests}/${tests}`);
check('README test count line', readme.includes(`**${tests} / ${tests} 通过**`), `README does not say ${tests}/${tests} 通过`);
check('README npm test hint', readme.includes(`# ${tests} 个用例`), `README does not say ${tests} 个用例`);
check('DESIGN test reliability', design.includes(`${tests}/${tests}`), `DESIGN NFR does not say ${tests}/${tests}`);
check('README ADR count', readme.includes(`（${adrCount} 份）`), `README does not say ${adrCount} 份`);
check('DESIGN route list', routes.every(route => design.includes(route)) && design.includes(`${routes.length} 条 loopback HTTP`), `DESIGN routes do not match ${routes.join(',')}`);
check('README tool count', tools.every(tool => readme.includes(tool)), `README misses a tool (${tools.join(',')})`);
check('CHANGELOG has current version', new RegExp(`## \\[${pkg.version.replaceAll('.', '\\.')}\\]`).test(changelog), `CHANGELOG has no ${pkg.version} entry`);

console.log(`\n${tests} tests, ${tools.length} tools, ${routes.length} routes, ${adrCount} ADRs, version ${pkg.version}`);
if (failures.length) {
  console.error(`\n${failures.length} documentation mismatch(es). Update the docs before shipping.`);
  process.exit(1);
}
console.log('documentation is consistent');
