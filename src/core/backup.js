'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { walkFiles, exists, isDir } = require('./util');
const { discoverAll } = require('./scan');

/**
 * 备份
 *
 * 设计取舍（实测驱动）：
 *  1. 用「目录快照」而不是 zip/tar —— Node 无内置压缩格式支持，
 *     为打包引入第三方库会破坏「零运行时依赖 + 内网离线」这两个硬约束。
 *     目录快照同样可增量对比、可人工检查、可直接还原。
 *  2. 快照时必须处理热数据：
 *       - SQLite（ZCode 等）要连 -wal / -shm 一起拷，否则会丢最新事务
 *       - 正在被追加的 JSONL 最后一行可能是半行，解析器已能容错
 *  3. 每个文件记 sha256，还原时可校验完整性。
 *
 * 目录布局：
 *   <out>/manifest.json
 *   <out>/files/<相对路径>      —— 镜像原始绝对路径，可直接反推回原位
 */

/** 绝对路径 → 快照内相对路径。Windows 盘符降为小写目录名，POSIX 根目录归到 root/ */
function absToRel(abs) {
  const norm = path.resolve(abs);
  const m = norm.match(/^([A-Za-z]):[\\/](.*)$/);
  if (m) return path.join(m[1].toLowerCase(), m[2]);
  if (norm.startsWith('/')) return path.join('root', norm.slice(1));
  return norm.replace(/[:\\/]/g, '_');
}

/** 快照内相对路径 → 绝对路径（还原用） */
function relToAbs(rel) {
  const parts = rel.split(/[\\/]/).filter(Boolean);
  if (parts.length >= 2 && /^[a-z]$/.test(parts[0])) {
    const drive = parts[0].toUpperCase();
    return `${drive}:\\${parts.slice(1).join('\\')}`;
  }
  if (parts[0] === 'root') return `/${parts.slice(1).join('/')}`;
  return parts.join('/');
}

function sha256(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    let n;
    // eslint-disable-next-line no-cond-assign
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

/** 把 provider 给出的原始路径（可能是目录）展开为文件清单 */
function expandPaths(paths) {
  const out = [];
  for (const p of paths) {
    if (!exists(p)) continue;
    if (isDir(p)) {
      for (const f of walkFiles(p, { maxDepth: 8 })) out.push(f);
    } else {
      out.push(p);
    }
  }
  return [...new Set(out)];
}

/**
 * 执行备份
 * @param {object} cfg
 * @param {object[]} cfg.providers
 * @param {string} cfg.out 输出目录
 * @param {string} [cfg.agent] 只备份某个 agent
 * @param {(ev:object)=>void} [cfg.onProgress]
 */
async function backup({ providers, out, agent = null, onProgress = () => {} }) {
  const picked = agent ? providers.filter((p) => p.id === agent) : providers;
  if (agent && picked.length === 0) throw new Error(`未知的 Agent：${agent}`);

  const { sessions, agents } = await discoverAll(picked);
  fs.mkdirSync(path.join(out, 'files'), { recursive: true });

  const manifest = {
    format: 'agent-session-vault/backup',
    version: 1,
    createdAt: Date.now(),
    host: os.hostname(),
    platform: process.platform,
    home: os.homedir(),
    agents: agents.map((a) => ({ id: a.id, label: a.label, available: a.available, count: a.count })),
    sessions: [],
    files: [],
    errors: [],
  };

  const done = new Set();
  let bytes = 0;

  for (const s of sessions) {
    const provider = picked.find((p) => p.id === s.agent);
    if (!provider) continue;
    let paths = [];
    try {
      paths = expandPaths(provider.originalPaths(s));
    } catch (e) {
      manifest.errors.push({ uid: s.uid, error: `收集原始路径失败：${e.message}` });
      continue;
    }
    manifest.sessions.push({
      uid: s.uid, agent: s.agent, sessionId: s.sessionId, title: s.title,
      projectPath: s.projectPath, createdAt: s.createdAt, updatedAt: s.updatedAt,
      sourcePath: s.sourcePath, sourceDb: s.sourceDb, bytes: s.bytes,
      files: paths.map(absToRel),
    });

    for (const abs of paths) {
      if (done.has(abs)) continue;
      done.add(abs);
      const rel = absToRel(abs);
      const dest = path.join(out, 'files', rel);
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        // 直接复制即可：SQLite 的 -wal 在文件清单里单独列了，
        // 追加中的 JSONL 即便末尾半行也不会毁掉整个文件
        fs.copyFileSync(abs, dest);
        const st = fs.statSync(dest);
        bytes += st.size;
        manifest.files.push({
          rel, size: st.size, mtimeMs: fs.statSync(abs).mtimeMs, sha256: sha256(dest),
        });
        onProgress({ file: rel, size: st.size });
      } catch (e) {
        manifest.errors.push({ path: abs, error: e.message });
      }
    }
  }

  manifest.summary = {
    sessions: manifest.sessions.length,
    files: manifest.files.length,
    bytes,
    errors: manifest.errors.length,
  };
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return { out, manifest };
}

module.exports = { backup, absToRel, relToAbs, sha256, expandPaths };
