# Agent Session Vault

**English** | [中文](#能读哪些-agent)

**Agent Session Vault (ASV)** is a local-first tool to **read, search, back up, restore and migrate** AI coding agent session histories — Claude Code, Codex CLI, Kimi CLI / Code, WorkBuddy, Qwen Work, ZCode / opencode and more. Zero runtime dependencies, fully offline, ships as a one-file CLI (`asv.exe`) and an Electron desktop app.

- 🔍 **Full-text search** over 100k+ messages — SQLite FTS5 trigram, with automatic LIKE fallback for 1–2 character queries (short Chinese words)
- 🧩 **Unified session model** across JSONL / event-stream / SQLite agents, subagents included
- 💾 **Backup & restore** with sha256 manifest, WAL-safe SQLite snapshots, dry-run by default, three safety gates, cross-machine home remapping
- 🔁 **Cross-agent migration** (text-preserving, with honest loss report) + Markdown / self-contained HTML export
- 🖥 **Desktop GUI** with live refresh, auto-refresh, in-session find, per-agent icons

All data stays on your machine. The tool never goes online and collects nothing.

---

统一**读取、检索、备份、还原、迁移**多种 AI Agent 本地会话记录的桌面工具（Electron）+ CLI。

所有数据都在本机磁盘上，工具不联网、不收集任何信息。

## 能读哪些 Agent

以下均以本机真实数据实测验证，不是凭文档写的：

| 标识 | Agent | 落盘位置 | 实测规模 |
|---|---|---|---|
| `workbuddy` | WorkBuddy | `~/.workbuddy/projects/<项目>/<会话>.jsonl` + `workbuddy.db` | 278 会话 |
| `claude-code` | Claude Code | `~/.claude/projects/<项目>/<会话>.jsonl`（含 subagents） | 16 会话 |
| `qwenworkcn` | Qwen Work | `~/.qwenworkcn/projects/<项目>/<会话>.jsonl` | 94 会话 |
| `codex` | Codex CLI | `~/.codex/sessions/<年>/<月>/<日>/rollout-*.jsonl` | 2 会话 |
| `kimi-cli` | Kimi CLI | `~/.kimi/sessions/<工作区>/<会话>/wire.jsonl` | 4 会话 |
| `kimi-code` | Kimi Code | `~/.kimi-code/sessions/<wd>/<会话>/agents/main/wire.jsonl` | 1 会话 |
| `zcode` | ZCode | `~/.zcode/cli/db/db.sqlite`（`session`/`message`/`part` 表） | 1 会话 |
| `opencode` | opencode | 同 ZCode 的 SQLite 布局 | 未安装 |

`asv agents` 会如实列出以上各家状态。另有三家**明确标注为受限**：

- `cursor` — 磁盘仅有 `mcps` 目录，会话正文在其私有状态库内
- `cline` — 仅有扩展状态文件，不含会话正文
- `antigravity` — `brain` 目录为空

这三家不是没做，而是**磁盘上根本没有可解析的会话文件**。工具宁可告诉你"读不到"也不会静默漏掉。

## 快速上手

```bash
npm install                 # 仅 devDependencies: electron
npm run asv -- agents       # 看看能读哪些
npm run asv -- index        # 建全文索引
npm run asv -- search "会话记录"
npm run asv                 # 启动桌面界面
```

## 可执行程序（免安装分发）

从 [Releases](../../releases) 下载免安装 exe（CLI 单文件 / 桌面便携版 / 安装包），或自行构建：

```bash
npm run build               # 一条命令产出全部
```

| 产物 | 位置 | 说明 |
|---|---|---|
| **CLI 单文件** | `dist/asv.exe` | Node SEA 打包，约 83 MB。**拷到任何 Windows 机器即可用**，无需 Node、无需源码、无任何外部文件。索引库落在 `%USERPROFILE%\.agent-session-vault\`。 |
| **桌面便携版** | `dist/AgentSessionVault-*-portable.exe` | 单文件 GUI，双击即开，不写注册表。 |
| **安装包** | `dist/AgentSessionVault-*-setup.exe` | NSIS 安装向导，可选安装目录。 |
| 免安装绿色版 | `dist/win-unpacked/` | 解包版目录，含完整 Electron 运行时。 |

`asv.exe` 已实测脱离源码独立运行（agents / search / export / backup / restore 全链路），并已过滤 `node:sqlite` 的实验特性警告。重新构建：

```bash
npm run build:sea           # 仅重建 asv.exe
npm run build:desktop       # 仅重建桌面版
node tools/build-sea.js --keep   # 保留中间产物，便于排查
```

打包原理：SEA 主脚本无法 `require` 相对路径（实测报 `ERR_UNKNOWN_BUILTIN_MODULE`），所以 `tools/build-sea.js` 先把 17 个模块静态打包成单文件（内置模块转发给原生 require），再经 Node 官方 SEA 流程（`--experimental-sea-config` + postject 注入）合成单 exe。

## 桌面界面

```
npm run desktop            # 开发/直接运行
electron . --smoke         # 核心自检（不弹窗）
electron . --selftest      # 界面自检（建窗→渲染→IPC 验证→自动退出）
electron . --screenshot x.png
```

界面截图待补充（截图会包含真实会话内容，发布前请注意脱敏）。

## 检索的硬限制（必读）

索引用的是 SQLite FTS5 的 **`trigram` 分词器**。它对**少于 3 个字符的查询会静默返回空结果**，既不报错也不提示：

- `贪食蛇`（3 字）→ 命中 ✓
- `会话`（2 字）→ **不命中** ✗

而中文里两字词恰恰最常见。因此检索做了双通道：

| 查询长度 | 通道 | 本机实测耗时 |
|---|---|---|
| ≥ 3 字 | FTS5 trigram 索引 | ~3 ms |
| ≤ 2 字 | LIKE 全表扫描（结果正确） | ~153 ms |

CLI 的输出会标明当前走的是哪条通道，不会让你误以为"搜不到"其实是"搜不了"。

## 备份与还原

```bash
asv backup --out D:/bak/asv            # 全量
asv backup --out D:/bak/asv --agent zcode
asv restore D:/bak/asv                 # 演练：只列清单，不写盘
asv restore D:/bak/asv --apply --yes   # 确认后才写入
asv restore D:/bak/asv --target D:/new-home --apply --yes   # 跨机器还原（重映射家目录）
```

一致性处理：

- SQLite（ZCode 等）**连 `-wal` / `-shm` 一起备份**。漏掉会丢最新事务，这是实测踩过的坑。
- 正在追加中的 JSONL 末尾可能是半行（Agent 崩溃），解析器会跳过脏行而不是整体失败。
- 还原**默认只演练**；真正写入需要 `--apply`，覆盖已存在文件还需 `--overwrite`，非交互环境再要 `--yes`。三道门。

## 导出与迁移

```bash
asv export <uid> --out out.md     # Markdown
asv export <uid> --out out.html   # 自包含 HTML，无外部资源，内网可直接打开
asv migrate <uid> --to claude-code --out ./migrated
```

**迁移的能力边界（如实说明，不含糊）**：

跨 Agent 迁移**只能保住用户消息与助手文本**。工具调用、工具结果、推理过程因各家格式不兼容**必然丢失**——这是格式决定的物理上限，不是实现缺陷。工具会在产出中明确列出丢了多少条。

另外，迁移**不会**去改写目标 Agent 的索引库（如 `workbuddy.db`），因为那是另一个运行中进程持有的库，强写有损坏风险。所以产出是"符合目标格式的会话文件 + 落位说明 + 丢失清单"，由你决定是否落位。

## 架构

```
src/core/
  model.js                统一会话模型 Session / Message
  util.js                 流式 JSONL、脏行容错、时间戳归一、超大单行
  providers/
    jsonl-project.js      WorkBuddy / Claude Code / QwenWorkCN（同构布局）
    codex.js              Codex（session_meta / response_item / event_msg）
    kimi.js               Kimi CLI（协议 1.1）与 Kimi Code（协议 1.3）——两套不同协议
    sqlite-opencode.js    ZCode / opencode（session/message/part 表，含热库快照兜底）
    restricted.js         Cursor / Cline / Antigravity（探测并说明为何不可读）
    index.js              注册表
  index-db.js             FTS5(trigram) 索引 + 双通道检索
  scan.js                 发现 / 增量索引 / 摘要
  backup.js restore.js    备份（含 wal/shm）/ 还原（三道安全门）
  export.js migrate.js    MD/HTML 导出 / 跨 Agent 迁移
desktop/                  Electron 主进程 + preload + 零构建渲染层
test/verify.js            端到端验证（36 项断言，用本机真实数据）
```

**零运行时依赖**。唯一的依赖是 devDependencies 里的 electron。SQLite 走 Node 22.5+ 内置的 `node:sqlite`，因此没有原生模块、不需要 node-gyp、内网离线可装。

加一家新 Agent：实现 `detect / discover / parse` 三个方法，注册进 `providers/index.js` 即可。同构家族（如又一个用 `projects/<slug>/<uuid>.jsonl` 布局的）只需加一条配置。

## 验证

```bash
npm run verify
```

36 项断言覆盖：探测、索引、检索双通道、详情、导出、备份、还原安全性（演练/`--yes`/`--overwrite` 三道门）、还原完整性（sha256 逐字节比对）、迁移、脏数据容错。全部写操作落在 `.scratch/`，不碰任何真实 Agent 数据目录。

## 已知边界

- **Cursor / Cline / Antigravity 读不到**，原因见上。
- Kimi CLI 的工作区目录名无法反推项目路径（已实测排除 md5/sha1/sha256 路径哈希的可能），其 `projectPath` 会显示为未知。
- 索引库与源数据体积相当（trigram 会为每个 3 字序列建倒排），本机 148 MB 源数据 → 150 MB 索引。如需瘦身可只索引 `text` 与 `reasoning` 两类，不索引工具结果。
- `codebuddy` 与 `opencode` 的适配器已就位但本机无数据，标为"未实测"。
