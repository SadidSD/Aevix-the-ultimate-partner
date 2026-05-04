import axios from 'axios';

const AW_BASE_URL = 'http://localhost:5600/api/0';

export async function getBuckets() {
    try {
        const res = await axios.get(`${AW_BASE_URL}/buckets`);
        return res.data;
    } catch (e) {
        console.error('Failed to connect to ActivityWatch. Is aw-server running?', e.message);
        return {};
    }
}

export async function getRecentActivity(hours = 24) {
    const buckets = await getBuckets();
    let windowBucket = null;
    let webBucket = null;
    
    // Auto-detect window and afk buckets
    for (const [id, bucket] of Object.entries(buckets)) {
        if (id.includes('aw-watcher-window')) windowBucket = id;
        if (id.includes('aw-watcher-web')) webBucket = id;
    }

    if (!windowBucket) return "ActivityWatch window watcher not found.";

    const now = new Date();
    const start = new Date(now.getTime() - (hours * 60 * 60 * 1000));

    try {
        let finalOutput = [];
        
        // 1. Desktop Apps
        const windowRes = await axios.get(`${AW_BASE_URL}/buckets/${windowBucket}/events?start=${start.toISOString()}&end=${now.toISOString()}`);
        const appTime = {};
        let totalActiveSeconds = 0;
        windowRes.data.forEach(ev => {
            const app = ev.data.app || 'Unknown';
            appTime[app] = (appTime[app] || 0) + ev.duration;
            totalActiveSeconds += ev.duration;
        });
        const sortedApps = Object.entries(appTime).sort((a, b) => b[1] - a[1]).slice(0, 8).map(x => `${x[0]}: ${(x[1] / 60).toFixed(1)}m`);
        finalOutput.push(`Apps: ${sortedApps.join(', ')}`);

        // 2. Chrome/Web Sites
        if (webBucket) {
            const webRes = await axios.get(`${AW_BASE_URL}/buckets/${webBucket}/events?start=${start.toISOString()}&end=${now.toISOString()}`);
            const siteTime = {};
            webRes.data.forEach(ev => {
                let site = ev.data.title || 'Unknown';
                if (ev.data.url) {
                    try { site = new URL(ev.data.url).hostname.replace('www.', ''); } catch (e) {}
                }
                // Filter out blank, dead handles, extension IDs, or new tab pages
                if (site && typeof site === 'string' && site.trim().length > 1 && site !== 'Unknown' && !site.includes('newtab')) {
                    siteTime[site] = (siteTime[site] || 0) + ev.duration;
                }
            });
            const sortedSites = Object.entries(siteTime).sort((a, b) => b[1] - a[1]).slice(0, 8).map(x => `${x[0]}: ${(x[1] / 60).toFixed(1)}m`);
            finalOutput.push(`Sites: ${sortedSites.length > 0 ? sortedSites.join(', ') : 'None'}`);
        } else {
            finalOutput.push(`Sites: [No Web Extension Installed]`);
        }

        return finalOutput.join('  |  ');
    } catch (e) {
        return `Error fetching activity data: ${e.message}`;
    }
}
