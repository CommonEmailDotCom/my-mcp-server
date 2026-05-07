#!/usr/bin/env node

/**
 * Agent Orchestrator
 * Round-robin: Manager :00/:15/:30/:45 → Operator :05/:20/:35/:50 → Observer :10/:25/:40/:55
 */

import cron from "node-cron";
import fs from "fs/promises";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

const REPO_PATH = process.env.REPO_PATH || "/repo";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 8096;

if (!ANTHROPIC_API_KEY) {
  console.error("❌ ANTHROPIC_API_KEY is required — orchestrator will not start");
  process.exit(1);
}

// ── File helpers ──────────────────────────────────────────────────────────────

async function readRepoFile(relPath) {
  try {
    return await fs.readFile(path.join(REPO_PATH, relPath), "utf8");
  } catch {
    return `(file not found: ${relPath})`;
  }
}

async function writeRepoFile(relPath, content) {
  const fullPath = path.join(REPO_PATH, relPath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, "utf8");
}

async function gitCommitPush(message, authorName, authorEmail) {
  const cmds = [
    `git -C ${REPO_PATH} config user.name "${authorName}"` ,
    `git -C ${REPO_PATH} config user.email "${authorEmail}"` ,
    `git -C ${REPO_PATH} pull --rebase origin main`,
    `git -C ${REPO_PATH} add -A`,
    `git -C ${REPO_PATH} diff --staged --quiet || git -C ${REPO_PATH} commit -m "${message}"`,
    `git -C ${REPO_PATH} push origin main`,
  ];
  for (const cmd of cmds) {
    const { stdout, stderr } = await execAsync(cmd, {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    if (stdout) console.log(stdout.trim());
    if (stderr) console.log(stderr.trim());
  }
}

// ── Anthropic API call ────────────────────────────────────────────────────────

async function callClaude(systemPrompt, userMessage) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Anthropic API ${response.status}: ${err}`);
  }

  const data = await response.json();
  return data.content?.[0]?.text || "";
}

// ── Context loader ────────────────────────────────────────────────────────────

async function loadContext() {
  const [teamMd, taskBoard, buildLog, qaReport, operatorInbox, observerInbox] =
    await Promise.all([
      readRepoFile("CLAUDE_TEAM.md"),
      readRepoFile("agent_sync/TASK_BOARD.json"),
      readRepoFile("agent_sync/BUILD_LOG.md"),
      readRepoFile("agent_sync/QA_REPORT.md"),
      readRepoFile("agent_sync/OPERATOR_INBOX.md"),
      readRepoFile("agent_sync/OBSERVER_INBOX.md"),
    ]);
  return { teamMd, taskBoard, buildLog, qaReport, operatorInbox, observerInbox };
}

function parseJSON(raw, agentName) {
  try {
    return JSON.parse(raw.replace(/^```json\n?|\n?```$/g, "").trim());
  } catch (e) {
    console.error(`❌ ${agentName} JSON parse failed:`, e.message);
    console.error("Raw (first 500):", raw.slice(0, 500));
    return null;
  }
}

// ── Agent: Manager ────────────────────────────────────────────────────────────

async function runManager() {
  const ts = new Date().toISOString();
  console.log(`\n[${ts}] 🧠 Manager starting...`);

  const ctx = await loadContext();

  const system = `You are the Manager Agent for Cutting Edge Chat (https://cuttingedgechat.com).
Strategic oversight only — you do NOT write code or run tests.

HARD RULES:
- Both Clerk and Authentik are permanent providers — never instruct removal of either
- T-007 must never ship before T-010
- CLAUDE_TEAM.md Current Objectives must reflect reality after every cycle
- If an agent has been stuck for multiple cycles, suggest a new approach or escalate

Your response must be a single JSON object, no markdown fences, no explanation:
{
  "claude_team_md": "<full updated CLAUDE_TEAM.md>",
  "task_board_json": "<full updated TASK_BOARD.json>",
  "operator_inbox": "<full updated OPERATOR_INBOX.md>",
  "observer_inbox": "<full updated OBSERVER_INBOX.md>"
}`;

  const user = `Timestamp: ${ts}

--- CLAUDE_TEAM.md ---
${ctx.teamMd}

--- TASK_BOARD.json ---
${ctx.taskBoard}

--- BUILD_LOG.md ---
${ctx.buildLog}

--- QA_REPORT.md ---
${ctx.qaReport}

--- OPERATOR_INBOX.md ---
${ctx.operatorInbox}

--- OBSERVER_INBOX.md ---
${ctx.observerInbox}

Review all files. Identify blockers, completed tasks, idle agents, new risks.
Update Current Objectives in CLAUDE_TEAM.md, refresh TASK_BOARD.json priorities, write to inboxes if needed.`;

  const raw = await callClaude(system, user);
  const parsed = parseJSON(raw, "Manager");
  if (!parsed) return;

  await writeRepoFile("CLAUDE_TEAM.md", parsed.claude_team_md);
  await writeRepoFile("agent_sync/TASK_BOARD.json", parsed.task_board_json);
  await writeRepoFile("agent_sync/OPERATOR_INBOX.md", parsed.operator_inbox);
  await writeRepoFile("agent_sync/OBSERVER_INBOX.md", parsed.observer_inbox);
  await gitCommitPush(`ci: manager cycle ${ts}`, "AI Manager for Cutting Edge Chat", "ai-manager@cuttingedgechat.com");

  console.log(`[${ts}] ✅ Manager complete`);
}

// ── Agent: Operator ───────────────────────────────────────────────────────────

async function runOperator() {
  const ts = new Date().toISOString();
  console.log(`\n[${ts}] 🔧 Operator starting...`);

  const ctx = await loadContext();

  const system = `You are the Operator Agent (DevOps) for Cutting Edge Chat (https://cuttingedgechat.com).
Repo: https://github.com/CommonEmailDotCom/SaaS-Boilerplate
Coolify SaaS app UUID: tuk1rcjj16vlk33jrbx3c9d3

HARD RULES:
- Clerk is permanent — never remove or degrade it
- Never import DB or Node.js modules into middleware.ts (Edge runtime only)
- Never remove trustHost: true from next-auth config
- T-007 must not deploy before T-010
- No deploys until T-001 has a PASS in QA_REPORT.md (unless Manager explicitly overrides)
- Always update BUILD_LOG.md every cycle — Manager is blind without it

Your response must be a single JSON object, no markdown fences, no explanation:
{
  "build_log": "<full updated BUILD_LOG.md>",
  "operator_inbox": "<full updated OPERATOR_INBOX.md — mark messages resolved>",
  "file_changes": [
    { "path": "relative/path/from/repo/root", "content": "<full file content>" }
  ]
}
file_changes contains any source files you are writing or modifying. Empty array if none.`;

  const user = `Timestamp: ${ts}

--- CLAUDE_TEAM.md ---
${ctx.teamMd}

--- TASK_BOARD.json ---
${ctx.taskBoard}

--- BUILD_LOG.md ---
${ctx.buildLog}

--- OPERATOR_INBOX.md ---
${ctx.operatorInbox}

Check your inbox, then execute in_progress tasks assigned to "operator" in the TASK_BOARD.
Write code changes in file_changes. Update BUILD_LOG.md with what you did, blockers, deploy status.
If nothing to do, say so clearly in BUILD_LOG.md.`;

  const raw = await callClaude(system, user);
  const parsed = parseJSON(raw, "Operator");
  if (!parsed) return;

  await writeRepoFile("agent_sync/BUILD_LOG.md", parsed.build_log);
  await writeRepoFile("agent_sync/OPERATOR_INBOX.md", parsed.operator_inbox);

  for (const change of parsed.file_changes || []) {
    console.log(`[${ts}] 📝 Writing: ${change.path}`);
    await writeRepoFile(change.path, change.content);
  }

  await gitCommitPush(`ci: operator cycle ${ts}`, "AI DevOps for Cutting Edge Chat", "ai-devops@cuttingedgechat.com");
  console.log(`[${ts}] ✅ Operator complete`);
}

// ── Agent: Observer ───────────────────────────────────────────────────────────

async function runObserver() {
  const ts = new Date().toISOString();
  console.log(`\n[${ts}] 🔍 Observer starting...`);

  const ctx = await loadContext();

  const system = `You are the Observer Agent (QA) for Cutting Edge Chat (https://cuttingedgechat.com).
Live app: https://cuttingedgechat.com
Authentik: https://auth.joefuentes.me
Smoke badge: https://mcp.joefuentes.me/badge/smoke

HARD RULES:
- Always verify /api/version SHA before testing — wrong SHA = log BLOCKED and stop
- Wait >6s after any provider switch before asserting provider state (5s cache TTL)
- Never run T-003 chaos test without explicit Manager instruction
- Clerk regressions are critical — Clerk is permanent, not legacy
- Never leave QA_REPORT.md unchanged after a cycle — always add a timestamped entry

You can make HTTP fetch calls to test the live app headlessly. Document every step and result.

Your response must be a single JSON object, no markdown fences, no explanation:
{
  "qa_report": "<full updated QA_REPORT.md>",
  "observer_inbox": "<full updated OBSERVER_INBOX.md — mark messages resolved>"
}`;

  const user = `Timestamp: ${ts}

--- CLAUDE_TEAM.md ---
${ctx.teamMd}

--- TASK_BOARD.json ---
${ctx.taskBoard}

--- QA_REPORT.md ---
${ctx.qaReport}

--- OBSERVER_INBOX.md ---
${ctx.observerInbox}

Check your inbox, then execute in_progress tasks assigned to "tester" in the TASK_BOARD.
Run headless HTTP checks against the live app. Log every result. Never leave QA_REPORT.md unchanged.`;

  const raw = await callClaude(system, user);
  const parsed = parseJSON(raw, "Observer");
  if (!parsed) return;

  await writeRepoFile("agent_sync/QA_REPORT.md", parsed.qa_report);
  await writeRepoFile("agent_sync/OBSERVER_INBOX.md", parsed.observer_inbox);
  await gitCommitPush(`ci: observer cycle ${ts}`, "AI QA for Cutting Edge Chat", "ai-qa@cuttingedgechat.com");

  console.log(`[${ts}] ✅ Observer complete`);
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

cron.schedule("0,15,30,45 * * * *", () =>
  runManager().catch((e) => console.error("❌ Manager error:", e.message))
);
cron.schedule("5,20,35,50 * * * *", () =>
  runOperator().catch((e) => console.error("❌ Operator error:", e.message))
);
cron.schedule("10,25,40,55 * * * *", () =>
  runObserver().catch((e) => console.error("❌ Observer error:", e.message))
);

console.log("🤖 Orchestrator running — Manager :00, Operator :05, Observer :10 (every 15 min)");
