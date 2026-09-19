'use strict';

/**
 * 统一会话模型
 *
 * 所有适配器最终都归一到这两个结构，上层（索引、检索、导出、备份、迁移）
 * 只认这个模型，不认任何一家的原生格式。
 *
 * SessionMeta = {
 *   uid:          string   全局唯一，形如 "workbuddy:086a7b28-..."
 *   agent:        string   provider id，如 "claude-code"
 *   sessionId:    string   原生会话 id
 *   projectPath:  string|null  归属工作目录（优先取自会话内容自带 cwd）
 *   pathSource:   "content"|"slug"|"db"|"unknown"  项目路径的可信来源
 *   title:        string|null
 *   createdAt:    number|null  毫秒
 *   updatedAt:    number|null  毫秒
 *   bytes:        number
 *   sourcePath:   string|null  文件型来源
 *   sourceDb:     string|null  SQLite 型来源
 *   meta:         object   原生字段兜底（model/mode/version 等）
 * }
 *
 * Message = {
 *   seq:        number
 *   role:       "user"|"assistant"|"system"|"tool"|"meta"
 *   kind:       "text"|"reasoning"|"tool_call"|"tool_result"|"meta"
 *   ts:         number|null
 *   text:       string      可检索正文（reasoning 也放这里）
 *   toolName:   string|null
 *   toolInput:  any
 *   toolResult: string|null
 *   truncated:  boolean     单条正文是否被截断
 * }
 */

const MAX_TEXT = 200 * 1024; // 单条正文上限，防止一条几 MB 的正文撑爆索引

function makeSession(fields) {
  return {
    uid: fields.uid,
    agent: fields.agent,
    sessionId: fields.sessionId,
    projectPath: fields.projectPath ?? null,
    pathSource: fields.pathSource ?? 'unknown',
    title: fields.title ?? null,
    createdAt: fields.createdAt ?? null,
    updatedAt: fields.updatedAt ?? null,
    bytes: fields.bytes ?? 0,
    sourcePath: fields.sourcePath ?? null,
    sourceDb: fields.sourceDb ?? null,
    meta: fields.meta ?? {},
  };
}

function makeMessage(fields) {
  let text = fields.text ?? '';
  let truncated = false;
  if (typeof text !== 'string') text = String(text);
  if (text.length > MAX_TEXT) {
    text = text.slice(0, MAX_TEXT);
    truncated = true;
  }
  return {
    seq: fields.seq ?? 0,
    role: fields.role ?? 'meta',
    kind: fields.kind ?? 'meta',
    ts: fields.ts ?? null,
    text,
    toolName: fields.toolName ?? null,
    toolInput: fields.toolInput ?? null,
    toolResult: fields.toolResult ?? null,
    truncated,
  };
}

/** 判断一段用户文本是不是 Agent 注入的噪声块（系统提示 / AGENTS.md 指令等） */
function isNoiseText(t) {
  if (t.startsWith('<system-reminder')) return true;
  if (t.startsWith('<command-name>')) return true;   // Claude 的斜杠命令回显
  if (t.startsWith('# AGENTS.md')) return true;
  if (t.startsWith('<INSTRUCTIONS>')) return true;
  if (t.startsWith('<identity_context>')) return true;
  if (t.startsWith('<skill ')) return true;          // Pi 等把技能注入也塞进用户正文
  if (t.startsWith('<user-memory>')) return true;
  if (t.startsWith('<environment_context>')) return true;
  return false;
}

/**
 * 从消息数组里挑一条像人写的标题。
 * 优先取「干净」的用户输入；如果整段都是注入噪声，
 * 则退而取第一条用户文本并剥掉 XML 标签——有标题总好过 null。
 */
function deriveTitle(messages) {
  const candidates = [];
  for (const m of messages) {
    if (m.role !== 'user' || m.kind !== 'text') continue;
    const t = (m.text || '').trim();
    if (t) candidates.push(t);
  }
  if (!candidates.length) return null;

  let fallback = null;
  for (const t of candidates) {
    if (!isNoiseText(t)) return clip(t);
    if (fallback === null) fallback = t;
  }
  // 全是噪声：剥掉标签后仍尝试给出一个可读标题
  const stripped = fallback.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return stripped ? clip(stripped) : null;
}

function clip(t) {
  const s = t.replace(/\s+/g, ' ').trim();
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

module.exports = { makeSession, makeMessage, deriveTitle, isNoiseText, MAX_TEXT };
