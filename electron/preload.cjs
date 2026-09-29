const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bushfireDesktop', {
  isElectron: true,
  getVersion: () => ipcRenderer.invoke('app:get-version'),

  saveGame: raw => ipcRenderer.invoke('save:write', raw),
  loadGame: () => ipcRenderer.invoke('save:read'),
  deleteSave: () => ipcRenderer.invoke('save:delete'),
  showSaveFolder: () => ipcRenderer.invoke('save:show-folder'),

  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  installUpdate: () => ipcRenderer.invoke('updates:install'),

  onUpdateStatus: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('updates:status', listener);
    return () => ipcRenderer.removeListener('updates:status', listener);
  }
});
