'use strict';

const fs = require('fs');
const path = require('path');
const { formatTime } = require('./util');

/**
 * 导出为可读文档（Markdown / HTML）
 *
 * HTML 完全自包含：不引用任何 CDN、字体或外部资源，
 * 这样在无互联网的内网环境里双击即可打开。
 */

const KIND_TAG = {
  text: '', reasoning: '推理', tool_call: '工具调用', tool_result: '工具结果', meta: '元信息',
};
const ROLE_NAME = { user: '用户', assistant: '助手', system: '系统', tool: '工具' };

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function header(session) {
  return {
    title: session.title || `会话 ${session.sessionId}`,
    agent: session.agent,
    sessionId: session.sessionId,
    projectPath: session.projectPath || '(未知)',
    createdAt: formatTime(session.createdAt),
    updatedAt: formatTime(session.updatedAt),
    messages: session.msgCount ?? null,
  };
}

/** @returns {string} Markdown 文本 */
function toMarkdown(session, messages) {
  const h = header(session);
  const L = [];
  L.push(`# ${h.title}`);
  L.push('');
  L.push('| 项 | 值 |');
  L.push('| --- | --- |');
  L.push(`| Agent | \`${h.agent}\` |`);
  L.push(`| 会话 ID | \`${h.sessionId}\` |`);
  L.push(`| 项目路径 | \`${h.projectPath}\` |`);
  L.push(`| 创建时间 | ${h.createdAt} |`);
  L.push(`| 更新时间 | ${h.updatedAt} |`);
  L.push(`| 消息条数 | ${messages.length} |`);
  L.push('');
  L.push('---');
  L.push('');

  let n = 0;
  for (const m of messages) {
    n += 1;
    const kind = KIND_TAG[m.kind] || m.kind;
    const role = ROLE_NAME[m.role] || m.role;
    const head = kind ? `${role} · ${kind}` : role;
    L.push(`### ${n}. ${head}${m.ts ? `  <sub>${formatTime(m.ts)}</sub>` : ''}`);
    L.push('');

    if (m.kind === 'tool_call') {
      L.push(`\`${m.toolName || '工具'}\``);
      L.push('');
      L.push('```json');
      L.push(prettyMaybeJson(m.text));
      L.push('```');
    } else if (m.kind === 'tool_result') {
      L.push('```text');
      L.push(String(m.text || '').slice(0, 20000));
      L.push('```');
      if ((m.text || '').length > 20000) L.push('> （内容过长，已截断，完整内容见原始会话文件）');
    } else if (m.kind === 'reasoning') {
      L.push('<details><summary>展开推理过程</summary>');
      L.push('');
      L.push(String(m.text || ''));
      L.push('');
      L.push('</details>');
    } else {
      L.push(String(m.text || ''));
    }
    L.push('');
  }
  return L.join('\n');
}

function prettyMaybeJson(s) {
  const t = String(s ?? '').trim();
  if (!t) return '';
  if (!/^[[{]/.test(t)) return t;
  try { return JSON.stringify(JSON.parse(t), null, 2); } catch { return t; }
}

/** @returns {string} 自包含 HTML（无外部依赖） */
function toHtml(session, messages) {
  const h = header(session);
  const rows = [];
  let n = 0;
  for (const m of messages) {
    n += 1;
    const kind = KIND_TAG[m.kind] || m.kind;
    const role = ROLE_NAME[m.role] || m.role;
    const cls = `m m-${m.role} k-${m.kind}`;
    let body;
    if (m.kind === 'tool_call') {
      body = `<div class="tool">${esc(m.toolName || '工具')}</div><pre class="json">${esc(prettyMaybeJson(m.text))}</pre>`;
    } else if (m.kind === 'tool_result') {
      const t = String(m.text || '');
      body = `<pre class="out">${esc(t.slice(0, 20000))}</pre>${t.length > 20000 ? '<p class="note">内容过长已截断</p>' : ''}`;
    } else if (m.kind === 'reasoning') {
      body = `<details><summary>展开推理过程</summary><pre class="think">${esc(m.text || '')}</pre></details>`;
    } else {
      body = `<div class="txt">${esc(m.text || '').replace(/\n/g, '<br>')}</div>`;
    }
    rows.push(`<article class="${cls}">
  <div class="hd"><span class="seq">${n}</span><span class="role">${esc(role)}</span>${kind ? `<span class="kind">${esc(kind)}</span>` : ''}<span class="ts">${esc(m.ts ? formatTime(m.ts) : '')}</span></div>
  <div class="bd">${body}</div>
</article>`);
  }

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(h.title)}</title>
<style>
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;padding:32px 20px;background:#f6f6f4;color:#1f1f1d;
  font:14px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}
.wrap{max-width:920px;margin:0 auto}
h1{font-size:22px;font-weight:600;margin:0 0 16px}
table{border-collapse:collapse;width:100%;margin-bottom:24px;background:#fff;
  border:1px solid #e2e2de;border-radius:10px;overflow:hidden}
td{padding:8px 14px;border-bottom:1px solid #eeeeea;font-size:13px}
tr:last-child td{border-bottom:0}
td:first-child{width:110px;color:#6b6b66}
code{font-family:ui-monospace,Consolas,monospace;font-size:12.5px;background:#f0f0ec;padding:1px 5px;border-radius:4px}
article{background:#fff;border:1px solid #e2e2de;border-radius:10px;padding:14px 16px;margin-bottom:12px}
article.m-user{border-left:3px solid #185fa5}
article.m-assistant{border-left:3px solid #0f6e56}
article.m-tool{border-left:3px solid #888780}
.hd{display:flex;align-items:center;gap:8px;margin-bottom:8px;font-size:12px;color:#6b6b66}
.seq{display:inline-flex;min-width:22px;height:22px;align-items:center;justify-content:center;
  background:#f0f0ec;border-radius:6px;font-weight:500;color:#444}
.role{font-weight:500;color:#1f1f1d}
.kind{background:#eef3f8;color:#185fa5;padding:1px 6px;border-radius:4px}
.ts{margin-left:auto}
.bd{font-size:13.5px}
.txt{white-space:pre-wrap;word-break:break-word}
pre{margin:0;padding:10px 12px;background:#fafaf8;border:1px solid #eeeeea;border-radius:8px;
  overflow-x:auto;font:12.5px/1.6 ui-monospace,Consolas,monospace;white-space:pre-wrap;word-break:break-word}
pre.out{max-height:420px;overflow:auto;color:#444}
pre.think{color:#5f5e5a}
.tool{display:inline-block;font:12.5px ui-monospace,Consolas,monospace;background:#eef3f8;
  color:#185fa5;padding:2px 8px;border-radius:5px;margin-bottom:6px}
details summary{cursor:pointer;font-size:12.5px;color:#6b6b66}
.note{font-size:12px;color:#888780;margin:6px 0 0}
footer{margin-top:28px;font-size:12px;color:#888780;text-align:center}
</style>
</head>
<body>
<div class="wrap">
<h1>${esc(h.title)}</h1>
<table>
<tr><td>Agent</td><td><code>${esc(h.agent)}</code></td></tr>
<tr><td>会话 ID</td><td><code>${esc(h.sessionId)}</code></td></tr>
<tr><td>项目路径</td><td><code>${esc(h.projectPath)}</code></td></tr>
<tr><td>创建时间</td><td>${esc(h.createdAt)}</td></tr>
<tr><td>更新时间</td><td>${esc(h.updatedAt)}</td></tr>
<tr><td>消息条数</td><td>${messages.length}</td></tr>
</table>
${rows.join('\n')}
<footer>由 Agent Session Vault 导出于 ${esc(formatTime(Date.now()))}</footer>
</div>
</body>
</html>`;
}

/** 导出到文件，格式由扩展名或显式 format 决定 */
function exportSession(session, messages, outFile, format) {
  const fmt = format || (outFile.toLowerCase().endsWith('.md') ? 'md' : 'html');
  const content = fmt === 'md' ? toMarkdown(session, messages) : toHtml(session, messages);
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  fs.writeFileSync(outFile, content, 'utf8');
  return { file: outFile, format: fmt, bytes: Buffer.byteLength(content, 'utf8') };
}

module.exports = { toMarkdown, toHtml, exportSession, esc };
