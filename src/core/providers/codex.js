'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  eachLine, tryParse, readHeadObjects, toMs, walkFiles, isDir,
} = require('../util');
const { makeSession, makeMessage, deriveTitle } = require('../model');

/**
 * OpenAI Codex CLI 适配器
 *
 * 实测布局：~/.codex/sessions/<年>/<月>/<日>/rollout-<ISO时间>-<uuid>.jsonl
 * 每行结构：{ timestamp, type, payload }
 *   type = session_meta     → payload.{id, cwd, cli_version, originator, instructions}
 *   type = response_item    → payload.type = message | reasoning | function_call |
 *                             function_call_output | local_shell_call
 *   type = event_msg        → payload.type = user_message | agent_message | token_count |
 *                             task_started | task_complete
 *   type = turn_context     → 每轮上下文（含 cwd / model）
 *
 * 注意：session_meta 里带完整 AGENTS.md 指令，属于噪声，不索引进正文。
 */

const SKIP_RESPONSE_TYPES = new Set(['reasoning_summary']);

function payloadText(payload) {
  if (!payload) return '';
  if (typeof payload.message === 'string') return payload.message;
  if (typeof payload.text === 'string') return payload.text;
  return '';
}

function mapResponseItem(payload, ts, seqStart) {
  const out = [];
  let seq = seqStart;
  const t = payload.type;

  if (t === 'message') {
    const role = payload.role === 'user' ? 'user'
      : payload.role === 'assistant' ? 'assistant' : 'system';
    const content = Array.isArray(payload.content) ? payload.content : [];
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      const text = b.text ?? b.input_text ?? b.output_text ?? '';
      if (!text) continue;
      out.push(makeMessage({ seq: seq++, role, kind: 'text', ts, text }));
    }
    if (!content.length) {
      const fallback = payloadText(payload);
      if (fallback) out.push(makeMessage({ seq: seq++, role, kind: 'text', ts, text: fallback }));
    }
    return out;
  }

  if (t === 'reasoning') {
    const txt = Array.isArray(payload.summary)
      ? payload.summary.map((s) => (typeof s === 'string' ? s : s?.text ?? '')).join('\n')
      : payloadText(payload);
    if (txt) out.push(makeMessage({ seq: seq++, role: 'assistant', kind: 'reasoning', ts, text: txt }));
    return out;
  }

  if (t === 'function_call' || t === 'local_shell_call' || t === 'custom_tool_call') {
    const args = payload.arguments ?? payload.action ?? payload.input ?? '';
    out.push(makeMessage({
      seq: seq++, role: 'assistant', kind: 'tool_call', ts,
      text: typeof args === 'string' ? args : JSON.stringify(args),
      toolName: payload.name ?? t, toolInput: args,
    }));
    return out;
  }

  if (t === 'function_call_output' || t === 'custom_tool_call_output') {
    const o = payload.output;
    const text = typeof o === 'string' ? o : (o ? JSON.stringify(o) : '');
    out.push(makeMessage({
      seq: seq++, role: 'tool', kind: 'tool_result', ts,
      text, toolName: payload.name ?? t, toolResult: text,
    }));
    return out;
  }

  if (SKIP_RESPONSE_TYPES.has(t)) return out;
  return out;
}

class CodexProvider {
  constructor() {
    this.id = 'codex';
    this.label = 'Codex CLI';
    this.family = 'jsonl-event';
    this.root = path.join(os.homedir(), '.codex', 'sessions');
  }

  detect() {
    if (!isDir(this.root)) {
      return { available: false, root: this.root, reason: `目录不存在：${this.root}` };
    }
    const n = walkFiles(this.root, { exts: ['.jsonl'] }).length;
    if (n === 0) return { available: false, root: this.root, reason: '未发现 rollout 会话文件' };
    return { available: true, root: this.root, reason: `发现 ${n} 个 rollout 文件` };
  }

  async discover() {
    const files = walkFiles(this.root, { exts: ['.jsonl'] });
    const sessions = [];
    for (const file of files) {
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (st.size === 0) continue;

      let meta = null;
      let firstTs = null;
      let title = null;
      try {
        const head = await readHeadObjects(file, 40);
        const userTexts = [];
        for (const o of head) {
          if (!firstTs) firstTs = toMs(o.timestamp);
          if (o.type === 'session_meta' && o.payload) { meta = o.payload; continue; }
          // Codex 无标题字段，标题只能由用户实际输入派生。
          // 真实输入走 event_msg/user_message；response_item/message 里多为 AGENTS.md 注入噪声。
          const p = o.payload;
          if (!p || typeof p !== 'object') continue;
          if (o.type === 'event_msg' && p.type === 'user_message') {
            const t = payloadText(p);
            if (t) userTexts.push(t);
          } else if (o.type === 'response_item' && p.type === 'message' && p.role === 'user') {
            for (const b of (Array.isArray(p.content) ? p.content : [])) {
              if (b && typeof b === 'object' && b.text) userTexts.push(b.text);
            }
          }
        }
        if (userTexts.length) title = deriveTitle(userTexts.map((t) => ({ role: 'user', kind: 'text', text: t })));
      } catch { /* 退化 */ }

      // 文件名形如 rollout-2026-04-27T10-10-34-<uuid>.jsonl
      const base = path.basename(file, '.jsonl');
      const sid = (meta && meta.id) || (base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i) || [])[1] || base;

      sessions.push(makeSession({
        uid: `${this.id}:${sid}`,
        agent: this.id,
        sessionId: sid,
        projectPath: (meta && meta.cwd) || null,
        pathSource: meta && meta.cwd ? 'content' : 'unknown',
        title,
        createdAt: toMs(meta && meta.timestamp) || firstTs || st.mtimeMs,
        updatedAt: st.mtimeMs,
        bytes: st.size,
        sourcePath: file,
        meta: { cliVersion: (meta && meta.cli_version) || null, originator: (meta && meta.originator) || null },
      }));
    }
    return sessions;
  }

  async parse(session) {
    const msgs = [];
    let seq = 0;
    await eachLine(session.sourcePath, (line) => {
      const obj = tryParse(line);
      if (!obj) return;
      const ts = toMs(obj.timestamp);
      const payload = obj.payload;
      if (!payload || typeof payload !== 'object') return;

      let produced = [];
      if (obj.type === 'response_item') {
        produced = mapResponseItem(payload, ts, seq);
      } else if (obj.type === 'event_msg') {
        if (payload.type === 'user_message' || payload.type === 'agent_message') {
          const text = payloadText(payload);
          if (text) {
            produced = [makeMessage({
              seq, role: payload.type === 'user_message' ? 'user' : 'assistant',
              kind: 'text', ts, text,
            })];
          }
        }
      }
      for (const m of produced) msgs.push(m);
      if (produced.length) seq = produced[produced.length - 1].seq + 1;
    });
    return { messages: msgs, title: null };
  }

  originalPaths(session) {
    return [session.sourcePath];
  }

  projectDir(session) {
    return path.dirname(session.sourcePath);
  }
}

module.exports = { CodexProvider };
