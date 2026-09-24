'use strict';

const { deriveTitle } = require('./model');

/**
 * 扫描与索引编排
 *
 * 把 provider 层（各家格式）与 index 层（检索）拼起来，
 * 提供「全量发现」「增量建索引」两个动作。
 */

/**
 * 发现所有 Provider 的会话。
 * @param {object[]} providers
 * @param {object} [opts]
 * @param {boolean} [opts.includeEmpty] 是否保留 0 字节的空会话
 * @returns {Promise<{sessions: object[], agents: object[]}>}
 */
async function discoverAll(providers, opts = {}) {
  const sessions = [];
  const agents = [];
  for (const p of providers) {
    const detect = p.detect();
    const entry = {
      id: p.id, label: p.label, family: p.family,
      available: detect.available, root: detect.root, reason: detect.reason,
      restricted: Boolean(p.restricted), count: 0, bytes: 0,
    };
    if (detect.available && !p.restricted) {
      try {
        const found = await p.discover();
        const kept = opts.includeEmpty === false ? found.filter((s) => s.bytes > 0) : found;
        for (const s of kept) {
          sessions.push(s);
          entry.count += 1;
          entry.bytes += s.bytes || 0;
        }
      } catch (e) {
        entry.available = false;
        entry.reason = `扫描失败：${e.message}`;
      }
    }
    agents.push(entry);
  }
  return { sessions, agents };
}

/**
 * 增量建索引。
 * @param {object} cfg
 * @param {object[]} cfg.providers
 * @param {import('./index-db').IndexDb} cfg.index
 * @param {boolean} [cfg.force] 忽略 mtime 强制重建
 * @param {(ev: object) => void} [cfg.onProgress]
 * @param {(name: string, args: any[]) => void} [cfg.log]
 */
async function buildIndex({ providers, index, force = false, onProgress = () => {}, log = () => {} }) {
  const { sessions, agents } = await discoverAll(providers);
  const t0 = Date.now();
  let indexed = 0, skipped = 0, failed = 0, totalMsgs = 0;

  const byAgent = new Map();
  for (const s of sessions) {
    if (!byAgent.has(s.agent)) byAgent.set(s.agent, []);
    byAgent.get(s.agent).push(s);
  }

  // 索引库里有、但这次扫描没再出现的会话 → 源已删除，清理掉。
  // 只清理本次扫描覆盖的 agent：--agent 过滤时其它 agent 的会话不归这次管
  const liveUids = new Set(sessions.map((s) => s.uid));
  const scannedAgents = new Set(providers.map((p) => p.id));
  let pruned = 0;
  for (const uid of index.allUids()) {
    const agent = uid.slice(0, uid.indexOf(':'));
    if (scannedAgents.has(agent) && !liveUids.has(uid)) { index.removeSession(uid); pruned += 1; }
  }
  if (pruned) log('prune', [`清理已消失的会话 ${pruned} 个`]);

  // 解析以文件 IO 为主，开小并发流水线；SQLite 写入保持串行，避免写锁竞争
  const concurrency = Math.max(1, Number(process.env.ASV_INDEX_CONCURRENCY) || 4);

  for (const p of providers) {
    const list = byAgent.get(p.id);
    if (!list || !list.length) continue;
    let cursor = 0;
    const worker = async () => {
      while (cursor < list.length) {
        const session = list[cursor];
        cursor += 1;
        if (!force && !index.needsIndex(session)) {
          skipped += 1;
          onProgress({ agent: p.id, uid: session.uid, skipped: true });
          continue;
        }
        try {
          const { messages, title, meta } = await p.parse(session);
          if (!session.title && title) session.title = title;
          if (!session.title && messages.length) session.title = deriveTitle(messages);
          // parse 阶段才能拿到的元数据（如逐行累计的 token usage）合并回会话
          if (meta && typeof meta === 'object') session.meta = { ...session.meta, ...meta };
          index.putSession(session, messages);
          indexed += 1;
          totalMsgs += messages.length;
          onProgress({ agent: p.id, uid: session.uid, messages: messages.length });
        } catch (e) {
          failed += 1;
          log('error', [`${p.id}/${session.sessionId} 解析失败：${e.message}`]);
          onProgress({ agent: p.id, uid: session.uid, error: e.message });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
  }

  index.setMeta('indexed_at', String(Date.now()));
  return {
    sessions: sessions.length, indexed, skipped, failed, pruned, totalMsgs,
    agents, elapsedMs: Date.now() - t0,
  };
}

/** 在正文中定位关键词并截取上下文片段 */
function makeSnippet(text, query, radius = 70) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const q = String(query || '');
  let at = q ? t.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (at < 0) at = 0;
  const start = Math.max(0, at - radius);
  const end = Math.min(t.length, at + q.length + radius);
  let out = t.slice(start, end);
  if (start > 0) out = `…${out}`;
  if (end < t.length) out = `${out}…`;
  return out;
}

const KIND_LABEL = {
  text: '正文', reasoning: '推理', tool_call: '工具调用', tool_result: '工具结果', meta: '元信息',
};
const ROLE_LABEL = { user: '用户', assistant: '助手', system: '系统', tool: '工具' };

module.exports = { discoverAll, buildIndex, makeSnippet, KIND_LABEL, ROLE_LABEL };
