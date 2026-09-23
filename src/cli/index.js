'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const reg = require('../core/providers');
const { IndexDb } = require('../core/index-db');
const { discoverAll, buildIndex, makeSnippet, KIND_LABEL, ROLE_LABEL } = require('../core/scan');
const { exportSession } = require('../core/export');
const { backup } = require('../core/backup');
const { planRestore, applyRestore } = require('../core/restore');
const { migrate, TARGETS } = require('../core/migrate');
const { humanSize, formatTime } = require('../core/util');
const { version: VERSION } = require('../../package.json');

/* ----------------------------- 输出工具 ----------------------------- */

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : String(s));
const bold = (s) => c('1', s);
const dim = (s) => c('2', s);
const red = (s) => c('31', s);
const green = (s) => c('32', s);
const yellow = (s) => c('33', s);
const blue = (s) => c('36', s);

const DEFAULT_INDEX = path.join(os.homedir(), '.agent-session-vault', 'index.db');

/* ----------------------------- 参数解析 ----------------------------- */

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (key.startsWith('no-')) { flags[key.slice(3)] = false; continue; }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { flags[key] = true; }
      else { flags[key] = next; i += 1; }
    } else if (a.startsWith('-') && a.length > 1) {
      flags[a.slice(1)] = true;
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function openIndex(flags) {
  return new IndexDb(flags.index || DEFAULT_INDEX);
}

/** 会话 uid 支持简写：直接给 sessionId 也能定位 */
function resolveSession(index, needle) {
  const exact = index.getSession(needle);
  if (exact) return exact;
  const matches = index.findSessions(needle, 10);
  if (!matches.length) return null;
  if (matches.length === 1) return index.getSession(matches[0].uid);
  return { ambiguous: matches };
}

/* ----------------------------- 各子命令 ----------------------------- */

async function cmdAgents(flags) {
  const { agents } = await discoverAll(reg.all());
  if (flags.json) {
    console.log(JSON.stringify(agents.map((a) => ({ ...a, verified: reg.isVerified(a.id) })), null, 2));
    return;
  }
  console.log(bold('本机可用的 Agent 会话来源\n'));
  console.log(`  ${'标识'.padEnd(14)}${'名称'.padEnd(14)}${'会话数'.padStart(8)}${'体积'.padStart(10)}  状态`);
  console.log(`  ${'-'.repeat(72)}`);
  for (const a of agents) {
    const mark = a.available && !a.restricted ? green('可用') : (a.restricted ? yellow('受限') : dim('无数据'));
    const verified = reg.isVerified(a.id) ? '' : dim(' [未实测]');
    console.log(`  ${a.id.padEnd(14)}${a.label.padEnd(14)}${String(a.count || 0).padStart(8)}${humanSize(a.bytes || 0).padStart(10)}  ${mark}${verified}`);
    if (!a.available) console.log(`  ${' '.repeat(14)}${dim(a.reason)}`);
    else if (a.restricted) console.log(`  ${' '.repeat(14)}${dim(a.reason)}`);
  }
  console.log();
  console.log(dim(`  数据根目录示例：${reg.get('workbuddy').root}`));
}

async function cmdScan(flags) {
  const providers = reg.resolve(flags.agent);
  const { sessions, agents } = await discoverAll(providers);
  if (flags.json) { console.log(JSON.stringify({ agents, sessions }, null, 2)); return; }
  console.log(bold(`扫描到 ${sessions.length} 个会话\n`));
  const byAgent = new Map();
  for (const s of sessions) {
    if (!byAgent.has(s.agent)) byAgent.set(s.agent, []);
    byAgent.get(s.agent).push(s);
  }
  for (const [agent, list] of byAgent) {
    const bytes = list.reduce((a, s) => a + s.bytes, 0);
    const titled = list.filter((s) => s.title).length;
    console.log(`  ${bold(agent)}  ${list.length} 会话  ${humanSize(bytes)}  有标题 ${titled}/${list.length}`);
  }
}

async function cmdIndex(flags) {
  const index = openIndex(flags);
  const providers = reg.resolve(flags.agent);
  const tty = process.stdout.isTTY;
  let lastLine = '';
  const r = await buildIndex({
    providers,
    index,
    force: Boolean(flags.force),
    log: (k, a) => console.log(`  ${k === 'error' ? red('[错误]') : dim(`[${k}]`)} ${a.join(' ')}`),
    onProgress: (ev) => {
      if (!tty) return;
      const line = `  索引中 ${ev.agent.padEnd(14)} ${ev.skipped ? dim('跳过(未变更)') : `${ev.messages} 条`}`;
      if (line !== lastLine) { process.stdout.write(`\r${line.padEnd(60)}`); lastLine = line; }
    },
  });
  if (tty) process.stdout.write(`\r${' '.repeat(62)}\r`);
  const st = index.stats();
  console.log(bold('索引完成'));
  console.log(`  会话 ${r.sessions} 个（新增/更新 ${green(r.indexed)}，未变更跳过 ${r.skipped}，失败 ${r.failed ? red(r.failed) : 0}${r.pruned ? `，清理失效 ${r.pruned}` : ''}）`);
  console.log(`  消息 ${st.messages} 条，耗时 ${(r.elapsedMs / 1000).toFixed(1)}s`);
  console.log(`  索引库 ${st.dbFile}  ${humanSize(st.dbSize)}`);
  index.close();
}

async function cmdStats(flags) {
  const index = openIndex(flags);
  const st = index.stats();
  if (st.sessions === 0) {
    console.log(yellow('索引库为空，请先运行：asv index'));
    index.close();
    return;
  }
  if (flags.json) { console.log(JSON.stringify(st, null, 2)); index.close(); return; }
  console.log(bold('索引库概览'));
  console.log(`  路径      ${st.dbFile}`);
  console.log(`  体积      ${humanSize(st.dbSize)}`);
  console.log(`  会话      ${st.sessions}`);
  console.log(`  消息      ${st.messages}`);
  console.log(`  建索引于  ${st.indexedAt ? formatTime(Number(st.indexedAt)) : '-'}`);
  console.log();
  console.log(`  ${'Agent'.padEnd(16)}${'会话'.padStart(8)}${'消息'.padStart(10)}`);
  for (const a of st.byAgent) {
    console.log(`  ${a.agent.padEnd(16)}${String(a.n).padStart(8)}${String(a.m).padStart(10)}`);
  }
  index.close();
}

async function cmdList(flags) {
  const index = openIndex(flags);
  if (index.stats().sessions === 0) {
    console.log(yellow('索引库为空，请先运行：asv index'));
    index.close();
    return;
  }
  const limit = Number(flags.limit || 30);
  const rows = index.listSessions({
    agent: flags.agent || null,
    project: flags.project || null,
    limit,
    order: flags.order === 'created' ? 'created' : 'updated',
    dir: flags.dir === 'asc' ? 'asc' : 'desc',
  });
  if (flags.json) { console.log(JSON.stringify(rows, null, 2)); index.close(); return; }

  console.log(bold(`最近 ${rows.length} 个会话（按${flags.order === 'created' ? '创建' : '更新'}时间）\n`));
  for (const r of rows) {
    const title = (r.title || '(无标题)').slice(0, 44);
    console.log(`  ${blue(r.agent.padEnd(13))} ${title}`);
    console.log(`  ${' '.repeat(13)} ${dim(`${r.msg_count} 条 · ${formatTime(r.updated_at)} · ${r.project_path || '未知项目'}`)}`);
    console.log(`  ${' '.repeat(13)} ${dim(r.uid)}`);
  }
  index.close();
}

async function cmdShow(flags, positional) {
  const needle = positional[0];
  if (!needle) throw new Error('用法：asv show <会话uid 或 会话id> [--full] [--json] [--limit N]');
  const index = openIndex(flags);
  let session; let messages; let source;
  try {
    const found = resolveSession(index, needle);

    if (found && found.ambiguous) {
      console.log(yellow(`匹配到 ${found.ambiguous.length} 个会话，请指定更精确的 ID：\n`));
      for (const m of found.ambiguous) console.log(`  ${m.uid}  ${dim((m.title || '').slice(0, 40))}`);
      return;
    }

    if (found) {
      session = found.session;
      messages = found.messages;
      source = 'index';
    } else {
      // 索引里没有 → 现场扫描并解析（不写库）
      const { sessions } = await discoverAll(reg.all());
      const hit = sessions.find((s) => s.uid === needle || s.sessionId === needle || s.uid.includes(needle));
      if (!hit) throw new Error(`未找到会话：${needle}（可先运行 asv index，或检查 ID）`);
      const p = reg.get(hit.agent);
      const parsed = await p.parse(hit);
      session = { ...hit, msg_count: parsed.messages.length };
      messages = parsed.messages.map((m, i) => ({ ...m, seq: m.seq ?? i }));
      source = 'live';
      if (parsed.title) session.title = parsed.title;
    }
  } finally {
    index.close();
  }

  if (flags.json) {
    console.log(JSON.stringify({ session, messages }, null, 2));
    return;
  }

  console.log(bold(session.title || '(无标题)'));
  console.log(`  Agent      ${session.agent}${source === 'live' ? dim('（现场解析）') : ''}`);
  console.log(`  会话 ID    ${session.session_id || session.sessionId}`);
  console.log(`  项目       ${session.project_path || session.projectPath || '未知'}`);
  console.log(`  创建/更新  ${formatTime(session.created_at || session.createdAt)} / ${formatTime(session.updated_at || session.updatedAt)}`);
  console.log(`  消息       ${messages.length} 条`);
  console.log();

  const limit = flags.full ? messages.length : Number(flags.limit || 40);
  const shown = messages.slice(0, limit);
  for (const m of shown) {
    const kind = KIND_LABEL[m.kind] || m.kind;
    const role = ROLE_LABEL[m.role] || m.role;
    const tag = m.kind === 'text' ? '' : ` ${dim(`[${kind}]`)}`;
    const ts = m.ts ? dim(formatTime(m.ts)) : '';
    console.log(`${bold(`#${m.seq}`)} ${blue(role)}${tag} ${ts}`);
    if (m.kind === 'tool_call') {
      console.log(`  ${dim('工具')} ${m.tool_name || m.toolName || ''}`);
    }
    const text = String(m.text || '');
    const clipped = text.length > (flags.full ? 1e9 : 600) ? `${text.slice(0, 600)}\n  ${dim('…（--full 查看完整内容）')}` : text;
    for (const line of clipped.split('\n')) console.log(`  ${line}`);
    console.log();
  }
  if (messages.length > limit) {
    console.log(dim(`  仅显示前 ${limit} 条，共 ${messages.length} 条。用 --full 查看全部。`));
  }
}

async function cmdSearch(flags, positional) {
  const query = positional.join(' ');
  if (!query) throw new Error('用法：asv search <关键词> [--agent X] [--kind text,reasoning] [--limit N] [--json]');
  const index = openIndex(flags);
  const kinds = flags.kind ? String(flags.kind).split(',').map((s) => s.trim()).filter(Boolean) : null;
  const t0 = Date.now();
  const { mode, hits, total_matches: totalMatches, truncated } = index.search(query, {
    agent: flags.agent || null,
    project: flags.project || null,
    kinds,
    limit: Number(flags.limit || 25),
  });
  const ms = Date.now() - t0;

  if (flags.json) { console.log(JSON.stringify({ mode, ms, hits, total_matches: totalMatches, truncated }, null, 2)); index.close(); return; }

  if (!hits.length) {
    console.log(yellow(`未命中：${query}`));
    if (mode === 'like') {
      console.log(dim('  （短查询走全表扫描；如需更精确，请用 3 个字符以上的关键词走索引）'));
    }
    index.close();
    return;
  }

  console.log(bold(`命中 ${hits.length} 个会话 · ${totalMatches} 处消息`) + dim(`  ${ms}ms · ${mode === 'fts' ? '索引检索(trigram)' : '全表扫描(短查询兜底)'}`) + (truncated ? dim('（已截断）') : '') + '\n');
  for (const h of hits) {
    console.log(`${blue(h.agent)} ${bold((h.title || '(无标题)').slice(0, 46))}${h.match_count > 1 ? dim(`  ${h.match_count} 处`) : ''}`);
    console.log(`  ${dim(`${ROLE_LABEL[h.role] || h.role} · ${KIND_LABEL[h.kind] || h.kind} · ${formatTime(h.ts)}`)}`);
    console.log(`  ${makeSnippet(h.text, query)}`);
    console.log(`  ${dim(h.uid)}`);
    console.log();
  }
  index.close();
}

async function cmdExport(flags, positional) {
  const needle = positional[0];
  if (!needle) throw new Error('用法：asv export <会话uid> --out <文件.md|.html>');
  const index = openIndex(flags);
  const found = resolveSession(index, needle);
  if (!found) throw new Error(`未找到会话：${needle}`);
  if (found.ambiguous) throw new Error(`匹配到多个会话，请用完整 uid 指定`);
  const { session, messages } = found;

  const out = flags.out || `./export/${session.agent}-${session.session_id}.md`;
  const r = exportSession(session, messages, out, flags.format || null);
  console.log(green('导出成功'));
  console.log(`  文件  ${path.resolve(r.file)}`);
  console.log(`  格式  ${r.format}  ${humanSize(r.bytes)}`);
  console.log(`  内容  ${messages.length} 条消息`);
  index.close();
}

async function cmdBackup(flags) {
  const out = flags.out;
  if (!out) throw new Error('用法：asv backup --out <备份目录> [--agent X]');
  if (fs.existsSync(path.join(out, 'manifest.json')) && !flags.force) {
    throw new Error(`目标目录已存在备份：${out}\n  如需覆盖请加 --force（旧备份不会被自动删除）`);
  }
  const providers = reg.resolve(flags.agent);
  const tty = process.stdout.isTTY;
  let n = 0;
  const r = await backup({
    providers,
    out,
    agent: flags.agent || null,
    onProgress: (ev) => {
      n += 1;
      if (tty && n % 10 === 0) process.stdout.write(`\r  已复制 ${n} 个文件…`.padEnd(40));
    },
  });
  if (tty) process.stdout.write(`\r${' '.repeat(42)}\r`);
  const s = r.manifest.summary;
  console.log(bold('备份完成'));
  console.log(`  目录  ${path.resolve(out)}`);
  console.log(`  会话  ${s.sessions} 个`);
  console.log(`  文件  ${s.files} 个，${humanSize(s.bytes)}`);
  if (s.errors) console.log(`  ${red(`错误 ${s.errors} 个（详见 manifest.json 的 errors 字段）`)}`);
  console.log(dim('\n  还原请用：asv restore <备份目录> --apply'));
}

async function cmdRestore(flags, positional) {
  const dir = positional[0];
  if (!dir) throw new Error('用法：asv restore <备份目录> [--agent X] [--uid U] [--target 家目录] [--apply] [--overwrite] [--verify]');
  const opts = {
    dir,
    agent: flags.agent || null,
    uid: flags.uid || null,
    target: flags.target || null,
    verify: Boolean(flags.verify),
  };

  if (!flags.apply) {
    const p = planRestore(opts);
    console.log(bold('还原演练（未写入任何文件）\n'));
    console.log(`  备份创建于  ${formatTime(p.manifest.createdAt)}`);
    console.log(`  源机器      ${p.manifest.host}  家目录 ${p.srcHome}`);
    if (p.target) console.log(`  目标家目录  ${p.target}${dim('（路径前缀已重映射）')}`);
    console.log(`  会话        ${p.sessions} 个`);
    console.log(`  文件        ${p.items.length} 个，${humanSize(p.bytes)}`);
    console.log(`  将覆盖      ${p.conflicts} 个已存在文件`);
    if (p.missing) console.log(`  ${red(`备份内缺失 ${p.missing} 个文件`)}`);
    console.log();
    console.log(bold('  待写入清单：'));
    for (const it of p.items.slice(0, 40)) {
      const flag = it.conflict ? yellow('覆盖') : green('新建');
      console.log(`    ${flag}  ${it.dest}`);
    }
    if (p.items.length > 40) console.log(dim(`    … 其余 ${p.items.length - 40} 个`));
    console.log();
    console.log(yellow('  以上仅为演练。确认无误后加 --apply 才会真正写入。'));
    if (p.conflicts) console.log(yellow('  覆盖已存在文件还需额外加 --overwrite。'));
    return;
  }

  const explicit = Boolean(flags.yes) || process.env.ASV_CONFIRM === '1';
  const p0 = planRestore(opts);
  if (!explicit) {
    console.log(yellow(`即将写入 ${p0.items.length} 个文件，其中覆盖 ${p0.conflicts} 个已存在文件。`));
    console.log('  非交互环境不会自动确认：请显式加 --yes 表示你已确认。');
    console.log(dim('  建议先不加 --apply 运行一次，查看完整清单。'));
    return;
  }

  if (p0.conflicts && !flags.overwrite) {
    console.log(yellow(`检测到 ${p0.conflicts} 个已存在文件，未授权覆盖，这些文件将被跳过。`));
    console.log(dim('  如需覆盖请加 --overwrite。'));
  }

  const { result } = applyRestore({ ...opts, overwrite: Boolean(flags.overwrite) });
  console.log(bold('还原执行完毕'));
  console.log(`  写入  ${green(result.written)}`);
  console.log(`  跳过  ${result.skipped}${result.skipped ? dim('（冲突未授权覆盖）') : ''}`);
  console.log(`  失败  ${result.failed ? red(result.failed) : 0}`);
  const bad = result.details.filter((d) => !['written', 'conflict-skipped'].includes(d.status));
  for (const b of bad.slice(0, 20)) console.log(`    ${red(b.status)}  ${b.dest}`);
}

async function cmdMigrate(flags, positional) {
  const needle = positional[0];
  const to = flags.to;
  if (!needle || !to) {
    throw new Error(`用法：asv migrate <会话uid> --to <目标agent> --out <目录>\n  支持的目标：${Object.keys(TARGETS).join(', ')}`);
  }
  const index = openIndex(flags);
  const found = resolveSession(index, needle);
  if (!found) throw new Error(`未找到会话：${needle}（请先 asv index）`);
  if (found.ambiguous) throw new Error('匹配到多个会话，请用完整 uid 指定');
  const { session, messages } = found;

  const out = flags.out || `./migrated/${to}`;
  if (!flags.force) {
    const r = migrate({ session, messages, to, out, sanitize: true });
    index.close();
    console.log(bold('迁移产出完成'));
    console.log(`  目标  ${r.target.label}（${r.target.dialect} 方言）`);
    console.log(`  文件  ${r.file}`);
    console.log(`  说明  ${r.noteFile}`);
    console.log(`  保留  ${r.wroteMessages} 条文本消息`);
    console.log();
    console.log(red('  ⚠ 内容损失（格式不兼容，无法恢复）：'));
    console.log(`    工具调用 ${r.report.lostBreakdown.tool_call} 条、工具结果 ${r.report.lostBreakdown.tool_result} 条、推理过程 ${r.report.lostBreakdown.reasoning} 条`);
    console.log(`    源会话共 ${messages.length} 条消息，仅 ${r.report.keptMessages} 条被保留`);
    console.log();
    console.log(dim('  下一步：把产出目录复制到目标 Agent 的项目根目录'));
    console.log(dim(`    ${r.target.projectRoot()}`));
    console.log(dim('  注意：本工具不会改写目标 Agent 的会话索引库，其会话列表可能不会立即显示这条会话。'));
    return;
  }

  // 显式 --force：允许连工具调用一起写入（内容更全，但目标 Agent 未必能解析）
  const r = migrate({ session, messages, to, out, sanitize: false });
  index.close();
  console.log(bold('迁移产出完成（--force，不做清洗）'));
  console.log(`  文件  ${r.file}`);
  console.log(yellow('  已使用 --force：工具调用与推理块被原样写入，目标 Agent 可能无法解析这些块。'));
}

function cmdHelp() {
  console.log(`${bold('Agent Session Vault')} — 统一读取、检索、备份、还原多种 AI Agent 的会话记录

${bold('用法')}  asv <命令> [参数]

${bold('命令')}
  agents                          列出本机所有 Agent 及其数据来源状态
  scan        [--agent X] [--json] 只扫描会话，不建索引
  index       [--force] [--agent X]
                                  建/更新全文索引（默认增量，--force 全量重建）
  stats       [--json]            查看索引库概览
  list        [--agent X] [--project P] [--limit N] [--order created|updated]
              [--dir asc|desc] [--json]
                                  列出会话（--dir 排序方向，默认倒序）
  show        <uid|会话id> [--full] [--limit N] [--json]
                                  查看某会话的消息流
  search      <关键词> [--agent X] [--kind text,reasoning,tool_call,tool_result]
                      [--project P] [--limit N] [--json]
                                  全文检索（含中文）
  export      <uid> --out <文件> [--format md|html]
                                  导出为 Markdown / HTML
  backup      --out <目录> [--agent X] [--force]
                                  原样备份（含 SQLite 的 wal/shm）
  restore     <备份目录> [--agent X] [--uid U] [--target 家目录] [--verify]
              [--apply] [--yes] [--overwrite]
                                  还原。默认只演练；--apply 才写入
  migrate     <uid> --to <agent> --out <目录> [--keep-tools]
                                  跨 Agent 迁移（仅保真文本，详见输出提示）

${bold('全局参数')}
  --index <路径>   指定索引库位置（默认 ~/.agent-session-vault/index.db）

${bold('环境变量')}
  NO_COLOR=1       关闭彩色输出
  ASV_CONFIRM=1    非交互环境下允许 restore --apply 直接执行
  ASV_INDEX_CONCURRENCY=N  建索引的并发解析数（默认 4）

${bold('典型流程')}
  asv agents                     # 看看能读哪些
  asv index                      # 建索引
  asv search "会话记录"           # 检索
  asv backup --out D:/bak/asv    # 备份
`);
}

/* ----------------------------- 入口 ----------------------------- */

async function main(argv) {
  const { flags, positional } = parseArgs(argv);
  const cmd = positional.shift() || 'help';

  if (flags.help || flags.h || cmd === 'help') { cmdHelp(); return; }

  switch (cmd) {
    case 'agents': await cmdAgents(flags); break;
    case 'scan': await cmdScan(flags); break;
    case 'index': await cmdIndex(flags); break;
    case 'stats': await cmdStats(flags); break;
    case 'list': await cmdList(flags); break;
    case 'show': await cmdShow(flags, positional); break;
    case 'search': await cmdSearch(flags, positional); break;
    case 'export': await cmdExport(flags, positional); break;
    case 'backup': await cmdBackup(flags); break;
    case 'restore': await cmdRestore(flags, positional); break;
    case 'migrate': await cmdMigrate(flags, positional); break;
    case 'version': console.log(VERSION); break;
    default:
      console.log(red(`未知命令：${cmd}`));
      cmdHelp();
      process.exitCode = 1;
  }
}

module.exports = { main };

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(red(`错误：${e.message}`));
    process.exitCode = 1;
  });
}
