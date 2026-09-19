'use strict';

/**
 * 端到端验证脚本
 *
 * 用本机真实数据跑通「发现 → 索引 → 检索 → 详情 → 导出 → 备份 → 还原 → 迁移」全链路，
 * 并对还原结果做字节级 sha256 校验。
 *
 * 安全性：所有写操作都落在 <项目>/.scratch 下，不会写任何真实 Agent 数据目录。
 * 备份阶段只读原始数据。
 *
 * 用法：node test/verify.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRATCH = path.join(ROOT, '.scratch');
const NODE = process.execPath;
const ASV = path.join(ROOT, 'bin', 'asv');
const INDEX = path.join(SCRATCH, 'index.db');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  \u2713 ${name}`); } else {
    fail += 1; failures.push(name);
    console.log(`  \u2717 ${name}${detail ? `  ${detail}` : ''}`);
  }
}

function run(args) {
  return execFileSync(NODE, ['--no-warnings', ASV, ...args], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
}

function runJson(args) {
  // 所有支持 --json 的子命令都会输出纯 JSON（不再混排人读文本），可直接解析
  const out = run([...args, '--json']).trim();
  return JSON.parse(out);
}

const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

/** 递归收集文件 */
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

async function main() {
  console.log('\n=== Agent Session Vault 端到端验证 ===\n');
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(SCRATCH, { recursive: true });

  console.log('[1] 环境探知');
  const agents = runJson(['agents', '--index', INDEX]);
  const readable = agents.filter((a) => a.available && !a.restricted);
  const restricted = agents.filter((a) => a.restricted);
  check('探测到可读 Agent 来源', readable.length >= 7, `实测 ${readable.length} 家：${readable.map((a) => a.id).join(', ')}`);
  check('受限来源被如实标注而非静默丢弃', restricted.length >= 2, `${restricted.length} 家受限`);
  check('受限来源带有明确原因', restricted.every((a) => a.reason && a.reason.length > 10));

  console.log('\n[2] 建索引');
  const t0 = Date.now();
  const idxOut = run(['index', '--force', '--index', INDEX]);
  const idxMs = Date.now() - t0;
  const stats = runJson(['stats', '--index', INDEX]);
  check('索引库有会话', stats.sessions > 100, `会话 ${stats.sessions}`);
  check('索引库有消息', stats.messages > 1000, `消息 ${stats.messages}`);
  check('覆盖多家 Agent', stats.byAgent.length >= 6, `覆盖 ${stats.byAgent.length} 家`);
  console.log(`      建索引耗时 ${(idxMs / 1000).toFixed(1)}s，库体积 ${(stats.dbSize / 1048576).toFixed(1)}MB`);

  console.log('\n[3] 检索双通道');
  const fts = runJson(['search', '贪食蛇', '--index', INDEX, '--limit', '5']);
  check('3 字查询走 FTS 索引', fts.mode === 'fts', `mode=${fts.mode}`);
  check('3 字查询有命中', fts.hits.length > 0);
  const like = runJson(['search', '会话', '--index', INDEX, '--limit', '5']);
  check('2 字查询自动降级为扫描', like.mode === 'like', `mode=${like.mode}`);
  check('2 字中文查询有命中（trigram 不支持，必须靠兜底）', like.hits.length > 0);
  const filtered = runJson(['search', '测试', '--agent', 'claude-code', '--index', INDEX, '--limit', '5']);
  check('Agent 过滤生效', filtered.hits.every((h) => h.agent === 'claude-code'));

  console.log('\n[4] 会话详情');
  const list = runJson(['list', '--limit', '5', '--index', INDEX]);
  check('列表返回会话', list.length > 0);
  check('列表带标题', list.filter((r) => r.title).length > 0);
  const target = list[0];
  const shown = run(['show', target.uid, '--limit', '5', '--index', INDEX]);
  check('详情渲染成功', shown.includes('会话 ID'));
  check('详情含消息编号', /#0/.test(shown));

  console.log('\n[5] 导出');
  const mdFile = path.join(SCRATCH, 'export.md');
  const htmlFile = path.join(SCRATCH, 'export.html');
  run(['export', target.uid, '--out', mdFile, '--index', INDEX]);
  run(['export', target.uid, '--out', htmlFile, '--index', INDEX]);
  check('Markdown 已生成', fs.existsSync(mdFile) && fs.statSync(mdFile).size > 200);
  check('HTML 已生成', fs.existsSync(htmlFile) && fs.statSync(htmlFile).size > 500);
  const html = fs.readFileSync(htmlFile, 'utf8');
  check('HTML 自包含（无外部资源引用）',
    !/src\s*=\s*["']https?:/i.test(html) && !/<link[^>]+https?:/i.test(html),
    '导出件必须能在离线内网直接打开');

  console.log('\n[6] 备份');
  const bakDir = path.join(SCRATCH, 'backup');
  const bakOut = run(['backup', '--out', bakDir, '--agent', 'zcode']);
  check('备份目录已生成', fs.existsSync(path.join(bakDir, 'manifest.json')));
  const manifest = JSON.parse(fs.readFileSync(path.join(bakDir, 'manifest.json'), 'utf8'));
  check('manifest 格式正确', manifest.format === 'agent-session-vault/backup');
  check('备份记录了文件 sha256', manifest.files.every((f) => f.sha256 && f.sha256.length === 64));
  check('SQLite 备份带上 wal/shm（否则会丢最新事务）',
    manifest.files.some((f) => f.rel.endsWith('-wal')) || manifest.files.some((f) => f.rel.endsWith('-shm')),
    '未发现 -wal/-shm');

  console.log('\n[7] 还原安全性');
  const noApply = run(['restore', bakDir, '--target', path.join(SCRATCH, 'restore')]);
  check('默认只演练不写盘', noApply.includes('未写入任何文件'));
  check('演练目标目录未被创建', !fs.existsSync(path.join(SCRATCH, 'restore')));
  const noYes = run(['restore', bakDir, '--target', path.join(SCRATCH, 'restore'), '--apply']);
  check('非交互环境缺少 --yes 时拒绝执行', noYes.includes('请显式加 --yes'));
  check('仍未被创建', !fs.existsSync(path.join(SCRATCH, 'restore')));

  console.log('\n[8] 还原并校验完整性');
  const restoreDir = path.join(SCRATCH, 'restore');
  const applied = run(['restore', bakDir, '--target', restoreDir, '--apply', '--yes', '--verify']);
  check('还原报告写入成功', /写入\s+3/.test(applied) || applied.includes('失败  0'));
  const restored = walk(restoreDir);
  check('还原出文件', restored.length === manifest.files.length,
    `期望 ${manifest.files.length}，实际 ${restored.length}`);
  let allMatch = true;
  for (const f of manifest.files) {
    const base = path.basename(f.rel);
    const hit = restored.find((r) => path.basename(r) === base);
    if (!hit || sha256(hit) !== f.sha256) { allMatch = false; }
  }
  check('还原文件与清单 sha256 逐字节一致', allMatch);

  console.log('\n[9] 跨 Agent 迁移');
  const migOut = path.join(SCRATCH, 'migrated');
  const mig = run(['migrate', target.uid, '--to', 'claude-code', '--out', migOut, '--index', INDEX]);
  check('迁移产出目标格式文件', mig.includes('迁移产出完成'));
  check('如实报告工具调用丢失', mig.includes('工具调用') && mig.includes('推理过程'));
  const migFiles = walk(migOut);
  const jsonl = migFiles.find((f) => f.endsWith('.jsonl'));
  check('生成 .jsonl 会话文件', Boolean(jsonl));
  check('生成落位说明文件', migFiles.some((f) => f.endsWith('.asv-migration.json')));
  if (jsonl) {
    const lines = fs.readFileSync(jsonl, 'utf8').trim().split('\n');
    let allParsed = true;
    for (const l of lines) { try { JSON.parse(l); } catch { allParsed = false; } }
    check('产出文件每行都是合法 JSON', allParsed);
    const hasMarker = lines.some((l) => l.includes('asv-migration') || l.includes('asv_migration'));
    check('产出文件带迁移标记（便于识别导入会话）', hasMarker);
  }

  console.log('\n[10] 容错：脏数据不应导致整体失败');
  const dirty = path.join(SCRATCH, 'dirty.jsonl');
  fs.writeFileSync(dirty, [
    JSON.stringify({ id: 'x', timestamp: Date.now(), type: 'message', role: 'user', content: [{ type: 'input_text', text: '第一条' }], sessionId: 'dirty-sess', cwd: 'C:\\tmp' }),
    '{"id":"broken", "type":"message", "role":"assist',   // 半行（模拟崩溃）
    JSON.stringify({ id: 'y', timestamp: Date.now(), type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '第二条' }], sessionId: 'dirty-sess', cwd: 'C:\\tmp' }),
  ].join('\n') + '\n', 'utf8');
  const { JsonlProjectProvider } = require('../src/core/providers/jsonl-project');
  const p = new JsonlProjectProvider({ id: 't', label: 'T', root: path.join(SCRATCH, 'dirtyroot') });
  const { eachLine, tryParse } = require('../src/core/util');
  const msgs = [];
  const known = { type: 'message' };
  await eachLine(dirty, (line) => {
    const o = tryParse(line);
    if (o && o.type === known.type) msgs.push(o);
    // 脏行交给解析器跳过，读取循环不中断
  });
  check('脏尾行被跳过且后续行仍被读到', msgs.length === 2, `读到 ${msgs.length} 条，应为 2`);

  console.log(`\n=== 结果：通过 ${pass}，失败 ${fail} ===`);
  if (fail) {
    console.log('失败项：');
    for (const f of failures) console.log(`  - ${f}`);
  }
  console.log(`\n临时产物位于：${SCRATCH}（可安全删除）\n`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((e) => {
  console.error('\n验证脚本异常：', e.message);
  console.error(e.stack);
  process.exitCode = 2;
});
