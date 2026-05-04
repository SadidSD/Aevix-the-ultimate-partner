'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wizardBridge', {
    complete: (config) => ipcRenderer.send('setup-complete', config),
});
