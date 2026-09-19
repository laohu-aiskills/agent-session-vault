'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { DatabaseSync } = require('node:sqlite');
const { exists } = require('./util');

/**
 * 会话索引读取器
 *
 * 部分 Agent 把「会话 id → 标题/模型」这类元数据单独存在一个索引里，
 * 而不是写在会话正文中（WorkBuddy 存 workbuddy.db，Kimi Code 存 session_index.jsonl）。
 * 这些索引是标题的权威来源，比从正文里猜要可靠得多。
 *
 * 全部按只读方式打开；必须带未合并 WAL 的场景交给调用方先做快照。
 */

function expand(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

/**
 * 从 SQLite 索引库读取 title 映射
 * @param {string} dbPath
 * @param {object} cfg
 * @param {string} cfg.table
 * @param {string} cfg.idCol
 * @param {string[]} cfg.titleCols 按优先级排列，取第一个非空的
 * @param {string} [cfg.modelCol]  可选，顺带取模型名
 * @returns {Map<string, {title?:string, model?:string}>}
 */
function readSqliteIndex(dbPath, cfg) {
  const out = new Map();
  const p = expand(dbPath);
  if (!exists(p)) return out;

  let con = null;
  try {
    con = new DatabaseSync(p, { readOnly: true });
  } catch {
    return out; // 被写锁占用时不强求，标题留空由正文兜底
  }
  try {
    const cols = [cfg.idCol, ...cfg.titleCols, ...(cfg.modelCol ? [cfg.modelCol] : [])];
    const sql = `select ${cols.join(', ')} from ${cfg.table}`;
    for (const row of con.prepare(sql).all()) {
      const id = row[cfg.idCol];
      if (!id) continue;
      const entry = {};
      for (const c of cfg.titleCols) {
        const v = row[c];
        if (typeof v === 'string' && v.trim()) { entry.title = v.trim(); break; }
      }
      if (cfg.modelCol) {
        const m = row[cfg.modelCol];
        if (typeof m === 'string' && m.trim()) entry.model = m.trim();
      }
      if (entry.title || entry.model) out.set(String(id), entry);
    }
  } catch {
    return out;
  } finally {
    try { con.close(); } catch { /* ignore */ }
  }
  return out;
}

/**
 * 从 JSONL 索引文件读取映射（每行一条 JSON）
 * @param {string} filePath
 * @param {object} cfg
 * @param {string} cfg.idField
 * @param {string[]} cfg.titleFields
 */
function readJsonlIndex(filePath, cfg) {
  const out = new Map();
  const p = expand(filePath);
  if (!exists(p)) return out;
  let text;
  try { text = fs.readFileSync(p, 'utf8'); } catch { return out; }
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    let obj;
    try { obj = JSON.parse(t); } catch { continue; }
    const id = obj[cfg.idField];
    if (!id) continue;
    const entry = {};
    for (const f of cfg.titleFields) {
      const v = obj[f];
      if (typeof v === 'string' && v.trim()) { entry.title = v.trim(); break; }
    }
    if (entry.title) out.set(String(id), entry);
  }
  return out;
}

module.exports = { readSqliteIndex, readJsonlIndex, expand };
