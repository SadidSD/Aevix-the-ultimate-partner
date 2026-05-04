'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aevixElectron', {
    onUpdateAvailable: (cb) => ipcRenderer.on('update-available', (_, info) => cb(info)),
    onUpdateDownloaded: (cb) => ipcRenderer.on('update-downloaded', (_, info) => cb(info)),
    installUpdate: () => ipcRenderer.send('install-update'),
    getVersion: () => ipcRenderer.invoke('get-version'),
});
