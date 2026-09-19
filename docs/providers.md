# 各 Agent 会话落盘格式参考

本文档是 ASV 适配层所依据的「会话类型 / 落盘格式」速查表。带 **✅ 实测** 的表示用本机真实数据跑通了 discover + parse；其余为社区项目（见文末参考）公开的格式信息，本机暂无数据，未做适配或仅作受限标注。

新写适配器时，把这里当格式档案；发现字段对不上，以真实文件为准并回填本文档。

## 通用会话模型

所有适配器都归一到：

```
Message.kind:  text | reasoning | tool_call | tool_result | meta
Message.role:  user | assistant | system | tool
Session.meta:  自由字段（model / provider / tokens / slug ...）
```

各家的「推理块」「工具调用」「工具结果」「token 统计」如何映射进来，见各节。

## ✅ WorkBuddy（codebuddy 方言）

- 位置：`~/.workbuddy/projects/<项目slug>/<会话id>.jsonl`；标题权威来源 `~/.workbuddy/workbuddy.db` 的 `sessions` 表
- 行 `type`：

| type | 语义 | 映射 |
|---|---|---|
| `message` | 顶层消息，`content[]` 块 | text（`input_text`/`output_text`） |
| `reasoning` | 推理，`rawContent[]` | reasoning（`reasoning_text`） |
| `function_call` | 工具调用（name + arguments） | tool_call |
| `function_call_result` | 工具结果（output.text） | tool_result |
| `ai-title` | 标题 | → session.title |
| `file-history-snapshot` | 文件快照 | 不索引 |

同构方言：**CodeBuddy**（`~/.codebuddy/projects/`）完全一致。

## ✅ Claude Code（claude 方言）

- 位置：`~/.claude/projects/<C--项目-slug>/<会话uuid>.jsonl`；子代理在 `<会话id>/subagents/agent-*.jsonl`
- 行 `type`：

| type | 语义 | 映射 |
|---|---|---|
| `user` / `assistant` | `message.content[]` 块 | text（`text`）/ tool_call（`tool_use`）/ tool_result（`tool_result`）/ reasoning（`thinking`） |
| `system` | 系统行 | meta（不进正文） |
| `ai-title` | 标题 | → session.title |
| `attachment`、`file-history-snapshot` 等 | 附件/快照 | 不索引 |

- token：assistant 行 `message.usage = { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens }`，逐条累加 → `meta.tokens`
- 注入噪声：`<system-reminder>`、斜杠命令回显 `<command-name>`、`# AGENTS.md` 等，标题派生时剔除

同构方言：**Qwen Work**（`~/.qwenworkcn/projects/`，`last-prompt` 行可作标题兜底）。

> 社区另见 **Qwen Code**（`~/.qwen/projects/.../chats/`，claude 系 JSONL）与 **Gemini CLI**（`~/.gemini/tmp/<slug>/chats/*.jsonl`）——本机无数据，未适配。

## ✅ Codex CLI（事件流方言）

- 位置：`~/.codex/sessions/<年>/<月>/<日>/rollout-<ISO>-<uuid>.jsonl`
- 行结构 `{ timestamp, type, payload }`：

| type | payload.type | 映射 |
|---|---|---|
| `session_meta` | — | cwd / cli_version / originator（AGENTS.md 指令是噪声，不索引） |
| `response_item` | `message`（role+content[]） | text（`input_text`/`output_text`/`text`） |
| `response_item` | `reasoning`（summary[]） | reasoning |
| `response_item` | `function_call` / `local_shell_call` / `custom_tool_call` | tool_call |
| `response_item` | `function_call_output` / `custom_tool_call_output` | tool_result |
| `event_msg` | `user_message` / `agent_message` | text（真实用户输入来源，标题金矿） |
| `event_msg` | `token_count` | `info.total_token_usage` 会话累计值，**取末次** → `meta.tokens`（cached_input_tokens → cacheRead） |
| `event_msg` | `task_started` / `task_complete` 等 | 进度标记，不索引 |
| `turn_context` | — | 每轮 cwd/model |

## ✅ Kimi CLI（协议 1.1）与 ✅ Kimi Code（协议 1.3）

两家同名不同协议，**不能共用解析器**：

| | Kimi CLI | Kimi Code |
|---|---|---|
| 位置 | `~/.kimi/sessions/<工作区hash>/<会话uuid>/wire.jsonl` | `~/.kimi-code/sessions/wd_<id>/session_<uuid>/agents/main/wire.jsonl` |
| 时间 | 秒浮点 `timestamp` | 毫秒 `time` / `created_at` |
| 用户输入 | `TurnBegin` → `payload.user_input[]` | `turn.prompt` → `input[]` |
| 助手内容 | 未识别类型通用兜底提取 | `context.append_message`（content[]/toolCalls[]）+ `context.append_loop_event`（`content.part` think/text、`tool.call`、`tool.result`） |
| 元数据 | — | `config.update`（modelAlias）、`state.json`（cwd） |
| 局限 | 工作区目录名是哈希，无法反推项目路径 | — |

## ✅ ZCode / opencode（SQLite 家族）

- 位置：`~/.zcode/cli/db/db.sqlite`、`~/.local/share/opencode/*.db`（候选路径见注册表）
- 表结构：`session(id, project_id, directory, title, time_created, time_updated)` / `message(id, session_id, data JSON, sequence)` / `part(id, message_id, data JSON, sequence)`
- `part.data.type`：`text` / `reasoning` / `tool`（`state.input` → tool_call，`state.output|error` → tool_result）/ `file` / `timeline` / `step-start` / `step-finish`（后四类不索引）
- 热库处理：目标应用运行中可能写锁（SQLITE_BUSY），直连失败则把 `db + wal + shm` 复制到临时目录再读快照——**备份也必须带上 wal/shm**，否则丢最新事务

## ✅ Pi（agent）

- 位置：`~/.pi/agent/sessions/<cwd-slug>/<ISO时间>_<uuid>.jsonl`
- 行结构：

| type | 语义 | 映射 |
|---|---|---|
| `session` | id / timestamp / cwd | 会话元数据 |
| `model_change` | provider / modelId | meta.model / meta.provider |
| `thinking_level_change` | 思考档位 | 不索引 |
| `message` | `message.{role, content[], usage}` | 见下 |

- `message.role`：`user` / `assistant` / `toolResult` / `bashExecution`（后两个是独立 role，不是 content 块）
- content 块：`text` → text；`thinking`(+`thinkingSignature`) → reasoning；`toolCall{id,name,arguments}` → tool_call
- token：**逐条 `message.usage = { input, output, cacheRead, cacheWrite, totalTokens, cost{input,output,total} }`**，累加 → `meta.tokens`（含美元成本，全家族里最全）
- 噪声：`<skill name=...>` 等技能注入会混进 user 正文，标题派生时剔除

## 受限（本机存在但读不到正文）

| Agent | 结论 |
|---|---|
| Cursor | 磁盘仅有 `projects/<slug>/mcps`，正文在私有状态库 |
| Cline | 仅有扩展 globalState/workspaceState，不含正文 |
| Antigravity | `brain` / `context_state` 目录为空 |
| Copilot CLI | 仅 config.json 与运行日志，未见 `session-state` 会话目录 |

## 社区格式情报（本机无数据，未适配）

以下格式信息来自同类开源项目的公开 provider 表，适配时可直接对照：

| Agent | 落盘位置 | 格式 |
|---|---|---|
| Gemini CLI | `~/.gemini/tmp/<hash>/chats/*.jsonl` | JSONL |
| Qwen Code | `~/.qwen/projects/.../chats/` | claude 系 JSONL |
| GitHub Copilot CLI | `~/.copilot/session-state/` | JSON |
| Amp | `~/.local/share/amp/threads/` | JSON |
| Goose | `~/.local/share/goose/sessions/sessions.db` | SQLite |
| Aider | `.aider.chat.history.md` | Markdown（无结构化块） |
| Open Interpreter | `~/.openinterpreter/sessions/` | codex 格式 rollout |
| Crush | `~/.local/share/crush/` | JSON |
| Kiro CLI | SQLite | 私有表结构 |
| Devin CLI | `~/.local/share/devin/cli/sessions.db` | SQLite |
| Zed | `…/Zed/threads/threads.db` | SQLite + Zstd |

有真实数据后，按「detect / discover / parse」三方法接入（见 `src/core/providers/index.js` 注册表）。

## 参考（格式情报来源）

- [claude-code-history-viewer](https://github.com/jhlee0409/claude-code-history-viewer) — 29 家 provider 的落盘位置表
- [agentsview](https://github.com/itga/agentsview) — Claude/Codex/Copilot/Gemini/OpenCode/Amp 解析布局
- [agent-session-viewer](https://github.com/dhruv-anand-aintech/agent-session-viewer) — Goose/Hermes/Devin/MiMo 等 SQLite 布局
- [sessionview](https://github.com/tyql688/sessionview) — Tauri 侧各家 resume 协议
