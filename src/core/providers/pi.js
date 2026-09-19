'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  eachLine, tryParse, readHeadObjects, toMs, walkFiles, isDir,
} = require('../util');
const { makeSession, makeMessage } = require('../model');

/**
 * Pi agent 适配器（~/.pi/agent/sessions，实测验证）
 *
 * 布局：<cwd-slug>/<ISO时间>_<uuid>.jsonl，每行一条 JSON：
 *   { type:'session',  version, id, timestamp, cwd }
 *   { type:'model_change', provider, modelId }
 *   { type:'thinking_level_change', thinkingLevel }
 *   { type:'message',  id, parentId, timestamp, message:{
 *       role: 'user' | 'assistant' | 'toolResult' | 'bashExecution',
 *       content: [ {type:'text',text} | {type:'thinking',thinking,thinkingSignature}
 *                  | {type:'toolCall',id,name,arguments} ],
 *       usage: { input, output, cacheRead, cacheWrite, totalTokens, cost },
 *       provider, model, api, stopReason } }
 *
 * 实测块类型只有 text / thinking / toolCall 三种；toolResult 与 bashExecution
 * 是独立 role 而非 content 块。usage 逐条累加，是会话级 token 统计最全的一家。
 */

/** 把 content（字符串或块数组）拍平成纯文本 */
function blockText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b && (b.text ?? b.content)) || '').filter(Boolean).join('\n');
}

/** 单条 message 行 → 0..N 条统一消息 */
function mapPiMessage(obj, seqStart) {
  const out = [];
  let seq = seqStart;
  const m = obj.message || {};
  const ts = toMs(obj.timestamp) || toMs(m.timestamp);
  const push = (fields) => out.push(makeMessage({ seq: seq++, ts, ...fields }));

  if (m.role === 'toolResult' || m.role === 'bashExecution') {
    const text = blockText(m.content);
    push({
      role: 'tool', kind: 'tool_result', ts,
      text, toolName: m.toolName || (m.role === 'bashExecution' ? 'bash' : null), toolResult: text,
    });
    return out;
  }

  const role = m.role === 'user' ? 'user' : 'assistant';
  for (const b of (Array.isArray(m.content) ? m.content : [])) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && b.text) {
      push({ role, kind: 'text', text: b.text });
    } else if (b.type === 'thinking' && b.thinking) {
      push({ role: 'assistant', kind: 'reasoning', text: b.thinking });
    } else if (b.type === 'toolCall') {
      const args = b.arguments ?? {};
      push({
        role: 'assistant', kind: 'tool_call', ts,
        text: typeof args === 'string' ? args : JSON.stringify(args),
        toolName: b.name || null, toolInput: args,
      });
    }
    // 其它块类型（image 等）不进索引
  }
  return out;
}

class PiProvider {
  constructor() {
    this.id = 'pi';
    this.label = 'Pi';
    this.family = 'jsonl-event';
    this.root = path.join(os.homedir(), '.pi', 'agent', 'sessions');
  }

  detect() {
    if (!isDir(this.root)) {
      return { available: false, root: this.root, reason: `目录不存在：${this.root}` };
    }
    const n = walkFiles(this.root, { exts: ['.jsonl'] }).length;
    if (n === 0) return { available: false, root: this.root, reason: '未发现会话文件' };
    return { available: true, root: this.root, reason: `发现 ${n} 个会话文件` };
  }

  async discover() {
    const files = walkFiles(this.root, { exts: ['.jsonl'] });
    const sessions = [];
    for (const file of files) {
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (st.size === 0) continue;

      let sid = null;
      let cwd = null;
      let firstTs = null;
      let model = null;
      let provider = null;
      let title = null;
      try {
        const head = await readHeadObjects(file, 12);
        const userTexts = [];
        for (const o of head) {
          if (!firstTs) firstTs = toMs(o.timestamp);
          if (o.type === 'session') { sid = o.id || sid; cwd = o.cwd || cwd; }
          if (o.type === 'model_change') { model = o.modelId || model; provider = o.provider || provider; }
          const m = o.message;
          if (m && m.role === 'user') {
            const t = blockText(m.content);
            if (t) userTexts.push(t);
          }
        }
        if (userTexts.length) {
          const { deriveTitle } = require('../model');
          title = deriveTitle(userTexts.map((t) => ({ role: 'user', kind: 'text', text: t })));
        }
      } catch { /* 退化：仅 stat 信息 */ }

      if (!sid) {
        // 文件名形如 2026-07-25T12-13-02-729Z_<uuid>.jsonl
        sid = (path.basename(file, '.jsonl').match(/([0-9a-f-]{36})$/i) || [null, path.basename(file, '.jsonl')])[1];
      }

      sessions.push(makeSession({
        uid: `${this.id}:${sid}`,
        agent: this.id,
        sessionId: sid,
        projectPath: cwd || null,
        pathSource: cwd ? 'content' : 'slug',
        title,
        createdAt: firstTs || st.mtimeMs,
        updatedAt: st.mtimeMs,
        bytes: st.size,
        sourcePath: file,
        meta: { model, provider, slug: path.basename(path.dirname(file)) },
      }));
    }
    return sessions;
  }

  async parse(session) {
    const msgs = [];
    let seq = 0;
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, costUsd: 0 };
    let model = null;
    let provider = null;
    const n = (v) => (Number.isFinite(v) ? v : 0);

    await eachLine(session.sourcePath, (line) => {
      const obj = tryParse(line);
      if (!obj) return;
      if (obj.type === 'model_change') {
        model = obj.modelId || model;
        provider = obj.provider || provider;
        return;
      }
      const m = obj.message;
      if (!m || typeof m !== 'object') return;

      const produced = mapPiMessage(obj, seq);
      if (produced.length) {
        seq = produced[produced.length - 1].seq + 1;
        for (const x of produced) msgs.push(x);
      }
      if (m.usage && typeof m.usage === 'object') {
        const u = m.usage;
        tokens.input += n(u.input);
        tokens.output += n(u.output);
        tokens.cacheRead += n(u.cacheRead);
        tokens.cacheWrite += n(u.cacheWrite);
        tokens.total += n(u.totalTokens);
        const c = u.cost;
        if (c && typeof c === 'object') {
          tokens.costUsd += Number.isFinite(c.total) ? c.total : n(c.input) + n(c.output);
        }
      }
    });

    const meta = { tokens };
    if (model) meta.model = model;
    if (provider) meta.provider = provider;
    return { messages: msgs, title: null, meta };
  }

  originalPaths(session) {
    return [session.sourcePath];
  }

  projectDir(session) {
    return path.dirname(session.sourcePath);
  }
}

module.exports = { PiProvider, mapPiMessage, blockText };
