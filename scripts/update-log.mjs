#!/usr/bin/env node
/**
 * Generate docs/UPDATES.md from the complete git history.
 *
 * Every commit on HEAD gets one record, newest first. The file is intentionally
 * generated: a hand-maintained list drifts, git history does not.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
  return execFileSync(git, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  }).trim();
}

const head = run(['rev-parse', 'HEAD']);
const headDate = run(['show', '-s', '--date=format-local:%Y-%m-%d %H:%M:%S', '--format=%ad', 'HEAD']);
const count = Number(run(['rev-list', '--count', 'HEAD']));
const format = '%H%x1f%ad%x1f%s%x1e';
const raw = run(['log', '--date=format-local:%Y-%m-%d %H:%M:%S', `--format=${format}`, 'HEAD']);
const commits = raw
  .split('\x1e')
  .filter(Boolean)
  .map((record) => {
    const [hash, date, subject] = record.trim().split('\x1f');
    return { hash, date, subject };
  });

let remote = '';
try {
  remote = run(['remote', 'get-url', 'origin']);
} catch {
  remote = '';
}
const commitBase = remote.startsWith('https://github.com/')
  ? remote.replace(/\.git$/, '')
  : 'https://github.com/wangzhen110/omni-memory';

const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
const reportLinks = [...readme.matchAll(/- \[(3\.9\.\d+)[^\]]*\]\((docs\/COMPLETION-[^)]+)\)/g)]
  .map((match) => ({
    version: match[1],
    path: match[2].replace(/^docs\//, './'),
  }));

const grouped = new Map();
for (const commit of commits) {
  const day = commit.date.slice(0, 10);
  if (!grouped.has(day)) grouped.set(day, []);
  grouped.get(day).push(commit);
}

const lines = [
  '# 更新记录',
  '',
  '> 本文件由 `npm run update-log` 从 git 历史自动生成，按时间倒序记录每一次提交。',
  '> 版本摘要见 [CHANGELOG](CHANGELOG.md)，版本报告见下方“版本报告”。',
  `> 当前 HEAD：\`${head.slice(0, 8)}\`（${headDate}）；共 ${count} 次提交。`,
  '',
  '## 版本报告',
  '',
];

for (const report of reportLinks) {
  lines.push(`- [${report.version} 完成报告](${report.path})`);
}
if (reportLinks.length === 0) lines.push('- 暂无完成报告链接。');

for (const [day, records] of grouped) {
  lines.push('', `## ${day}`, '');
  for (const record of records) {
    const time = record.date.slice(11, 19);
    const hash = record.hash.slice(0, 8);
    const isHead = record.hash === head ? '（HEAD）' : '';
    const url = `${commitBase}/commit/${record.hash}`;
    lines.push(`- ${time} \`${hash}\`${isHead} — ${record.subject} — [提交](${url})`);
  }
}

writeFileSync(resolve(root, 'docs/UPDATES.md'), `${lines.join('\n')}\n`, 'utf8');
console.log(`docs/UPDATES.md: ${count} commits, HEAD ${head.slice(0, 8)}`);
