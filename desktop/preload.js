'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * 渲染进程只暴露这一组明确的能力，不做 nodeIntegration。
 * 所有磁盘访问都发生在主进程，渲染层只能通过这里的方法间接调用。
 */
contextBridge.exposeInMainWorld('asv', {
  agents: () => ipcRenderer.invoke('agents'),
  stats: () => ipcRenderer.invoke('stats'),
  index: (opts) => ipcRenderer.invoke('index', opts),
  list: (opts) => ipcRenderer.invoke('list', opts),
  search: (opts) => ipcRenderer.invoke('search', opts),
  show: (uid) => ipcRenderer.invoke('show', uid),
  showLive: (needle) => ipcRenderer.invoke('showLive', needle),
  exportSession: (opts) => ipcRenderer.invoke('export', opts),
  backup: (opts) => ipcRenderer.invoke('backup', opts),
  pickDir: (title) => ipcRenderer.invoke('pickDir', title),
  restorePlan: (opts) => ipcRenderer.invoke('restorePlan', opts),
  restoreApply: (opts) => ipcRenderer.invoke('restoreApply', opts),
  migrate: (opts) => ipcRenderer.invoke('migrate', opts),
  migrateTargets: () => ipcRenderer.invoke('migrateTargets'),
  openPath: (p) => ipcRenderer.invoke('openPath', p),
  openTerminal: (opts) => ipcRenderer.invoke('openTerminal', opts),
  agentIcon: (id) => ipcRenderer.invoke('agentIcon', id),

  onIndexProgress: (cb) => {
    const h = (ev, payload) => cb(payload);
    ipcRenderer.on('index:progress', h);
    return () => ipcRenderer.removeListener('index:progress', h);
  },
  onBackupProgress: (cb) => {
    const h = (ev, payload) => cb(payload);
    ipcRenderer.on('backup:progress', h);
    return () => ipcRenderer.removeListener('backup:progress', h);
  },
});
