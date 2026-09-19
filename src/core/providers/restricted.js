'use strict';

const os = require('os');
const path = require('path');
const { isDir } = require('../util');

/**
 * 受限 Provider —— 这些 Agent 在本机存在，但磁盘上没有可靠的会话正文。
 *
 * 之所以仍然注册它们，是为了让 `asv agents` 能明确回答
 * 「这家为什么扫不到东西」，而不是静默漏掉、让人以为是工具的 bug。
 * 每一家都带实测结论（详见 reason），discover() 恒返回空。
 */
class RestrictedProvider {
  /**
   * @param {object} cfg
   * @param {string} cfg.id
   * @param {string} cfg.label
   * @param {string} cfg.probePath 用于判断是否安装
   * @param {string} cfg.reason    实测结论：为什么读不到正文
   */
  constructor(cfg) {
    this.id = cfg.id;
    this.label = cfg.label;
    this.family = 'restricted';
    this.root = cfg.probePath.startsWith('~')
      ? path.join(os.homedir(), cfg.probePath.slice(1))
      : cfg.probePath;
    this.reason = cfg.reason;
    this.restricted = true;
  }

  detect() {
    if (!isDir(this.root)) {
      return { available: false, root: this.root, reason: `目录不存在：${this.root}` };
    }
    return { available: false, root: this.root, reason: this.reason, installed: true };
  }

  async discover() {
    return [];
  }

  async parse() {
    return { messages: [], title: null };
  }

  originalPaths() {
    return [];
  }

  projectDir() {
    return this.root;
  }
}

module.exports = { RestrictedProvider };
