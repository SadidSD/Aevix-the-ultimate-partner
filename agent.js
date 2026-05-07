import "dotenv/config";
import { Annotation, StateGraph } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import Database from "better-sqlite3";
import { ChatGroq } from "@langchain/groq";
import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import fs from "fs";
import path from "path";
import {
    SYSTEM_AEVIX,
    MEMORY_REFINEMENT_PROMPT_LITE,
    ACTIVITY_LOGGING_PROMPT,
    BOOT_BRIEFING_PROMPT,
    PROACTIVE_CHECKIN_PROMPT
} from "./prompts.js";
import { getRecentActivity } from "./aw_client.js";

// ─── Monitor Event Bus ───────────────────────────────────────────────
const MAX_MONITOR_EVENTS = 200;
const monitorEvents = [];

export function logMonitor(type, data) {
    const event = { id: Date.now() + Math.random(), ts: new Date().toISOString(), type, ...data };
    monitorEvents.unshift(event);
    if (monitorEvents.length > MAX_MONITOR_EVENTS) monitorEvents.pop();
    if (global._monitorPush) global._monitorPush(event);
}

export function getMonitorEvents() { return monitorEvents; }

// ─── LLM Configuration ───────────────────────────────────────────────

function buildLLM(env) {
    const provider = env.LLM_PROVIDER || "groq";
    if (provider === "local" || provider === "ollama") {
        return new ChatOpenAI({
            configuration: { baseURL: env.LOCAL_LLM_URL || "http://localhost:1234/v1" },
            modelName: env.LOCAL_LLM_MODEL || "gemma-4",
            temperature: 0.1,
            apiKey: "not-needed",
        });
    }
    if (provider === "openai") {
        return new ChatOpenAI({
            apiKey: env.OPENAI_API_KEY,
            modelName: env.OPENAI_MODEL || "gpt-4o-mini",
            temperature: 0,
        });
    }
    if (provider === "anthropic") {
        return new ChatAnthropic({
            apiKey: env.ANTHROPIC_API_KEY,
            model: env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
            temperature: 0,
        });
    }
    // default: groq
    return new ChatGroq({
        apiKey: env.GROQ_API_KEY,
        model: env.GROQ_MODEL || "llama-3.3-70b-versatile",
        temperature: 0,
        maxRetries: 3,
        timeout: 15000,
    });
}

let _llmInstance = buildLLM(process.env);
let _llmConfigKey = JSON.stringify([process.env.LLM_PROVIDER, process.env.GROQ_MODEL, process.env.OPENAI_MODEL, process.env.ANTHROPIC_MODEL, process.env.LOCAL_LLM_MODEL]);

function getLLM() {
    const configKey = JSON.stringify([process.env.LLM_PROVIDER, process.env.GROQ_MODEL, process.env.OPENAI_MODEL, process.env.ANTHROPIC_MODEL, process.env.LOCAL_LLM_MODEL]);
    if (configKey !== _llmConfigKey) {
        console.log("[Core] LLM config changed, reinitializing...");
        _llmInstance = buildLLM(process.env);
        _llmConfigKey = configKey;
    }
    return _llmInstance;
}

const llm = { invoke: (...a) => getLLM().invoke(...a), withConfig: (...a) => getLLM().withConfig(...a) };
const fastLlm = llm;

// ─── Utility Functions ───────────────────────────────────────────────

/**
 * Parses Owner-Tasks.md into a structured JSON array.
 */
export function readTasksFromFile(filePath = "./tasks/Owner-Tasks.md") {
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    const tasks = [];
    
    // Regex to match "- [ ] Task Name" or "- [x] Task Name"
    const taskRegex = /-\s\[( |x)\]\s(.*)/;
    
    for (const line of lines) {
        const match = line.match(taskRegex);
        if (match) {
            tasks.push({
                completed: match[1] === "x",
                title: match[2].trim(),
                notified: false // Transient state for reminders
            });
        }
    }
    return tasks;
}

/**
 * Writes a JSON array of tasks back to Owner-Tasks.md.
 */
export function writeTasksToFile(tasks, filePath = "./tasks/Owner-Tasks.md") {
    const filename = path.basename(filePath);
    const headerPrefix = filename.replace(".md", "").replace("-", " ");
    let content = `# ${headerPrefix}\n\n## Active\n`;
    const active = tasks.filter(t => !t.completed);
    const completed = tasks.filter(t => t.completed);
    
    for (const t of active) {
        content += `- [ ] ${t.title}\n`;
    }
    
    content += "\n## Completed\n";
    for (const t of completed) {
        content += `- [x] ${t.title}\n`;
    }
    
    fs.writeFileSync(filePath, content, "utf-8");
}

/**
 * Scrubs redundant facts from identity files to prevent persona bloat.
 */
function deduplicateIdentity(filePath) {
    if (!fs.existsSync(filePath)) return;
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    const unique = [];
    const seen = new Set();

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === "# Owner Identity & Known Facts") {
            unique.push(line);
            continue;
        }
        
        // Simple deduplication for exact or highly similar bullets
        const bullet = trimmed.replace(/^- /, "").toLowerCase();
        if (!seen.has(bullet)) {
            unique.push(line);
            seen.add(bullet);
        }
    }
    fs.writeFileSync(filePath, unique.join("\n"), "utf-8");
}

/**
 * Logs task activity to time-based and name-based log files.
 */
function logTaskActivity(taskTitle, startTime, endTime, status) {
    const dateStr = new Date().toISOString().split('T')[0];
    const timeStr = new Date().toLocaleTimeString();
    
    // 1. Time-based Activity Log (logs/activity/YYYY-MM-DD.md)
    const dayLogPath = `./logs/activity/${dateStr}.md`;
    if (!fs.existsSync(path.dirname(dayLogPath))) fs.mkdirSync(path.dirname(dayLogPath), { recursive: true });
    
    let durationLog = "";
    if (startTime && endTime) {
        const diff = new Date(endTime) - new Date(startTime);
        const mins = Math.floor(diff / 60000);
        durationLog = ` (Duration: ${mins}m)`;
    }

    const entry = `\n- [${timeStr}] **${status}**: ${taskTitle}${durationLog}\n`;
    fs.appendFileSync(dayLogPath, entry, "utf-8");

    // 2. Name-based Activity Log (logs/activities/Task-Name.md)
    const sanitizedTitle = taskTitle.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const taskLogPath = `./logs/activities/${sanitizedTitle}.md`;
    if (!fs.existsSync(path.dirname(taskLogPath))) fs.mkdirSync(path.dirname(taskLogPath), { recursive: true });
    
    const taskEntry = `\n- **${dateStr} ${timeStr}**: ${status}${durationLog}\n`;
    fs.appendFileSync(taskLogPath, taskEntry, "utf-8");
    
    console.log(`[Logger] Activity Logged: ${status} - ${taskTitle}${durationLog}`);
}

// 1. Define Graph State
export const AevixState = Annotation.Root({
    messages: Annotation({
        reducer: (x, y) => x.concat(y),
        default: () => [],
    }),
    activity_summary: Annotation({
        reducer: (_, y) => y,
        default: () => "",
    }),
    energy_prediction: Annotation({
        reducer: (_, y) => y,
        default: () => "Unknown",
    }),
    daily_plan: Annotation({
        reducer: (_, y) => y,
        default: () => "",
    }),
    active_session: Annotation({
        reducer: (_, y) => y,
        default: () => null, // { task_title: string, start_time: ISO_String }
    })
});

// 2. Define Nodes
async function activityQueryNode() {
    const summaryText = await getRecentActivity(24);
    return { activity_summary: summaryText };
}

async function analyzerNode(state) {
    const activity = state.activity_summary || "No data.";
    
    const prompt = `Based on this PC activity data:\n${activity}\nPredict the user's energy level for tomorrow (High, Medium, Low) and explain why in 2 sentences.`;
    const res = await llm.invoke([new SystemMessage("You are an energy predictor."), new HumanMessage(prompt)]);
    
    return { energy_prediction: res.content };
}

async function plannerNode(state) {
    const energy = state.energy_prediction;
    const tasks = JSON.stringify(readTasksFromFile().filter(t => !t.completed));
    
    const prompt = `Energy: ${energy}\nTasks: ${tasks}\nDraft a short time-blocked schedule for tomorrow maximizing deep work.`;
    const res = await fastLlm.invoke([new SystemMessage("You are a schedule planner."), new HumanMessage(prompt)]);
    
    return { daily_plan: res.content };
}

function hasExplicitConsent(messages) {
    if (!messages || messages.length === 0) return false;

    const lastMsg = messages.slice().reverse().find(m => {
        const type = m.getType ? m.getType() : (m._getType ? m._getType() : m.type);
        return type === 'human' || m.role === 'user';
    });
    if (!lastMsg) return false;

    const text = (typeof lastMsg.content === 'string' ? lastMsg.content : '').toLowerCase();

    // Block: removal-only intent must never unlock task addition
    const removalOnly = /\b(remove|delete|clear|cancel|dismiss|drop)\b/.test(text) &&
        !/\b(add|queue|remind|task|note|remember|track|schedule|put)\b/.test(text);
    if (removalOnly) return false;

    // Require explicit addition intent
    const additionKeywords = [
        'add', 'queue', 'remind me', 'remember', 'new task', 'put this',
        'track', 'schedule', 'note this', 'log this', 'yes', 'sure', 'ok', 'okay',
        'sounds good', 'go ahead', 'do it', 'confirm', 'please do'
    ];
    return additionKeywords.some(k => text.includes(k));
}

async function memoryReflectorNode(state) {
    // Determine current onboarding status
    const onboardingActive = fs.existsSync("./system/OpeningFunction.md");
    
    const ownerIdentity = fs.readFileSync("./system/Owner-Identity.md", "utf-8").slice(-1500);
    const identity = fs.readFileSync("./system/Identity.md", "utf-8").slice(-1500);
    const compressedContext = `[Owner Facts]: ${ownerIdentity}\n[Aevix Identity]: ${identity}`;

    const exampleOutput = JSON.stringify({
        owner_facts: ["Likes coffee"],
        identity_updates: ["Prefers dark mode"],
        onboarding_complete: false,
        new_skills: [],
        tasks: { owner: ["Buy milk"], aevix: [], targets: [], remove: ["Old task title"] },
        task_sessions: { start: [], complete: [] }
    });

    const memSysPrompt = MEMORY_REFINEMENT_PROMPT_LITE + `\n\nCONTEXT:\n${compressedContext}\n\nEXAMPLE OUTPUT:\n${exampleOutput}\n\nCRITICAL: RESPONSE MUST BE A VALID JSON OBJECT ONLY. NO MARKDOWN. NO EXPLANATION.`;
    const memUserPrompt = `Analyze this conversation for new facts, preferences, or tasks to add/remove: ${JSON.stringify(state.messages.slice(-2))}`;
    const prompt = [new SystemMessage(memSysPrompt), new HumanMessage(memUserPrompt)];

    logMonitor('memory', { label: 'Memory Reflector', system: memSysPrompt, user: memUserPrompt });
    try {
        const res = await llm.withConfig({ temperature: 0 }).invoke(prompt);
        
        let content = res.content.trim();
        // Strip markdown code fences local models often add
        content = content.replace(/^```(?:json)?\s*/m, '').replace(/```\s*$/m, '');
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            console.warn("[Memory] LLM failed to output JSON. Raw:", content.slice(0, 200));
            return {};
        }

        let extracted;
        try {
            extracted = JSON.parse(jsonMatch[0]);
        } catch (parseErr) {
            console.warn("[Memory] JSON parse failed:", parseErr.message, "| Raw:", jsonMatch[0].slice(0, 200));
            return {};
        }
        const extractionSummary = { tasks: extracted.tasks, task_sessions: extracted.task_sessions, facts: extracted.owner_facts?.length };
        console.log("[Memory] Extraction:", JSON.stringify(extractionSummary));
        logMonitor('memory_result', { label: 'Memory Extraction', response: res.content, extracted: extractionSummary });

        // Cap to prevent re-extraction explosion on large histories
        if (Array.isArray(extracted.owner_facts)) extracted.owner_facts = extracted.owner_facts.slice(0, 3);

        // 1. Update Owner Facts
        if (extracted.owner_facts?.length > 0) {
            fs.appendFileSync("./system/Owner-Identity.md", `\n- ${extracted.owner_facts.join("\n- ")}`, "utf-8");
            deduplicateIdentity("./system/Owner-Identity.md");
        }

        // 2. Update Identity/Preferences
        if (extracted.identity_updates?.length > 0) {
            fs.appendFileSync("./system/Identity.md", `\n- ${extracted.identity_updates.join("\n- ")}`, "utf-8");
            deduplicateIdentity("./system/Identity.md");
        }

        // 3. New Skills
        if (extracted.new_skills?.length > 0) {
            for (const skill of extracted.new_skills) {
                const skillPath = `./skills/${skill.name.replace(/\s+/g, '-')}.md`;
                if (!fs.existsSync(skillPath)) {
                    fs.writeFileSync(skillPath, `# Skill: ${skill.name}\n\n${skill.description}\n\n*Created dynamically via conversation reflection.*`, "utf-8");
                }
            }
        }

        // 4. Update Task Files (Semantic Reflection)
        const hasConsent = hasExplicitConsent(state.messages);
        const isRemoving = extracted.task_sessions?.complete?.length > 0;

        if (!onboardingActive && (hasConsent || isRemoving)) {
            // Owner Tasks
            if (extracted.tasks?.owner?.length > 0) {
                const current = readTasksFromFile("./tasks/Owner-Tasks.md");
                for (const t of extracted.tasks.owner) {
                    if (!current.find(u => u.title.toLowerCase().trim() === t.toLowerCase().trim())) {
                        current.push({ title: t, completed: false });
                        writeTasksToFile(current, "./tasks/Owner-Tasks.md");
                        console.log(`[SEMANTIC-TRUST] Task Addition: "${t}"`);
                        logMonitor('task_op', { label: 'Task Added', detail: `Owner: "${t}"` });
                    }
                }
            }
            // Aevix Directives
            if (extracted.tasks?.aevix?.length > 0) {
                const current = readTasksFromFile("./tasks/Aevix-Tasks.md");
                for (const t of extracted.tasks.aevix) {
                    if (!current.find(u => u.title.toLowerCase().trim() === t.toLowerCase().trim())) {
                        current.push({ title: t, completed: false });
                        writeTasksToFile(current, "./tasks/Aevix-Tasks.md");
                        console.log(`[SEMANTIC-TRUST] Aevix Directive: "${t}"`);
                    }
                }
            }
            // Targets
            if (extracted.tasks?.targets?.length > 0) {
                const current = readTasksFromFile("./tasks/Targets.md");
                for (const t of extracted.tasks.targets) {
                    if (!current.find(u => u.title.toLowerCase().trim() === t.toLowerCase().trim())) {
                        current.push({ title: t, completed: false });
                        writeTasksToFile(current, "./tasks/Targets.md");
                        console.log(`[SEMANTIC-TRUST] Target Extraction: "${t}"`);
                    }
                }
            }
        }

        // Catch-all for logging unauthorized extractions
        if (!hasConsent && !isRemoving) {
            const hasOwner = extracted.tasks?.owner?.length > 0;
            const hasAevix = extracted.tasks?.aevix?.length > 0;
            const hasTargets = extracted.tasks?.targets?.length > 0;
            if (hasOwner || hasAevix || hasTargets) {
                console.log(`[GUARDRAIL] Universal Block: Unauthorized extraction detected (Owner:${hasOwner}, Aevix:${hasAevix}, Target:${hasTargets}). Hardware gate engaged.`);
            }
        }

        // Physical Removal (Hard Delete)
        if (extracted.tasks?.remove?.length > 0) {
            const files = ["./tasks/Owner-Tasks.md", "./tasks/Aevix-Tasks.md", "./tasks/Targets.md"];
            for (const removalTitle of extracted.tasks.remove) {
                const lowTitle = removalTitle.toLowerCase();
                
                // Bulk Clear Logic
                if (lowTitle.includes("all directives") || lowTitle.includes("agent directives") || lowTitle === "directives") {
                    writeTasksToFile([], "./tasks/Aevix-Tasks.md");
                    console.log(`[IRON_GATE V2] BULK CLEAR: Agent Directives`);
                    continue;
                }
                if (lowTitle.includes("all tasks") || lowTitle === "tasks") {
                    writeTasksToFile([], "./tasks/Owner-Tasks.md");
                    console.log(`[IRON_GATE V2] BULK CLEAR: Owner Tasks`);
                    continue;
                }
                if (lowTitle.includes("all targets") || lowTitle === "targets") {
                    writeTasksToFile([], "./tasks/Targets.md");
                    console.log(`[IRON_GATE V2] BULK CLEAR: Targets`);
                    continue;
                }

                // Fuzzy word-overlap match — handles LLM paraphrasing task titles
                const removalWords = lowTitle.split(/\s+/).filter(w => w.length > 2);
                const taskMatches = (taskTitle) => {
                    const t = taskTitle.toLowerCase();
                    if (t.includes(lowTitle) || lowTitle.includes(t)) return true;
                    const hits = removalWords.filter(w => t.includes(w)).length;
                    return hits >= Math.max(2, Math.floor(removalWords.length * 0.5));
                };

                for (const f of files) {
                    const tasks = readTasksFromFile(f);
                    const filtered = tasks.filter(u => !taskMatches(u.title));
                    if (filtered.length !== tasks.length) {
                        writeTasksToFile(filtered, f);
                        console.log(`[IRON_GATE V2] Physically DELETED: "${removalTitle}" from ${f}`);
                        break;
                    }
                }
            }
        }

        // 5. SESSION TRACKING (START/COMPLETE)
        const sessionDelta = {};
        if (extracted.task_sessions) {
            const { start, complete } = extracted.task_sessions;
            const now = new Date().toISOString();

            // Handle Multiple Starts
            if (Array.isArray(start)) {
                for (const stag of start) {
                    logTaskActivity(stag, now, null, "STARTED");
                    sessionDelta.active_session = { task_title: stag, start_time: now };
                }
            } else if (start) {
                logTaskActivity(start, now, null, "STARTED");
                sessionDelta.active_session = { task_title: start, start_time: now };
            }

            // Handle Multiple Completions
            const completionList = Array.isArray(complete) ? complete : (complete ? [complete] : []);
            for (const compTag of completionList) {
                // 1. Mark as completed in file (Fuzzy matcher)
                const files = ["./tasks/Owner-Tasks.md", "./tasks/Aevix-Tasks.md", "./tasks/Targets.md"];
                for (const f of files) {
                    const tasks = readTasksFromFile(f);
                    const t = tasks.find(u => !u.completed && (u.title.toLowerCase().includes(compTag.toLowerCase()) || compTag.toLowerCase().includes(u.title.toLowerCase())));
                    if (t) {
                        t.completed = true;
                        writeTasksToFile(tasks, f);
                        break;
                    }
                }

                // 2. Log activity
                const currentSession = state.active_session;
                let startTime = null;
                if (currentSession && (currentSession.task_title.toLowerCase().includes(compTag.toLowerCase()) || compTag.toLowerCase().includes(currentSession.task_title.toLowerCase()))) {
                    startTime = currentSession.start_time;
                }
                
                logTaskActivity(compTag, startTime, now, "COMPLETED");
                logMonitor('task_op', { label: 'Task Completed', detail: `"${compTag}"` });
                sessionDelta.active_session = null;
            }
        }

        // 6. Cleanup Onboarding — auto-complete when enough facts are accumulated
        const onboardingPath = "./system/OpeningFunction.md";
        if (fs.existsSync(onboardingPath)) {
            const identityContent = fs.existsSync("./system/Owner-Identity.md") ? fs.readFileSync("./system/Owner-Identity.md", "utf-8") : "";
            const factCount = (identityContent.match(/\n[*-]/g) || []).length;
            if (extracted.onboarding_complete === true || factCount >= 8) {
                console.log("[Memory] Onboarding complete. Removing OpeningFunction.md");
                fs.unlinkSync(onboardingPath);
                // Write completion marker so bootstrap never re-triggers onboarding
                fs.writeFileSync("./system/.onboarding_complete", new Date().toISOString(), "utf-8");
            }
        }

        return sessionDelta;

    } catch (e) {
        console.warn("[Memory] Reflection failed", e.message);
    }
    return {};
}


async function activityLoggerNode(state) {
    const dateStr = new Date().toISOString().split('T')[0];
    const telemetry = state.activity_summary || "No data.";
    const lastExchange = state.messages.slice(-2).map(m => `${m.getType()}: ${m.content}`).join("\n");

    const prompt = ACTIVITY_LOGGING_PROMPT
        .replace("{telemetry}", telemetry)
        .replace("{chat_summary}", lastExchange);

    try {
        const res = await fastLlm.invoke([new SystemMessage("You are a productivity logger."), new HumanMessage(prompt)]);
        const jsonMatch = res.content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return {};
        
        let log;
        try {
            log = JSON.parse(jsonMatch[0]);
        } catch (e) {
            console.error("[Logger] JSON Parse failed for AI output:", e.message);
            // Even more aggressive cleanup: Remove ALL control characters (0-31 and 127) explicitly
            const cleaned = jsonMatch[0]
                .replace(/\\n/g, " ") 
                .replace(/[\u0000-\u001F\u007F]/g, " ")
                .replace(/\s+/g, " ")
                .trim();
            log = JSON.parse(cleaned);
        }

        // 1. Raw Activity Log
        const activityPath = `./logs/activity/${dateStr}.md`;
        if (!fs.existsSync(path.dirname(activityPath))) fs.mkdirSync(path.dirname(activityPath), { recursive: true });
        const logEntry = `\n### SESSION ${new Date().toLocaleTimeString()}\n${log.activity_bullets}\n`;
        fs.appendFileSync(activityPath, logEntry, "utf-8");

        // 2. Pattern Analytics (Daily)
        const patternPath = `./logs/patterns/daily/${dateStr}.md`;
        if (!fs.existsSync(path.dirname(patternPath))) fs.mkdirSync(path.dirname(patternPath), { recursive: true });
        fs.writeFileSync(patternPath, `# Patterns & Analytics: ${dateStr}\n\n${log.pattern_summary}`, "utf-8");

        // 3. Category Index
        if (log.category) {
            const safeCategory = log.category.replace(/[^a-z0-9]/gi, '-').toLowerCase();
            const catPath = `./logs/activities/${safeCategory}.md`;
            if (!fs.existsSync(path.dirname(catPath))) fs.mkdirSync(path.dirname(catPath), { recursive: true });
            fs.appendFileSync(catPath, `\n- **${dateStr}**: ${log.activity_bullets.split('\n')[0]}`, "utf-8");
        }

    } catch (e) {
        console.warn("[Logger] Logging failed", e.message);
    }
    return {};
}

// 3. Define Graph Routing
// We separate the daily routines from the conversational routines.

async function chatNode(state) {
    const onboardingActive = fs.existsSync("./system/OpeningFunction.md");

    const ownerIdentity = fs.existsSync("./system/Owner-Identity.md") ? fs.readFileSync("./system/Owner-Identity.md", "utf-8").slice(-1500) : "";
    const identity = fs.existsSync("./system/Identity.md") ? fs.readFileSync("./system/Identity.md", "utf-8").slice(-1500) : "";
    const memoryContext = `[Owner Facts]: ${ownerIdentity}\n[Aevix Identity]: ${identity}`;

    let systemPrompt;
    if (onboardingActive) {
        const openingProtocol = fs.readFileSync("./system/OpeningFunction.md", "utf-8");
        systemPrompt = `You are Aevix — a sharp, dry-witted AI assistant modelled after J.A.R.V.I.S. Address the user as "Sir" or "Boss". Be concise and professional.\n\nDo NOT reference time, energy, tasks, or activity — you have none of that yet. Do NOT hallucinate context.\n\n${openingProtocol}\n\n${memoryContext}`;
    } else {
        const pendingTasks = readTasksFromFile("./tasks/Owner-Tasks.md").filter(t => !t.completed).map(t => t.title);
        const aevixDirectives = readTasksFromFile("./tasks/Aevix-Tasks.md").filter(t => !t.completed).map(t => t.title);
        const activitySnippet = (state.activity_summary || "No recent activity data.").slice(0, 600);
        const liveContext = [
            `[Current Time]: ${new Date().toLocaleString()}`,
            `[Energy Forecast]: ${state.energy_prediction || "Unknown"}`,
            `[Pending Tasks]: ${pendingTasks.length ? pendingTasks.join(", ") : "None"}`,
            `[Aevix Directives]: ${aevixDirectives.length ? aevixDirectives.join(", ") : "None"}`,
            `[Recent PC Activity]: ${activitySnippet}`,
            `\nGROUND TRUTH RULE: The values above are read live from disk RIGHT NOW. They are always correct. If conversation history contradicts them, ignore the history and trust what is written above.`
        ].join("\n");
        systemPrompt = `${SYSTEM_AEVIX}\n${memoryContext}\n${liveContext}`;
    }
    const sysMsg = new SystemMessage(systemPrompt);
    const messages = [sysMsg, ...state.messages.slice(-4)];

    const userMsg = state.messages.slice(-1)[0]?.content || "";
    logMonitor('chat', { label: 'Chat', system: systemPrompt, user: userMsg });
    const res = await llm.invoke(messages);
    logMonitor('chat_response', { label: 'Chat Response', response: res.content });
    return { messages: [res] };
}

const workflow = new StateGraph(AevixState)
    .addNode("chat", chatNode)
    .addEdge("__start__", "chat")
    .addEdge("chat", "__end__");

// We still keep the nodes but don't automatically trigger them after chat.
// We'll export a wrapper to explicitly run the background memory engine.
export const asyncMemorySync = async (state, config) => {
    console.log("[Core] Executing Async Memory Sync...");
    try {
        const delta = await memoryReflectorNode(state);
        if (delta && Object.keys(delta).length > 0) {
            await aevixApp.updateState(config, delta);
            console.log("[Core] State updated via memory reflection:", delta);
        }
        await activityLoggerNode(state);
    } catch (e) {
        console.error("[Core] Fast memory sync failed.", e);
    }
};

// Persistent Offline SQLite Database
const db = new Database("aevix_memory.db");
const checkpointer = new SqliteSaver(db);
export const aevixApp = workflow.compile({ checkpointer });

// Expose individual routine functions so index.js can trigger them on cron
export async function runNightlyRoutine(config) {
    console.log("[Cron] Running Nightly Routine...");
    
    // We can manually run analyzer and planner without routing them through the standard chat edge
    const state = await aevixApp.getState(config);
    const s = state.values;
    
    const act = await activityQueryNode(s);
    const anResult = await analyzerNode({ ...s, ...act });
    const plResult = await plannerNode({ ...s, ...act, ...anResult });
    
    await aevixApp.updateState(config, {
        activity_summary: act.activity_summary,
        energy_prediction: anResult.energy_prediction,
        daily_plan: plResult.daily_plan
    });
    
    return plResult.daily_plan;
}

// Active polling function for desktop notifications
export async function checkReminders(config) {
    let tasks = readTasksFromFile().filter(t => !t.completed);
    let unnotifiedTasks = tasks.filter(t => !t.notified);
    if (unnotifiedTasks.length === 0) return null;

    const prompt = `Current System Time: ${new Date().toLocaleString()}
Pending Tasks: ${JSON.stringify(unnotifiedTasks)}

CRITICAL SYSTEM COMMAND: Are any of these tasks cleanly approaching their deadline within the next 5 to 15 minutes?
To prevent temporal hallucinations, YOU MUST physically use a <scratchpad> block to calculate the EXACT hour and minute differences for every task before you make your final decision.

Rules:
1. If a task is tagged as type 'Project' and has no explicit deadline within 15 minutes, IGNORE IT.
2. If the calculated time remaining is > 15 minutes (meaning it's 2 hours away, tomorrow, etc.), YOU MUST NOT GENERATE A REMINDER.
3. If ALL evaluated tasks are > 15 minutes away, respond with EXACTLY the word: NONE after your scratchpad.
4. Only if a task mathematically has exactly 5 to 15 minutes remaining (or is actively overdue), respond with a pure JSON object in this exact format after your scratchpad: { "message": "your witty 1-sentence reminder acting in your persona, reminding them of the upcoming deadline", "taskTitle": "the EXACT title of the task from the array" }`;

    try {
        const res = await fastLlm.withConfig({ temperature: 0 }).invoke([new SystemMessage(SYSTEM_AEVIX), new HumanMessage(prompt)]);
        const answer = res.content.trim();
        
        // If the LLM successfully calculates it is too early/empty, it will output NONE below the scratchpad
        if (answer.includes('NONE') || answer.split('</scratchpad>')[1]?.includes('NONE')) return null;

        // Try to explicitly parse the JSON payload generated after the scratchpad
        const jsonMatch = answer.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return null;
        
        let parsed;
        try {
            parsed = JSON.parse(jsonMatch[0].replace(/\`\`\`json/g, '').replace(/\`\`\`/g, ''));
        } catch (e) {
            console.error("[CRON] Recoverable error - LLM generated malformed JSON ping payload.", e.message);
            return null;
        }

        if (parsed.message && parsed.taskTitle) {
            // Flag the specific task as notified globally in the SQLite state
            const newTasks = tasks.map(t => {
                if (t.title.toLowerCase().includes(parsed.taskTitle.toLowerCase()) || parsed.taskTitle.toLowerCase().includes(t.title.toLowerCase())) {
                    return { ...t, notified: true };
                }
                return t;
            });
            await aevixApp.updateState(config, { tasks: newTasks });
            return parsed.message;
        }
        return null;
    } catch (e) {
        return null;
    }
}

// Generates the JARVIS-style boot briefing shown on UI load
export async function generateBootBriefing(config) {
    try {
        const currentState = await aevixApp.getState(config);
        const s = currentState.values || {};

        const pendingTasks = readTasksFromFile("./tasks/Owner-Tasks.md").filter(t => !t.completed).map(t => t.title);
        const targets = readTasksFromFile("./tasks/Targets.md").filter(t => !t.completed).map(t => t.title);
        const activityRaw = s.activity_summary || await getRecentActivity(24);
        const activityText = typeof activityRaw === 'string' ? activityRaw : JSON.stringify(activityRaw);

        const prompt = BOOT_BRIEFING_PROMPT
            .replace("{time}", new Date().toLocaleString())
            .replace("{energy}", s.energy_prediction || "Unknown")
            .replace("{tasks}", pendingTasks.length ? pendingTasks.join(", ") : "None queued")
            .replace("{targets}", targets.length ? targets.join(", ") : "None set")
            .replace("{activity}", activityText.slice(0, 800));

        logMonitor('boot', { label: 'Boot Briefing', system: SYSTEM_AEVIX, user: prompt });
        const res = await fastLlm.invoke([new SystemMessage(SYSTEM_AEVIX), new HumanMessage(prompt)]);
        logMonitor('boot_response', { label: 'Boot Briefing Response', response: res.content });
        return res.content;
    } catch (e) {
        console.warn("[Boot] Briefing generation failed:", e.message);
        return `Good ${new Date().getHours() < 12 ? 'morning' : 'evening'}, Sir. Systems are online.`;
    }
}

// Checks recent activity and decides whether to proactively interrupt the owner
export async function generateProactiveCheckIn() {
    try {
        const activity = await getRecentActivity(1);
        const activityText = typeof activity === 'string' ? activity : JSON.stringify(activity);
        const pendingTasks = readTasksFromFile("./tasks/Owner-Tasks.md").filter(t => !t.completed).map(t => t.title);

        const prompt = PROACTIVE_CHECKIN_PROMPT
            .replace("{time}", new Date().toLocaleString())
            .replace("{activity}", activityText.slice(0, 600))
            .replace("{tasks}", pendingTasks.length ? pendingTasks.join(", ") : "None");

        logMonitor('checkin', { label: 'Proactive Check-In', system: SYSTEM_AEVIX, user: prompt });
        const res = await fastLlm.withConfig({ temperature: 0 }).invoke([new SystemMessage(SYSTEM_AEVIX), new HumanMessage(prompt)]);
        logMonitor('checkin_response', { label: 'Check-In Response', response: res.content });

        let parsed;
        try {
            let c = res.content.trim().replace(/^```(?:json)?\s*/m, '').replace(/```\s*$/m, '');
            parsed = JSON.parse(c.match(/\{[\s\S]*\}/)?.[0] || c);
        } catch { return null; }
        return parsed.should_notify ? parsed.message : null;
    } catch (e) {
        console.warn("[CheckIn] Proactive check-in failed:", e.message);
        return null;
    }
}

// Function to mutate state directly to delete a task
export async function removeTask(_config, title, type = 'owner') {
    const fileMap = {
        'owner': './tasks/Owner-Tasks.md',
        'aevix': './tasks/Aevix-Tasks.md',
        'target': './tasks/Targets.md'
    };
    
    const filePath = fileMap[type] || fileMap['owner'];
    const tasks = readTasksFromFile(filePath);
    const target = tasks.find(t => t.title === title);
    
    if (target) {
        target.completed = true;
        writeTasksToFile(tasks, filePath);
    }
    
    return tasks.filter(t => !t.completed);
}
