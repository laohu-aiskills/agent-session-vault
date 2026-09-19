#!/usr/bin/env node
'use strict';
/**
 * 构建单文件可执行程序（Node SEA 方案）。
 *
 * 为什么需要 bundler：
 *   SEA 把主脚本当作"内置模块"执行，主脚本里的 `require('./x')` 会被当成
 *   内置模块名去解析，直接报 ERR_UNKNOWN_BUILTIN_MODULE（已实测）。
 *   因此必须先把整个项目压成一个不依赖相对路径的单文件。
 *
 * 本 bundler 只处理本项目的代码形态：CommonJS + 字面量 require。
 * 内置模块转发给原生 require，相对路径在构建期解析成模块 id。
 *
 * 用法：
 *   node tools/build-sea.js            构建 dist/asv.exe
 *   node tools/build-sea.js --keep     保留中间产物（便于排查）
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(ROOT, 'bin', 'asv');
const OUT_DIR = path.join(ROOT, 'dist');
const WORK = path.join(ROOT, '.build-sea');
const OUT_EXE = path.join(OUT_DIR, 'asv.exe');
const { version: PKG_VERSION } = require(path.join(ROOT, 'package.json'));

const KEEP = process.argv.includes('--keep');

/** SEA 的哨兵 fuse，Node 各版本此值固定 */
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const RE_REQUIRE = /\brequire\(\s*(['"])([^'"]+)\1\s*\)/g;

const log = (m) => process.stdout.write(`  ${m}\n`);
const step = (m) => process.stdout.write(`\n▸ ${m}\n`);

function stripShebang(src) {
  return src.replace(/^#![^\n]*\n/, '');
}

function isRelative(spec) {
  return spec === '.' || spec === '..' || spec.startsWith('./') || spec.startsWith('../');
}

function resolveModule(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const c of [base, `${base}.js`, `${base}.json`, path.join(base, 'index.js')]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

const idOf = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');

/** 从入口出发，递归收集所有本地模块，并把 require 参数改写成模块 id */
function collect(entryFile) {
  const mods = new Map();
  const queue = [entryFile];

  while (queue.length) {
    const file = queue.pop();
    const id = idOf(file);
    if (mods.has(id)) continue;

    let code = stripShebang(fs.readFileSync(file, 'utf8'));
    const json = file.endsWith('.json');

    if (json) {
      // JSON 字面量本身就是合法 JS 表达式，直接内联最省事
      mods.set(id, `module.exports = ${fs.readFileSync(file, 'utf8').trim()};`);
      continue;
    }

    code = code.replace(RE_REQUIRE, (_m, q, spec) => {
      if (!isRelative(spec)) return `require(${q}lib:${spec}${q})`;
      const abs = resolveModule(file, spec);
      if (!abs) throw new Error(`无法解析 require('${spec}')，来自 ${id}`);
      queue.push(abs);
      return `require(${q}mod:${idOf(abs)}${q})`;
    });

    mods.set(id, code);
  }

  return mods;
}

function indent(code, n) {
  const pad = ' '.repeat(n);
  return code
    .split('\n')
    .map((l) => (l.length ? pad + l : l))
    .join('\n');
}

function makeBundle(mods, entryId) {
  const defs = [...mods.entries()]
    .map(([id, code]) => `    ${JSON.stringify(`mod:${id}`)}: function (module, exports, require) {\n${indent(code, 6)}\n    },`)
    .join('\n');

  return `'use strict';
// 由 tools/build-sea.js 生成，请勿手工编辑。
// SEA 环境下主脚本无法 require 相对路径，因此所有本地模块在此内联。
(function (__nativeRequire) {
  // Windows 控制台默认代码页会让中文乱码，显式指定 UTF-8
  try { process.stdout.setDefaultEncoding('utf8'); } catch (e) { /* 忽略 */ }

  // node:sqlite 仍是实验特性，Node 每次启动都会打印 ExperimentalWarning。
  // 对本工具而言纯属噪音（用户会误以为出错），这里只过滤这一条，其余告警照常输出。
  (function () {
    var __emit = process.emit;
    process.emit = function (name, payload) {
      if (name === 'warning' && payload && payload.name === 'ExperimentalWarning') return false;
      return __emit.apply(this, arguments);
    };
  })();

  var __defs = {
${defs}
  };

  var __cache = {};
  function __load(id) {
    var def = __defs[id];
    if (!def) throw new Error('未找到模块: ' + id);
    var hit = __cache[id];
    if (hit) return hit.exports;
    var m = { exports: {} };
    __cache[id] = m;
    def(m, m.exports, __req);
    return m.exports;
  }

  function __req(id) {
    // lib: 前缀 -> 交给原生 require 处理内置模块（SEA 下仍然可用，已实测）
    if (id.slice(0, 4) === 'lib:') return __nativeRequire(id.slice(4));
    return __load(id);
  }

  __load(${JSON.stringify(`mod:${entryId}`)});
})(require);
`;
}

/* ------------------------------------------------------------------ */

function main() {
  if (!fs.existsSync(ENTRY)) throw new Error(`入口不存在: ${ENTRY}`);

  step('1/5 静态打包');
  const mods = collect(ENTRY);
  const entryId = idOf(ENTRY);
  const bundle = makeBundle(mods, entryId);
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  const bundleFile = path.join(WORK, 'asv.bundle.cjs');
  fs.writeFileSync(bundleFile, bundle, 'utf8');
  log(`模块 ${mods.size} 个 -> ${path.relative(ROOT, bundleFile)}（${(bundle.length / 1024).toFixed(0)} KB）`);
  for (const id of mods.keys()) log(`  · ${id}`);

  step('2/5 生成 SEA blob');
  const cfgFile = path.join(WORK, 'sea-config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({
    main: bundleFile,
    output: path.join(WORK, 'asv.blob'),
    disableExperimentalSEAWarning: true,
  }, null, 2), 'utf8');
  execFileSync(process.execPath, ['--experimental-sea-config', cfgFile], { stdio: 'pipe' });
  const blob = path.join(WORK, 'asv.blob');
  log(`blob -> ${(fs.statSync(blob).size / 1024).toFixed(0)} KB`);

  step('3/5 复制 Node 运行时');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.copyFileSync(process.execPath, OUT_EXE);
  log(`以 ${process.version} 为基础 -> ${(fs.statSync(OUT_EXE).size / 1048576).toFixed(1)} MB`);

  step('4/5 注入 blob');
  // Windows 上 execFileSync 直接跑 .cmd 会被安全策略拒绝，因此调用 postject 的 JS 入口
  const postjectCli = path.join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js');
  if (!fs.existsSync(postjectCli)) throw new Error('缺少 postject，请先 npm i -D postject');
  execFileSync(process.execPath, [
    postjectCli, OUT_EXE, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', SEA_FUSE,
  ], { stdio: 'pipe' });
  log(`${path.relative(ROOT, OUT_EXE)}（${(fs.statSync(OUT_EXE).size / 1048576).toFixed(1)} MB）`);

  step('5/5 自检');
  // SEA 下 process.argv 的偏移与 `node script.js` 不同，这里必须实测而非假定
  const ver = execFileSync(OUT_EXE, ['version'], { encoding: 'utf8' }).trim();
  log(`argv 偏移检查 -> version 输出「${ver}」`);
  if (ver !== PKG_VERSION) {
    throw new Error(`命令行参数未被正确解析（期望 ${PKG_VERSION}，实得「${ver}」）。SEA 下 process.argv 结构不同，需要在入口处归一化。`);
  }

  if (!KEEP) fs.rmSync(WORK, { recursive: true, force: true });
  process.stdout.write(`\n完成: ${OUT_EXE}\n`);
}

try {
  main();
} catch (e) {
  process.stderr.write(`\n构建失败: ${e.message}\n`);
  if (e.stdout) process.stderr.write(String(e.stdout));
  if (e.stderr) process.stderr.write(String(e.stderr));
  process.exitCode = 1;
}
