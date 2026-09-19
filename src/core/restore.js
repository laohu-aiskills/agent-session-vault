'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { sha256, relToAbs } = require('./backup');

/**
 * 还原
 *
 * 安全设计：默认【只演练不落盘】。
 * 还原会写回 ~/.claude、~/.workbuddy 这类个人数据目录，
 * 所以必须先打印计划、列出冲突，只有显式传 apply 才真正写入。
 * 覆盖已存在的文件还需要额外传 overwrite。
 *
 * 跨机器还原：备份清单里记了源机的 home 路径，
 * 传 target 即可把该前缀整体替换为目标路径（换电脑/换用户名场景）。
 */

/**
 * 生成还原计划（不落盘）
 * @param {object} cfg
 * @param {string} cfg.dir 备份目录
 * @param {string} [cfg.agent] 只还原某家
 * @param {string} [cfg.uid] 只还原某个会话
 * @param {string} [cfg.target] 目标家目录前缀替换（跨机器还原）
 * @param {boolean} [cfg.verify] 校验 sha256
 */
function planRestore({ dir, agent = null, uid = null, target = null, verify = false }) {
  const manifestFile = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestFile)) {
    throw new Error(`不是有效的备份目录（缺少 manifest.json）：${dir}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (manifest.format !== 'agent-session-vault/backup') {
    throw new Error(`备份格式不匹配：${manifest.format}`);
  }

  // 筛选要还原的文件
  let sessions = manifest.sessions;
  if (agent) sessions = sessions.filter((s) => s.agent === agent);
  if (uid) sessions = sessions.filter((s) => s.uid === uid);

  const wanted = new Map();
  for (const s of sessions) for (const rel of s.files) wanted.set(rel, s);

  const srcHome = manifest.home || '';
  const dstHome = target || null;

  const items = [];
  for (const f of manifest.files) {
    if (!wanted.has(f.rel)) continue;
    let dest = relToAbs(f.rel);
    let remapped = false;
    if (dstHome && srcHome && dest.toLowerCase().startsWith(srcHome.toLowerCase())) {
      dest = path.join(dstHome, dest.slice(srcHome.length).replace(/^[\\/]+/, ''));
      remapped = true;
    }
    const srcPath = path.join(dir, 'files', f.rel);
    const existsNow = fs.existsSync(dest);
    let same = false;
    if (existsNow && !remapped) {
      try { same = fs.statSync(dest).size === f.size; } catch { same = false; }
    }
    let integrity = 'not-checked';
    if (verify) {
      integrity = fs.existsSync(srcPath) && sha256(srcPath) === f.sha256 ? 'ok' : 'MISMATCH';
    }
    items.push({
      rel: f.rel, src: srcPath, dest, size: f.size,
      sessionUid: wanted.get(f.rel).uid,
      sessionTitle: wanted.get(f.rel).title,
      conflict: existsNow, identicalSize: same, remapped, integrity,
    });
  }

  return {
    manifest,
    dir,
    target: dstHome,
    srcHome,
    sessions: sessions.length,
    items,
    conflicts: items.filter((i) => i.conflict).length,
    missing: items.filter((i) => !fs.existsSync(i.src)).length,
    bytes: items.reduce((a, i) => a + i.size, 0),
  };
}

/**
 * 执行还原
 * @param {object} cfg apply / overwrite 为显式授权开关
 */
function applyRestore({ dir, agent = null, uid = null, target = null, verify = false, overwrite = false }) {
  const p = planRestore({ dir, agent, uid, target, verify });
  const result = { written: 0, skipped: 0, failed: 0, details: [], conflicts: p.conflicts };

  // 未授权覆盖时，冲突项一律跳过，绝不静默改写用户既有文件
  const blocked = !overwrite;

  for (const item of p.items) {
    if (!fs.existsSync(item.src)) {
      result.failed += 1;
      result.details.push({ dest: item.dest, status: 'missing-source' });
      continue;
    }
    if (item.integrity === 'MISMATCH') {
      result.failed += 1;
      result.details.push({ dest: item.dest, status: 'checksum-mismatch' });
      continue;
    }
    if (item.conflict && blocked) {
      result.skipped += 1;
      result.details.push({ dest: item.dest, status: 'conflict-skipped' });
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(item.dest), { recursive: true });
      fs.copyFileSync(item.src, item.dest);
      result.written += 1;
      result.details.push({ dest: item.dest, status: 'written' });
    } catch (e) {
      result.failed += 1;
      result.details.push({ dest: item.dest, status: `error: ${e.message}` });
    }
  }
  return { plan: p, result };
}

module.exports = { planRestore, applyRestore };
