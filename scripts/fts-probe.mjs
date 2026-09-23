// 验证 FTS5 的 unicode61 分词器对中文的实际行为。
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(":memory:");
const SENTENCE = "机器学习是人工智能的一个分支，深度学习又是机器学习的子集。";

function probe(tokenize, label) {
  const table = `t_${label}`;
  db.exec(`CREATE VIRTUAL TABLE ${table} USING fts5(content, tokenize = '${tokenize}');`);
  db.prepare(`INSERT INTO ${table}(content) VALUES (?)`).run(SENTENCE);
  const queries = ["机器学习", "深度学习", "人工智能", "分支"];
  const hits = queries.map((q) => {
    try {
      const row = db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${table} MATCH ?`).get(`"${q}"`);
      return `${q}:${row.n > 0 ? "命中" : "未命中"}`;
    } catch (error) {
      return `${q}:错误(${error.message.slice(0, 30)})`;
    }
  });
  console.log(`${label.padEnd(10)} ${hits.join("  ")}`);
}

console.log(`语料：${SENTENCE}\n`);
probe("unicode61 remove_diacritics 2", "unicode61");
try {
  probe("trigram", "trigram");
} catch (error) {
  console.log(`trigram    不可用：${error.message.slice(0, 60)}`);
}
db.close();
