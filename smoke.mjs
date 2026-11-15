import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(':memory:');
let mode = 'like';
try {
  db.exec("CREATE VIRTUAL TABLE t USING fts5(text, tokenize='trigram')");
  mode = 'trigram';
} catch (error) {
  mode = `fail: ${error.message}`;
}
console.log('node:', process.version);
console.log('fts mode:', mode);

db.exec('CREATE TABLE c(id INTEGER PRIMARY KEY, text TEXT)');
const sample = '上次那个插件报错是因为 inspectSession 把实时会话顶掉了';
db.prepare('INSERT INTO c(text) VALUES (?)').run(sample);

if (mode === 'trigram') {
  db.prepare('INSERT INTO t(rowid, text) VALUES (?, ?)').run(1, sample);
  const fts = db.prepare('SELECT rowid FROM t WHERE t MATCH ?').all('"插件报错"');
  console.log('fts hit:', JSON.stringify(fts));
}

const like = db.prepare('SELECT id FROM c WHERE text LIKE ?').all('%插件报错%');
console.log('like hit:', JSON.stringify(like));
console.log('bm25 available:', (() => {
  try { db.prepare('SELECT bm25(t) FROM t LIMIT 1').all(); return true; } catch { return false; }
})());
