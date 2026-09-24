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

// Codex Desktop 会把环境上下文写成 response_item/user「消息」，
// 这些是注入不是用户输入，进索引只会污染检索结果
const CODEX_NOISE_PREFIX = [
  '<recommended_plugins', '<environment_context', '<user_instructions', '<turn_context',
  '<permissions', '<system-reminder', '<skill ', '<identity_context', '<INSTRUCTIONS',
  '# AGENTS.md', '<AGENTS.md', '<goal', '<output_style',
];

function isCodexNoise(t) {
  const s = String(t || '').trimStart();
  return CODEX_NOISE_PREFIX.some((p) => s.startsWith(p));
}

function payloadText(payload) {
  if (!payload) return '';
  if (typeof payload.message === 'string') return payload.message;
  if (typeof payload.text === 'string') return payload.text;
  return '';
}

/** 相邻同角色同类型的碎段合并（Desktop 流式写入会把一条回复拆成多条 message）。 */
function mergeAdjacent(msgs) {
  const out = [];
  for (const m of msgs) {
    const prev = out[out.length - 1];
    if (
      prev && m.kind === prev.kind && m.role === prev.role
      && (m.kind === 'text' || m.kind === 'reasoning')
      && m.tool_name === prev.tool_name
    ) {
      prev.text = `${prev.text}\n\n${m.text}`;
      continue;
    }
    out.push(m);
  }
  return out;
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
      if (role === 'user' && isCodexNoise(text)) continue;
      out.push(makeMessage({ seq: seq++, role, kind: 'text', ts, text }));
    }
    if (!content.length) {
      const fallback = payloadText(payload);
      if (fallback && !(role === 'user' && isCodexNoise(fallback))) {
        out.push(makeMessage({ seq: seq++, role, kind: 'text', ts, text: fallback }));
      }
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
    // Codex Desktop 的会话名（thread_name）单独存在 session_index.jsonl，
    // 是标题的权威来源——没有它，Desktop 会话在列表里全是「(无标题)」认不出来
    let titles = new Map();
    try {
      const { readJsonlIndex } = require('../session-index');
      titles = readJsonlIndex(path.join(os.homedir(), '.codex', 'session_index.jsonl'), {
        idField: 'id',
        titleFields: ['thread_name'],
      });
    } catch { /* 索引缺失则退化为正文派生 */ }
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
            if (t && !isCodexNoise(t)) userTexts.push(t);
          } else if (o.type === 'response_item' && p.type === 'message' && p.role === 'user') {
            for (const b of (Array.isArray(p.content) ? p.content : [])) {
              if (b && typeof b === 'object' && b.text && !isCodexNoise(b.text)) userTexts.push(b.text);
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
        title: (titles.get(sid) && titles.get(sid).title) || title,
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
    // event_msg/token_count 的 info.total_token_usage 是会话累计值，取末次即为全量
    let totals = null;
    await eachLine(session.sourcePath, (line) => {
      const obj = tryParse(line);
      if (!obj) return;
      const ts = toMs(obj.timestamp);
      const payload = obj.payload;
      if (!payload || typeof payload !== 'object') return;

      if (obj.type === 'event_msg' && payload.type === 'token_count'
          && payload.info && payload.info.total_token_usage) {
        const u = payload.info.total_token_usage;
        totals = {
          input: u.input_tokens, output: u.output_tokens,
          cacheRead: u.cached_input_tokens, cacheWrite: u.cache_write_input_tokens,
          total: u.total_tokens,
        };
      }

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
    return { messages: mergeAdjacent(msgs), title: null, meta: totals ? { tokens: totals } : null };
  }

  originalPaths(session) {
    return [session.sourcePath];
  }

  projectDir(session) {
    return path.dirname(session.sourcePath);
  }
}

module.exports = { CodexProvider };
