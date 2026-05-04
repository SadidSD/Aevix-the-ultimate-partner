const chatWindow = document.getElementById('chat-window');
const chatInput = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');
const taskList = document.getElementById('task-list');
const taskCount = document.getElementById('task-count');
const agentTaskList = document.getElementById('agent-task-list');
const agentTaskCount = document.getElementById('agent-task-count');
const projectList = document.getElementById('project-list');
const projectCount = document.getElementById('project-count');
const energyStatus = document.getElementById('energy-status');
const activityStats = document.getElementById('activity-stats');

// ═══════════════════ MARKDOWN FORMATTER ═══════════════════

function formatMarkdown(text) {
    let html = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
    html = html.replace(/\n- (.*?)/g, '<br>• $1');
    return html;
}

// ═══════════════════ CHAT MESSAGING ═══════════════════

function addMessage(text, isUser = false) {
    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${isUser ? 'user' : 'ai'}`;
    
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.innerText = isUser ? 'U' : 'K';

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.innerHTML = isUser ? text : formatMarkdown(text);

    msgDiv.appendChild(avatar);
    msgDiv.appendChild(bubble);
    
    chatWindow.appendChild(msgDiv);
    chatWindow.scrollTop = chatWindow.scrollHeight;
}

function updateHUD(data) {
    // Update Energy
    if (data.energy_prediction) {
        const text = data.energy_prediction.substring(0, 15);
        let cls = 'unknown';
        if (text.toLowerCase().includes('high')) cls = 'high';
        if (text.toLowerCase().includes('medium')) cls = 'medium';
        if (text.toLowerCase().includes('low')) cls = 'low';
        
        energyStatus.className = `badge ${cls}`;
        energyStatus.innerText = data.energy_prediction.split('.')[0] + '.';
    }

    // Update Owner Tasks
    if (data.tasks) {
        renderTaskList(data.tasks, taskList, taskCount, 'owner');
    }

    // Update Agent Directives
    if (data.aevix_tasks) {
        renderTaskList(data.aevix_tasks, agentTaskList, agentTaskCount, 'aevix');
    }

    // Update Strategic Targets
    if (data.targets) {
        renderTaskList(data.targets, projectList, projectCount, 'target');
    }

    // Update Activity Summary
    if (data.activity_summary) {
        activityStats.innerText = data.activity_summary;
    }
}

function renderTaskList(tasks, listEl, countEl, type) {
    countEl.innerText = tasks.length;
    if (tasks.length > 0) {
        listEl.innerHTML = '';
        tasks.forEach(t => {
            const li = document.createElement('li');
            const truncatedTitle = t.title.length > 35 ? t.title.substring(0, 32) + "..." : t.title;
            li.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                    <div>
                        <strong title="${t.title.replace(/"/g, '&quot;')}">${truncatedTitle}</strong><br>
                        <span style="color:#949CAA;font-size:0.75rem">Pri: ${t.priority || 'Low'}</span>
                    </div>
                    <button class="complete-btn" onclick="completeTaskBtn('${t.title.replace(/'/g, "\\'")}', '${type}')" title="Mark Complete">✔</button>
                </div>
            `;
            listEl.appendChild(li);
        });
    } else {
        listEl.innerHTML = `<li class="empty-state">${type === 'aevix' ? 'Aevix is idling...' : 'No pending tasks.'}</li>`;
    }
}

// ═══════════════════ CHAT SEND (with debounce) ═══════════════════

let isSending = false;

async function sendMessage() {
    const text = chatInput.value.trim();
    if (!text || isSending) return;

    isSending = true;
    addMessage(text, true);
    chatInput.value = '';
    sendBtn.disabled = true;

    const loadId = 'loading-' + Date.now();
    const msgDiv = document.createElement('div');
    msgDiv.className = 'message ai';
    msgDiv.id = loadId;
    msgDiv.innerHTML = `<div class="avatar">K</div><div class="bubble"><em>Analyzing directive...</em></div>`;
    chatWindow.appendChild(msgDiv);
    chatWindow.scrollTop = chatWindow.scrollHeight;

    try {
        const res = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: text })
        });
        
        const data = await res.json();
        document.getElementById(loadId)?.remove();
        
        if (data.error) {
            addMessage(`[AEVIX] ${data.error}`);
            // Still update task list if included in degraded response
            if (data.tasks) updateHUD(data);
        } else {
            addMessage(data.reply);
            updateHUD(data);

            // Show sync indicator if task modification is contextually likely
            const contextText = (text + " " + data.reply).toLowerCase();
            const triggers = ['add', 'task', 'queue', 'list', 'remind', 'target', 'complete', 'done', 'finished', 'remove', 'delete', 'clear'];

            if (triggers.some(t => contextText.includes(t))) {
                showBackgroundSyncIndicator();
            }

            // Fallback refresh if SSE misses the sync event (fires after asyncMemorySync is guaranteed done)
            setTimeout(refreshHUD, 15000);
        }
    } catch (err) {
        document.getElementById(loadId)?.remove();
        addMessage(`[NETWORK ERROR] Could not reach Localhost Core.`);
    } finally {
        sendBtn.disabled = false;
        isSending = false;
        chatInput.focus();
    }
}

function showBackgroundSyncIndicator() {
    const id = 'mem-sync-loader';
    if (document.getElementById(id)) return;
    const msgDiv = document.createElement('div');
    msgDiv.className = 'message ai';
    msgDiv.id = id;
    msgDiv.innerHTML = `<div class="avatar">sys</div><div class="bubble"><em style="color:var(--highlight); font-size: 0.8rem;">[Processing] Extracting data arrays...</em></div>`;
    chatWindow.appendChild(msgDiv);
    chatWindow.scrollTop = chatWindow.scrollHeight;
}

function hideBackgroundSyncIndicator() {
    document.getElementById('mem-sync-loader')?.remove();
}

async function refreshHUD() {
    try {
        const res = await fetch('/api/status');
        const data = await res.json();
        updateHUD(data);
    } catch(e) {}
}

sendBtn.addEventListener('click', sendMessage);
chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.repeat) {
        e.preventDefault();
        sendMessage();
    }
});

// ═══════════════════ TASK COMPLETION ═══════════════════

window.completeTaskBtn = async function(title, type = 'owner') {
    try {
        const res = await fetch('/api/tasks/complete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title, type })
        });
        const data = await res.json();
        if (data.success) {
            updateHUD(data);
            addMessage(`[SYSTEM] ${type.toUpperCase()} task '${title}' permanently dismissed.`, false);
        }
    } catch (err) {
        console.error("Failed to cross off task", err);
    }
};

// ═══════════════════ SSE WITH AUTO-RECONNECT ═══════════════════

function connectSSE() {
    const evtSource = new EventSource('/api/events');
    
    evtSource.onmessage = function(event) {
        try {
            const payload = JSON.parse(event.data);
            if (payload.type === 'reminder') {
                addMessage(`[URGENT OVERRIDE] ${payload.message}`, false);
            }
            if (payload.type === 'checkin') {
                addMessage(`[AEVIX] ${payload.message}`, false);
            }
            if (payload.type === 'memory_sync_complete') {
                if (document.getElementById('mem-sync-loader')) {
                    hideBackgroundSyncIndicator();
                }
                // Apply task data directly from SSE payload — no fetch race condition
                updateHUD(payload);
            }
        } catch (err) {
            console.error("SSE Parsing Error:", err);
        }
    };

    evtSource.onerror = function() {
        evtSource.close();
        console.warn('[SSE] Connection lost. Reconnecting in 5s...');
        setTimeout(connectSSE, 5000);
    };
}

connectSSE();

// ═══════════════════ BOOT PING ═══════════════════

window.addEventListener('DOMContentLoaded', async () => {
    try {
        // Fast status load (no LLM call)
        const res = await fetch('/api/status');
        const data = await res.json();
        updateHUD(data);

        if (data.history && data.history.length > 0) {
            data.history.forEach(msg => {
                if (!msg.content.includes("CURRENT CONTEXT")) {
                    addMessage(msg.content, msg.role === 'user');
                }
            });
        }

        // Fetch boot briefing separately (slow LLM call — non-blocking)
        fetch('/api/briefing')
            .then(r => r.json())
            .then(b => { if (b.briefing) addMessage(b.briefing, false); })
            .catch(() => {});
    } catch(e) {
        console.warn("Silent boot ping failed.");
    }
});


// ═══════════════════════════════════════════════════════════
// ANALYTICS DASHBOARD
// ═══════════════════════════════════════════════════════════

let currentRange = 'day';
let chartInstances = { hourly: null, app: null, trend: null };

window.openAnalytics = function() {
    document.getElementById('analytics-modal').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    switchRange('day');
};

window.closeAnalytics = function() {
    document.getElementById('analytics-modal').classList.add('hidden');
    document.body.style.overflow = '';
    // Destroy chart instances to free memory
    Object.values(chartInstances).forEach(c => { if (c) c.destroy(); });
    chartInstances = { hourly: null, app: null, trend: null };
};

window.switchRange = function(range) {
    currentRange = range;
    // Update pill states
    document.querySelectorAll('.range-pill').forEach(p => {
        p.classList.toggle('active', p.dataset.range === range);
    });
    // Show/hide trend chart (only for week/month)
    document.getElementById('trend-panel').style.display = range === 'day' ? 'none' : 'block';
    fetchAnalytics(range);
    fetchInsights(range);
};

async function fetchAnalytics(range) {
    // Reset stat cards to loading
    ['stat-total', 'stat-productive', 'stat-distracted', 'stat-focus'].forEach(id => {
        document.getElementById(id).innerText = '...';
    });

    try {
        const res = await fetch(`/api/analytics?range=${range}`);
        const data = await res.json();

        if (data.error) {
            document.getElementById('stat-total').innerText = 'ERR';
            return;
        }

        // Populate stat cards
        document.getElementById('stat-total').innerText = data.totalActiveHours + 'h';
        document.getElementById('stat-productive').innerText = data.productiveHours + 'h';
        document.getElementById('stat-distracted').innerText = data.distractedHours + 'h';
        document.getElementById('stat-focus').innerText = data.focusRatio + '%';

        // Render charts
        renderHourlyChart(data);
        renderAppChart(data);
        if (range !== 'day') renderTrendChart(data);

        // Populate classification manager
        renderClassifyList(data);

    } catch (err) {
        console.error('[Analytics] Fetch failed:', err);
        document.getElementById('stat-total').innerText = 'Offline';
    }
}

async function fetchInsights(range) {
    const container = document.getElementById('insights-content');
    container.innerHTML = `
        <div class="skeleton-loader">
            <div class="skeleton-line"></div>
            <div class="skeleton-line short"></div>
            <div class="skeleton-line"></div>
            <div class="skeleton-line short"></div>
            <div class="skeleton-line"></div>
        </div>
    `;

    try {
        const res = await fetch(`/api/analytics/insights?range=${range}`);
        const data = await res.json();
        container.innerHTML = formatMarkdown(data.insights || 'No insights available.');
    } catch (err) {
        container.innerHTML = '<em style="color: var(--red);">Failed to generate insights. Check your Groq API connection.</em>';
    }
}

// ═══════════════════ CHART RENDERERS ═══════════════════

const chartDefaults = {
    color: '#949CAA',
    borderColor: 'rgba(255,255,255,0.05)',
};

function renderHourlyChart(data) {
    if (chartInstances.hourly) chartInstances.hourly.destroy();
    const ctx = document.getElementById('hourly-chart').getContext('2d');

    const hours = data.hourlyDistribution || new Array(24).fill(0);
    const colors = hours.map((_, i) => {
        // Color code: morning=blue, afternoon=green, evening=yellow, night=purple
        if (i >= 6 && i < 12) return 'rgba(69, 250, 255, 0.6)';
        if (i >= 12 && i < 17) return 'rgba(0, 255, 128, 0.6)';
        if (i >= 17 && i < 21) return 'rgba(255, 180, 0, 0.6)';
        return 'rgba(168, 85, 247, 0.5)';
    });

    chartInstances.hourly = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: Array.from({ length: 24 }, (_, i) => `${i}:00`),
            datasets: [{
                label: 'Active Minutes',
                data: hours,
                backgroundColor: colors,
                borderRadius: 4,
                borderSkipped: false,
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: 'rgba(11, 12, 16, 0.9)',
                    titleColor: '#45FAFF',
                    bodyColor: '#ECEFF4',
                    borderColor: 'rgba(69, 250, 255, 0.2)',
                    borderWidth: 1,
                    cornerRadius: 8,
                }
            },
            scales: {
                x: {
                    ticks: { color: chartDefaults.color, font: { size: 10 }, maxRotation: 0 },
                    grid: { color: chartDefaults.borderColor },
                },
                y: {
                    ticks: { color: chartDefaults.color, font: { size: 10 } },
                    grid: { color: chartDefaults.borderColor },
                    beginAtZero: true,
                }
            }
        }
    });
}

function renderAppChart(data) {
    if (chartInstances.app) chartInstances.app.destroy();
    const ctx = document.getElementById('app-chart').getContext('2d');

    // Combine apps and sites, sort by minutes
    const combined = [...(data.apps || []), ...(data.sites || [])]
        .sort((a, b) => b.minutes - a.minutes)
        .slice(0, 8);

    const colorMap = {
        productive: 'rgba(0, 255, 128, 0.7)',
        distracting: 'rgba(255, 77, 106, 0.7)',
        neutral: 'rgba(148, 156, 170, 0.5)',
        browser: 'rgba(69, 250, 255, 0.5)',
    };

    chartInstances.app = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: combined.map(c => c.name),
            datasets: [{
                data: combined.map(c => c.minutes),
                backgroundColor: combined.map(c => colorMap[c.category] || colorMap.neutral),
                borderColor: 'rgba(11, 12, 16, 0.8)',
                borderWidth: 2,
                hoverOffset: 6,
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '55%',
            plugins: {
                legend: {
                    position: 'right',
                    labels: {
                        color: '#ECEFF4',
                        font: { size: 11 },
                        padding: 12,
                        usePointStyle: true,
                        pointStyleWidth: 10,
                    }
                },
                tooltip: {
                    backgroundColor: 'rgba(11, 12, 16, 0.9)',
                    titleColor: '#45FAFF',
                    bodyColor: '#ECEFF4',
                    borderColor: 'rgba(69, 250, 255, 0.2)',
                    borderWidth: 1,
                    cornerRadius: 8,
                    callbacks: {
                        label: (ctx) => ` ${ctx.label}: ${ctx.parsed}m`
                    }
                }
            },
        }
    });
}

function renderTrendChart(data) {
    if (chartInstances.trend) chartInstances.trend.destroy();
    const ctx = document.getElementById('trend-chart').getContext('2d');

    const trend = data.dailyTrend || [];
    const labels = trend.map(d => {
        const dt = new Date(d.date);
        return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    });

    chartInstances.trend = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [
                {
                    label: 'Productive (min)',
                    data: trend.map(d => d.productive),
                    borderColor: 'rgba(0, 255, 128, 0.8)',
                    backgroundColor: 'rgba(0, 255, 128, 0.1)',
                    fill: true,
                    tension: 0.35,
                    pointRadius: 3,
                    pointBackgroundColor: '#00FF80',
                },
                {
                    label: 'Distracted (min)',
                    data: trend.map(d => d.distracted),
                    borderColor: 'rgba(255, 77, 106, 0.8)',
                    backgroundColor: 'rgba(255, 77, 106, 0.1)',
                    fill: true,
                    tension: 0.35,
                    pointRadius: 3,
                    pointBackgroundColor: '#FF4D6A',
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { intersect: false, mode: 'index' },
            plugins: {
                legend: {
                    labels: { color: '#ECEFF4', font: { size: 11 }, usePointStyle: true, pointStyleWidth: 10 }
                },
                tooltip: {
                    backgroundColor: 'rgba(11, 12, 16, 0.9)',
                    titleColor: '#45FAFF',
                    bodyColor: '#ECEFF4',
                    borderColor: 'rgba(69, 250, 255, 0.2)',
                    borderWidth: 1,
                    cornerRadius: 8,
                }
            },
            scales: {
                x: {
                    ticks: { color: chartDefaults.color, font: { size: 10 } },
                    grid: { color: chartDefaults.borderColor },
                },
                y: {
                    ticks: { color: chartDefaults.color, font: { size: 10 } },
                    grid: { color: chartDefaults.borderColor },
                    beginAtZero: true,
                }
            }
        }
    });
}

// ═══════════════════ DOWNLOAD REPORT ═══════════════════

window.downloadReport = function() {
    const a = document.createElement('a');
    a.href = `/api/analytics/report?range=${currentRange}`;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
};

// ═══════════════════ CLASSIFICATION MANAGER ═══════════════════

let _classifyItems = [];

function renderClassifyList(data) {
    const container = document.getElementById('classify-list');
    if (!container) return;

    _classifyItems = [];
    if (data.apps) {
        data.apps.forEach(a => _classifyItems.push({ name: a.name, type: 'app', category: a.category }));
    }
    if (data.sites) {
        data.sites.forEach(s => _classifyItems.push({ name: s.name, type: 'site', category: s.category }));
    }

    if (_classifyItems.length === 0) {
        container.innerHTML = '<em style="color: var(--text-sec);">No apps or sites detected for this period.</em>';
        return;
    }

    container.innerHTML = '';
    _classifyItems.forEach(function(item, idx) {
        var row = document.createElement('div');
        row.className = 'classify-item';

        var nameSpan = document.createElement('span');
        nameSpan.className = 'classify-item-name';
        nameSpan.title = item.name;
        nameSpan.textContent = item.name;

        var typeSpan = document.createElement('span');
        typeSpan.className = 'classify-item-type';
        typeSpan.textContent = item.type;

        var btnsDiv = document.createElement('div');
        btnsDiv.className = 'classify-btns';

        var cats = [
            { cat: 'productive', cls: 'green', icon: '\u2713' },
            { cat: 'distracting', cls: 'red', icon: '\u2717' },
            { cat: 'neutral', cls: 'grey', icon: '\u2014' }
        ];

        cats.forEach(function(c) {
            var btn = document.createElement('button');
            btn.className = 'classify-dot ' + c.cls;
            var isActive = (c.cat === item.category) || (c.cat === 'neutral' && item.category === 'browser');
            if (isActive) btn.classList.add('active');
            btn.title = c.cat.charAt(0).toUpperCase() + c.cat.slice(1);
            btn.textContent = c.icon;
            btn.setAttribute('data-idx', idx);
            btn.setAttribute('data-cat', c.cat);
            btn.addEventListener('click', handleClassifyClick);
            btnsDiv.appendChild(btn);
        });

        row.appendChild(nameSpan);
        row.appendChild(typeSpan);
        row.appendChild(btnsDiv);
        container.appendChild(row);
    });
}

function handleClassifyClick(e) {
    var idx = parseInt(e.currentTarget.getAttribute('data-idx'));
    var category = e.currentTarget.getAttribute('data-cat');
    var item = _classifyItems[idx];
    if (!item) return;
    fetch('/api/classifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: item.name, type: item.type, category: category })
    })
    .then(function(res) { return res.json(); })
    .then(function(data) {
        if (data.success) {
            fetchAnalytics(currentRange);
        }
    })
    .catch(function(err) {
        console.error('Classification update failed:', err);
    });
}

// Close modal on Escape key
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAnalytics();
});

// ─── Model Switcher ────────────────────────────────────────────────────
const PROVIDER_MODELS = {
    groq: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
    openai: ['gpt-4o-mini', 'gpt-4o', 'gpt-4-turbo'],
    anthropic: ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6', 'claude-opus-4-7'],
    local: [],
};

let _msProvider = 'groq';

function updateMsModelList(provider, currentModel) {
    const sel = document.getElementById('ms-model');
    sel.innerHTML = '';
    const models = PROVIDER_MODELS[provider] || [];
    if (models.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'Enter model name below';
        sel.appendChild(opt);
        sel.style.display = 'none';
    } else {
        sel.style.display = '';
        models.forEach(m => {
            const opt = document.createElement('option');
            opt.value = m;
            opt.textContent = m;
            if (m === currentModel) opt.selected = true;
            sel.appendChild(opt);
        });
    }
    document.getElementById('ms-key-row').style.display = (provider === 'local') ? 'none' : 'block';
    document.getElementById('ms-local-row').style.display = (provider === 'local') ? 'block' : 'none';
}

function selectMsProvider(provider, currentConfig) {
    _msProvider = provider;
    document.querySelectorAll('.ms-provider-btn').forEach(b => {
        b.style.background = b.dataset.provider === provider ? '#00d4ff22' : '#0a0a0f';
        b.style.borderColor = b.dataset.provider === provider ? '#00d4ff' : '#2a2a3a';
        b.style.color = b.dataset.provider === provider ? '#00d4ff' : '#94a3b8';
    });
    const modelMap = { groq: currentConfig.groq_model, openai: currentConfig.openai_model, anthropic: currentConfig.anthropic_model, local: currentConfig.local_model };
    updateMsModelList(provider, modelMap[provider]);
    if (provider === 'local') document.getElementById('ms-local-url').value = currentConfig.local_url || 'http://localhost:1234/v1';
}

async function openModelSwitcher() {
    const modal = document.getElementById('model-switcher-modal');
    modal.style.display = 'flex';
    document.getElementById('ms-status').textContent = 'Loading...';

    // Style provider buttons
    document.querySelectorAll('.ms-provider-btn').forEach(b => {
        Object.assign(b.style, {
            background: '#0a0a0f', border: '1px solid #2a2a3a', borderRadius: '6px',
            color: '#94a3b8', padding: '8px 12px', cursor: 'pointer',
            fontSize: '12px', fontWeight: '700', width: '100%', textAlign: 'left',
            transition: 'all 0.15s',
        });
        b.onclick = () => selectMsProvider(b.dataset.provider, _msCurrentConfig);
    });

    try {
        const res = await fetch('/api/config');
        _msCurrentConfig = await res.json();
        selectMsProvider(_msCurrentConfig.provider, _msCurrentConfig);
        document.getElementById('ms-status').textContent = '';
    } catch {
        document.getElementById('ms-status').textContent = 'Could not load config.';
    }
}

let _msCurrentConfig = {};

function closeModelSwitcher() {
    document.getElementById('model-switcher-modal').style.display = 'none';
}

async function saveModelConfig() {
    const status = document.getElementById('ms-status');
    const model = document.getElementById('ms-model').value;
    const key = document.getElementById('ms-key').value.trim();
    const localUrl = document.getElementById('ms-local-url').value.trim();
    status.style.color = '#64748b';
    status.textContent = 'Applying...';

    const body = { provider: _msProvider, model };
    if (key) body.api_key = key;
    if (_msProvider === 'local' && localUrl) body.local_url = localUrl;

    try {
        const res = await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const data = await res.json();
        if (data.ok) {
            status.style.color = '#22c55e';
            status.textContent = '✓ Applied. Active on next message.';
            const label = model || _msProvider;
            document.getElementById('model-switcher-btn').textContent = `⬡ ${label}`;
            setTimeout(closeModelSwitcher, 1200);
        } else {
            status.style.color = '#ef4444';
            status.textContent = '✗ Failed to save.';
        }
    } catch {
        status.style.color = '#ef4444';
        status.textContent = '✗ Network error.';
    }
}

// Load current model into button on startup
fetch('/api/config').then(r => r.json()).then(c => {
    const label = c.groq_model || c.openai_model || c.anthropic_model || c.local_model || c.provider || '—';
    document.getElementById('model-switcher-btn').textContent = `⬡ ${label}`;
}).catch(() => {});

// Close modal on backdrop click
document.getElementById('model-switcher-modal').addEventListener('click', function(e) {
    if (e.target === this) closeModelSwitcher();
});

// Close on Escape
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModelSwitcher(); });
