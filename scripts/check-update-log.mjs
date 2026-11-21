#!/usr/bin/env node
/**
 * Fail when a normal commit is missing from docs/UPDATES.md.
 *
 * Update-log commits themselves are excluded: a generated file cannot contain
 * its own commit hash. Every other commit must be recorded before `npm run check`
 * can pass, so the update log cannot silently fall behind.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const gitCandidates = [
  process.env.GIT_BIN,
  'C:\\Program Files\\Git\\cmd\\git.exe',
  'git',
].filter(Boolean);
const git = gitCandidates.find((candidate) => candidate === 'git' || existsSync(candidate)) || 'git';

function run(args) {
  return execFileSync(git, args, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim();
}

const logPath = resolve(root, 'docs/UPDATES.md');
if (!existsSync(logPath)) {
  console.error('docs/UPDATES.md missing; run npm run update-log');
  process.exit(1);
}

const recorded = new Set(
  [...readFileSync(logPath, 'utf8').matchAll(/`([0-9a-f]{8})`/g)].map((match) => match[1]),
);
const raw = run(['log', '--format=%H%x1f%s']);
const missing = [];
for (const line of raw.split('\n')) {
  if (!line) continue;
  const [hash, subject] = line.split('\x1f');
  if (!subject) continue;
  if (/^docs: (add|update) per-commit update log/i.test(subject)) continue;
  if (!recorded.has(hash.slice(0, 8))) missing.push(`${hash.slice(0, 8)} ${subject}`);
}

if (missing.length > 0) {
  console.error(`docs/UPDATES.md is missing ${missing.length} commit(s); run npm run update-log and commit it:`);
  for (const item of missing.slice(0, 20)) console.error(`  ${item}`);
  if (missing.length > 20) console.error(`  ... ${missing.length - 20} more`);
  process.exit(1);
}

console.log(`update log covers ${recorded.size} recorded commit hashes`);
