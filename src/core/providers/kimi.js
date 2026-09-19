'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  eachLine, tryParse, readHeadObjects, toMs, listDir, walkFiles, isDir,
} = require('../util');
const { makeSession, makeMessage, deriveTitle } = require('../model');

/* ------------------------------------------------------------------ *
 * Kimi CLI —— 协议 1.1（较老的 wire 协议）
 * 布局：~/.kimi/sessions/<工作区hash>/<会话uuid>/wire.jsonl
 * 行结构：{ timestamp(秒浮点), message: { type, payload } }
 *   TurnBegin      → payload.user_input[] = [{type:'text', text}]
 *   StepBegin      → payload.n           （进度标记，不索引）
 *   StepInterrupted→ payload             （中断标记，不索引）
 *
 * 说明：本机该协议的样本量很小（3 个会话且均被中断），
 * 因此解析器对未识别类型采用通用兜底提取，而不是硬编码白名单。
 * ------------------------------------------------------------------ */

function extractKimiText(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (Array.isArray(payload.user_input)) {
    return payload.user_input
      .map((b) => (b && (b.text ?? b.content)) || '')
      .filter(Boolean).join('\n');
  }
  for (const k of ['text', 'content', 'message', 'output']) {
    const v = payload[k];
    if (typeof v === 'string' && v) return v;
    if (Array.isArray(v)) {
      const s = v.map((b) => (b && (b.text ?? b.content)) || '').filter(Boolean).join('\n');
      if (s) return s;
    }
  }
  return '';
}

class KimiCliProvider {
  constructor() {
    this.id = 'kimi-cli';
    this.label = 'Kimi CLI';
    this.family = 'jsonl-wire';
    this.root = path.join(os.homedir(), '.kimi', 'sessions');
  }

  detect() {
    if (!isDir(this.root)) {
      return { available: false, root: this.root, reason: `目录不存在：${this.root}` };
    }
    const n = walkFiles(this.root, { exts: ['wire.jsonl'] }).length;
    if (n === 0) return { available: false, root: this.root, reason: '未发现 wire.jsonl 会话文件' };
    return { available: true, root: this.root, reason: `发现 ${n} 个会话` };
  }

  async discover() {
    const sessions = [];
    for (const wsEntry of listDir(this.root)) {
      if (!wsEntry.isDirectory()) continue;
      const wsDir = path.join(this.root, wsEntry.name);
      for (const sEntry of listDir(wsDir)) {
        if (!sEntry.isDirectory()) continue;
        const sessDir = path.join(wsDir, sEntry.name);
        // 有的会话只有空的 context.jsonl（打开后即中断），仍如实登记，
        // 这样 `asv list` 的会话数与磁盘事实一致，而不是静默丢弃
        const wire = path.join(sessDir, 'wire.jsonl');
        const ctx = path.join(sessDir, 'context.jsonl');
        const target = fs.existsSync(wire) ? wire : (fs.existsSync(ctx) ? ctx : null);
        if (!target) continue;
        let st;
        try { st = fs.statSync(target); } catch { continue; }

        let firstTs = null;
        let cwd = null;
        let title = null;
        try {
          // 该协议的 wire.jsonl 很小，头部读若干行即可
          const head = await readHeadObjects(target, 12);
          const userTexts = [];
          for (const o of head) {
            if (!firstTs) firstTs = toMs(o.timestamp);
            const m = o.message;
            const p = m && m.payload;
            if (p && typeof p.cwd === 'string') cwd = p.cwd;
            // TurnBegin 里的 user_input 是唯一可靠的用户输入来源，用作标题
            if (m && m.type === 'TurnBegin') {
              const t = extractKimiText(p);
              if (t) userTexts.push(t);
            }
          }
          if (userTexts.length) title = deriveTitle(userTexts.map((t) => ({ role: 'user', kind: 'text', text: t })));
        } catch { /* 退化 */ }

        sessions.push(makeSession({
          uid: `${this.id}:${sEntry.name}`,
          agent: this.id,
          sessionId: sEntry.name,
          projectPath: cwd,
          pathSource: cwd ? 'content' : 'unknown',
          title,
          createdAt: firstTs || st.mtimeMs,
          updatedAt: st.mtimeMs,
          bytes: st.size,
          sourcePath: target,
          meta: { workspace: wsEntry.name, empty: st.size === 0 },
        }));
      }
    }
    return sessions;
  }

  async parse(session) {
    const msgs = [];
    let seq = 0;
    await eachLine(session.sourcePath, (line) => {
      const obj = tryParse(line);
      if (!obj) return;
      const m = obj.message;
      if (!m || typeof m !== 'object') return; // metadata 行
      const ts = toMs(obj.timestamp) || toMs(m.timestamp);
      const t = m.type;

      if (t === 'TurnBegin') {
        const text = extractKimiText(m.payload);
        if (text) msgs.push(makeMessage({ seq: seq++, role: 'user', kind: 'text', ts, text }));
        return;
      }
      if (t === 'StepBegin' || t === 'StepInterrupted' || t === 'TurnEnd') return;

      // 通用兜底：未识别的类型只要有文本就当助手输出，避免漏内容
      const text = extractKimiText(m.payload);
      if (text) msgs.push(makeMessage({ seq: seq++, role: 'assistant', kind: 'text', ts, text }));
    });
    return { messages: msgs, title: null };
  }

  originalPaths(session) {
    // 一个会话目录下除 wire.jsonl 外还有 context.jsonl 等，整体打包更稳妥
    return [path.dirname(session.sourcePath)];
  }

  projectDir(session) {
    return path.dirname(session.sourcePath);
  }
}

/* ------------------------------------------------------------------ *
 * Kimi Code —— 协议 1.3（与 Kimi CLI 完全不同，不能共用解析器）
 * 布局：~/.kimi-code/sessions/wd_<id>/session_<uuid>/agents/main/wire.jsonl
 * 时间字段为 time（毫秒）
 *   metadata / config.update / tools.set_active_tools / usage.record  → 元数据
 *   turn.prompt          → input[] 用户输入
 *   context.append_message → message.{role, content[], toolCalls[]}
 *   context.append_loop_event → event.type:
 *        content.part → part.{type:'think'|'text', think/text}
 *        tool.call    → name, args, toolCallId
 *        tool.result  → result.output
 *        step.begin / step.end → 进度标记
 * ------------------------------------------------------------------ */

class KimiCodeProvider {
  constructor() {
    this.id = 'kimi-code';
    this.label = 'Kimi Code';
    this.family = 'jsonl-wire';
    this.root = path.join(os.homedir(), '.kimi-code', 'sessions');
  }

  detect() {
    if (!isDir(this.root)) {
      return { available: false, root: this.root, reason: `目录不存在：${this.root}` };
    }
    const n = walkFiles(this.root, { exts: ['wire.jsonl'] }).length;
    if (n === 0) return { available: false, root: this.root, reason: '未发现 wire.jsonl 会话文件' };
    return { available: true, root: this.root, reason: `发现 ${n} 个会话` };
  }

  async discover() {
    const sessions = [];
    for (const wdEntry of listDir(this.root)) {
      if (!wdEntry.isDirectory()) continue;
      const wdDir = path.join(this.root, wdEntry.name);
      for (const sEntry of listDir(wdDir)) {
        if (!sEntry.isDirectory()) continue;
        const sessDir = path.join(wdDir, sEntry.name);
        const wire = path.join(sessDir, 'agents', 'main', 'wire.jsonl');
        let st;
        try { st = fs.statSync(wire); } catch { continue; }

        let firstTs = null;
        let model = null;
        let cwd = null;
        let title = null;
        try {
          const head = await readHeadObjects(wire, 20);
          const userTexts = [];
          for (const o of head) {
            if (!firstTs) firstTs = toMs(o.created_at) || toMs(o.time);
            if (o.type === 'config.update' && o.modelAlias) model = o.modelAlias;
            // turn.prompt 是该协议唯一的用户输入来源
            if (o.type === 'turn.prompt' && Array.isArray(o.input)) {
              const t = o.input.map((b) => (b && b.text) || '').filter(Boolean).join('\n');
              if (t) userTexts.push(t);
            }
            const p = o.message && o.message.payload;
            if (p && typeof p.cwd === 'string') cwd = p.cwd;
          }
          if (userTexts.length) title = deriveTitle(userTexts.map((t) => ({ role: 'user', kind: 'text', text: t })));
          // state.json 里通常带工作目录，优先采信
          const stateFile = path.join(sessDir, 'state.json');
          if (fs.existsSync(stateFile)) {
            try {
              const stj = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
              const cand = stj.cwd || stj.workspace || stj.directory;
              if (typeof cand === 'string' && cand) cwd = cand;
              if (!model && stj.model) model = stj.model;
            } catch { /* 忽略损坏的 state.json */ }
          }
        } catch { /* 退化 */ }

        sessions.push(makeSession({
          uid: `${this.id}:${sEntry.name}`,
          agent: this.id,
          sessionId: sEntry.name,
          projectPath: cwd,
          pathSource: cwd ? 'content' : 'unknown',
          title,
          createdAt: firstTs || st.mtimeMs,
          updatedAt: st.mtimeMs,
          bytes: st.size,
          sourcePath: wire,
          meta: { workspace: wdEntry.name, model },
        }));
      }
    }
    return sessions;
  }

  async parse(session) {
    const msgs = [];
    let seq = 0;
    await eachLine(session.sourcePath, (line) => {
      const obj = tryParse(line);
      if (!obj) return;
      const ts = toMs(obj.time) || toMs(obj.created_at);
      const push = (f) => msgs.push(makeMessage({ seq: seq++, ts, ...f }));

      switch (obj.type) {
        case 'turn.prompt': {
          const text = (Array.isArray(obj.input) ? obj.input : [])
            .map((b) => (b && b.text) || '').filter(Boolean).join('\n');
          if (text) push({ role: 'user', kind: 'text', text });
          break;
        }
        case 'context.append_message': {
          const m = obj.message || {};
          const role = m.role === 'user' ? 'user' : 'assistant';
          for (const b of (Array.isArray(m.content) ? m.content : [])) {
            if (b && b.type === 'text' && b.text) push({ role, kind: 'text', text: b.text });
          }
          for (const tc of (Array.isArray(m.toolCalls) ? m.toolCalls : [])) {
            const args = tc && tc.function ? tc.function.arguments : (tc && tc.args);
            push({
              role: 'assistant', kind: 'tool_call',
              text: typeof args === 'string' ? args : JSON.stringify(args ?? ''),
              toolName: (tc && (tc.name || (tc.function && tc.function.name))) || null,
              toolInput: args ?? null,
            });
          }
          break;
        }
        case 'context.append_loop_event': {
          const ev = obj.event || {};
          if (ev.type === 'content.part' && ev.part) {
            const part = ev.part;
            if (part.type === 'think' && part.think) push({ role: 'assistant', kind: 'reasoning', text: part.think });
            else if (part.type === 'text' && part.text) push({ role: 'assistant', kind: 'text', text: part.text });
          } else if (ev.type === 'tool.call') {
            const args = ev.args;
            push({
              role: 'assistant', kind: 'tool_call',
              text: typeof args === 'string' ? args : JSON.stringify(args ?? ''),
              toolName: ev.name || null, toolInput: args ?? null,
            });
          } else if (ev.type === 'tool.result') {
            const o = ev.result && ev.result.output;
            const text = typeof o === 'string' ? o : (o ? JSON.stringify(o) : '');
            if (text) push({ role: 'tool', kind: 'tool_result', text, toolResult: text });
          }
          break;
        }
        default:
          break; // metadata / config.update / usage.record / tools.* 等不进正文
      }
    });
    return { messages: msgs, title: null };
  }

  originalPaths(session) {
    return [path.dirname(path.dirname(path.dirname(session.sourcePath)))]; // session_<uuid>/ 整个目录
  }

  projectDir(session) {
    return path.dirname(session.sourcePath);
  }
}

module.exports = { KimiCliProvider, KimiCodeProvider };
