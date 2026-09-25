'use strict';

/**
 * 桌面端功能探针（注入脚本，在渲染层执行）
 *
 * 由 `npm run probe`（electron . --probe test/ui-probe.js）经 desktop/main.js
 * 注入真实窗口运行。验证渲染层新增能力，不依赖人工点击：
 *   1. 会话详情打开后查找栏出现
 *   2. 会话内查找：高亮全部命中、计数、下一个 / 上一个、到末尾回绕
 *   3. 刷新的选区保护：正在选文字时检测到更新 → 挂提示 chip，DOM 不动
 *   4. 刷新的滚动保护：无选区时更新会话 → 重建 DOM 但滚动位置保留、高亮自动重挂
 *
 * 约定：顶层 return 一个 { pass: string[], fail: string[] }。
 */

const res = { pass: [], fail: [] };
try {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ok = (name, cond) => (cond ? res.pass.push(name) : res.fail.push(name));
  const $ = (s) => document.querySelector(s);
  const step = (m) => console.log('[probe] ' + m);

  // 1. 等列表渲染出来（boot 要先扫全部来源，可能要几秒），再打开第一个会话
  step('等待列表');
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && !document.querySelector('#list .item')) await sleep(200);
  step('列表就绪，点击首项');
  $('#list .item').click();
  // 详情是分批渲染 + 启动期还有图标抽取在抢 CPU，轮询等消息真正出现
  const dl = Date.now() + 15000;
  while (Date.now() < dl && !document.querySelector('#detail .msg')) await sleep(200);
  ok('详情已渲染消息', document.querySelectorAll('#detail .msg').length > 0);
  ok('查找栏随会话出现', $('#findBar').style.display === 'flex');

  // 2. 会话内查找（词条从正文动态取，并在候选里挑全局最低频的，避免几千个高亮拖死布局）
  step('开始查找');
  const detailAllText = $('#detail').textContent;
  const bodyText = (document.querySelector('#detail .msg .body') || {}).textContent || '';
  const candidates = bodyText.match(/[一-龥]{3}/g) || [];
  let word = null, best = Infinity;
  for (let i = 0; i < candidates.length && i < 2000; i += 1) {
    const w = candidates[i];
    const n = detailAllText.split(w).length - 1;
    if (n >= 2 && n <= 80 && n < best) { best = n; word = w; if (n <= 5) break; }
  }
  if (!word) throw new Error('正文里取不到 2~80 次命中的测试词条');
  step('测试词条: ' + word + '（约 ' + best + ' 处）');
  const box = $('#findBox');
  box.value = word;
  box.dispatchEvent(new Event('input'));
  await sleep(500);
  step('查找完成');
  const countText = $('#findCount').textContent;
  if (/过多/.test(countText)) throw new Error('测试词条命中过多，请换个取词方式');
  const marks = document.querySelectorAll('mark.find').length;

  // confirm 间谍必须装在第一次点「下一个」之前：命中在末尾时会弹原生框，
  // 隐藏窗口里没人点确定，整个渲染进程就死锁了
  const realConfirm = window.confirm;
  let confirmed = 0; window.confirm = () => { confirmed += 1; return true; };
  ok('命中高亮 > 1', marks > 1);
  ok('计数显示 1/N', /^1 \/ \d+$/.test($('#findCount').textContent));

  // 命中数 n≥3 时两次「下一个」应到 3；n=2 时第二次就回绕到 1——两种都算对
  const expectAfterTwo = marks >= 3 ? '3 ' : '1 ';
  document.querySelector('#btnFindNext').click(); await sleep(80);
  document.querySelector('#btnFindNext').click(); await sleep(80);
  ok('下一个推进计数', $('#findCount').textContent.startsWith(expectAfterTwo));
  document.querySelector('#btnFindPrev').click(); await sleep(80);
  ok('上一个回退计数', $('#findCount').textContent.startsWith('2 '));

  // 到末尾重搜：直接把游标拨到最后一个命中，再点一次「下一个」就该触发回绕
  findState.idx = findState.hits.length - 1;
  document.querySelector('#btnFindNext').click(); await sleep(100);
  ok('到末尾触发重搜确认', confirmed >= 1);
  ok('回绕后计数为 1', $('#findCount').textContent.startsWith('1 '));
  window.confirm = realConfirm;

  // 3. 选区保护：伪造「有更新」+ 构造选区 → 应挂 chip 且 DOM 不动
  //    注意先做选区再定 scrollTop：addRange 会触发一次隐式滚动
  step('构造选区');
  const detail = $('#detail');
  const tnode = document.querySelector('#detail .msg .body');
  let selOk = false;
  if (tnode && tnode.firstChild) {
    const rng = document.createRange();
    rng.selectNodeContents(tnode);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(rng);
    selOk = !sel.isCollapsed;
  }
  ok('测试选区已构造', selOk);
  detail.scrollTop = 600;
  const scrollBase = detail.scrollTop; // 实际生效值（可能被钳制）
  const htmlBefore = detail.innerHTML.length;
  current.sessionUpdatedAt = 1; // 伪造：记录的更新时间远旧于现在 → 视为有更新
  step('doRefresh #1（选区保护）');
  await doRefresh();
  step('doRefresh #1 返回');
  await sleep(300);
  ok('选区时挂出「有新内容」chip', $('#updChip').style.display === 'inline-block');
  ok('选区时 DOM 未被重建', detail.innerHTML.length === htmlBefore);
  ok('选区时滚动未动', detail.scrollTop === scrollBase);

  // 4. 无选区刷新 → 重建 DOM；查找词还活着时应停回当前命中
  step('doRefresh #2（高亮保持）');
  window.getSelection().removeAllRanges();
  await doRefresh();
  step('doRefresh #2 返回');
  await sleep(300);
  ok('无选区时 chip 收起', $('#updChip').style.display !== 'inline-block');
  ok('更新后当前命中保持高亮并定位', document.querySelector('mark.find.cur') !== null);
  ok('更新后命中全部重挂', document.querySelectorAll('mark.find').length >= marks - 2);

  // 5. 无查找词时刷新 → 纯滚动位置保护
  step('doRefresh #3（滚动保护）');
  box.value = ''; applyFind('');
  detail.scrollTop = scrollBase;
  const scrollPre = detail.scrollTop;
  current.sessionUpdatedAt = 1; // 再次伪造「有更新」，走重建分支
  await doRefresh();
  step('doRefresh #3 返回');
  await sleep(300);
  ok('更新后滚动位置保留', Math.abs(detail.scrollTop - scrollPre) < 40);
} catch (e) {
  res.fail.push('探针异常: ' + e.message);
}
return res;
