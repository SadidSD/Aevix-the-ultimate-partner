'use strict';
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain } = require('electron');

const path = require('path');
const fs = require('fs');
const http = require('http');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');

// ─── Runtime state ────────────────────────────────────────────────────
const PORT = 3001;
let isDev, USER_DATA, APP_ROOT, CONFIG_PATH;

function initPaths() {
    isDev = !app.isPackaged;
    USER_DATA = app.getPath('userData');
    APP_ROOT = app.isPackaged
        ? path.join(process.resourcesPath, 'app')
        : path.join(__dirname, '..');
    CONFIG_PATH = path.join(USER_DATA, 'aevix.config.json');
}

// ─── File logger ──────────────────────────────────────────────────────
function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    console.log(msg);
    try {
        const logPath = path.join(USER_DATA, 'logs', 'aevix-startup.log');
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        fs.appendFileSync(logPath, line, 'utf-8');
    } catch (_) {}
}

// ─── JSON Config ──────────────────────────────────────────────────────
function readConfig() {
    try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); } catch { return {}; }
}
function writeConfig(data) {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), 'utf-8');
}
function hasValidConfig() {
    const c = readConfig();
    if (!c.LLM_PROVIDER) return false;
    if (c.LLM_PROVIDER === 'groq' && !c.GROQ_API_KEY) return false;
    return true;
}
function getStoredEnv() {
    const c = readConfig(), env = {};
    ['LLM_PROVIDER','GROQ_API_KEY','GROQ_MODEL','LOCAL_LLM_URL','LOCAL_LLM_MODEL']
        .forEach(k => { if (c[k]) env[k] = c[k]; });
    return env;
}

// ─── Bootstrap user data ──────────────────────────────────────────────
function bootstrapUserData() {
    ['tasks','system','logs','logs/activity','logs/activities',
     'logs/patterns','logs/patterns/daily','skills'].forEach(d =>
        fs.mkdirSync(path.join(USER_DATA, d), { recursive: true }));
    ['tasks/Owner-Tasks.md','tasks/Aevix-Tasks.md','tasks/Targets.md',
     'system/Identity.md','system/Core-Identity.md','system/Owner-Identity.md',
     'system/Tools.md','system/Agents.md','system/OpeningFunction.md',
     'classifications.json'].forEach(f => {
        const dest = path.join(USER_DATA, f);
        const src  = path.join(APP_ROOT, f);
        if (!fs.existsSync(dest) && fs.existsSync(src)) {
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(src, dest);
        }
    });
}

// ─── ActivityWatch ────────────────────────────────────────────────────
const awProcesses = [];

function startActivityWatch() {
    const awDir = app.isPackaged
        ? path.join(process.resourcesPath, 'activitywatch')
        : path.join(__dirname, '..', 'extraResources', 'activitywatch');

    const binaries = [
        ['aw-server', 'aw-server.exe'],
        ['aw-watcher-window', 'aw-watcher-window.exe'],
        ['aw-watcher-afk', 'aw-watcher-afk.exe'],
    ];

    for (const [dir, exe] of binaries) {
        const bin = path.join(awDir, dir, exe);
        if (!fs.existsSync(bin)) { console.warn(`[AW] Not found: ${bin}`); continue; }
        try {
            const proc = spawn(bin, [], { cwd: path.dirname(bin), detached: false, stdio: 'ignore' });
            proc.on('error', err => console.warn(`[AW] ${exe}:`, err.message));
            awProcesses.push(proc);
            console.log(`[AW] Started: ${exe}`);
        } catch (e) { console.warn(`[AW] Failed to start ${exe}:`, e.message); }
    }
}

function stopActivityWatch() {
    for (const proc of awProcesses) { try { proc.kill(); } catch (_) {} }
    awProcesses.length = 0;
}

// ─── Express server (runs in-process via dynamic import) ──────────────
let isQuitting = false;

async function startServer() {
    // Inject env vars so index.js and agent.js find the right paths
    process.env.PORT = String(PORT);
    process.env.AEVIX_APP_ROOT = APP_ROOT;
    process.env.AEVIX_USER_DATA = USER_DATA;
    process.env.NODE_ENV = isDev ? 'development' : 'production';
    Object.assign(process.env, getStoredEnv());

    // Change cwd so relative file I/O (tasks/, logs/, etc.) resolves to userData
    try { process.chdir(USER_DATA); } catch (_) {}

    try {
        await import(pathToFileURL(path.join(APP_ROOT, 'index.js')).href);
        log('[server] Express started in-process');
    } catch (err) {
        log(`[server] Failed to import index.js: ${err.stack || err.message}`);
        throw err;
    }
}

function waitForServer(maxAttempts = 30) {
    return new Promise((resolve, reject) => {
        let attempts = 0;
        const check = () => {
            const req = http.get(`http://localhost:${PORT}/api/status`, res => {
                if (res.statusCode === 200) return resolve();
                retry();
            });
            req.on('error', retry);
            req.setTimeout(500, () => { req.destroy(); retry(); });
        };
        const retry = () => { if (++attempts >= maxAttempts) return reject(new Error('Server did not start')); setTimeout(check, 600); };
        check();
    });
}

// ─── Setup wizard ─────────────────────────────────────────────────────
function showSetupWizard() {
    return new Promise(resolve => {
        const win = new BrowserWindow({
            width: 580, height: 540, resizable: false, center: true,
            title: 'Aevix — Setup', backgroundColor: '#0a0a0f',
            webPreferences: { preload: path.join(__dirname, 'wizard-preload.cjs'), contextIsolation: true, nodeIntegration: false },
        });
        win.setMenuBarVisibility(false);
        win.loadFile(path.join(__dirname, 'setup-wizard', 'wizard.html'));
        ipcMain.once('setup-complete', (_, config) => { writeConfig(config); win.close(); resolve(); });
    });
}

// ─── Main window ──────────────────────────────────────────────────────
let mainWindow = null;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280, height: 820, minWidth: 960, minHeight: 640,
        title: 'Aevix', backgroundColor: '#0a0a0f', show: false,
        webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false },
    });
    mainWindow.setMenuBarVisibility(false);
    mainWindow.loadURL(`http://localhost:${PORT}`);
    mainWindow.once('ready-to-show', () => mainWindow.show());
    mainWindow.webContents.on('before-input-event', (_, input) => {
        if (input.control && input.shift && input.key === 'I') {
            mainWindow.webContents.toggleDevTools();
        }
    });
    mainWindow.on('close', ev => { if (!isQuitting) { ev.preventDefault(); mainWindow.hide(); } });
}

// ─── Tray ─────────────────────────────────────────────────────────────
let tray = null;

function createTray() {
    const iconPath = path.join(APP_ROOT, 'assets', 'tray.ico');
    const icon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
    tray = new Tray(icon);
    tray.setToolTip('Aevix — Online');
    tray.setContextMenu(Menu.buildFromTemplate([
        { label: 'Open Aevix', click: () => { mainWindow.show(); mainWindow.focus(); } },
        { label: 'Open Monitor', click: () => shell.openExternal(`http://localhost:${PORT}/monitor`) },
        { type: 'separator' },
        { label: `Version ${app.getVersion()}`, enabled: false },
        { label: 'Check for Updates', click: () => { try { require('electron-updater').autoUpdater.checkForUpdates(); } catch (_) {} } },
        { type: 'separator' },
        { label: 'Quit Aevix', click: () => { isQuitting = true; app.quit(); } },
    ]));
    tray.on('double-click', () => { mainWindow.show(); mainWindow.focus(); });
}

// ─── Auto-updater ─────────────────────────────────────────────────────
function setupUpdater() {
    try {
        const { autoUpdater } = require('electron-updater');
        autoUpdater.autoDownload = true;
        autoUpdater.autoInstallOnAppQuit = true;
        autoUpdater.on('update-available', info => { if (mainWindow) mainWindow.webContents.send('update-available', info); });
        autoUpdater.on('update-downloaded', info => {
            if (isDev) return;
            if (mainWindow) mainWindow.webContents.send('update-downloaded', info);
            tray?.displayBalloon({ iconType: 'info', title: 'Aevix Update Ready', content: `v${info.version} ready. Restart to apply.` });
        });
        autoUpdater.on('error', err => console.warn('[updater]', err.message));
        ipcMain.on('install-update', () => { isQuitting = true; autoUpdater.quitAndInstall(false, true); });
        if (!isDev) setTimeout(() => autoUpdater.checkForUpdatesAndNotify(), 3000);
    } catch (err) {
        console.warn('[updater] Setup failed:', err.message);
    }
}

ipcMain.handle('get-version', () => app.getVersion());

// ─── App lifecycle ────────────────────────────────────────────────────
app.whenReady().then(async () => {
    initPaths();
    log(`[main] App starting — userData: ${USER_DATA}`);
    log(`[main] APP_ROOT: ${APP_ROOT}`);
    bootstrapUserData();
    log('[main] User data bootstrapped');
    startActivityWatch();
    if (!hasValidConfig()) {
        log('[main] No valid config — showing setup wizard');
        await showSetupWizard();
    }
    log('[main] Starting Express server');
    try {
        await startServer();
    } catch (err) {
        log(`[main] startServer threw: ${err.stack || err.message}`);
    }
    log('[main] Waiting for server to respond');
    let serverOk = false;
    try {
        await waitForServer();
        serverOk = true;
        log('[main] Server is up');
    } catch (err) {
        log(`[main] Server did not respond: ${err.message}`);
        const { dialog } = require('electron');
        dialog.showErrorBox(
            'Aevix — Startup Failed',
            `The backend server did not start.\n\nError: ${err.message}\n\nLog file: ${path.join(USER_DATA, 'logs', 'aevix-startup.log')}\n\nPlease send this log file to support.`
        );
        app.quit();
        return;
    }
    if (serverOk) {
        log('[main] Creating window');
        createWindow();
    }
    createTray();
    setupUpdater();
});

app.on('window-all-closed', ev => ev.preventDefault());
app.on('before-quit', () => { isQuitting = true; stopActivityWatch(); });
app.on('activate', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
