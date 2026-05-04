import axios from 'axios';
import { ChatGroq } from '@langchain/groq';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';

const AW_BASE_URL = 'http://localhost:5600/api/0';

// ─── App & Site Classification Maps ───────────────────────────────────
// Chrome is NOT classified here — individual websites are classified instead.

const PRODUCTIVE_APPS = new Set([
    'code', 'code.exe', 'visual studio code', 'vs code',
    'terminal', 'windowsterminal.exe', 'cmd.exe', 'powershell.exe', 'wt.exe',
    'figma', 'figma.exe',
    'notion', 'notion.exe',
    'obsidian', 'obsidian.exe',
    'postman', 'postman.exe',
    'excel', 'excel.exe', 'microsoft excel',
    'word', 'winword.exe', 'microsoft word',
    'powerpoint', 'powerpnt.exe',
    'onenote', 'onenote.exe',
    'blender', 'blender.exe',
    'adobe photoshop', 'photoshop.exe',
    'adobe illustrator', 'illustrator.exe',
    'unity', 'unity.exe',
    'antigravity', 'antigravity.exe',
]);

const DISTRACTING_APPS = new Set([
    'discord', 'discord.exe',
    'telegram', 'telegram.exe',
    'whatsapp',
    'netflix',
    'spotify', 'spotify.exe',
    'vlc', 'vlc.exe',
    'steam', 'steam.exe',
    'epicgameslauncher', 'epicgameslauncher.exe',
]);

const PRODUCTIVE_SITES = new Set([
    'github.com', 'gitlab.com', 'bitbucket.org',
    'stackoverflow.com', 'stackexchange.com',
    'developer.mozilla.org', 'mdn.io',
    'docs.google.com', 'drive.google.com', 'sheets.google.com',
    'notion.so',
    'figma.com',
    'vercel.com', 'netlify.com', 'railway.app',
    'npmjs.com', 'pypi.org',
    'learn.microsoft.com', 'aws.amazon.com',
    'udemy.com', 'coursera.org', 'khanacademy.org',
    'chatgpt.com', 'chat.openai.com',
    'claude.ai', 'console.groq.com',
    'medium.com', 'dev.to', 'hashnode.dev',
    'w3schools.com', 'geeksforgeeks.org',
    'leetcode.com', 'hackerrank.com', 'codeforces.com',
]);

const DISTRACTING_SITES = new Set([
    'youtube.com', 'youtu.be',
    'reddit.com', 'old.reddit.com',
    'twitter.com', 'x.com',
    'facebook.com', 'fb.com',
    'instagram.com',
    'tiktok.com',
    'netflix.com',
    'twitch.tv',
    'discord.com',
    '9gag.com',
    'buzzfeed.com',
]);

// ─── Custom Classification Persistence ────────────────────────────────

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLASSIFICATIONS_PATH = path.join(__dirname, 'classifications.json');

function loadCustomClassifications() {
    try {
        const raw = fs.readFileSync(CLASSIFICATIONS_PATH, 'utf-8');
        return JSON.parse(raw);
    } catch (e) {
        return { apps: {}, sites: {} };
    }
}

function saveCustomClassifications(data) {
    fs.writeFileSync(CLASSIFICATIONS_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

export function getCustomClassifications() {
    return loadCustomClassifications();
}

export function setClassification(name, type, category) {
    // type = 'app' or 'site', category = 'productive' | 'distracting' | 'neutral'
    const data = loadCustomClassifications();
    const key = type === 'app' ? 'apps' : 'sites';
    data[key][name.toLowerCase()] = category;
    saveCustomClassifications(data);
    return data;
}

// ─── Classification Logic ─────────────────────────────────────────────

function classifyApp(appName) {
    const lower = (appName || '').toLowerCase().trim();
    
    // 1. Check custom user overrides FIRST (highest priority)
    const custom = loadCustomClassifications();
    for (const [key, cat] of Object.entries(custom.apps)) {
        if (lower.includes(key) || key.includes(lower)) return cat;
    }
    
    // 2. Check hardcoded productive apps
    for (const p of PRODUCTIVE_APPS) {
        if (lower.includes(p) || p.includes(lower)) return 'productive';
    }
    // 3. Check hardcoded distracting apps
    for (const d of DISTRACTING_APPS) {
        if (lower.includes(d) || d.includes(lower)) return 'distracting';
    }
    // Chrome/Firefox/Edge are classified as "browser" — their sites are classified separately
    if (lower.includes('chrome') || lower.includes('firefox') || lower.includes('msedge') || lower.includes('brave')) return 'browser';
    return 'neutral';
}

function classifySite(hostname) {
    const lower = (hostname || '').toLowerCase().trim();
    
    // 1. Check custom user overrides FIRST
    const custom = loadCustomClassifications();
    if (custom.sites[lower]) return custom.sites[lower];
    
    // 2. Hardcoded defaults
    if (PRODUCTIVE_SITES.has(lower)) return 'productive';
    if (DISTRACTING_SITES.has(lower)) return 'distracting';
    return 'neutral';
}

// ─── Core Aggregation Engine ──────────────────────────────────────────

async function getBuckets() {
    try {
        const res = await axios.get(`${AW_BASE_URL}/buckets`);
        return res.data;
    } catch (e) {
        return {};
    }
}

/**
 * Fetches and aggregates ActivityWatch data for a given time range.
 * @param {"day"|"week"|"month"} range
 */
export async function getActivityBreakdown(range = 'day') {
    const buckets = await getBuckets();
    let windowBucket = null;
    let webBucket = null;

    for (const [id] of Object.entries(buckets)) {
        if (id.includes('aw-watcher-window')) windowBucket = id;
        if (id.includes('aw-watcher-web')) webBucket = id;
    }

    if (!windowBucket) {
        return { error: 'ActivityWatch window watcher not found. Is aw-server running?' };
    }

    // Calculate time window
    const now = new Date();
    let start;
    if (range === 'day') {
        start = new Date(now);
        start.setHours(0, 0, 0, 0); // Start of today
    } else if (range === 'week') {
        start = new Date(now);
        start.setDate(start.getDate() - 7);
        start.setHours(0, 0, 0, 0);
    } else {
        start = new Date(now);
        start.setDate(start.getDate() - 30);
        start.setHours(0, 0, 0, 0);
    }

    try {
        // ── 1. Desktop App Events ──────────────────────────────────
        const windowRes = await axios.get(
            `${AW_BASE_URL}/buckets/${windowBucket}/events?start=${start.toISOString()}&end=${now.toISOString()}&limit=-1`
        );

        const appTime = {};           // { appName: totalSeconds }
        const hourlyActive = new Array(24).fill(0);   // minutes per hour
        const dailyProductive = {};    // { "2026-04-01": minutes }
        const dailyDistracted = {};
        let totalActiveSeconds = 0;
        let productiveSeconds = 0;
        let distractedSeconds = 0;

        windowRes.data.forEach(ev => {
            const app = ev.data.app || 'Unknown';
            const dur = ev.duration || 0;
            const evTime = new Date(ev.timestamp);

            appTime[app] = (appTime[app] || 0) + dur;
            totalActiveSeconds += dur;

            // Hourly distribution
            const hour = evTime.getHours();
            hourlyActive[hour] += dur / 60; // convert to minutes

            // Daily aggregation for trend charts
            const dateKey = evTime.toISOString().split('T')[0];

            const category = classifyApp(app);
            if (category === 'productive') {
                productiveSeconds += dur;
                dailyProductive[dateKey] = (dailyProductive[dateKey] || 0) + dur / 60;
            } else if (category === 'distracting') {
                distractedSeconds += dur;
                dailyDistracted[dateKey] = (dailyDistracted[dateKey] || 0) + dur / 60;
            }
            // Browser time is NOT counted here — it's counted per-site below
        });

        // Sort apps by usage time (descending), top 10
        const sortedApps = Object.entries(appTime)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([name, seconds]) => ({
                name,
                minutes: Math.round(seconds / 60),
                category: classifyApp(name)
            }));

        // ── 2. Website Events ──────────────────────────────────────
        let sortedSites = [];
        if (webBucket) {
            const webRes = await axios.get(
                `${AW_BASE_URL}/buckets/${webBucket}/events?start=${start.toISOString()}&end=${now.toISOString()}&limit=-1`
            );

            const siteTime = {};
            webRes.data.forEach(ev => {
                let site = 'Unknown';
                if (ev.data.url) {
                    try { site = new URL(ev.data.url).hostname.replace('www.', ''); } catch (e) {}
                }
                if (site && typeof site === 'string' && site.trim().length > 1 && site !== 'Unknown' && !site.includes('newtab')) {
                    const dur = ev.duration || 0;
                    siteTime[site] = (siteTime[site] || 0) + dur;

                    // Classify site and add to productive/distracted totals
                    const dateKey = new Date(ev.timestamp).toISOString().split('T')[0];
                    const cat = classifySite(site);
                    if (cat === 'productive') {
                        productiveSeconds += dur;
                        dailyProductive[dateKey] = (dailyProductive[dateKey] || 0) + dur / 60;
                    } else if (cat === 'distracting') {
                        distractedSeconds += dur;
                        dailyDistracted[dateKey] = (dailyDistracted[dateKey] || 0) + dur / 60;
                    }
                }
            });

            sortedSites = Object.entries(siteTime)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 10)
                .map(([name, seconds]) => ({
                    name,
                    minutes: Math.round(seconds / 60),
                    category: classifySite(name)
                }));
        }

        // ── 3. Build daily trend arrays ────────────────────────────
        const allDates = new Set([...Object.keys(dailyProductive), ...Object.keys(dailyDistracted)]);
        const sortedDates = [...allDates].sort();
        const dailyTrend = sortedDates.map(date => ({
            date,
            productive: Math.round(dailyProductive[date] || 0),
            distracted: Math.round(dailyDistracted[date] || 0)
        }));

        // ── 4. Final payload ───────────────────────────────────────
        const totalActiveHours = parseFloat((totalActiveSeconds / 3600).toFixed(1));
        const productiveHours = parseFloat((productiveSeconds / 3600).toFixed(1));
        const distractedHours = parseFloat((distractedSeconds / 3600).toFixed(1));
        const focusRatio = totalActiveSeconds > 0
            ? Math.round((productiveSeconds / (productiveSeconds + distractedSeconds)) * 100) || 0
            : 0;

        return {
            range,
            totalActiveHours,
            productiveHours,
            distractedHours,
            focusRatio,
            apps: sortedApps,
            sites: sortedSites,
            hourlyDistribution: hourlyActive.map(m => Math.round(m)),
            dailyTrend
        };
    } catch (e) {
        return { error: `Failed to fetch activity data: ${e.message}` };
    }
}

// ─── LLM-Powered Insight Generation ──────────────────────────────────

// Lazy-initialize to ensure dotenv has loaded before accessing env vars
let _insightLLM = null;
function getInsightLLM() {
    if (!_insightLLM) {
        _insightLLM = new ChatGroq({
            apiKey: process.env.GROQ_API_KEY,
            model: 'llama-3.3-70b-versatile',
            temperature: 0.3
        });
    }
    return _insightLLM;
}

/**
 * Sends aggregated telemetry to the LLM for pattern recognition.
 */
export async function generateInsights(breakdown, range) {
    if (breakdown.error) return breakdown.error;

    const compressed = `
Time Range: ${range}
Total Active: ${breakdown.totalActiveHours}h | Productive: ${breakdown.productiveHours}h | Distracted: ${breakdown.distractedHours}h | Focus: ${breakdown.focusRatio}%
Top Apps: ${breakdown.apps.map(a => `${a.name}(${a.minutes}m,${a.category})`).join(', ')}
Top Sites: ${breakdown.sites.map(s => `${s.name}(${s.minutes}m,${s.category})`).join(', ')}
Hourly Activity (mins per hour 0-23): ${breakdown.hourlyDistribution.join(',')}
${breakdown.dailyTrend.length > 1 ? `Daily Trend: ${breakdown.dailyTrend.map(d => `${d.date}: P${d.productive}m/D${d.distracted}m`).join(' | ')}` : ''}
    `.trim();

    const prompt = `You are a productivity analyst. Based on the following computer usage data, provide a concise analysis.

DATA:
${compressed}

Respond in EXACTLY this format (use markdown):

**🕐 Peak Productivity Windows**
Identify the 2-3 hours where the user is most focused and productive. Reference specific hours.

**⚠️ Distraction Patterns**
Identify when and what pulls the user off-track. Be specific about apps/sites and time windows.

**✅ 3 Actionable Recommendations**
Give 3 specific, practical changes the user could make to improve their focus ratio. Reference their actual data.

Keep it under 200 words total. Be direct, no fluff.`;

    try {
        const res = await getInsightLLM().invoke([
            new SystemMessage('You are a concise productivity analyst. Use the user\'s real data. Never invent statistics.'),
            new HumanMessage(prompt)
        ]);
        return res.content;
    } catch (e) {
        return `Insight generation failed: ${e.message}`;
    }
}

// ─── Markdown Report Generator ───────────────────────────────────────

export function generateReport(breakdown, insights) {
    const now = new Date().toLocaleString();
    const rangeLabel = breakdown.range === 'day' ? 'Daily' : breakdown.range === 'week' ? 'Weekly' : 'Monthly';

    let md = `# AEVIX ${rangeLabel} Productivity Report\n`;
    md += `> Generated: ${now}\n\n`;
    md += `---\n\n`;
    md += `## Summary\n`;
    md += `| Metric | Value |\n|---|---|\n`;
    md += `| Total Active | ${breakdown.totalActiveHours} hours |\n`;
    md += `| Productive | ${breakdown.productiveHours} hours |\n`;
    md += `| Distracted | ${breakdown.distractedHours} hours |\n`;
    md += `| Focus Ratio | ${breakdown.focusRatio}% |\n\n`;

    md += `## Top Applications\n`;
    md += `| App | Time | Category |\n|---|---|---|\n`;
    breakdown.apps.forEach(a => {
        const emoji = a.category === 'productive' ? '🟢' : a.category === 'distracting' ? '🔴' : '⚪';
        md += `| ${a.name} | ${a.minutes}m | ${emoji} ${a.category} |\n`;
    });

    if (breakdown.sites.length > 0) {
        md += `\n## Top Websites\n`;
        md += `| Site | Time | Category |\n|---|---|---|\n`;
        breakdown.sites.forEach(s => {
            const emoji = s.category === 'productive' ? '🟢' : s.category === 'distracting' ? '🔴' : '⚪';
            md += `| ${s.name} | ${s.minutes}m | ${emoji} ${s.category} |\n`;
        });
    }

    md += `\n## AI Insights\n\n${insights}\n`;
    md += `\n---\n*Report generated by AEVIX Productivity OS*\n`;

    return md;
}
