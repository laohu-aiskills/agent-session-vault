'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFileSync } = require('child_process');

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');

const SMOKE = process.argv.includes('--smoke');
const SELFTEST = process.argv.includes('--selftest');
const SHOT_AT = process.argv.indexOf('--screenshot');
const SHOT_PATH = SHOT_AT >= 0 ? process.argv[SHOT_AT + 1] : null;
const PROBE_AT = process.argv.indexOf('--probe');
const PROBE_FILE = PROBE_AT >= 0 ? process.argv[PROBE_AT + 1] : null;

/* ------------------------------------------------------------------ *
 * 两种自检模式
 *
 * --smoke    ：核心依赖自检。验证 Electron 内置 Node 是否提供 node:sqlite、
 *              FTS5 trigram 中文检索是否可用、core 能否加载真实索引库。
 *              注意：若环境变量 ELECTRON_RUN_AS_NODE=1，Electron 会以纯 Node 运行，
 *              此时 app 不可用（本模式已兼容这种情形）。
 *
 * --selftest ：界面自检。真正创建窗口、注入脚本确认渲染层启动成功、
 *              并把会话列表渲染出来，然后自动退出。用于验证 GUI 链路。
 * ------------------------------------------------------------------ */
if (SMOKE) {
  const lines = [];
  let ok = true;
  const say = (s) => lines.push(s);
  try {
    say(`Electron: ${process.versions.electron}`);
    say(`Node    : ${process.versions.node}`);
    say(`Chrome  : ${process.versions.chrome}`);
    say(`运行模式: ${process.env.ELECTRON_RUN_AS_NODE ? '纯 Node（ELECTRON_RUN_AS_NODE=1，app 不可用）' : '完整 Electron'}`);
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    const v = db.prepare('select sqlite_version() as v').get().v;
    say(`SQLite  : ${v}`);
    try {
      db.exec("create virtual table t using fts5(body, tokenize='trigram')");
      db.exec("insert into t values ('帮我生成一个贪食蛇程序')");
      const hit = db.prepare("select body from t where t match '贪食蛇'").all();
      say(`FTS5    : 可用（trigram 中文命中 ${hit.length} 条）`);
      if (hit.length !== 1) ok = false;
    } catch (e) {
      say(`FTS5    : 不可用 -> ${e.message}`);
      ok = false;
    }
    const reg = require('../src/core/providers');
    const { IndexDb } = require('../src/core/index-db');
    const idx = new IndexDb(path.join(os.homedir(), '.agent-session-vault', 'index.db'));
    const st = idx.stats();
    idx.close();
    say(`索引库  : ${st.sessions} 会话 / ${st.messages} 消息`);
    say(`Provider: ${reg.all().length} 个已注册（实测验证 ${reg.VERIFIED.size} 家）`);
  } catch (e) {
    ok = false;
    say(`失败    : ${e.message}`);
  }
  process.stdout.write(`--- asv smoke ---\n${lines.join('\n')}\n结果: ${ok ? 'PASS' : 'FAIL'}\n`);
  if (typeof app !== 'undefined' && app) app.exit(ok ? 0 : 1);
  else process.exit(ok ? 0 : 1);
  return;
}

const reg = require('../src/core/providers');
const { IndexDb } = require('../src/core/index-db');
const { discoverAll, buildIndex } = require('../src/core/scan');
const { exportSession } = require('../src/core/export');
const { backup } = require('../src/core/backup');
const { planRestore, applyRestore } = require('../src/core/restore');
const { migrate, TARGETS } = require('../src/core/migrate');

const INDEX_FILE = path.join(os.homedir(), '.agent-session-vault', 'index.db');

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#f6f6f4',
    title: 'Agent Session Vault',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(async () => {
  createWindow();
  if (SELFTEST) { await runSelfTest(); return; }
  if (PROBE_FILE) { await runProbe(PROBE_FILE); return; }
  if (SHOT_PATH) { await captureScreenshot(SHOT_PATH); return; }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

/**
 * 界面截图：等 UI 渲染完成后把窗口截成 PNG 并退出。
 * 注意要在窗口可见的状态下截图，否则会得到空白图。
 */
async function captureScreenshot(out) {
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('加载超时')), 30000);
      win.webContents.once('did-finish-load', () => { clearTimeout(timer); resolve(); });
    });
    // 等列表与详情都渲染出来
    await win.webContents.executeJavaScript(`(async () => {
      const deadline = Date.now() + 25000;
      while (Date.now() < deadline) {
        if (document.querySelectorAll('#list .item').length > 0) break;
        await new Promise(r => setTimeout(r, 200));
      }
      document.querySelector('#list .item')?.click();
      await new Promise(r => setTimeout(r, 1600));
      return true;
    })()`);
    const img = await win.webContents.capturePage();
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, img.toPNG());
    process.stdout.write(`--- asv screenshot ---\n已保存: ${path.resolve(out)}\n`);
    app.exit(0);
  } catch (e) {
    process.stdout.write(`--- asv screenshot ---\n失败: ${e.message}\n`);
    app.exit(1);
  }
}

/**
 * 界面自检：等窗口真正加载完，再往渲染层注入脚本，
 * 确认 UI 已启动、会话列表已渲染、IPC 通道可用，然后退出。
 * 这是对「主进程 ↔ preload ↔ 渲染层」整条链路的验证。
 */
async function runSelfTest() {
  const lines = [];
  let ok = true;
  const say = (s) => lines.push(s);
  // 渲染层的报错不会出现在主进程 stdout，selftest 里转出来才能定位问题
  win.webContents.on('console-message', (ev, level, message, line, sourceId) => {
    say(`渲染层控制台[${level}]: ${message} (${sourceId}:${line})`);
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('窗口加载超时（30s）')), 30000);
      win.webContents.once('did-finish-load', () => { clearTimeout(timer); resolve(); });
      win.webContents.once('did-fail-load', (e, code, desc) => { clearTimeout(timer); reject(new Error(`加载失败 ${code} ${desc}`)); });
    });
    say('窗口加载      : 成功');

    // 等待渲染层的 boot() 完成（列表渲染出来为止）
    const probe = await win.webContents.executeJavaScript(`(async () => {
      const deadline = Date.now() + 25000;
      while (Date.now() < deadline) {
        const items = document.querySelectorAll('#list .item').length;
        const count = document.querySelector('#listCount').textContent;
        const st = document.querySelector('#stIndex').textContent;
        if (items > 0 || /没有会话|索引为空/.test(count + st)) {
          return { items, count, status: st, agents: document.querySelector('#stAgents').textContent,
                   hasApi: typeof window.asv === 'object', errors: document.querySelector('#status').textContent };
        }
        await new Promise(r => setTimeout(r, 200));
      }
      return { items: -1, count: document.querySelector('#listCount').textContent, errors: '超时' };
    })()`);

    say(`preload 桥接  : ${probe.hasApi ? '可用' : '不可用'}`);
    if (!probe.hasApi) ok = false;
    say(`来源统计      : ${probe.agents}`);
    say(`索引状态      : ${probe.status}`);
    say(`列表渲染      : ${probe.items} 条（${probe.count}）`);
    if (probe.items <= 0) ok = false;

    // 验证 IPC：检索 + 详情两条链路
    const ipc = await win.webContents.executeJavaScript(`(async () => {
      const s = await window.asv.search({ query: '会话', limit: 5 });
      const l = await window.asv.list({ limit: 3 });
      const one = l.rows && l.rows[0] ? await window.asv.show(l.rows[0].uid) : null;
      return { searchMode: s.mode, searchHits: s.hits.length, listRows: l.rows.length,
               detailMsgs: one ? one.messages.length : 0, detailTitle: one ? one.session.title : null };
    })()`);
    say(`IPC 检索      : mode=${ipc.searchMode}，命中 ${ipc.searchHits} 条`);
    say(`IPC 详情      : ${ipc.listRows} 行列表，首条「${String(ipc.detailTitle).slice(0, 24)}」共 ${ipc.detailMsgs} 条消息`);
    if (ipc.searchHits <= 0 || ipc.detailMsgs <= 0) ok = false;
  } catch (e) {
    ok = false;
    say(`失败          : ${e.message}`);
  }
  process.stdout.write(`--- asv selftest ---\n${lines.join('\n')}\n结果: ${ok ? 'PASS' : 'FAIL'}\n`);
  app.exit(ok ? 0 : 1);
}

/**
 * 渲染层功能探针：把 test/ui-probe.js 注入真实窗口执行（该脚本依赖主进程
 * 的 IPC handler，所以必须跑在完整 app 里而不是独立进程）。
 * 脚本顶层 return { pass: [], fail: [] }，这里汇总输出并以退出码表达结果。
 */
async function runProbe(clientFile) {
  try {
    win.webContents.on('console-message', (ev, level, message, line, sourceId) => {
      if (level >= 1) process.stdout.write(`  [渲染层] ${message}\n`);
    });
    process.stdout.write('  probe: 等待窗口加载\n');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('窗口加载超时（30s）')), 30000);
      win.webContents.once('did-finish-load', () => { clearTimeout(timer); resolve(); });
      win.webContents.once('did-fail-load', (e, code, desc) => { clearTimeout(timer); reject(new Error(`加载失败 ${code} ${desc}`)); });
    });
    process.stdout.write('  probe: 已加载，等待列表渲染\n');
    await new Promise((r) => setTimeout(r, 4000)); // 等 boot() 与列表渲染完成
    process.stdout.write('  probe: 注入探针\n');
    const src = fs.readFileSync(path.resolve(__dirname, '..', clientFile), 'utf8');
    const out = await win.webContents.executeJavaScript(`(async () => {\n${src}\n})()`);
    process.stdout.write('  probe: 探针返回\n');
    process.stdout.write('--- asv ui-probe ---\n');
    for (const p of out.pass) process.stdout.write(`  ✓ ${p}\n`);
    for (const f of out.fail) process.stdout.write(`  ✗ ${f}\n`);
    process.stdout.write(`结果: ${out.fail.length ? 'FAIL' : 'PASS'}（通过 ${out.pass.length}，失败 ${out.fail.length}）\n`);
    app.exit(out.fail.length ? 1 : 0);
  } catch (e) {
    process.stdout.write(`--- asv ui-probe ---\n失败: ${e.message}\n`);
    app.exit(1);
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* ----------------------------- IPC ----------------------------- */

// 每次调用开一个连接，用完即关：避免长时间持有句柄把库锁住
function withIndex(fn) {
  const idx = new IndexDb(INDEX_FILE);
  try {
    return fn(idx);
  } finally {
    idx.close();
  }
}

ipcMain.handle('agents', async () => {
  const { agents } = await discoverAll(reg.all());
  return agents.map((a) => ({ ...a, verified: reg.isVerified(a.id) }));
});

ipcMain.handle('stats', async () => withIndex((idx) => idx.stats()));

ipcMain.handle('index', async (ev, opts = {}) => {
  const idx = new IndexDb(INDEX_FILE);
  try {
    const r = await buildIndex({
      providers: reg.resolve(opts.agent || 'all'),
      index: idx,
      force: Boolean(opts.force),
      log: (k, a) => { if (win) win.webContents.send('index:progress', { kind: k, text: a.join(' ') }); },
      onProgress: (p) => { if (win) win.webContents.send('index:progress', { kind: 'progress', ...p }); },
    });
    return { ...r, stats: idx.stats() };
  } finally {
    idx.close();
  }
});

ipcMain.handle('list', async (ev, opts = {}) => withIndex((idx) => ({
  rows: idx.listSessions({
    agent: opts.agent || null,
    project: opts.project || null,
    limit: opts.limit ?? 100,
    order: opts.order || 'updated',
    dir: opts.dir === 'asc' ? 'asc' : 'desc',
  }),
  total: idx.stats().sessions,
})));

ipcMain.handle('search', async (ev, opts = {}) => withIndex((idx) => idx.search(opts.query, {
  agent: opts.agent || null,
  project: opts.project || null,
  kinds: opts.kinds || null,
  limit: opts.limit ?? 50,
})));

ipcMain.handle('show', async (ev, uid) => withIndex((idx) => {
  const found = idx.getSession(uid);
  if (found) return { ...found, source: 'index' };
  return null;
}));

ipcMain.handle('showLive', async (ev, needle) => {
  const { sessions } = await discoverAll(reg.all());
  const hit = sessions.find((s) => s.uid === needle || s.sessionId === needle);
  if (!hit) return null;
  const p = reg.get(hit.agent);
  const parsed = await p.parse(hit);
  return {
    session: { ...hit, title: parsed.title || hit.title, msg_count: parsed.messages.length },
    messages: parsed.messages,
    source: 'live',
  };
});

ipcMain.handle('export', async (ev, { uid, format }) => {
  const data = withIndex((idx) => idx.getSession(uid));
  if (!data) throw new Error('会话不存在');
  const defName = `${data.session.agent}-${data.session.session_id}.${format === 'html' ? 'html' : 'md'}`;
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: '导出会话',
    defaultPath: path.join(app.getPath('documents'), defName),
    filters: format === 'html'
      ? [{ name: 'HTML', extensions: ['html'] }]
      : [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (canceled || !filePath) return { canceled: true };
  const r = exportSession(data.session, data.messages, filePath, format);
  return { ...r, canceled: false };
});

ipcMain.handle('backup', async (ev, { agent }) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '选择备份输出目录',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (canceled || !filePaths.length) return { canceled: true };
  const out = path.join(filePaths[0], `asv-backup-${new Date().toISOString().slice(0, 10)}`);
  const r = await backup({
    providers: reg.resolve(agent || 'all'),
    out,
    agent: agent || null,
    onProgress: (p) => { if (win) win.webContents.send('backup:progress', p); },
  });
  return { canceled: false, out, summary: r.manifest.summary };
});

ipcMain.handle('restorePlan', async (ev, { dir, target }) => planRestore({ dir, target: target || null }));

ipcMain.handle('pickDir', async (ev, title) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: title || '选择目录',
    properties: ['openDirectory'],
  });
  return canceled || !filePaths.length ? null : filePaths[0];
});

ipcMain.handle('restoreApply', async (ev, { dir, target, overwrite }) => {
  const { result } = applyRestore({ dir, target: target || null, overwrite: Boolean(overwrite) });
  return result;
});

ipcMain.handle('migrate', async (ev, { uid, to }) => {
  const data = withIndex((idx) => idx.getSession(uid));
  if (!data) throw new Error('会话不存在');
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '选择迁移产出目录',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (canceled || !filePaths.length) return { canceled: true };
  const r = migrate({ session: data.session, messages: data.messages, to, out: filePaths[0], sanitize: true });
  // IPC 结构化克隆序列化不了函数：target.projectRoot 是方法，
  // 原样返回会让 invoke 在渲染层 reject（数据其实已写完，界面却停在「尚未执行」）
  return {
    canceled: false,
    file: r.file,
    noteFile: r.noteFile,
    dir: r.dir,
    slug: r.slug,
    newSessionId: r.newSessionId,
    wroteMessages: r.wroteMessages,
    report: r.report,
    target: { id: r.target.id, label: r.target.label, projectRoot: r.target.projectRoot() },
  };
});

ipcMain.handle('migrateTargets', async () => Object.values(TARGETS).map((t) => ({ id: t.id, label: t.label })));

ipcMain.handle('openPath', async (ev, p) => {
  if (fs.existsSync(p)) { await shell.openPath(path.dirname(p)); return true; }
  return false;
});

/* ---------------- Agent 真图标抽取 ----------------
 * 有 GUI 应用的 agent 直接从其 exe 里抽 icon（PowerShell GDI+，零原生依赖），
 * PNG 缓存在 ~/.agent-session-vault/icons/ 下；抽不到（npm CLI 壳只有 node 图标）
 * 返回 null，渲染层回退到手绘 SVG。 */
const ICON_DIR = path.join(os.homedir(), '.agent-session-vault', 'icons');
const AGENT_EXE_CANDIDATES = {
  workbuddy: ['%LOCALAPPDATA%\\Programs\\WorkBuddy\\WorkBuddy.exe'],
  qwenworkcn: ['%LOCALAPPDATA%\\Programs\\QwenWorkCN\\Launcher.exe'],
  zcode: ['%LOCALAPPDATA%\\Programs\\ZCode\\ZCode.exe'],
  opencode: ['%LOCALAPPDATA%\\Programs\\@opencode-aidesktop\\OpenCode.exe'],
  'kimi-code': ['%USERPROFILE%\\.kimi-code\\bin\\kimi.exe'],
  'kimi-cli': ['%USERPROFILE%\\.kimi-code\\bin\\kimi.exe'],
};
// MSIX（Microsoft Store）应用：exe 在 WindowsApps 下受 ACL 保护抽不了 icon，
// 但包内 assets 的 logo PNG 可读，直接按清单拷贝
const AGENT_MSIX = {
  codex: '*Codex*',
};
const MSIX_LOGO_CANDIDATES = [
  // Square150x150 是带品牌底色的完整应用图标；44x44 系多为透明底单色变体，
  // 在浅色列表里会糊成一片
  'assets\\Square150x150Logo.png',
  'assets\\Square150x150Logo.scale-200.png',
  'assets\\Square44x44Logo.scale-200.png',
  'assets\\Square44x44Logo.scale-100.png',
  'assets\\Square44x44Logo.png',
];
const iconMem = new Map();

function expandEnv(p) {
  return p.replace(/%([^%]+)%/g, (_, n) => process.env[n] || '');
}

function msixLogoPng(pattern, outFile) {
  let loc = '';
  try {
    loc = execFileSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-AppxPackage -Name '${pattern}' | Select-Object -First 1).InstallLocation`],
      { timeout: 30000, windowsHide: true, encoding: 'utf8' }).trim();
  } catch {
    return false;
  }
  if (!loc) return false;
  for (const rel of MSIX_LOGO_CANDIDATES) {
    const src = path.join(loc, rel);
    if (fs.existsSync(src)) {
      try {
        fs.copyFileSync(src, outFile);
        return true;
      } catch { /* 换下一个候选 */ }
    }
  }
  return false;
}

function extractIconPng(exe, out) {
  const ps = [
    "Add-Type -AssemblyName System.Drawing",
    `$i=[System.Drawing.Icon]::ExtractAssociatedIcon('${exe.replace(/'/g, "''")}')`,
    "if($i){ $i.ToBitmap().Save('" + out.replace(/'/g, "''") + "',[System.Drawing.Imaging.ImageFormat]::Png) }",
  ].join('; ');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    timeout: 20000, windowsHide: true, stdio: 'ignore',
  });
  return fs.existsSync(out);
}

ipcMain.handle('agentIcon', async (ev, id) => {
  if (iconMem.has(id)) return iconMem.get(id);
  let dataUrl = null;
  fs.mkdirSync(ICON_DIR, { recursive: true });
  const png = path.join(ICON_DIR, `${id}.png`);
  const exe = (AGENT_EXE_CANDIDATES[id] || []).map(expandEnv).find((p) => fs.existsSync(p));
  try {
    if (exe) {
      if (!fs.existsSync(png)) extractIconPng(exe, png);
    } else if (AGENT_MSIX[id] && !fs.existsSync(png)) {
      msixLogoPng(AGENT_MSIX[id], png);
    }
    if (fs.existsSync(png)) {
      dataUrl = 'data:image/png;base64,' + fs.readFileSync(png).toString('base64');
    }
  } catch { /* 抽取失败回落 SVG */ }
  iconMem.set(id, dataUrl);
  return dataUrl;
});

/**
 * 在指定目录打开终端（供「终端继续」用：cd 到会话项目目录，直接续接 CLI 会话）。
 * 优先 Windows Terminal，未安装回退传统 cmd 窗口。
 * command 为空时只 cd 不执行命令。
 */
ipcMain.handle('openTerminal', async (ev, { dir, command }) => {
  if (!dir || !fs.existsSync(dir)) return { ok: false, error: `目录不存在：${dir}` };
  const cmdline = command ? `cd /d "${dir}" && ${command}` : `cd /d "${dir}"`;
  return new Promise((resolve) => {
    try {
      const wt = spawn('wt.exe', ['-d', dir, 'cmd.exe', '/k', command || ''], {
        detached: true, stdio: 'ignore',
      });
      wt.once('spawn', () => resolve({ ok: true, via: 'wt' }));
      wt.once('error', () => {
        try {
          spawn('cmd.exe', ['/c', 'start', '', 'cmd.exe', '/k', cmdline], {
            detached: true, stdio: 'ignore',
          }).unref();
          resolve({ ok: true, via: 'cmd' });
        } catch (e) {
          resolve({ ok: false, error: e.message });
        }
      });
    } catch (e) {
      resolve({ ok: false, error: e.message });
    }
  });
});
