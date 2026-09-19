'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

/**
 * 流式逐行读取文件。设计要点：
 *  - 不用 readFileSync/readlines()，因为单行可能有几 MB（function_call_result）
 *  - 脏尾行（Agent 崩溃留下的半行 JSON）交给调用方通过 tryParse 处理，读循环不中断
 * @param {string} file
 * @param {(line: string, lineNo: number) => void|false} onLine 返回 false 提前终止读取
 * @returns {Promise<number>} 实际读取行数
 */
async function eachLine(file, onLine) {
  const stream = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 20 });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let n = 0;
  let stopped = false;
  try {
    for await (const line of rl) {
      n += 1;
      if (line.length === 0) continue;
      if (onLine(line, n) === false) { stopped = true; break; }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return n;
}

/** 解析 JSON，失败返回 null（脏尾行/截断行容错） */
function tryParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/**
 * 读取文件最后 size 字节中的最后一条完整行，用于廉价地取到会话的最新状态。
 * 用于 discover 阶段避免全量解析。
 */
function readLastLine(file, size = 128 * 1024) {
  let fd;
  try {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - size);
    const len = st.size - start;
    if (len <= 0) return null;
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    const text = buf.toString('utf8');
    const lines = text.split(/\r?\n/);
    // 首行可能是被截断的半行，从后往前找第一条能解析的
    for (let i = lines.length - 1; i >= 1; i -= 1) {
      const l = lines[i].trim();
      if (!l) continue;
      const obj = tryParse(l);
      if (obj) return obj;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/**
 * 从文件尾部读若干条可解析对象。用于取追加在末尾的 ai-title 与最新时间戳。
 * 只读最后 size 字节，不做全量扫描。
 */
function readTailObjects(file, maxLines = 8, size = 256 * 1024) {
  let fd;
  try {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - size);
    const len = st.size - start;
    if (len <= 0) return [];
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    const lines = buf.toString('utf8').split(/\r?\n/);
    const out = [];
    // 首行可能是被截断的半行，跳过 index 0
    for (let i = lines.length - 1; i >= 1 && out.length < maxLines; i -= 1) {
      const l = lines[i].trim();
      if (!l) continue;
      const obj = tryParse(l);
      if (obj) out.push(obj);
    }
    return out;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/**
 * 只读文件头部若干条可解析对象，用于廉价地取 cwd / title / model 等元数据。
 * 命中上限后立即中止读取，不做全量扫描——大文件（实测最大 11MB）必须早停。
 */
async function readHeadObjects(file, maxLines = 60, maxBytes = 4 * 1024 * 1024) {
  const out = [];
  let bytes = 0;
  await eachLine(file, (line) => {
    bytes += line.length;
    const obj = tryParse(line);
    if (obj) out.push(obj);
    if (out.length >= maxLines || bytes >= maxBytes) return false;
  });
  return out;
}

/**
 * 时间戳归一化为毫秒整数。实测各家格式：
 *  - WorkBuddy / Claude / QwenWorkCN: 毫秒整数 1789543853895
 *  - Kimi: 秒浮点 1780296611.9164207
 *  - Codex: ISO 字符串 "2026-04-27T02:10:34.671Z"
 *  - ZCode(SQLite): 秒或毫秒整数
 */
function toMs(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v <= 0) return null;
    // < 1e11 视为秒（1e11 ms ≈ 1973 年，秒级时间戳到 5138 年才到 1e11）
    return v < 1e11 ? Math.round(v * 1000) : Math.round(v);
  }
  if (typeof v === 'string') {
    const asNum = Number(v);
    if (Number.isFinite(asNum) && v.trim() !== '') return toMs(asNum);
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

/**
 * 把 Claude/WorkBuddy 风格的目录分片名尽力还原成路径。
 * 该编码不可逆（分隔符都被压成 '-'），因此仅作兜底，
 * 调用方必须优先使用会话内容里自带的 cwd。
 */
function decodeSlug(slug) {
  if (!slug) return null;
  let s = slug;
  if (/^[a-z]--/.test(s)) {
    // "c--Users-..." / "d--code-xiaoyu" → "C:\Users\..." / "D:\code\xiaoyu"
    s = `${s[0]}:\\${s.slice(3)}`;
  } else if (/^[a-zA-Z]-/.test(s)) {
    s = `${s[0]}:\\${s.slice(2)}`;
  }
  return s.replace(/-/g, '\\');
}

/** 递归扫描目录下匹配后缀的文件，跳过符号链接与超过 maxDepth 的层级 */
function walkFiles(root, { exts = null, maxDepth = 12, skipDirs = [] } = {}) {
  const found = [];
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    if (depth > maxDepth) continue;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (skipDirs.includes(e.name)) continue;
        stack.push({ dir: full, depth: depth + 1 });
      } else if (e.isFile()) {
        if (exts && !exts.some((x) => e.name.toLowerCase().endsWith(x))) continue;
        found.push(full);
      }
    }
  }
  return found;
}

/** 安全列目录，不存在返回空数组 */
function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/** 人类可读字节数 */
function humanSize(n) {
  if (!Number.isFinite(n)) return '-';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)}${u[i]}`;
}

function formatTime(ms) {
  if (!ms) return '-';
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

module.exports = {
  eachLine,
  tryParse,
  readLastLine,
  readTailObjects,
  readHeadObjects,
  toMs,
  decodeSlug,
  walkFiles,
  listDir,
  exists,
  isDir,
  humanSize,
  formatTime,
};
