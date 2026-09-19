'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  eachLine, tryParse, readHeadObjects, readTailObjects, toMs, decodeSlug, walkFiles, exists, isDir,
} = require('../util');
const { makeSession, makeMessage, deriveTitle } = require('../model');

/**
 * jsonl-project 家族适配器
 *
 * 覆盖三家实测同构的 Agent：
 *   - WorkBuddy    ~/.workbuddy/projects/<项目slug>/<会话id>.jsonl
 *   - Claude Code  ~/.claude/projects/<项目slug>/<会话id>.jsonl
 *                  ~/.claude/projects/<项目slug>/<会话id>/subagents/agent-*.jsonl
 *   - QwenWorkCN   ~/.qwenworkcn/projects/<项目slug>/<会话id>.jsonl
 *
 * 两处方言差异用「按形状识别」而非分支硬编码解决（见 extractBlocks / classify），
 * 这样新增同族 Agent 只需加一条配置，不用改解析逻辑：
 *   - WorkBuddy : 顶层 content[] / rawContent[]，行 type = message|reasoning|function_call|
 *                 function_call_result|ai-title|file-history-snapshot
 *   - Claude 系 : message.content[]，行 type = user|assistant|system|attachment|ai-title|...
 *
 * 不接收的参数一律不猜：项目路径优先取会话内容自带 cwd，
 * 取不到才退回 decodeSlug（该编码不可逆，会用 pathSource 标记可信度）。
 */

/** 行类型 → 语义分类。未识别的返回 null，由调用方按元数据行处理 */
function classify(obj) {
  switch (obj.type) {
    case 'message': // WorkBuddy 顶层消息
      return { role: obj.role === 'user' ? 'user' : 'assistant', kind: 'text' };
    case 'reasoning':
      return { role: 'assistant', kind: 'reasoning' };
    case 'function_call':
      return { role: 'assistant', kind: 'tool_call' };
    case 'function_call_result':
      return { role: 'tool', kind: 'tool_result' };
    case 'user': // Claude 系
      return { role: 'user', kind: 'text' };
    case 'assistant':
      return { role: 'assistant', kind: 'text' };
    case 'system':
      return { role: 'system', kind: 'meta' };
    default:
      return null;
  }
}

/** 收集一条记录里所有可能承载内容的块，兼容三种嵌套位置 */
function extractBlocks(obj) {
  const blocks = [];
  const take = (arr) => {
    if (Array.isArray(arr)) {
      for (const b of arr) if (b && typeof b === 'object') blocks.push(b);
    }
  };
  take(obj.content);           // WorkBuddy 顶层
  take(obj.rawContent);        // WorkBuddy reasoning
  if (obj.message && Array.isArray(obj.message.content)) take(obj.message.content); // Claude 系
  return blocks;
}

/** 把一条原始记录展开成 1..N 条统一消息 */
function mapLine(obj, startSeq) {
  const cls = classify(obj);
  const ts = toMs(obj.timestamp);
  const out = [];
  let seq = startSeq;

  if (!cls) return out;

  // 工具调用 / 结果在 WorkBuddy 里是独立行类型
  if (cls.kind === 'tool_call') {
    out.push(makeMessage({
      seq: seq++, role: 'assistant', kind: 'tool_call', ts,
      text: typeof obj.arguments === 'string' ? obj.arguments : JSON.stringify(obj.arguments ?? ''),
      toolName: obj.name ?? null, toolInput: obj.arguments ?? null,
    }));
    return out;
  }
  if (cls.kind === 'tool_result') {
    const text = obj.output && typeof obj.output === 'object'
      ? (obj.output.text ?? JSON.stringify(obj.output))
      : (typeof obj.output === 'string' ? obj.output : '');
    out.push(makeMessage({
      seq: seq++, role: 'tool', kind: 'tool_result', ts,
      text, toolName: obj.name ?? null, toolResult: text,
    }));
    return out;
  }

  const blocks = extractBlocks(obj);

  // Claude 系的 user 消息 content 可能是纯字符串
  if (blocks.length === 0 && obj.message && typeof obj.message.content === 'string') {
    out.push(makeMessage({ seq: seq++, role: cls.role, kind: cls.kind, ts, text: obj.message.content }));
    return out;
  }
  // 无内容块时（如 system 行），不产出消息，避免污染索引
  if (blocks.length === 0) return out;

  for (const b of blocks) {
    const bt = b.type;
    if (bt === 'input_text' || bt === 'output_text' || bt === 'text') {
      out.push(makeMessage({ seq: seq++, role: cls.role, kind: 'text', ts, text: b.text ?? '' }));
    } else if (bt === 'thinking' || bt === 'reasoning_text' || bt === 'reasoning') {
      out.push(makeMessage({ seq: seq++, role: 'assistant', kind: 'reasoning', ts, text: b.thinking ?? b.text ?? '' }));
    } else if (bt === 'tool_use') {
      const input = b.input ?? {};
      out.push(makeMessage({
        seq: seq++, role: 'assistant', kind: 'tool_call', ts,
        text: typeof input === 'string' ? input : JSON.stringify(input),
        toolName: b.name ?? null, toolInput: input,
      }));
    } else if (bt === 'tool_result') {
      const c = b.content;
      const text = typeof c === 'string' ? c
        : Array.isArray(c) ? c.map((x) => (x && (x.text ?? x.content)) || '').join('\n')
          : (c ? JSON.stringify(c) : '');
      out.push(makeMessage({
        seq: seq++, role: 'tool', kind: 'tool_result', ts,
        text, toolName: b.tool_use_id ? null : (b.name ?? null), toolResult: text,
      }));
    }
    // image 等其它块类型直接跳过，不进索引
  }
  return out;
}

/** 从非消息行里抽取有价值的元数据 */
function metaLine(obj, acc) {
  switch (obj.type) {
    case 'ai-title':
      if (obj.aiTitle) acc.title = obj.aiTitle;
      break;
    case 'agent-name':
      if (obj.agentName) acc.meta.agentName = obj.agentName;
      break;
    case 'runtime-config':
      if (obj.model) acc.meta.model = obj.model;
      break;
    case 'last-prompt':
      // Qwen Work 的会话末尾会记最后一次用户输入，是很好的标题兜底
      if (obj.lastPrompt && !acc.lastPrompt) acc.lastPrompt = String(obj.lastPrompt);
      break;
    case 'workspace-directories':
      if (Array.isArray(obj.directories) && obj.directories.length && !acc.projectPath) {
        acc.projectPath = obj.directories[0];
        acc.pathSource = 'content';
      }
      break;
    case 'permission-mode':
      if (obj.permissionMode) acc.meta.permissionMode = obj.permissionMode;
      break;
    default:
      break;
  }
}

/** 从任意一条记录里补齐会话级元数据 */
function harvest(obj, acc) {
  if (!acc.cwd && typeof obj.cwd === 'string' && obj.cwd) {
    acc.cwd = obj.cwd;
  }
  if (!acc.sessionId && (obj.sessionId || obj.session_id)) {
    acc.sessionId = obj.sessionId || obj.session_id;
  }
  if (!acc.ts) acc.ts = toMs(obj.timestamp);
  if (!acc.meta.version && obj.version) acc.meta.version = obj.version;
  if (!acc.meta.gitBranch && obj.gitBranch) acc.meta.gitBranch = obj.gitBranch;
  const m = obj.message;
  if (m && typeof m === 'object' && m.model && !acc.meta.model) acc.meta.model = m.model;
  const pd = obj.providerData;
  if (pd && typeof pd === 'object' && pd.model && !acc.meta.model) acc.meta.model = pd.model;
  if (typeof obj.model === 'string' && !acc.meta.model) acc.meta.model = obj.model;

  // 记下第一条用户正文，作为最终兜底的标题来源。
  // 注意：Claude 系的 message.content 可能是纯字符串而非块数组，两条路径都要覆盖
  if (acc.firstUserText === undefined) {
    const cls = classify(obj);
    if (cls && cls.role === 'user') {
      const blocks = extractBlocks(obj);
      const t = blocks.find((b) => b.type === 'input_text' || b.type === 'text');
      if (t && t.text) {
        acc.firstUserText = t.text;
      } else if (obj.message && typeof obj.message.content === 'string' && obj.message.content) {
        acc.firstUserText = obj.message.content;
      }
    }
  }

  metaLine(obj, acc);
}

class JsonlProjectProvider {
  /**
   * @param {object} cfg
   * @param {string} cfg.id            provider id，如 "claude-code"
   * @param {string} cfg.label         展示名
   * @param {string} cfg.root          数据根目录，支持 ~ 前缀
   * @param {boolean} [cfg.subagents]  是否把 <会话id>/subagents/*.jsonl 也作为会话
   * @param {object} [cfg.titleIndex]  外部索引作为标题的权威来源
   *        { kind:'sqlite', db, table, idCol, titleCols, modelCol }
   *        { kind:'jsonl',  file, idField, titleFields }
   */
  constructor(cfg) {
    this.id = cfg.id;
    this.label = cfg.label;
    this.family = 'jsonl-project';
    this.root = cfg.root.startsWith('~')
      ? path.join(os.homedir(), cfg.root.slice(1))
      : cfg.root;
    this.withSubagents = Boolean(cfg.subagents);
    this.titleIndexCfg = cfg.titleIndex || null;
    this._titleIndex = null;
  }

  /** 懒加载外部标题索引，失败不抛错（标题降级为空即可，不应阻断扫描） */
  _titles() {
    if (this._titleIndex) return this._titleIndex;
    const cfg = this.titleIndexCfg;
    if (!cfg) { this._titleIndex = new Map(); return this._titleIndex; }
    try {
      const { readSqliteIndex, readJsonlIndex } = require('../session-index');
      this._titleIndex = cfg.kind === 'sqlite'
        ? readSqliteIndex(cfg.db, cfg)
        : readJsonlIndex(cfg.file, cfg);
    } catch {
      this._titleIndex = new Map();
    }
    return this._titleIndex;
  }

  detect() {
    if (!isDir(this.root)) {
      return { available: false, root: this.root, reason: `目录不存在：${this.root}` };
    }
    const projects = fs.readdirSync(this.root).length;
    if (projects === 0) {
      return { available: false, root: this.root, reason: '数据目录为空（该 Agent 未产生会话）' };
    }
    return { available: true, root: this.root, reason: `发现 ${projects} 个项目目录` };
  }

  /** 收集待扫描的 (文件, 原生会话 id) 列表 */
  _files() {
    const out = [];
    for (const projEntry of require('../util').listDir(this.root)) {
      if (!projEntry.isDirectory()) continue;
      const projDir = path.join(this.root, projEntry.name);
      let entries;
      try { entries = fs.readdirSync(projDir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (e.isFile() && e.name.endsWith('.jsonl')) {
          out.push({ file: path.join(projDir, e.name), slug: projEntry.name, sid: e.name.replace(/\.jsonl$/, '') });
        } else if (e.isDirectory() && this.withSubagents) {
          const sid = e.name;
          const subDir = path.join(projDir, sid, 'subagents');
          if (!isDir(subDir)) continue;
          for (const f of walkFiles(subDir, { exts: ['.jsonl'], maxDepth: 2 })) {
            const base = path.basename(f).replace(/\.jsonl$/, '');
            out.push({ file: f, slug: projEntry.name, sid: `${sid}:${base}` });
          }
        }
      }
    }
    return out;
  }

  /**
   * 廉价扫描：只读文件头 + 尾部，不做全量解析。
   * 全量解析交给 parse()，由 index 流程按需调用。
   */
  async discover() {
    const files = this._files();
    const titles = this._titles();
    const sessions = [];
    for (const { file, slug, sid } of files) {
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (st.size === 0) continue;

      const acc = {
        cwd: null, sessionId: sid, ts: null, title: null, lastPrompt: null,
        projectPath: null, pathSource: 'unknown', meta: {}, firstUserText: undefined,
      };
      try {
        const head = await readHeadObjects(file, 40);
        for (const o of head) harvest(o, acc);
        if (!acc.title) {
          for (const o of readTailObjects(file, 8)) {
            harvest(o, acc);
            if (acc.title) break;
          }
        }
      } catch { /* 读取失败则退化为仅有 stat 信息 */ }

      let projectPath = acc.cwd || acc.projectPath;
      let pathSource = acc.cwd ? 'content' : acc.pathSource;
      if (!projectPath) {
        projectPath = decodeSlug(slug);
        pathSource = 'slug';
      }

      // 标题优先级：外部索引（权威） > 正文 ai-title > 末次输入 > 首条用户消息派生
      const idx = titles.get(sid);
      let title = (idx && idx.title) || acc.title || null;
      if (!title && acc.lastPrompt) title = acc.lastPrompt.replace(/\s+/g, ' ').slice(0, 80);
      if (!title && acc.firstUserText) {
        title = deriveTitle([{ role: 'user', kind: 'text', text: acc.firstUserText }]);
      }
      const meta = { ...acc.meta, slug };
      if (idx && idx.model && !meta.model) meta.model = idx.model;

      sessions.push(makeSession({
        uid: `${this.id}:${sid}`,
        agent: this.id,
        sessionId: sid,
        projectPath,
        pathSource,
        title,
        createdAt: acc.ts,
        updatedAt: st.mtimeMs,
        bytes: st.size,
        sourcePath: file,
        meta,
      }));
    }
    return sessions;
  }

  /** 全量解析正文。流式读取，脏尾行跳过，单行超大不炸 */
  async parse(session) {
    const msgs = [];
    let seq = 0;
    let derived = null;
    await eachLine(session.sourcePath, (line) => {
      const obj = tryParse(line);
      if (!obj) return; // 脏尾行/截断行：跳过，不中断整个会话
      const produced = mapLine(obj, seq);
      if (produced.length) {
        seq = produced[produced.length - 1].seq + 1;
        for (const m of produced) msgs.push(m);
      }
      if (obj.type === 'ai-title' && obj.aiTitle) derived = obj.aiTitle;
    });
    return { messages: msgs, title: derived };
  }

  /** 备份时需要原样打包的路径 */
  originalPaths(session) {
    const paths = [session.sourcePath];
    const subDir = session.sourcePath.replace(/\.jsonl$/, '');
    if (isDir(subDir)) paths.push(subDir); // Claude 的 <会话id>/ 附带文件
    return paths.filter(exists);
  }

  /** 会话归属的项目分片目录，用于按项目整体备份 */
  projectDir(session) {
    return path.dirname(session.sourcePath);
  }
}

module.exports = { JsonlProjectProvider, mapLine, classify, deriveTitle };
