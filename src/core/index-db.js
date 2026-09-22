'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

/**
 * 检索索引库
 *
 * 关键设计决定：FTS5 的 trigram 分词器对「少于 3 个字符」的查询会【静默返回空结果】，
 * 既不报错也不提示。而中文里两字词（"会话""天气"）恰恰是最常见的查询。
 * 实测：查询 "贪食" / "会话" / "蛇" 全部匹配不到，而 "贪食蛇" / "会话记录" 正常。
 *
 * 因此检索走双通道：
 *   - 查询长度 >= 3  → FTS5 trigram MATCH（走索引，毫秒级）
 *   - 查询长度 <= 2  → LIKE 全表扫描（慢，但结果正确）
 * 调用的返回值里带 mode 字段，CLI 会如实告诉用户用的是哪条通道。
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  uid          TEXT PRIMARY KEY,
  agent        TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  project_path TEXT,
  path_source  TEXT,
  title        TEXT,
  created_at   INTEGER,
  updated_at   INTEGER,
  bytes        INTEGER,
  source_path  TEXT,
  source_db    TEXT,
  meta_json    TEXT,
  msg_count    INTEGER,
  src_mtime    REAL,
  indexed_at   INTEGER
);
CREATE INDEX IF NOT EXISTS ix_sessions_agent ON sessions(agent);
CREATE INDEX IF NOT EXISTS ix_sessions_updated ON sessions(updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id        INTEGER PRIMARY KEY,
  uid       TEXT NOT NULL,
  seq       INTEGER NOT NULL,
  role      TEXT,
  kind      TEXT,
  ts        INTEGER,
  text      TEXT,
  tool_name TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_messages ON messages(uid, seq);
CREATE INDEX IF NOT EXISTS ix_messages_uid ON messages(uid);
CREATE INDEX IF NOT EXISTS ix_messages_kind ON messages(kind);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
  USING fts5(text, content='messages', content_rowid='id', tokenize='trigram');
`;

class IndexDb {
  /** @param {string} [file] 索引库路径，默认 ~/.agent-session-vault/index.db */
  constructor(file) {
    this.file = file || path.join(os.homedir(), '.agent-session-vault', 'index.db');
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.db = new DatabaseSync(this.file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec(SCHEMA);
    this._stmts = {};
  }

  _s(sql) {
    if (!this._stmts[sql]) this._stmts[sql] = this.db.prepare(sql);
    return this._stmts[sql];
  }

  close() {
    try { this.db.close(); } catch { /* ignore */ }
  }

  /* ----------------------------- 写入 ----------------------------- */

  /** 该会话是否需要（重新）索引：源文件未变且已索引过则跳过 */
  needsIndex(session) {
    const row = this._s('select src_mtime, indexed_at from sessions where uid = ?').get(session.uid);
    if (!row) return true;
    if (row.src_mtime === null || row.src_mtime === undefined) return true;
    let mtime = 0;
    if (session.sourcePath) {
      try { mtime = fs.statSync(session.sourcePath).mtimeMs; } catch { return true; }
    } else if (session.sourceDb) {
      try { mtime = fs.statSync(session.sourceDb).mtimeMs; } catch { return true; }
    }
    return Math.abs(Number(row.src_mtime) - mtime) > 0.5;
  }

  _mtimeOf(session) {
    const p = session.sourcePath || session.sourceDb;
    if (!p) return null;
    try { return fs.statSync(p).mtimeMs; } catch { return null; }
  }

  /**
   * 写入一个会话及其消息（覆盖式）。整体在一个事务里，避免中途失败留下半个会话。
   * @param {object} session
   * @param {object[]} messages
   */
  putSession(session, messages) {
    const now = Date.now();
    const mtime = this._mtimeOf(session);
    this.db.exec('BEGIN');
    try {
      // 先清掉旧消息：FTS 是 external content 表，必须显式发 delete 指令再删主表
      const old = this._s('select id, text from messages where uid = ?').all(session.uid);
      const delFts = this._s("insert into messages_fts(messages_fts, rowid, text) values('delete', ?, ?)");
      for (const o of old) delFts.run(o.id, o.text ?? '');
      this._s('delete from messages where uid = ?').run(session.uid);

      this._s(`insert or replace into sessions
        (uid, agent, session_id, project_path, path_source, title, created_at, updated_at,
         bytes, source_path, source_db, meta_json, msg_count, src_mtime, indexed_at)
        values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        session.uid, session.agent, session.sessionId, session.projectPath, session.pathSource,
        session.title, session.createdAt, session.updatedAt, session.bytes,
        session.sourcePath, session.sourceDb, JSON.stringify(session.meta || {}),
        messages.length, mtime, now,
      );

      const insMsg = this._s('insert into messages(uid, seq, role, kind, ts, text, tool_name) values (?,?,?,?,?,?,?)');
      const insFts = this._s('insert into messages_fts(rowid, text) values (?, ?)');
      for (const m of messages) {
        const info = insMsg.run(session.uid, m.seq, m.role, m.kind, m.ts, m.text ?? '', m.toolName);
        insFts.run(Number(info.lastInsertRowid), m.text ?? '');
      }
      this.db.exec('COMMIT');
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    }
  }

  /** 移除一个会话（源已消失时调用） */
  removeSession(uid) {
    const old = this._s('select id, text from messages where uid = ?').all(uid);
    this.db.exec('BEGIN');
    try {
      const delFts = this._s("insert into messages_fts(messages_fts, rowid, text) values('delete', ?, ?)");
      for (const o of old) delFts.run(o.id, o.text ?? '');
      this._s('delete from messages where uid = ?').run(uid);
      this._s('delete from sessions where uid = ?').run(uid);
      this.db.exec('COMMIT');
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    }
  }

  setMeta(key, value) {
    this._s('insert or replace into meta(key, value) values (?, ?)').run(key, String(value));
  }

  getMeta(key) {
    const r = this._s('select value from meta where key = ?').get(key);
    return r ? r.value : null;
  }

  /* ----------------------------- 读取 ----------------------------- */

  stats() {
    const s = this._s('select count(*) n, coalesce(sum(msg_count),0) m, coalesce(sum(bytes),0) b from sessions').get();
    const byAgent = this._s('select agent, count(*) n, coalesce(sum(msg_count),0) m from sessions group by agent order by n desc').all();
    return {
      sessions: s.n, messages: s.m, bytes: s.b, byAgent,
      indexedAt: this.getMeta('indexed_at'),
      dbFile: this.file,
      dbSize: (() => { try { return fs.statSync(this.file).size; } catch { return 0; } })(),
    };
  }

  listSessions({ agent = null, project = null, limit = 50, offset = 0, order = 'updated' } = {}) {
    const where = [];
    const args = [];
    if (agent) { where.push('agent = ?'); args.push(agent); }
    if (project) { where.push('(project_path like ? or title like ?)'); args.push(`%${project}%`, `%${project}%`); }
    const orderSql = order === 'created' ? 'created_at desc' : 'updated_at desc';
    const sql = `select * from sessions ${where.length ? 'where ' + where.join(' and ') : ''}
                 order by ${orderSql} limit ? offset ?`;
    return this.db.prepare(sql).all(...args, limit, offset);
  }

  /** 全部已索引会话的 uid。prune 用，避免整表全列加载 */
  allUids() {
    return this._s('select uid from sessions').all().map((r) => r.uid);
  }

  getSession(uid) {
    const s = this._s('select * from sessions where uid = ?').get(uid);
    if (!s) return null;
    const messages = this.db.prepare(
      'select seq, role, kind, ts, text, tool_name from messages where uid = ? order by seq asc',
    ).all(uid);
    return { session: s, messages };
  }

  /** 按 uid 或 session_id 前缀模糊定位会话 */
  findSessions(needle, limit = 20) {
    const like = `%${needle}%`;
    return this.db.prepare(
      `select * from sessions where uid = ? or session_id like ? or title like ?
       order by updated_at desc limit ?`,
    ).all(needle, like, like, limit);
  }

  /**
   * 全文检索。自动选择通道：
   *   query 长度 >= 3 → FTS5 trigram MATCH
   *   query 长度 <= 2 → LIKE 扫描
   * 结果按会话聚合：同一会话只出一条，match_count 记录该会话内命中的消息数。
   * @returns {{mode:'fts'|'like', hits: object[], total_matches: number, truncated: boolean}}
   */
  search(query, { agent = null, project = null, kinds = null, limit = 30 } = {}) {
    const q = String(query || '').trim();
    if (!q) return { mode: 'fts', hits: [], total_matches: 0, truncated: false };

    const filters = [];
    const fargs = [];
    if (agent) { filters.push('s.agent = ?'); fargs.push(agent); }
    if (project) { filters.push('(s.project_path like ? or s.title like ?)'); fargs.push(`%${project}%`, `%${project}%`); }
    if (kinds && kinds.length) {
      filters.push(`m.kind in (${kinds.map(() => '?').join(',')})`);
      fargs.push(...kinds);
    }
    const filterSql = filters.length ? 'and ' + filters.join(' and ') : '';

    // 聚合前先取到足够多的命中消息（上限内 JS 端 group），
    // 直接 SQL group by 会丢掉「该会话第一条命中消息」的确定性行
    const rawLimit = 2000;

    if (q.length >= 3) {
      // FTS5 MATCH：把查询包成短语，避免特殊字符被当作查询语法
      const phrase = `"${q.replace(/"/g, '""')}"`;
      const sql = `
        select s.uid, s.agent, s.title, s.project_path, s.updated_at, s.source_path,
               m.seq, m.role, m.kind, m.ts, m.text
        from messages_fts f
        join messages m on m.id = f.rowid
        join sessions s on s.uid = m.uid
        where messages_fts match ? ${filterSql}
        order by s.updated_at desc, m.seq asc
        limit ?`;
      var rows = this.db.prepare(sql).all(phrase, ...fargs, rawLimit);
    } else {
      // 短查询兜底：trigram 无法处理 1-2 字符，只能全表扫描
      const sql = `
        select s.uid, s.agent, s.title, s.project_path, s.updated_at, s.source_path,
               m.seq, m.role, m.kind, m.ts, m.text
        from messages m
        join sessions s on s.uid = m.uid
        where m.text like ? ${filterSql}
        order by s.updated_at desc, m.seq asc
        limit ?`;
      var rows = this.db.prepare(sql).all(`%${q}%`, ...fargs, rawLimit);
    }

    const byUid = new Map();
    let total = 0;
    for (const r of rows) {
      total += 1;
      const cur = byUid.get(r.uid);
      if (cur) cur.match_count += 1;
      else byUid.set(r.uid, { ...r, match_count: 1 });
    }
    // rows 已按 updated_at desc 排序，Map 保持插入序即所需序
    const hits = [...byUid.values()].slice(0, limit);
    return { mode: q.length >= 3 ? 'fts' : 'like', hits, total_matches: total, truncated: rows.length >= rawLimit };
  }
}

module.exports = { IndexDb };
