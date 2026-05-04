'use strict';
// Clears ELECTRON_RUN_AS_NODE (set by VS Code/Electron host) before launching,
// otherwise electron.exe runs in Node-only mode and require('electron') is unavailable.
const { spawn } = require('child_process');
const path = require('path');
const electronPath = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, ['.'], {
    cwd: path.join(__dirname, '..'),
    env,
    stdio: 'inherit',
});
child.on('exit', code => process.exit(code ?? 0));
