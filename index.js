import 'dotenv/config';
import path from 'path';
import fs from 'fs';
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import notifier from 'node-notifier';
import { aevixApp, runNightlyRoutine, checkReminders, removeTask, readTasksFromFile, writeTasksToFile, asyncMemorySync, generateBootBriefing, generateProactiveCheckIn, getMonitorEvents } from './agent.js';
import { getRecentActivity } from './aw_client.js';
import { getActivityBreakdown, generateInsights, generateReport, getCustomClassifications, setClassification } from './analytics.js';
import { HumanMessage } from "@langchain/core/messages";

if (process.env.LLM_PROVIDER === 'groq' && process.env.MODE !== 'local' && !process.env.GROQ_API_KEY) {
    console.error('[FATAL] Missing GROQ_API_KEY in .env (Required for Cloud mode)');
    process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
const publicDir = process.env.AEVIX_APP_ROOT ? path.join(process.env.AEVIX_APP_ROOT, 'public') : 'public';
app.use(express.static(publicDir));

// Daily Cron at 2:00 AM
cron.schedule('0 2 * * *', async () => {
    console.log("[Cron] Executing nightly review...");
    try {
        const config = { configurable: { thread_id: "local_user_thread" } };
        const plan = await runNightlyRoutine(config);
        console.log("[Cron] Nightly plan generated:", plan);
    } catch (e) {
        console.error("[Cron] Failed nightly routine:", e);
    }
});

let openClients = [];
let monitorClients = [];

// Wire monitor push into agent's event bus
global._monitorPush = (event) => {
    const payload = JSON.stringify(event);
    monitorClients.forEach(c => c.write(`data: ${payload}\n\n`));
};

// SSE Endpoint for proactive UI messaging
app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    openClients.push(res);
    req.on('close', () => {
        openClients = openClients.filter(c => c !== res);
    });
});

// SSE Endpoint for monitor page — streams every LLM event live
app.get('/api/monitor/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    monitorClients.push(res);
    req.on('close', () => {
        monitorClients = monitorClients.filter(c => c !== res);
    });
});

// Monitor page route
app.get('/monitor', (_req, res) => res.sendFile('monitor.html', { root: publicDir }));

// REST endpoint — returns full buffered history for initial page load
app.get('/api/monitor', (_req, res) => {
    res.json(getMonitorEvents());
});

// Active 5-Minute Reminder Polling
cron.schedule('*/5 * * * *', async () => {
    try {
        const config = { configurable: { thread_id: "local_user_thread" } };
        const alertMsg = await checkReminders(config);
        if (alertMsg) {
            console.log("[Reminder Alert Triggered] " + alertMsg);
            notifier.notify({
                title: 'AEVIX ASSISTANT',
                message: alertMsg,
                sound: true,
                wait: true,
                timeout: 10
            });
            const payload = JSON.stringify({ type: 'reminder', message: alertMsg });
            openClients.forEach(client => client.write(`data: ${payload}\n\n`));
        }
    } catch (e) {
        console.error("[Cron] Reminder loop failed.", e);
    }
});

// Proactive Activity Check-In every 30 minutes
cron.schedule('*/30 * * * *', async () => {
    try {
        const checkInMsg = await generateProactiveCheckIn();
        if (checkInMsg) {
            console.log("[CheckIn] Proactive interrupt:", checkInMsg);
            notifier.notify({
                title: 'AEVIX',
                message: checkInMsg,
                sound: false,
                timeout: 15
            });
            const payload = JSON.stringify({ type: 'checkin', message: checkInMsg });
            openClients.forEach(client => client.write(`data: ${payload}\n\n`));
        }
    } catch (e) {
        console.error("[Cron] Check-in loop failed.", e);
    }
});

// Immediately marks a task complete based on keyword overlap — no LLM needed
function tryImmediateCompletion(message) {
    const lower = message.toLowerCase();
    const completionTriggers = ['completed', 'done', 'finished', 'fixed', 'resolved', 'bought', 'crossed off', 'checked off'];
    if (!completionTriggers.some(t => lower.includes(t))) return;

    const words = lower.split(/\W+/).filter(w => w.length > 3);
    const files = [
        './tasks/Owner-Tasks.md',
        './tasks/Aevix-Tasks.md',
        './tasks/Targets.md'
    ];

    for (const filePath of files) {
        const tasks = readTasksFromFile(filePath);
        const target = tasks.find(t =>
            !t.completed &&
            words.some(w => t.title.toLowerCase().includes(w))
        );
        if (target) {
            target.completed = true;
            writeTasksToFile(tasks, filePath);
            console.log(`[Chat] Immediate completion: "${target.title}" in ${filePath}`);
            return;
        }
    }
}

// Chat API Endpoint
app.post('/api/chat', async (req, res) => {
    const { message } = req.body;

    if (!message) {
        return res.status(400).json({ error: "Message is required." });
    }

    // Run before LLM — pure file ops, isolated from graph errors
    try { tryImmediateCompletion(message); } catch (e) {
        console.warn('[Chat] Immediate completion failed:', e.message);
    }

    try {
        const config = { configurable: { thread_id: "local_user_thread" } };

        const result = await aevixApp.invoke(
            { messages: [new HumanMessage(message)] },
            config
        );

        const currentState = await aevixApp.getState(config);
        const reply = result.messages[result.messages.length - 1].content;

        // Async memory extraction — push updated tasks via SSE when done
        setTimeout(() => {
            asyncMemorySync(currentState.values, config).then(() => {
                const payload = JSON.stringify({
                    type: 'memory_sync_complete',
                    tasks: readTasksFromFile("./tasks/Owner-Tasks.md").filter(t => !t.completed),
                    aevix_tasks: readTasksFromFile("./tasks/Aevix-Tasks.md").filter(t => !t.completed),
                    targets: readTasksFromFile("./tasks/Targets.md").filter(t => !t.completed)
                });
                openClients.forEach(c => c.write(`data: ${payload}\n\n`));
            });
        }, 5000);

        res.json({
            reply,
            tasks: readTasksFromFile("./tasks/Owner-Tasks.md").filter(t => !t.completed),
            aevix_tasks: readTasksFromFile("./tasks/Aevix-Tasks.md").filter(t => !t.completed),
            targets: readTasksFromFile("./tasks/Targets.md").filter(t => !t.completed),
            energy_prediction: currentState.values.energy_prediction || "Unknown",
            activity_summary: currentState.values.activity_summary || "No recent activity data."
        });

    } catch (err) {
        console.error('[API] Graph execution failed:', err.message);
        // Return degraded response — tasks still readable even if LLM is busy
        res.status(503).json({
            error: "Model busy or unreachable. Try again in a moment, Sir.",
            tasks: readTasksFromFile("./tasks/Owner-Tasks.md").filter(t => !t.completed),
            aevix_tasks: readTasksFromFile("./tasks/Aevix-Tasks.md").filter(t => !t.completed),
            targets: readTasksFromFile("./tasks/Targets.md").filter(t => !t.completed)
        });
    }
});

// Task Completion Endpoint
app.post('/api/tasks/complete', async (req, res) => {
    const { title, type } = req.body;
    if (!title) return res.status(400).json({ error: "Title is required" });

    try {
        const config = { configurable: { thread_id: "local_user_thread" } };
        const updatedTasks = await removeTask(config, title, type || 'owner');
        res.json({ success: true, tasks: updatedTasks });
    } catch (err) {
        res.status(500).json({ error: "Failed to mark task complete" });
    }
});

// ─── Analytics API Endpoints ──────────────────────────────────────────
// NOTE: Sub-routes MUST be registered before the parent route in Express 5

// LLM-powered insights (slower, async in frontend)
app.get('/api/analytics/insights', async (req, res) => {
    const range = req.query.range || 'day';
    if (!['day', 'week', 'month'].includes(range)) {
        return res.status(400).json({ error: 'Range must be day, week, or month' });
    }
    try {
        const breakdown = await getActivityBreakdown(range);
        const insights = await generateInsights(breakdown, range);
        res.json({ insights });
    } catch (err) {
        console.error('[Analytics] Insights failed:', err.message);
        res.status(500).json({ error: 'Insight generation failed' });
    }
});

// Downloadable Markdown report
app.get('/api/analytics/report', async (req, res) => {
    const range = req.query.range || 'day';
    try {
        const breakdown = await getActivityBreakdown(range);
        const insights = await generateInsights(breakdown, range);
        const report = generateReport(breakdown, insights);
        const rangeLabel = range === 'day' ? 'Daily' : range === 'week' ? 'Weekly' : 'Monthly';
        res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="AEVIX_${rangeLabel}_Report_${new Date().toISOString().split('T')[0]}.md"`);
        res.send(report);
    } catch (err) {
        res.status(500).json({ error: 'Report generation failed' });
    }
});

// Classification management endpoints
app.get('/api/classifications', (_req, res) => {
    res.json(getCustomClassifications());
});

app.post('/api/classifications', (req, res) => {
    const { name, type, category } = req.body;
    if (!name || !type || !category) {
        return res.status(400).json({ error: 'name, type (app|site), and category (productive|distracting|neutral) are required' });
    }
    if (!['app', 'site'].includes(type)) {
        return res.status(400).json({ error: 'type must be app or site' });
    }
    if (!['productive', 'distracting', 'neutral'].includes(category)) {
        return res.status(400).json({ error: 'category must be productive, distracting, or neutral' });
    }
    const updated = setClassification(name, type, category);
    res.json({ success: true, classifications: updated });
});

// Raw structured data for Chart.js (fast, no LLM call)
app.get('/api/analytics', async (req, res) => {
    const range = req.query.range || 'day';
    if (!['day', 'week', 'month'].includes(range)) {
        return res.status(400).json({ error: 'Range must be day, week, or month' });
    }
    try {
        const breakdown = await getActivityBreakdown(range);
        res.json(breakdown);
    } catch (err) {
        console.error('[Analytics] Breakdown failed:', err.message);
        res.status(500).json({ error: 'Analytics aggregation failed' });
    }
});

// HUD Initial Boot Status Endpoint — fast file read only, no LLM calls
app.get('/api/status', async (_req, res) => {
    try {
        const config = { configurable: { thread_id: "local_user_thread" } };
        const currentState = await aevixApp.getState(config);

        const messages = currentState?.values?.messages || [];
        const history = messages.map(m => {
            let type = 'aevix';
            if (m.getType && m.getType() === 'human') type = 'user';
            else if (m.id && Array.isArray(m.id) && m.id.includes('HumanMessage')) type = 'user';
            else if (m.type === 'human') type = 'user';
            return { role: type, content: m.content || "" };
        });

        const summary = await getRecentActivity(24);
        const activityText = typeof summary === 'string' ? summary : `Total Active: ${summary.total_active_hours} hours\nTop Apps: ${summary.top_apps.join(', ')}`;

        res.json({
            tasks: readTasksFromFile("./tasks/Owner-Tasks.md").filter(t => !t.completed),
            aevix_tasks: readTasksFromFile("./tasks/Aevix-Tasks.md").filter(t => !t.completed),
            targets: readTasksFromFile("./tasks/Targets.md").filter(t => !t.completed),
            energy_prediction: currentState?.values?.energy_prediction || "Unknown",
            activity_summary: activityText,
            history: history
        });
    } catch(err) {
        res.json({ tasks: [], energy_prediction: "Unknown", activity_summary: "Offline", history: [] });
    }
});

// Dedicated boot briefing endpoint — skipped during onboarding
app.get('/api/briefing', async (_req, res) => {
    if (fs.existsSync('./system/OpeningFunction.md')) return res.json({ briefing: null });
    try {
        const config = { configurable: { thread_id: "local_user_thread" } };
        const briefing = await generateBootBriefing(config);
        res.json({ briefing });
    } catch(err) {
        res.json({ briefing: `Good ${new Date().getHours() < 12 ? 'morning' : 'evening'}, Sir. Systems are online.` });
    }
});

// ─── Model Config Endpoints ───────────────────────────────────────────
const CONFIG_PATH = process.env.AEVIX_USER_DATA
    ? path.join(process.env.AEVIX_USER_DATA, 'aevix.config.json')
    : path.join(process.env.HOME || process.env.USERPROFILE || '.', 'aevix.config.json');

function readConfig() {
    try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); } catch { return {}; }
}
function writeConfig(data) {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

app.get('/api/config', (_req, res) => {
    const c = readConfig();
    res.json({
        provider: c.LLM_PROVIDER || 'groq',
        groq_model: c.GROQ_MODEL || 'llama-3.3-70b-versatile',
        openai_model: c.OPENAI_MODEL || 'gpt-4o-mini',
        anthropic_model: c.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
        local_url: c.LOCAL_LLM_URL || 'http://localhost:1234/v1',
        local_model: c.LOCAL_LLM_MODEL || '',
        has_groq_key: !!c.GROQ_API_KEY,
        has_openai_key: !!c.OPENAI_API_KEY,
        has_anthropic_key: !!c.ANTHROPIC_API_KEY,
    });
});

app.post('/api/config', (req, res) => {
    const { provider, model, api_key, local_url } = req.body;
    const c = readConfig();
    if (provider) c.LLM_PROVIDER = provider;
    if (provider === 'groq' && model) c.GROQ_MODEL = model;
    if (provider === 'openai' && model) c.OPENAI_MODEL = model;
    if (provider === 'anthropic' && model) c.ANTHROPIC_MODEL = model;
    if ((provider === 'local' || provider === 'ollama') && model) c.LOCAL_LLM_MODEL = model;
    if ((provider === 'local' || provider === 'ollama') && local_url) c.LOCAL_LLM_URL = local_url;
    if (provider === 'groq' && api_key) c.GROQ_API_KEY = api_key;
    if (provider === 'openai' && api_key) c.OPENAI_API_KEY = api_key;
    if (provider === 'anthropic' && api_key) c.ANTHROPIC_API_KEY = api_key;
    writeConfig(c);
    // Apply to process.env so getLLM() picks it up immediately
    if (c.LLM_PROVIDER) process.env.LLM_PROVIDER = c.LLM_PROVIDER;
    if (c.GROQ_MODEL) process.env.GROQ_MODEL = c.GROQ_MODEL;
    if (c.OPENAI_MODEL) process.env.OPENAI_MODEL = c.OPENAI_MODEL;
    if (c.ANTHROPIC_MODEL) process.env.ANTHROPIC_MODEL = c.ANTHROPIC_MODEL;
    if (c.LOCAL_LLM_MODEL) process.env.LOCAL_LLM_MODEL = c.LOCAL_LLM_MODEL;
    if (c.LOCAL_LLM_URL) process.env.LOCAL_LLM_URL = c.LOCAL_LLM_URL;
    if (c.GROQ_API_KEY) process.env.GROQ_API_KEY = c.GROQ_API_KEY;
    if (c.OPENAI_API_KEY) process.env.OPENAI_API_KEY = c.OPENAI_API_KEY;
    if (c.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = c.ANTHROPIC_API_KEY;
    console.log(`[Config] Switched to provider=${c.LLM_PROVIDER} model=${model}`);
    res.json({ ok: true });
});

app.listen(PORT, () => {
    console.log(`[Aevix] Local Web Interface active on http://localhost:${PORT}`);
});
