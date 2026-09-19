'use strict';

const path = require('path');
const os = require('os');
const { JsonlProjectProvider } = require('./jsonl-project');
const { CodexProvider } = require('./codex');
const { KimiCliProvider, KimiCodeProvider } = require('./kimi');
const { SqliteOpencodeProvider } = require('./sqlite-opencode');
const { PiProvider } = require('./pi');
const { RestrictedProvider } = require('./restricted');

const home = (p) => path.join(os.homedir(), p);

/**
 * Provider 注册表
 *
 * verified 字段标明该适配器是否用本机真实数据实测验证过。
 * 未实测的一律标 false，CLI 会显式提示，避免把「我猜的格式」当成可用能力。
 */
const providers = [
  new JsonlProjectProvider({
    id: 'workbuddy',
    label: 'WorkBuddy',
    root: '~/.workbuddy/projects',
    // workbuddy.db 的 sessions 表是标题的权威来源（实测 280 条会话中 126 条有标题），
    // 正文里的 ai-title 行不保证落在文件头尾，单靠正文会大面积取不到标题
    titleIndex: {
      kind: 'sqlite',
      db: '~/.workbuddy/workbuddy.db',
      table: 'sessions',
      idCol: 'id',
      titleCols: ['custom_title', 'title'],
      modelCol: 'model',
    },
  }),
  new JsonlProjectProvider({
    id: 'claude-code',
    label: 'Claude Code',
    root: '~/.claude/projects',
    subagents: true,
  }),
  new JsonlProjectProvider({
    id: 'qwenworkcn',
    label: 'Qwen Work',
    root: '~/.qwenworkcn/projects',
  }),
  new JsonlProjectProvider({
    id: 'codebuddy',
    label: 'CodeBuddy',
    root: '~/.codebuddy/projects',
  }),
  new CodexProvider(),
  new KimiCliProvider(),
  new KimiCodeProvider(),
  new SqliteOpencodeProvider({
    id: 'zcode',
    label: 'ZCode',
    dbCandidates: ['~/.zcode/cli/db/db.sqlite'],
  }),
  new SqliteOpencodeProvider({
    id: 'opencode',
    label: 'opencode',
    dbCandidates: [
      '~/.local/share/opencode/opencode.db',
      '~/.local/share/opencode/db/db.sqlite',
      '~/.opencode/db/db.sqlite',
    ],
  }),
  new PiProvider(),
  new RestrictedProvider({
    id: 'copilot',
    label: 'Copilot CLI',
    probePath: '~/.copilot',
    reason: '本机仅有 config.json 与运行日志，未见 session-state 会话目录（该工具的会话落盘位置，未产生数据）',
  }),
  new RestrictedProvider({
    id: 'cursor',
    label: 'Cursor',
    probePath: '~/.cursor',
    reason: '磁盘仅有 projects/<slug>/mcps 目录，会话正文保存在其私有状态库内，无可用落盘格式',
  }),
  new RestrictedProvider({
    id: 'cline',
    label: 'Cline',
    probePath: '~/.cline',
    reason: '仅有扩展状态文件（data/globalState.json、workspaces/*/workspaceState.json），不含会话正文',
  }),
  new RestrictedProvider({
    id: 'antigravity',
    label: 'Antigravity',
    probePath: '~/.gemini/antigravity',
    reason: 'brain 与 context_state 目录为空，未产生可解析的会话记录',
  }),
];

/** 实测验证过的 Provider（用本机真实数据跑通 discover + parse） */
const VERIFIED = new Set([
  'workbuddy', 'claude-code', 'qwenworkcn', 'codex', 'kimi-cli', 'kimi-code', 'zcode', 'pi',
]);

function all() {
  return providers;
}

function get(id) {
  return providers.find((p) => p.id === id) || null;
}

/** 把用户输入的 agent 标识解析成 provider 列表；支持 "all" 与逗号分隔 */
function resolve(spec) {
  if (!spec || spec === 'all') return providers;
  const ids = String(spec).split(',').map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const id of ids) {
    const p = get(id);
    if (!p) throw new Error(`未知的 Agent 标识：${id}（可用：${providers.map((x) => x.id).join(', ')}）`);
    out.push(p);
  }
  return out;
}

function isVerified(id) {
  return VERIFIED.has(id);
}

function homeDir() {
  return os.homedir();
}

module.exports = { all, get, resolve, isVerified, VERIFIED, home, homeDir };
