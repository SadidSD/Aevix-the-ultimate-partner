'use strict';
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const AW_VERSION = 'v0.13.1';
const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'extraResources', 'activitywatch');
const TMP_DIR = path.join(ROOT, 'extraResources', '_aw_tmp');
const ZIP = path.join(TMP_DIR, 'aw.zip');
const URL = `https://github.com/ActivityWatch/activitywatch/releases/download/${AW_VERSION}/activitywatch-${AW_VERSION}-windows-x86_64.zip`;

if (fs.existsSync(path.join(OUT_DIR, 'aw-server', 'aw-server.exe'))) {
    console.log('[AW] Already downloaded, skipping.');
    process.exit(0);
}

fs.mkdirSync(TMP_DIR, { recursive: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

console.log(`[AW] Downloading ActivityWatch ${AW_VERSION}...`);
execSync(`curl -L -o "${ZIP}" "${URL}"`, { stdio: 'inherit' });

console.log('[AW] Extracting...');
execSync(`powershell -Command "Expand-Archive -Path '${ZIP}' -DestinationPath '${TMP_DIR}' -Force"`, { stdio: 'inherit' });

// Locate activitywatch root inside the zip (may be nested)
function findDir(base, name) {
    if (!fs.existsSync(base)) return null;
    const entries = fs.readdirSync(base);
    for (const e of entries) {
        const full = path.join(base, e);
        if (e === name && fs.statSync(full).isDirectory()) return full;
        if (fs.statSync(full).isDirectory()) {
            const found = findDir(full, name);
            if (found) return found;
        }
    }
    return null;
}

const awRoot = findDir(TMP_DIR, 'activitywatch') || TMP_DIR;
const needed = ['aw-server', 'aw-watcher-afk', 'aw-watcher-window'];

for (const dir of needed) {
    const src = path.join(awRoot, dir);
    const dst = path.join(OUT_DIR, dir);
    if (fs.existsSync(src)) {
        fs.cpSync(src, dst, { recursive: true });
        console.log(`[AW] Copied ${dir}`);
    } else {
        console.warn(`[AW] Not found in zip: ${dir}`);
    }
}

fs.rmSync(TMP_DIR, { recursive: true, force: true });
console.log('[AW] Done.');
