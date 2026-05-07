#!/usr/bin/env node

/**
 * Agent Orchestrator
 * Round-robin: Manager :00/:15/:30/:45 -> Operator :05/:20/:35/:50 -> Observer :10/:25/:40/:55
 *
 * Each agent has its own repo checkout. Git discipline per agent:
 * fetch + reset --hard to origin/main, write changes, single commit, push.
 */

import cron from "node-cron";
import fs from "fs/promises";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

const GITHUB_REPO    = process.env.GITHUB_REPO || "CommonEmailDotCom/SaaS-Boilerplate";
const GITHUB_TOKEN   = process.env.GITHUB_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL          = "claude-sonnet-4-6";
const MAX_TOKENS     = 16000;

const REPO_MANAGER  = "/repo-manager";
const REPO_OPERATOR = "/repo-operator";
const REPO_OBSERVER = "/repo-observer";

if (!ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is required");
  process.exit(1);
}

// ── Repo helpers ──────────────────────────────────────────────────────────────

async function ensureRepo(repoPath) {
  try {
    await fs.access(path.join(repoPath, ".git"));
  } catch {
    console.log("  -> Cloning into " + repoPath + "...");
    await execAsync(
      "git clone https://" + GITHUB_TOKEN + "@github.com/" + GITHUB_REPO + " " + repoPath,
      { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }
    );
  }
}

async function syncToMain(repoPath) {
  await execAsync(
    "git -C " + repoPath + " fetch origin main && git -C " + repoPath + " reset --hard origin/main",
    { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }
  );
}

async function readRepoFile(repoPath, relPath) {
  try {
    return await fs.readFile(path.join(repoPath, relPath), "utf8");
  } catch {
    return "(file not found: " + relPath + ")";
  }
}

async function writeRepoFile(repoPath, relPath, content) {
  const fullPath = path.join(repoPath, relPath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, "utf8");
}

async function commitAndPush(repoPath, message, authorName, authorEmail) {
  const cmds = [
    "git -C " + repoPath + " config user.name \"" + authorName + "\"",
    "git -C " + repoPath + " config user.email \"" + authorEmail + "\"",
    "git -C " + repoPath + " add -A",
    "git -C " + repoPath + " diff --staged --quiet || git -C " + repoPath + " commit -m \"" + message + "\"",
    "git -C " + repoPath + " push origin main",
  ];
  for (const cmd of cmds) {
    try {
      const { stdout, stderr } = await execAsync(cmd, {
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      if (stdout) console.log(stdout.trim());
      if (stderr) console.log(stderr.trim());
    } catch (e) {
      console.error("git cmd failed: " + cmd + "\n" + e.message);
      throw e;
    }
  }
}

// ── Anthropic API ─────────────────────────────────────────────────────────────

async function callClaude(systemPrompt, userMessage) {
  console.log("  -> Calling Claude (" + MODEL + ", max_tokens: " + MAX_TOKENS + ")...");
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
    throw new Error("Anthropic API " + response.status + ": " + err);
  }

  const data = await response.json();
  console.log("  -> stop_reason: " + data.stop_reason + ", tokens: " + data.usage?.input_tokens + "in / " + data.usage?.output_tokens + "out");
  if (data.stop_reason === "max_tokens") console.error("  WARNING: Response truncated");
  return data.content?.[0]?.text || "";
}

// ── Context loader ────────────────────────────────────────────────────────────

async function loadContext(repoPath) {
  const [teamMd, taskBoard, buildLog, qaReport, operatorInbox, observerInbox] =
    await Promise.all([
      readRepoFile(repoPath, "CLAUDE_TEAM.md"),
      readRepoFile(repoPath, "agent_sync/TASK_BOARD.json"),
      readRepoFile(repoPath, "agent_sync/BUILD_LOG.md"),
      readRepoFile(repoPath, "agent_sync/QA_REPORT.md"),
      readRepoFile(repoPath, "agent_sync/OPERATOR_INBOX.md"),
      readRepoFile(repoPath, "agent_sync/OBSERVER_INBOX.md"),
    ]);
  return { teamMd, taskBoard, buildLog, qaReport, operatorInbox, observerInbox };
}

function parseJSON(raw, agentName) {
  const cleaned = raw.replace(/^```json\n?|\n?```$/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    console.error(agentName + " JSON parse failed: " + e.message);
    console.error("Length: " + raw.length + " | First 300: " + raw.slice(0, 300));
    console.error("Last 300: " + raw.slice(-300));
    return null;
  }
}

// ── Agent: Manager ────────────────────────────────────────────────────────────

async function runManager() {
  const ts = new Date().toISOString();
  console.log("\n[" + ts + "] Manager starting...");

  await ensureRepo(REPO_MANAGER);
  await syncToMain(REPO_MANAGER);
  const ctx = await loadContext(REPO_MANAGER);

  const system = [
    "You are the Manager Agent for Cutting Edge Chat (https://cuttingedgechat.com).",
    "You commit as: AI Manager for Cutting Edge Chat",
    "Your repo checkout: /repo-manager (isolated — no conflicts with other agents)",
    "",
    "YOUR ROLE: Strategic oversight only. Do NOT write code or run tests.",
    "FILES YOU OWN (the ONLY files you may write):",
    "  CLAUDE_TEAM.md, agent_sync/TASK_BOARD.json, agent_sync/OPERATOR_INBOX.md, agent_sync/OBSERVER_INBOX.md",
    "",
    "FILES YOU MUST NEVER TOUCH:",
    "  src/, migrations/, .github/workflows/, playwright.config.ts, scripts/,",
    "  agent_sync/BUILD_LOG.md, agent_sync/QA_REPORT.md, package.json",
    "",
    "HARD RULES:",
    "  - Both Clerk and Authentik are permanent",
    "  - T-007 must never ship before T-010",
    "  - Update CLAUDE_TEAM.md Current Objectives every cycle",
    "  - If an agent wrote a file they do not own, flag it in their inbox immediately",
    "  - Keep file contents concise",
    "",
    "Respond with ONE JSON object, no markdown fences, no extra text:",
    "{\"claude_team_md\":\"...\",\"task_board_json\":\"...\",\"operator_inbox\":\"...\",\"observer_inbox\":\"...\"}"
  ].join("\n");
  const user = "Timestamp: " + ts + "\n\n" +
    "--- CLAUDE_TEAM.md ---\n" + ctx.teamMd + "\n\n" +
    "--- TASK_BOARD.json ---\n" + ctx.taskBoard + "\n\n" +
    "--- BUILD_LOG.md (last 3000 chars) ---\n" + ctx.buildLog.slice(-3000) + "\n\n" +
    "--- QA_REPORT.md (last 3000 chars) ---\n" + ctx.qaReport.slice(-3000) + "\n\n" +
    "--- OPERATOR_INBOX.md ---\n" + ctx.operatorInbox + "\n\n" +
    "--- OBSERVER_INBOX.md ---\n" + ctx.observerInbox + "\n\n" +
    "Review all files. Update Current Objectives, TASK_BOARD.json, and inboxes as needed.";

  const raw = await callClaude(system, user);
  const parsed = parseJSON(raw, "Manager");
  if (!parsed) return;

  await syncToMain(REPO_MANAGER);
  await writeRepoFile(REPO_MANAGER, "CLAUDE_TEAM.md", parsed.claude_team_md);
  await writeRepoFile(REPO_MANAGER, "agent_sync/TASK_BOARD.json", parsed.task_board_json);
  await writeRepoFile(REPO_MANAGER, "agent_sync/OPERATOR_INBOX.md", parsed.operator_inbox);
  await writeRepoFile(REPO_MANAGER, "agent_sync/OBSERVER_INBOX.md", parsed.observer_inbox);
  await commitAndPush(REPO_MANAGER, "ci: manager cycle " + ts, "AI Manager for Cutting Edge Chat", "ai-manager@users.noreply.github.com");

  console.log("[" + ts + "] Manager complete");
}

// ── Agent: Operator ───────────────────────────────────────────────────────────

async function runOperator() {
  const ts = new Date().toISOString();
  console.log("\n[" + ts + "] Operator starting...");

  await ensureRepo(REPO_OPERATOR);
  await syncToMain(REPO_OPERATOR);
  const ctx = await loadContext(REPO_OPERATOR);

  const system = [
    "You are the Operator Agent (DevOps) for Cutting Edge Chat (https://cuttingedgechat.com).",
    "You commit as: AI DevOps for Cutting Edge Chat",
    "Your repo checkout: /repo-operator (isolated — no conflicts with other agents)",
    "Coolify SaaS app UUID: tuk1rcjj16vlk33jrbx3c9d3",
    "",
    "YOUR ROLE: Implement code changes, fix bugs, manage infra.",
    "FILES YOU OWN (only paths allowed in file_changes): src/**, migrations/**",
    "You also update: agent_sync/BUILD_LOG.md, agent_sync/OPERATOR_INBOX.md",
    "",
    "FILES YOU MUST NEVER TOUCH — DO NOT PUT THESE IN file_changes:",
    "  .github/workflows/smoke-test.yml — NEVER TOUCH (owned by Manager/CI)",
    "  .github/workflows/set-version.yml — NEVER TOUCH",
    "  .github/workflows/observer-qa.yml — NEVER TOUCH",
    "  .github/workflows/CI.yml — NEVER TOUCH",
    "  .github/workflows/typecheck.yml — NEVER TOUCH",
    "  playwright.config.ts — NEVER TOUCH",
    "  scripts/smoke-summary.js — NEVER TOUCH",
    "  CLAUDE_TEAM.md — NEVER TOUCH (owned by Manager)",
    "  agent_sync/TASK_BOARD.json — NEVER TOUCH (owned by Manager)",
    "  agent_sync/QA_REPORT.md — NEVER TOUCH (owned by Observer)",
    "  agent_sync/OBSERVER_INBOX.md — NEVER TOUCH",
    "  package.json, package-lock.json — NEVER unless Manager explicitly instructs",
    "",
    "HARD RULES:",
    "  - Clerk is permanent — never remove or degrade it",
    "  - No DB/Node.js imports in middleware.ts (Edge runtime only)",
    "  - Keep trustHost: true in next-auth config",
    "  - T-007 must not deploy before T-010",
    "  - No deploys until T-001 has a PASS in QA_REPORT.md (unless Manager explicitly overrides)",
    "  - Always update BUILD_LOG.md every cycle — keep last 2 entries only",
    "",
    "Respond with ONE JSON object, no markdown fences, no extra text:",
    "{\"build_log\":\"...\",\"operator_inbox\":\"...\",\"file_changes\":[{\"path\":\"src/...\",\"content\":\"...\"}]}",
    "IMPORTANT: file_changes must ONLY contain paths starting with src/ or migrations/."
  ].join("\n");
  const user = "Timestamp: " + ts + "\n\n" +
    "--- CLAUDE_TEAM.md ---\n" + ctx.teamMd + "\n\n" +
    "--- TASK_BOARD.json ---\n" + ctx.taskBoard + "\n\n" +
    "--- BUILD_LOG.md (last 2000 chars) ---\n" + ctx.buildLog.slice(-2000) + "\n\n" +
    "--- OPERATOR_INBOX.md ---\n" + ctx.operatorInbox + "\n\n" +
    "Check inbox, execute in_progress operator tasks, update BUILD_LOG.md.";

  const raw = await callClaude(system, user);
  const parsed = parseJSON(raw, "Operator");
  if (!parsed) return;

  await syncToMain(REPO_OPERATOR);
  await writeRepoFile(REPO_OPERATOR, "agent_sync/BUILD_LOG.md", parsed.build_log);
  await writeRepoFile(REPO_OPERATOR, "agent_sync/OPERATOR_INBOX.md", parsed.operator_inbox);
  for (const change of parsed.file_changes || []) {
    if (!change.path.startsWith("src/") && !change.path.startsWith("migrations/")) {
      console.error("  BLOCKED: Operator tried to write outside src/ or migrations/: " + change.path);
      continue;
    }
    console.log("  Writing: " + change.path);
    await writeRepoFile(REPO_OPERATOR, change.path, change.content);
  }
  await commitAndPush(REPO_OPERATOR, "ci: operator cycle " + ts, "AI DevOps for Cutting Edge Chat", "ai-devops@users.noreply.github.com");

  console.log("[" + ts + "] Operator complete");
}

// ── Agent: Observer ───────────────────────────────────────────────────────────

async function runObserver() {
  const ts = new Date().toISOString();
  console.log("\n[" + ts + "] Observer starting...");

  await ensureRepo(REPO_OBSERVER);
  await syncToMain(REPO_OBSERVER);
  const ctx = await loadContext(REPO_OBSERVER);

  const system = [
    "You are the Observer Agent (QA) for Cutting Edge Chat (https://cuttingedgechat.com).",
    "You commit as: AI QA for Cutting Edge Chat",
    "Your repo checkout: /repo-observer (isolated — no conflicts with other agents)",
    "Live app: https://cuttingedgechat.com | Authentik: https://auth.joefuentes.me",
    "",
    "YOUR ROLE: Run tests, log results, report bugs. Do NOT write application code.",
    "FILES YOU OWN (the ONLY files you may write):",
    "  agent_sync/QA_REPORT.md, agent_sync/OBSERVER_INBOX.md",
    "",
    "FILES YOU MUST NEVER TOUCH:",
    "  src/, migrations/, .github/, scripts/, e2e/, tests/, playwright.config.ts,",
    "  package.json, CLAUDE_TEAM.md, agent_sync/TASK_BOARD.json,",
    "  agent_sync/BUILD_LOG.md, agent_sync/OPERATOR_INBOX.md",
    "",
    "HARD RULES:",
    "  - Always verify /api/version SHA before testing — wrong SHA = log BLOCKED and stop",
    "  - Wait >6s after any provider switch before asserting state (5s cache TTL)",
    "  - Never run T-003 without explicit Manager instruction",
    "  - Clerk regressions are critical — Clerk is permanent, not legacy",
    "  - Always add a new timestamped entry to QA_REPORT.md — keep last 2 entries only",
    "",
    "Respond with ONE JSON object, no markdown fences, no extra text:",
    "{\"qa_report\":\"...\",\"observer_inbox\":\"...\"}"
  ].join("\n");
  const user = "Timestamp: " + ts + "\n\n" +
    "--- CLAUDE_TEAM.md ---\n" + ctx.teamMd + "\n\n" +
    "--- TASK_BOARD.json ---\n" + ctx.taskBoard + "\n\n" +
    "--- QA_REPORT.md (last 2000 chars) ---\n" + ctx.qaReport.slice(-2000) + "\n\n" +
    "--- OBSERVER_INBOX.md ---\n" + ctx.observerInbox + "\n\n" +
    "Check inbox, run headless checks against live app, log results.";

  const raw = await callClaude(system, user);
  const parsed = parseJSON(raw, "Observer");
  if (!parsed) return;

  await syncToMain(REPO_OBSERVER);
  await writeRepoFile(REPO_OBSERVER, "agent_sync/QA_REPORT.md", parsed.qa_report);
  await writeRepoFile(REPO_OBSERVER, "agent_sync/OBSERVER_INBOX.md", parsed.observer_inbox);
  await commitAndPush(REPO_OBSERVER, "ci: observer cycle " + ts, "AI QA for Cutting Edge Chat", "ai-qa@users.noreply.github.com");

  console.log("[" + ts + "] Observer complete");
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

cron.schedule("0,15,30,45 * * * *", () =>
  runManager().catch((e) => console.error("Manager error:", e.message))
);
cron.schedule("5,20,35,50 * * * *", () =>
  runOperator().catch((e) => console.error("Operator error:", e.message))
);
cron.schedule("10,25,40,55 * * * *", () =>
  runObserver().catch((e) => console.error("Observer error:", e.message))
);

console.log("Orchestrator running — Manager :00, Operator :05, Observer :10 (every 15 min)");
