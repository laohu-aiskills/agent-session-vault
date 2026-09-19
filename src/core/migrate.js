'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { formatTime } = require('./util');

/**
 * 跨 Agent 迁移
 *
 * ⚠️ 能力边界（必须如实告知，不能含糊）：
 * 各家 Agent 的工具调用 schema、推理块格式、文件快照机制、会话索引库
 * 互不兼容。因此跨 Agent 迁移【只能保住用户消息与助手文本】，
 * 工具调用、工具结果、推理过程【必然丢失】。
 * 这不是实现缺陷，而是格式本身决定的物理上限。
 *
 * 另外，本工具【不会】去写目标 Agent 的索引库（如 workbuddy.db 的 sessions 表）。
 * 因为那是另一个正在运行的进程持有的库，强行写入有损坏风险。
 * 所以产出的是「符合目标格式的会话文件 + 落位说明 + 丢失清单」，
 * 由使用者决定是否落位。
 */

const TARGETS = {
  workbuddy: {
    id: 'workbuddy',
    label: 'WorkBuddy',
    dialect: 'codebuddy',
    projectRoot: () => path.join(os.homedir(), '.workbuddy', 'projects'),
  },
  'claude-code': {
    id: 'claude-code',
    label: 'Claude Code',
    dialect: 'claude',
    projectRoot: () => path.join(os.homedir(), '.claude', 'projects'),
  },
  qwenworkcn: {
    id: 'qwenworkcn',
    label: 'Qwen Work',
    dialect: 'claude',
    projectRoot: () => path.join(os.homedir(), '.qwenworkcn', 'projects'),
  },
  codebuddy: {
    id: 'codebuddy',
    label: 'CodeBuddy',
    dialect: 'codebuddy',
    projectRoot: () => path.join(os.homedir(), '.codebuddy', 'projects'),
  },
};

/**
 * 项目路径 → 目标 Agent 的分片目录名
 * 两种实测编码风格：
 *   codebuddy 系  C:\Users\me\x  →  c-Users-me-x
 *   claude 系     C:\Users\me\x  →  C--Users-me-x
 */
function slugFor(projectPath, dialect) {
  const norm = path.resolve(projectPath || '.');
  const m = norm.match(/^([A-Za-z]):[\\/](.*)$/);
  if (m) {
    const rest = m[2].replace(/[\\/]/g, '-');
    return dialect === 'claude' ? `${m[1].toUpperCase()}--${rest}` : `${m[1].toLowerCase()}-${rest}`;
  }
  const rest = norm.replace(/^[\\/]+/, '').replace(/[\\/]/g, '-');
  return `-${rest}`;
}

function uuid() {
  return crypto.randomUUID();
}

function iso(ms) {
  return new Date(ms || Date.now()).toISOString();
}

/** 渲染成 codebuddy（WorkBuddy / CodeBuddy）方言的一行 */
function lineCodebuddy(m, sid, cwd, parentId) {
  const id = uuid();
  const base = { id, parentId, timestamp: m.ts || Date.now(), sessionId: sid, cwd };
  switch (m.kind) {
    case 'text':
      return {
        ...base,
        type: 'message',
        role: m.role === 'user' ? 'user' : 'assistant',
        status: 'completed',
        content: [{
          type: m.role === 'user' ? 'input_text' : 'output_text',
          text: m.text || '',
        }],
      };
    case 'reasoning':
      return { ...base, type: 'reasoning', content: [], rawContent: [{ type: 'reasoning_text', text: m.text || '' }] };
    case 'tool_call':
      return { ...base, type: 'function_call', name: m.toolName || 'unknown', callId: `call_${id.slice(0, 12)}`, arguments: m.toolInput ?? m.text ?? '' };
    case 'tool_result':
      return {
        ...base,
        type: 'function_call_result',
        name: m.toolName || 'unknown',
        callId: `call_${id.slice(0, 12)}`,
        status: 'completed',
        output: { type: 'text', text: m.text || '' },
      };
    default:
      return null;
  }
}

/** 渲染成 claude（Claude Code / Qwen Work）方言的一行 */
function lineClaude(m, sid, cwd) {
  const base = { uuid: uuid(), timestamp: iso(m.ts), sessionId: sid, cwd, version: 'asv-import' };
  switch (m.kind) {
    case 'text':
      return {
        ...base,
        type: m.role === 'user' ? 'user' : 'assistant',
        message: {
          role: m.role === 'user' ? 'user' : 'assistant',
          content: [{ type: 'text', text: m.text || '' }],
        },
      };
    case 'reasoning':
      return {
        ...base,
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: m.text || '', signature: '' }] },
      };
    case 'tool_call':
      return {
        ...base,
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: `toolu_${base.uuid.slice(0, 20)}`, name: m.toolName || 'unknown', input: m.toolInput ?? {} }],
        },
      };
    case 'tool_result':
      return {
        ...base,
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: null, content: m.text || '' }],
        },
      };
    default:
      return null;
  }
}

/** 统计在迁移中会丢失的内容 */
function lossReport(messages) {
  const lost = { tool_call: 0, tool_result: 0, reasoning: 0, other: 0 };
  let kept = 0;
  for (const m of messages) {
    if (m.kind === 'text') { kept += 1; continue; }
    if (lost[m.kind] !== undefined) lost[m.kind] += 1;
    else lost.other += 1;
  }
  const lostTotal = lost.tool_call + lost.tool_result + lost.reasoning + lost.other;
  return { keptMessages: kept, lostMessages: lostTotal, lostBreakdown: lost };
}

/**
 * 执行迁移：产出目标格式文件 + 落位说明
 * @param {object} cfg
 * @param {object} cfg.session 源会话
 * @param {object[]} cfg.messages 源消息
 * @param {string} cfg.to 目标 agent id
 * @param {string} cfg.out 输出目录
 * @param {boolean} [cfg.sanitize] 是否剔除工具调用与推理（默认 true，因为目标格式承载不了）
 */
function migrate({ session, messages, to, out, sanitize = true }) {
  const target = TARGETS[to];
  if (!target) {
    throw new Error(`不支持迁移到该 Agent：${to}（当前支持：${Object.keys(TARGETS).join(', ')}）`);
  }

  const report = lossReport(messages);
  const sid = uuid();
  const cwd = session.projectPath || process.cwd();
  const slug = slugFor(cwd, target.dialect);
  const destDir = path.join(out, slug);
  fs.mkdirSync(destDir, { recursive: true });
  const destFile = path.join(destDir, `${sid}.jsonl`);

  // sanitize=true：只保留跨格式可承载的正文，避免产出目标 Agent 解析不了的块
  const usable = sanitize
    ? messages.filter((m) => m.kind === 'text' && m.text && m.text.trim())
    : messages;

  const lines = [];
  let parentId = null;
  if (target.dialect === 'claude') {
    lines.push(JSON.stringify({ type: 'mode', mode: 'normal', sessionId: sid }));
  }
  for (const m of usable) {
    const obj = target.dialect === 'claude'
      ? lineClaude(m, sid, cwd)
      : lineCodebuddy(m, sid, cwd, parentId);
    if (!obj) continue;
    lines.push(JSON.stringify(obj));
    parentId = obj.id || obj.uuid || parentId;
  }

  const titleText = session.title || '（无标题）';
  const titleLine = target.dialect === 'claude'
    ? { type: 'ai-title', aiTitle: titleText, sessionId: sid }
    : { type: 'ai-title', timestamp: Date.now(), aiTitle: titleText, sessionId: sid, cwd };
  lines.push(JSON.stringify(titleLine));

  // 首行插入一条迁移标记，便于日后识别「这条是导入的」
  const marker = target.dialect === 'claude'
    ? { type: 'system', subtype: 'asv_migration', uuid: uuid(), timestamp: iso(Date.now()), sessionId: sid, cwd, version: 'asv-import', note: `imported by agent-session-vault from ${session.agent}:${session.sessionId}` }
    : { id: uuid(), timestamp: Date.now(), type: 'asv-migration', sessionId: sid, cwd, note: `imported by agent-session-vault from ${session.agent}:${session.sessionId}` };
  lines.splice(target.dialect === 'claude' ? 1 : 0, 0, JSON.stringify(marker));

  fs.writeFileSync(destFile, `${lines.join('\n')}\n`, 'utf8');

  const note = {
    format: 'agent-session-vault/migration-note',
    createdAt: Date.now(),
    source: { agent: session.agent, sessionId: session.sessionId, title: session.title },
    target: { agent: target.id, label: target.label, dialect: target.dialect },
    outputFile: destFile,
    newSessionId: sid,
    title: titleText,
    keptMessages: usable.length,
    lost: report.lostBreakdown,
    instructions: [
      `把 ${destDir} 整个目录复制到目标 Agent 的项目根目录：`,
      `  ${target.projectRoot()}`,
      `即最终路径为：`,
      `  ${path.join(target.projectRoot(), slug, `${sid}.jsonl`)}`,
      '注意：本工具不会替目标 Agent 更新它的会话索引库（如 workbuddy.db），',
      '      因此目标 Agent 的会话列表中可能不会立即出现这条会话。',
      '      请先用目标 Agent 打开一次该目录，或在其设置中触发一次重建索引。',
    ],
    warning: [
      '跨 Agent 迁移只能保住用户消息与助手文本。',
      '工具调用、工具结果、推理过程因格式不兼容已被剔除，无法恢复。',
      '若需要完整内容，请使用 export 命令导出 Markdown/HTML，或保留原始备份。',
    ],
  };
  fs.writeFileSync(
    path.join(destDir, `${sid}.asv-migration.json`),
    JSON.stringify(note, null, 2),
    'utf8',
  );

  return {
    file: destFile,
    noteFile: path.join(destDir, `${sid}.asv-migration.json`),
    dir: destDir,
    slug,
    newSessionId: sid,
    wroteMessages: usable.length,
    report,
    target,
    sourceTitle: session.title,
    sourceCreated: formatTime(session.createdAt),
  };
}

module.exports = { migrate, TARGETS, slugFor, lossReport };
