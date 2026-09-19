'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { isDir, exists } = require('../util');
const { makeSession, makeMessage } = require('../model');

/**
 * SQLite 家族适配器 —— 覆盖 ZCode 与 opencode（同源，表结构与 part 类型完全一致）
 *
 * ZCode 实测库：~/.zcode/cli/db/db.sqlite
 *   session(id, project_id, slug, directory, path, title, version, time_created, time_updated, ...)
 *   message(id, session_id, time_created, time_updated, data(JSON), sequence)
 *            data = { role, time:{created,completed}, modelID, providerID, agent }
 *   part(id, message_id, session_id, time_created, time_updated, data(JSON), sequence)
 *            data.type ∈ text | reasoning | tool | file | timeline | step-start | step-finish
 *            tool = { callID, tool, state:{ status, input, output|error } }
 *
 * 一致性处理：目标应用（如 ZCode）运行时库是热的，且带未合并 WAL。
 * 直接以只读模式打开可能被写锁挡住（SQLITE_BUSY），
 * 因此先尝试直连，失败则把 db + wal + shm 一起复制到临时目录再读快照。
 * 这也是备份路径必须快照而非裸拷的同一个原因。
 */

function snapshotSqlite(srcDb) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asv-snap-'));
  const base = path.basename(srcDb);
  const dst = path.join(tmpDir, base);
  fs.copyFileSync(srcDb, dst);
  for (const suffix of ['-wal', '-shm']) {
    if (exists(srcDb + suffix)) {
      try { fs.copyFileSync(srcDb + suffix, dst + suffix); } catch { /* 忽略 */ }
    }
  }
  return { dir: tmpDir, db: dst };
}

class SqliteOpencodeProvider {
  /**
   * @param {object} cfg
   * @param {string} cfg.id
   * @param {string} cfg.label
   * @param {string[]} cfg.dbCandidates 候选数据库路径（~ 前缀会被展开）
   */
  constructor(cfg) {
    this.id = cfg.id;
    this.label = cfg.label;
    this.family = 'sqlite-opencode';
    this.dbCandidates = cfg.dbCandidates.map((p) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p));
    this.dbPath = null;
  }

  _resolve() {
    if (this.dbPath) return this.dbPath;
    for (const p of this.dbCandidates) {
      if (!exists(p)) continue;
      if (!this._schemaOk(p)) continue;
      this.dbPath = p;
      return p;
    }
    return null;
  }

  /** 表结构指纹校验，避免把一个只是同名的库当成目标库 */
  _schemaOk(p) {
    let con = null; let snap = null;
    try {
      con = new DatabaseSync(p, { readOnly: true });
    } catch {
      try {
        snap = snapshotSqlite(p);
        con = new DatabaseSync(snap.db, { readOnly: true });
      } catch {
        return false;
      }
    }
    try {
      const rows = con.prepare("select name from sqlite_master where type='table'").all();
      const names = new Set(rows.map((r) => r.name));
      return names.has('session') && names.has('message') && names.has('part');
    } catch {
      return false;
    } finally {
      try { con.close(); } catch { /* ignore */ }
      if (snap) { try { fs.rmSync(snap.dir, { recursive: true, force: true }); } catch { /* ignore */ } }
    }
  }

  detect() {
    const p = this._resolve();
    if (p) {
      return { available: true, root: p, reason: `数据库可用：${p}` };
    }
    const tried = this.dbCandidates.filter((c) => exists(c));
    if (this.dbCandidates.every((c) => !exists(c))) {
      return {
        available: false,
        root: this.dbCandidates[0],
        reason: '未找到数据库（该 Agent 未安装或未产生会话）',
      };
    }
    return {
      available: false,
      root: tried[0] || this.dbCandidates[0],
      reason: '存在同名文件但表结构不匹配（非 session/message/part 布局）',
    };
  }

  /** 打开一个可用的连接；直连失败自动降级为临时快照 */
  _open() {
    const p = this._resolve();
    if (!p) throw new Error(`${this.label}: 数据库不可用`);
    try {
      return { con: new DatabaseSync(p, { readOnly: true }), cleanup: () => {} };
    } catch {
      const snap = snapshotSqlite(p);
      const con = new DatabaseSync(snap.db, { readOnly: true });
      return {
        con,
        cleanup: () => {
          try { con.close(); } catch { /* ignore */ }
          try { fs.rmSync(snap.dir, { recursive: true, force: true }); } catch { /* ignore */ }
        },
      };
    }
  }

  async discover() {
    const p = this._resolve();
    if (!p) return [];
    const { con, cleanup } = this._open();
    try {
      const rows = con.prepare(
        'select id, directory, path, title, version, time_created, time_updated from session order by time_updated desc',
      ).all();
      const countStmt = con.prepare('select count(*) as n, max(time_updated) as last from message where session_id = ?');
      return rows.map((r) => {
        let n = 0; let last = null;
        try {
          const c = countStmt.get(r.id);
          n = c ? c.n : 0;
          last = c ? c.last : null;
        } catch { /* ignore */ }
        return makeSession({
          uid: `${this.id}:${r.id}`,
          agent: this.id,
          sessionId: r.id,
          projectPath: r.directory || r.path || null,
          pathSource: r.directory || r.path ? 'db' : 'unknown',
          title: r.title || null,
          createdAt: r.time_created ?? null,
          updatedAt: r.time_updated ?? last ?? null,
          bytes: 0,
          sourceDb: p,
          meta: { version: r.version || null, messageCount: n },
        });
      });
    } finally {
      cleanup();
    }
  }

  async parse(session) {
    const { con, cleanup } = this._open();
    try {
      const msgs = con.prepare(
        'select id, time_created, data from message where session_id = ? order by time_created asc, sequence asc',
      ).all(session.sessionId);
      const partStmt = con.prepare(
        'select time_created, data from part where message_id = ? order by sequence asc, time_created asc',
      );

      const out = [];
      let seq = 0;
      for (const row of msgs) {
        let mdata = {};
        try { mdata = JSON.parse(row.data || '{}'); } catch { /* ignore */ }
        const role = mdata.role === 'user' ? 'user' : 'assistant';
        const parts = partStmt.all(row.id);
        for (const pr of parts) {
          let d = {};
          try { d = JSON.parse(pr.data || '{}'); } catch { continue; }
          const ts = (d.time && (d.time.start ?? d.time.end)) ?? pr.time_created ?? row.time_created ?? null;
          if (d.type === 'text' && d.text) {
            out.push(makeMessage({ seq: seq++, role, kind: 'text', ts, text: d.text }));
          } else if (d.type === 'reasoning' && d.text) {
            out.push(makeMessage({ seq: seq++, role: 'assistant', kind: 'reasoning', ts, text: d.text }));
          } else if (d.type === 'tool') {
            const st = d.state || {};
            const input = st.input ?? {};
            out.push(makeMessage({
              seq: seq++, role: 'assistant', kind: 'tool_call', ts,
              text: typeof input === 'string' ? input : JSON.stringify(input),
              toolName: d.tool || null, toolInput: input,
            }));
            const res = st.output ?? st.error ?? st.metadata ?? '';
            const text = typeof res === 'string' ? res : (res ? JSON.stringify(res) : '');
            if (text) {
              out.push(makeMessage({
                seq: seq++, role: 'tool', kind: 'tool_result', ts,
                text, toolName: d.tool || null, toolResult: text,
              }));
            }
          }
          // file / timeline / step-start / step-finish 不进正文
        }
      }
      return { messages: out, title: null };
    } finally {
      cleanup();
    }
  }

  originalPaths(session) {
    const p = this._resolve();
    if (!p) return [];
    // 备份必须带上 wal/shm，否则可能丢最新事务
    return [p, `${p}-wal`, `${p}-shm`].filter(exists);
  }

  projectDir() {
    return this._resolve();
  }
}

module.exports = { SqliteOpencodeProvider, snapshotSqlite };
