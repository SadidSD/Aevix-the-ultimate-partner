// Update notification bridge — only active inside Electron
(function () {
    if (!window.aevixElectron) return;

    const banner = document.createElement('div');
    banner.id = 'aevix-update-banner';
    banner.style.cssText = `
        display: none; position: fixed; bottom: 0; left: 0; right: 0;
        background: #0e2a33; border-top: 1px solid #00d4ff44;
        padding: 10px 20px; z-index: 9999;
        display: flex; align-items: center; justify-content: space-between;
        font-family: monospace; font-size: 12px; color: #e2e8f0;
    `;
    banner.innerHTML = `
        <span>⬡ Aevix <strong id="update-ver"></strong> is ready — restart to install.</span>
        <div style="display:flex;gap:8px">
            <button onclick="window.aevixElectron.installUpdate()" style="
                background:#00d4ff;color:#000;border:none;padding:5px 14px;
                border-radius:4px;font-weight:700;cursor:pointer;font-size:11px;">
                Restart Now
            </button>
            <button onclick="document.getElementById('aevix-update-banner').style.display='none'" style="
                background:transparent;color:#64748b;border:1px solid #2a2a3a;
                padding:5px 10px;border-radius:4px;cursor:pointer;font-size:11px;">
                Later
            </button>
        </div>
    `;

    document.addEventListener('DOMContentLoaded', () => {
        document.body.appendChild(banner);

        window.aevixElectron.onUpdateDownloaded((info) => {
            document.getElementById('update-ver').textContent = `v${info.version}`;
            banner.style.display = 'flex';
        });
    });

    window.aevixElectron.getVersion().then(v => {
        console.log('[Aevix] Running v' + v);
    }).catch(() => {});
})();
