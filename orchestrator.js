#!/usr/bin/env node

/**
 * Agent Orchestrator
 * Round-robin: Manager :00 -> Operator :20 -> Observer :40 (every 60 min, 20 min gaps)
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
  // Install node_modules if missing or package.json has changed
  // This makes Playwright + all SaaS deps available in the volume-mounted repo
  const nmPath = path.join(repoPath, "node_modules");
  const pkgPath = path.join(repoPath, "package.json");
  const stampPath = path.join(repoPath, "node_modules", ".install_stamp");
  try {
    const pkgMtime = (await fs.stat(pkgPath)).mtimeMs;
    const stampMtime = (await fs.stat(stampPath)).mtimeMs;
    if (stampMtime >= pkgMtime) return; // node_modules is fresh
  } catch {
    // stamp missing or node_modules doesn't exist — install needed
  }
  console.log("  -> Installing node_modules in " + repoPath + " (this may take a minute)...");
  await execAsync("npm ci --prefer-offline", { cwd: repoPath, env: { ...process.env, NODE_ENV: "development" } })
    .catch(e => execAsync("npm ci", { cwd: repoPath, env: { ...process.env, NODE_ENV: "development" } }));
  // Write stamp file so we don't reinstall next cycle
  await fs.writeFile(stampPath, new Date().toISOString(), "utf8");
  console.log("  -> node_modules installed in " + repoPath);
  // Install Playwright browsers for the observer repo
  if (repoPath.includes('observer')) {
    console.log("  -> Installing Playwright browsers for " + repoPath + "...");
    await execAsync("npx playwright install chromium", { cwd: repoPath })
      .catch(e => console.log("  -> Playwright install warning: " + e.message.slice(0,100)));
    console.log("  -> Playwright browsers ready");
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
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  const run = (cmd) => execAsync(cmd, { env }).then(({ stdout, stderr }) => {
    if (stdout.trim()) console.log(stdout.trim());
    if (stderr.trim()) console.log(stderr.trim());
  });

  // Set identity and stage
  await run("git -C " + repoPath + " config user.name \"" + authorName + "\"");
  await run("git -C " + repoPath + " config user.email \"" + authorEmail + "\"");
  await run("git -C " + repoPath + " add -A");

  // Commit (no-op if nothing staged)
  try {
    await run("git -C " + repoPath + " diff --staged --quiet || git -C " + repoPath + " commit --author=\"" + authorName + " <" + authorEmail + ">\" -m \"" + message + "\"");
  } catch (e) {
    console.error("commit failed: " + e.message);
    throw e;
  }

  // Push with retry — other agents may have pushed during the Claude API call
  const MAX_RETRIES = 5;
  for (let i = 1; i <= MAX_RETRIES; i++) {
    try {
      await run("git -C " + repoPath + " push origin main");
      console.log("  -> push succeeded on attempt " + i);
      return;
    } catch (e) {
      if (i === MAX_RETRIES) {
        console.error("  -> push failed after " + MAX_RETRIES + " attempts: " + e.message);
        throw e;
      }
      console.log("  -> push rejected (attempt " + i + "), rebasing and retrying...");
      try {
        await run("git -C " + repoPath + " fetch origin main");
        await run("git -C " + repoPath + " rebase origin/main");
      } catch (rebaseErr) {
        console.error("  -> rebase failed: " + rebaseErr.message);
        // Abort rebase and re-apply on fresh base
        await run("git -C " + repoPath + " rebase --abort").catch(() => {});
        await run("git -C " + repoPath + " reset --hard origin/main");
        throw rebaseErr;
      }
    }
  }
}

// ── Anthropic API ─────────────────────────────────────────────────────────────

async function callClaude(systemPrompt, userMessage, useMcpTools = false) {
  console.log("  -> Calling Claude (" + MODEL + ", max_tokens: " + MAX_TOKENS + (useMcpTools ? ", MCP tools enabled" : "") + ")...");
  
  const body = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  };

  // When MCP tools are enabled, pass the MCP server so the agent can
  // call run_command, write_file, git_commit_push etc. directly
  if (useMcpTools) {
    body.mcp_servers = [
      {
        type: "url",
        url: "https://mcp.joefuentes.me/mcp",
        name: "mcp-server",
        authorization_token: process.env.BEARER_TOKEN || ""
      }
    ];
    // All tools available — agents told in system prompt which to use
    // Use correct mcp-client-2025-11-20 format: default_config + configs
    // git_commit_push is DISABLED — orchestrator handles commits with correct per-agent identity
    // Agents calling git_commit_push directly get wrong author (CommonEmailDotCom from MCP git config)
    body.tools = [{
      type: 'mcp_toolset',
      mcp_server_name: 'mcp-server',
      default_config: { enabled: false },
      configs: {
        read_file:              { enabled: true },
        write_file:             { enabled: true },
        delete_file:            { enabled: true },
        run_command:            { enabled: true },
        git_pull:               { enabled: true },
        coolify_trigger_deploy: { enabled: true },
        query_postgres:         { enabled: true }
      }
    }];
    body.tool_choice = { type: "auto" };
  }

  const controller = new AbortController();
  const fetchTimeout = setTimeout(() => controller.abort(), 300000); // 5 min hard timeout
  let response;
  try {
    response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "mcp-client-2025-11-20",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(fetchTimeout);
  }

  if (!response.ok) {
    const err = await response.text();
    throw new Error("Anthropic API " + response.status + ": " + err);
  }

  const data = await response.json();
  console.log("  -> stop_reason: " + data.stop_reason + ", tokens: " + data.usage?.input_tokens + "in / " + data.usage?.output_tokens + "out");
  if (data.stop_reason === "max_tokens") console.error("  WARNING: Response truncated");
  
  // Extract all text blocks regardless of stop_reason
  // pause_turn means Claude used tools — extract text from the response
  // The tool results are already processed by Anthropic's MCP client
  if (Array.isArray(data.content)) {
    const text = data.content
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("\n");
    if (text) return text;
    // If no text blocks yet (all tool use), log and return empty for now
    if (data.stop_reason === "pause_turn") {
      console.log("  -> pause_turn with no text yet — tool calls in progress");
      // Return a minimal valid JSON so the agent doesn't fail silently
      return "{}";
    }
  }
  return data.content?.[0]?.text || "";
}

// ── Context loader ────────────────────────────────────────────────────────────

async function readFileSafe(repoPath, relPath, maxChars = 6000) {
  try {
    const content = await fs.readFile(path.join(repoPath, relPath), "utf8");
    if (content.length > maxChars) {
      return content.slice(0, maxChars) + `\n[...truncated at ${maxChars} chars, ${content.length} total. Agent can read_file with start_line/end_line for more.]`;
    }
    return content;
  } catch { return "(not found)"; }
}

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

// Pre-fetch specific src/ files from the filesystem (free — no MCP tool call needed)
// Used by Operator to get current state of fragile files before modifying them
async function loadSrcContext(repoPath) {
  const [authProvider, middleware, authNextauth] = await Promise.all([
    readFileSafe(repoPath, "src/libs/auth-provider/index.ts"),
    readFileSafe(repoPath, "src/middleware.ts"),
    readFileSafe(repoPath, "src/libs/auth-nextauth.ts"),
  ]);
  return { authProvider, middleware, authNextauth };
}

function parseJSON(raw, agentName) {
  // Strip markdown fences
  let cleaned = raw.replace(/^```json\n?|\n?```$/g, "").trim();
  
  // Try direct parse first
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // If Claude returned prose with embedded JSON, extract the JSON block
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      const extracted = cleaned.slice(firstBrace, lastBrace + 1);
      try {
        const result = JSON.parse(extracted);
        console.log(agentName + " JSON extracted from prose response (length: " + raw.length + ")");
        return result;
      } catch (e2) {
        // fall through
      }
    }
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
    "YOUR ROLE: Strategic oversight. Coordinate agents, verify state, unblock work.",
    "",
    "TOOLS AVAILABLE TO YOU:",
    "  - run_command(command): verify state — ls, curl, check logs — OUTPUT CAPPED AT 5000 CHARS",
    "  - query_postgres(sql): check DB state",
    "  - coolify_trigger_deploy(app_uuid): trigger a deployment",
    "  - write_file(path, content): write agent_sync/ files directly if needed",
    "  // git_commit_push: NOT available — orchestrator commits with correct per-agent identity",
    "",
    "  - read_file(path, start_line?, end_line?): read files with optional pagination",
    "",
    "READING FILES:",
    "  All agent_sync/ files are pre-fetched and already in your context — no need to read them.",
    "  Use read_file only for files NOT already injected (e.g. src/ files, scripts).",
    "  For large files, paginate: read_file(path, start_line=1, end_line=80), then next chunk.",
    "",
    "CAPS:",
    "  - run_command output CAPPED at 5000 chars — use grep/curl/ls not cat",
    "  - read_file CAPPED at 8000 chars per call — use start_line/end_line to paginate",
    "  - Example: curl -s https://cuttingedgechat.com/api/version",
    "  - Example: ls /repo-observer/scripts/",
    "BEFORE claiming something is broken or blocked: USE RUN_COMMAND TO CHECK.",
    "Example: before saying 'scripts/t001-run.js is missing', run: ls /repo-observer/scripts/",
    "Example: before saying 'app is down', run: curl -s -o /dev/null -w '%{http_code}' https://cuttingedgechat.com",
    "Example: before saying 'MCP tools broken', run: wget -qO- https://mcp.joefuentes.me/status",
        "",
    "MCP SERVER HEALTH ENDPOINTS (no auth, check before escalating any tool problem):",
    "  wget -qO- https://mcp.joefuentes.me/status   → version, uptime_seconds, active_mcp_connections, postgres",
    "  wget -qO- https://mcp.joefuentes.me/healthz  → status (ok/degraded), tools_registered, postgres, uptime_seconds",
    "If /status is unreachable: MCP is down — fall back to plain JSON. Log it, do not spiral.",
    "If /status returns ok but tools error: transient issue — retry once, then fall back.",
    "NEVER claim tools are unavailable without checking /status first.",
    "",
    "FILES YOU OWN (the ONLY files you may write via JSON response):",
    "  CLAUDE_TEAM.md, agent_sync/TASK_BOARD.json, agent_sync/OPERATOR_INBOX.md, agent_sync/OBSERVER_INBOX.md",
    "",
    "FILES YOU MUST NEVER TOUCH:",
    "  src/, migrations/, .github/workflows/, playwright.config.ts, scripts/,",
    "  agent_sync/BUILD_LOG.md, agent_sync/QA_REPORT.md, package.json",
    "",
    "MANAGEMENT PRINCIPLES — apply every single cycle:",
    "  1. VERIFY BEFORE CLAIMING. Use tools to check actual state before writing agent instructions.",
    "  2. ASSUME NOTHING IS GOING WELL. Read BUILD_LOG and QA_REPORT critically every cycle.",
    "  3. If an agent had the same status as last cycle, they are stuck — intervene immediately.",
    "  4. Blockers must be narrow and specific. A blocker on X never justifies idling on Y.",
    "  5. If Operator has no in_progress tasks, assign work — tech debt, perf, error handling, dead code.",
    "  6. If Observer has no active run, tell them to dispatch T-001 immediately.",
    "  7. Never let an agent coast on a vague waiting status for more than one cycle.",
    "  8. T-001 gate is NARROW: ONLY T-007 and T-010 deployment is blocked. All other work ships freely.",
    "  9. T-007 must never ship before T-010.",
    " 10. Both Clerk and Authentik are permanent — never instruct removal of either.",
    " 11. Update CLAUDE_TEAM.md Current Objectives every cycle — reality not aspiration.",
    " 12. If an agent wrote a file they do not own, flag it in their inbox immediately.",
    " 13. Keep file contents concise to stay within token limits.",
    " 14. Operator has MCP tools and can do anything that does not require physical server access.",
    "     Never tell Operator something requires human intervention unless it needs Hetzner SSH console.",
    "",
    "Use tools first to verify state, THEN respond with ONE JSON object:",
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

  let raw;
  try {
    raw = await callClaude(system, user, true);
  } catch (e) {
    const isRetryable = e.message.includes("Authentication error") 
      || e.message.includes("401") 
      || e.message.includes("400")
      || e.message.includes("aborted")
      || e.message.includes("502")
      || e.message.includes("503")
      || e.message.includes("ECONNRESET")
      || e.message.includes("fetch failed");
    if (isRetryable) {
      console.error("  -> MCP call failed, falling back to plain completion:", e.message.slice(0, 100));
      raw = await callClaude(system, user, false);
    } else {
      throw e;
    }
  }
  const parsed = parseJSON(raw, "Manager");
  if (!parsed) return;

  await syncToMain(REPO_MANAGER);
  await writeRepoFile(REPO_MANAGER, "CLAUDE_TEAM.md", parsed.claude_team_md);
  await writeRepoFile(REPO_MANAGER, "agent_sync/TASK_BOARD.json", parsed.task_board_json);
  await writeRepoFile(REPO_MANAGER, "agent_sync/OPERATOR_INBOX.md", parsed.operator_inbox);
  await writeRepoFile(REPO_MANAGER, "agent_sync/OBSERVER_INBOX.md", parsed.observer_inbox);
  await writeRepoFile(REPO_MANAGER, "agent_sync/.manager-heartbeat", new Date().toISOString() + "\n");
  await commitAndPush(REPO_MANAGER, "ci: manager cycle " + ts, "AI Manager for Cutting Edge Chat", "managercuttingedgechat@commonemail.com");

  console.log("[" + ts + "] Manager complete");
}

// ── Agent: Operator ───────────────────────────────────────────────────────────

async function runOperator() {
  const ts = new Date().toISOString();
  console.log("\n[" + ts + "] Operator starting...");

  await ensureRepo(REPO_OPERATOR);
  await syncToMain(REPO_OPERATOR);
  const ctx = await loadContext(REPO_OPERATOR);

  // Read CODEBASE_REFERENCE.md to inject into Operator prompt
  let codebaseRef = '';
  try {
    codebaseRef = await readRepoFile(REPO_OPERATOR, 'agent_sync/CODEBASE_REFERENCE.md');
  } catch (e) {
    console.error('Could not read CODEBASE_REFERENCE.md:', e.message);
  }

  const system = [
    "CRITICAL: Your response MUST be a single raw JSON object. No prose, no reasoning, no markdown. Start with { and end with }.",
    "",
    "You are the Operator Agent (DevOps) for Cutting Edge Chat (https://cuttingedgechat.com).",
    "You commit as: AI DevOps for Cutting Edge Chat",
    "Your repo checkout: /repo-operator (isolated — no conflicts with other agents)",
    "Coolify SaaS app UUID: tuk1rcjj16vlk33jrbx3c9d3",
    "",
    "=== CODEBASE REFERENCE (READ THIS BEFORE WRITING ANY CODE) ===",
    codebaseRef,
    "=== END CODEBASE REFERENCE ===",
    "",
    "MANDATORY PRE-CODE CHECKLIST — verify EVERY file_changes entry against these before including it:",
    "  🚨 #1 MOST BROKEN: getAuthProvider() must be a function returning Promise<IAuthProvider> — NEVER alias it to getActiveProvider (which returns a string). If you write 'export const getAuthProvider = getActiveProvider' that is WRONG and will break the build.",
    "  ✅ Using authentikAuth() not getServerSession()",
    "  ✅ Not importing authOptions (does not exist)",
    "  ✅ Importing from '@/libs/DB' not '@/libs/db'",
    "  ✅ Importing from '@/models/Schema' not '@/libs/schema'",
    "  ✅ Using organizationMemberSchema not organizationMemberTable",
    "  ✅ Using .orgId not .organizationId on organizationMemberSchema",
    "  ✅ organization_member insert includes id: crypto.randomUUID()",
    "  ✅ Not gutting existing exports from auth-provider/index.ts (getSession, setActiveProvider, getAuthProvider, AUTH_PROVIDER must all remain exported)",
    "  ✅ getSession() returns Promise<AuthSession | null> — normalized, not raw provider types",
    "If ANY check fails — DO NOT include that file in file_changes. Fix the issue first.",
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
    "  - T-001 deploy gate is NARROW: ONLY T-007 and T-010 deployment is blocked until Observer declares PASS",
    "  - ALL other tasks (code, fixes, infra) ship independently — never use T-001 as a reason to be idle",
    "  - If inbox and TASK_BOARD are empty, find tech debt, dead code, or perf improvements to ship",
    "  - Always update BUILD_LOG.md every cycle — keep last 2 entries only",
    "  - NEVER communicate via commit messages — use OPERATOR_INBOX.md replies only",
    "  - Commit messages: ci: operator cycle [timestamp] when idle, real description when making code changes",
    "",
    "TOOLS AVAILABLE TO YOU (write/action only):",
    "  - write_file(path, content): write a file — path is relative to repo root",
    "  - delete_file(path): delete a file",
    "  - run_command(command, cwd?): run shell commands — OUTPUT IS CAPPED AT 5000 CHARS",
    "  // git_commit_push: NOT available — orchestrator commits with correct per-agent identity",
    "  - git_pull(): pull latest from main",
    "  - coolify_trigger_deploy(app_uuid): trigger a Coolify deployment",
    "  - query_postgres(sql, params?): run a SQL query",
    "",
    "  - read_file(path, start_line?, end_line?): read a file — supports pagination",
    "",
    "PRE-FETCHED FILES — already in your context, no tool call needed:",
    "  src/libs/auth-provider/index.ts  → under '--- SRC CONTEXT ---' in this message",
    "  src/middleware.ts                → under '--- SRC CONTEXT ---' in this message",
    "  src/libs/auth-nextauth.ts        → under '--- SRC CONTEXT ---' in this message",
    "  All agent_sync/ files            → already injected above",
    "  DO NOT call read_file for these — you already have them.",
    "",
    "FOR OTHER FILES — use read_file with pagination:",
    "  read_file(path) → shows [File: x | N lines] header",
    "  read_file(path, start_line=1, end_line=80) → first 80 lines",
    "  read_file(path, start_line=81, end_line=160) → next chunk",
    "  Never use run_command with cat — same 5000 char cap, less control.",
    "",
    "TOOLS NOT IN SCOPE:",
    "  - list_directory: use run_command with ls",
    "  - coolify_list_deployments / coolify_deployment_logs: deployment state is in LIVE DATA",
    "",
    "CAPS:",
    "  - run_command output HARD CAPPED at 5000 chars — use grep/head/tail not cat",
    "  - read_file slice HARD CAPPED at 8000 chars — use start_line/end_line to paginate",
    "  - write_file has NO cap — write full content",
    "",
    "MCP SERVER HEALTH (check when tools seem broken):",
    "  wget -qO- https://mcp.joefuentes.me/status   → version, uptime, active_connections, postgres",
    "  wget -qO- https://mcp.joefuentes.me/healthz  → detailed health including postgres check",
    "  If /status unreachable: MCP is down — fall back to JSON, commit heartbeat, log it.",
    "  Never claim tools are unavailable without checking /status first.",
    "",
    "WORKFLOW: Use tools to do real work, THEN respond with JSON summary.",
    "Respond with ONE JSON object after completing your tool calls:",
    "{\"build_log\":\"...\",\"operator_inbox\":\"...\",\"file_changes\":[]}",
    "file_changes can be empty [] — you used tools to write files directly.",
    "The JSON response is just a summary/log — the actual work happens via tool calls."
  ].join("\n");
  // Fetch live data so Operator has real build/deploy state
  let liveData = {};
  try {
    liveData = await fetchLiveData(GITHUB_TOKEN, GITHUB_REPO);
    console.log("  -> live data fetched: SHA=" + liveData.liveSha + " latestQaRun=" + liveData.latestObserverQaDetail?.conclusion);
  } catch (e) {
    console.error("  -> fetchLiveData error:", e.message);
  }

  // Pre-fetch fragile src/ files from filesystem — free, no MCP tool needed
  const srcCtx = await loadSrcContext(REPO_OPERATOR);

  const user = "Timestamp: " + ts + "\n\n" +
    "--- CLAUDE_TEAM.md ---\n" + ctx.teamMd + "\n\n" +
    "--- TASK_BOARD.json ---\n" + ctx.taskBoard + "\n\n" +
    "--- BUILD_LOG.md (last 2000 chars) ---\n" + ctx.buildLog.slice(-2000) + "\n\n" +
    "--- OPERATOR_INBOX.md ---\n" + ctx.operatorInbox + "\n\n" +
    "--- SRC CONTEXT (current file state — read from filesystem, no tool call needed) ---\n" +
    "src/libs/auth-provider/index.ts:\n" + srcCtx.authProvider + "\n\n" +
    "src/middleware.ts:\n" + srcCtx.middleware + "\n\n" +
    "src/libs/auth-nextauth.ts:\n" + srcCtx.authNextauth + "\n\n" +
    "--- LIVE DATA (pre-fetched by orchestrator) ---\n" +
    JSON.stringify(liveData, null, 2) + "\n\n" +
    "INSTRUCTIONS: Use the LIVE DATA to inform your work this cycle.\n" +
    "- liveSha: what is actually deployed right now — compare to expected SHA\n" +
    "- setVersionRuns: did the last build succeed or fail?\n" +
    "- latestObserverQaDetail: has T-001 passed? If conclusion is 'success', deploy T-007+T-010 NOW.\n" +
    "- smokeTestRuns: is the smoke badge healthy?\n" +
    "Check inbox, execute tasks, update BUILD_LOG.md with real data from above.";

  // Try with MCP tools first; fall back to plain completion if auth fails
  let raw;
  try {
    raw = await callClaude(system, user, true);
  } catch (e) {
    const isRetryable = e.message.includes("Authentication error") 
      || e.message.includes("401") 
      || e.message.includes("400")
      || e.message.includes("aborted")
      || e.message.includes("502")
      || e.message.includes("503")
      || e.message.includes("ECONNRESET")
      || e.message.includes("fetch failed");
    if (isRetryable) {
      console.error("  -> MCP call failed, falling back to plain completion:", e.message.slice(0, 100));
      raw = await callClaude(system, user, false);
    } else {
      throw e;
    }
  }
  const parsed = parseJSON(raw, "Operator");
  if (!parsed) return;

  await writeRepoFile(REPO_OPERATOR, "agent_sync/BUILD_LOG.md", parsed.build_log);
  // Always write heartbeat so cron cycle is visible in git history
  await writeRepoFile(REPO_OPERATOR, "agent_sync/.operator-heartbeat", new Date().toISOString() + "\n");
  await writeRepoFile(REPO_OPERATOR, "agent_sync/OPERATOR_INBOX.md", parsed.operator_inbox);
  for (const change of parsed.file_changes || []) {
    if (!change.path.startsWith("src/") && !change.path.startsWith("migrations/")) {
      console.error("  BLOCKED: Operator tried to write outside src/ or migrations/: " + change.path);
      continue;
    }
    console.log("  Writing: " + change.path);
    await writeRepoFile(REPO_OPERATOR, change.path, change.content);
  }
  await commitAndPush(REPO_OPERATOR, "ci: operator cycle " + ts, "AI DevOps for Cutting Edge Chat", "Devopscuttingedgechat@commonemail.com");

  console.log("[" + ts + "] Operator complete");
}


// ── Live data fetcher for Observer ───────────────────────────────────────────

async function fetchLiveData(ghToken, repo) {
  const results = {};
  const ghHeaders = {
    "Authorization": "Bearer " + ghToken,
    "Accept": "application/vnd.github+json"
  };

  // Live SHA
  try {
    const r = await fetch("https://cuttingedgechat.com/api/version");
    results.liveSha = (await r.json()).sha || "unknown";
  } catch (e) { results.liveSha = "ERROR: " + e.message; }

  // Smoke status from file
  try {
    const smokeRes = await fetch(
      "https://api.github.com/repos/" + repo + "/contents/smoke-status.json",
      { headers: { ...ghHeaders, "Accept": "application/vnd.github+json" } }
    );
    const smokeJson = await smokeRes.json();
    results.smokeStatus = smokeJson.content
      ? JSON.parse(Buffer.from(smokeJson.content, "base64").toString())
      : "not found";
  } catch (e) { results.smokeStatus = "not readable: " + e.message; }

  // Latest observer-qa.yml runs (last 3)
  try {
    const r = await fetch("https://api.github.com/repos/" + repo + "/actions/workflows/272374889/runs?per_page=3", { headers: ghHeaders });
    const d = await r.json();
    results.observerQaRuns = (d.workflow_runs || []).map(r => ({
      id: r.id, conclusion: r.conclusion || r.status,
      sha: r.head_sha?.slice(0,7), created: r.created_at?.slice(11,19)
    }));
  } catch (e) { results.observerQaRuns = "ERROR: " + e.message; }

  // Latest observer-qa.yml run — full job/step breakdown
  try {
    const r = await fetch("https://api.github.com/repos/" + repo + "/actions/workflows/272374889/runs?per_page=1", { headers: ghHeaders });
    const d = await r.json();
    const run = d.workflow_runs?.[0];
    if (run) {
      const jr = await fetch("https://api.github.com/repos/" + repo + "/actions/runs/" + run.id + "/jobs", { headers: ghHeaders });
      const jd = await jr.json();
      results.latestObserverQaDetail = {
        id: run.id, conclusion: run.conclusion || run.status,
        sha: run.head_sha?.slice(0,7), created: run.created_at,
        jobs: (jd.jobs || []).map(j => ({
          name: j.name, conclusion: j.conclusion || j.status,
          steps: (j.steps || []).map(s => (s.conclusion||s.status) + " [" + s.number + "] " + s.name)
        }))
      };
    }
  } catch (e) { results.latestObserverQaDetail = "ERROR: " + e.message; }

  // Latest smoke-test.yml runs (last 3)
  try {
    const r = await fetch("https://api.github.com/repos/" + repo + "/actions/workflows/271525944/runs?per_page=3", { headers: ghHeaders });
    const d = await r.json();
    results.smokeTestRuns = (d.workflow_runs || []).map(r => ({
      id: r.id, conclusion: r.conclusion || r.status,
      sha: r.head_sha?.slice(0,7), created: r.created_at?.slice(11,19)
    }));
  } catch (e) { results.smokeTestRuns = "ERROR: " + e.message; }

  // Latest set-version runs (last 3) — tells us if build deployed
  try {
    const r = await fetch("https://api.github.com/repos/" + repo + "/actions/workflows/271188882/runs?per_page=3", { headers: ghHeaders });
    const d = await r.json();
    results.setVersionRuns = (d.workflow_runs || []).map(r => ({
      id: r.id, conclusion: r.conclusion || r.status,
      sha: r.head_sha?.slice(0,7), created: r.created_at?.slice(11,19)
    }));
  } catch (e) { results.setVersionRuns = "ERROR: " + e.message; }

  // Auto-dispatch observer-qa.yml if no passing run in last 30 minutes
  try {
    const runs = results.observerQaRuns || [];
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const recentPass = runs.find(r => r.conclusion === 'success' && r.created > thirtyMinAgo);
    if (!recentPass) {
      const dr = await fetch(
        "https://api.github.com/repos/" + repo + "/actions/workflows/272374889/dispatches",
        { method: "POST", headers: { ...ghHeaders, "Content-Type": "application/json" }, body: JSON.stringify({ ref: "main" }) }
      );
      results.autoDispatch = dr.status === 204 ? "dispatched" : "failed (" + dr.status + ")";
      console.log("  -> observer-qa auto-dispatch:", results.autoDispatch);
    } else {
      results.autoDispatch = "skipped — recent pass found";
    }
  } catch (e) { results.autoDispatch = "ERROR: " + e.message; }


  // T-001 is run in runObserver() after ensureRepo — not here
  // (avoids "script not found" when /repo-observer hasn't been cloned yet)
  results.t001Result = "pending — will run in Observer cycle";

  return results;
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
    "YOUR ROLE: QA engineer. You write and maintain tests, analyze results, report bugs.",
    "  - You ARE a developer for test code. Write, improve, and fix test files.",
    "  - You are NOT a developer for application source code. Never touch src/.",
    "  - The orchestrator runs T-001 automatically and gives you results in LIVE DATA. Interpret them.",
    "",
    "TOOLS AVAILABLE TO YOU:",
    "  - run_command(command, cwd?): run scripts, curl, ls — OUTPUT CAPPED AT 5000 CHARS",
    "  - write_file(path, content): update test scripts",
    "  // git_commit_push: NOT available — orchestrator commits with correct per-agent identity",
    "  - query_postgres(sql): check DB state",
    "",
    "  - read_file(path, start_line?, end_line?): read files with optional pagination",
    "",
    "READING LARGE FILES:",
    "  read_file returns a header showing total line count. Paginate with start_line/end_line.",
    "  Do NOT use run_command with cat — same 5000 char cap, less control.",
    "",
    "CAPS:",
    "  - run_command output CAPPED at 5000 chars — use grep/head/tail not cat",
    "  - read_file CAPPED at 8000 chars per call — paginate with start_line/end_line",
    "  - write_file has NO cap",
    "  - T-001 exits code 1 when tests fail — NORMAL. Orchestrator captures stdout anyway.",
    "BEFORE reporting something is broken or missing: use run_command to verify.",
    "Example: before saying 'script not found', run: ls /repo-observer/scripts/",
    "Example: verify live app: curl -s https://cuttingedgechat.com/api/version",
    "Example: before saying MCP tools broken, run: wget -qO- https://mcp.joefuentes.me/status",
    "  /status → version, uptime_seconds, active_mcp_connections, postgres",
    "  /healthz → detailed health check including postgres",
    "  If /status unreachable: MCP is down — note it in QA_REPORT, fall back to JSON, keep going.",
    "  If /status ok but tools error: transient — retry once then fall back.",
    "",
    "FILES YOU OWN — you may freely read and write these:",
    "  agent_sync/QA_REPORT.md        — your primary output every cycle",
    "  agent_sync/OBSERVER_INBOX.md   — replies to Manager",
    "  e2e/**                          — Playwright end-to-end specs",
    "  tests/**                        — unit/integration test files",
    "  scripts/t001-run.js            — T-001 MCP server test script",
    "  scripts/smoke-summary.js       — smoke summary generator",
    "  playwright.config.ts           — Playwright config",
    "",
    "WHAT YOU CAN TOUCH:",
    "  e2e/**, tests/**, scripts/**    — PRIMARY. Own these fully.",
    "  playwright.config.ts            — yours to maintain",
    "  src/**                          — YES, but ONLY to fix bugs discovered while testing. No feature work.",
    "  migrations/**                   — only if a schema issue is blocking a test",
    "",
    "NEVER TOUCH:",
    "  .github/workflows/smoke-test.yml, set-version.yml, typecheck.yml",
    "  CLAUDE_TEAM.md, agent_sync/TASK_BOARD.json",
    "  agent_sync/BUILD_LOG.md, agent_sync/OPERATOR_INBOX.md",
    "",
    "HARD RULES:",
    "  - Always verify /api/version SHA before testing — wrong SHA = log BLOCKED and stop",
    "  - Wait >6s after any provider switch before asserting state (5s cache TTL)",
    "  - Never run T-003 without explicit Manager instruction",
    "  - Clerk regressions are critical — Clerk is permanent, not legacy",
    "  - Always add a new timestamped entry to QA_REPORT.md — keep last 2 entries only",
    "  - NEVER communicate via commit messages — use OBSERVER_INBOX.md replies only",
    "  - Commit messages must be exactly: ci: observer cycle [timestamp]",
    "",
    "Use tools first to verify state, THEN respond with ONE JSON object:",
    "{\"qa_report\":\"...\",\"observer_inbox\":\"...\"}"
  ].join("\n");
  // Run T-001 NOW — after ensureRepo so /repo-observer/scripts/t001-run.js exists
  let t001Result = "not run";
  let t001Stderr = "";
  try {
    const t001Script = REPO_OBSERVER + "/scripts/t001-run.js";
    const { stdout, stderr } = await execAsync("node " + t001Script, {
      timeout: 120000,
      cwd: REPO_OBSERVER,
      env: { ...process.env }
    }).catch(e => {
      // T-001 exits with code 1 when any test fails — that's a valid result, not an error
      // execAsync throws on non-zero exit, but stdout still contains the test output
      if (e.stdout) return { stdout: e.stdout, stderr: e.stderr || "" };
      throw e;
    });
    t001Result = stdout.slice(-3000);
    t001Stderr = stderr ? stderr.slice(-500) : "";
    console.log("  -> T-001 run complete, last line:", stdout.trim().split("\n").pop());
  } catch (e) {
    t001Result = "ERROR: " + e.message;
    console.error("  -> T-001 run error:", e.message);
  }

  // Fetch live data (without T-001 — already ran above)
  let liveData = {};
  try {
    liveData = await fetchLiveData(GITHUB_TOKEN, GITHUB_REPO);
    liveData.t001Result = t001Result;
    if (t001Stderr) liveData.t001Stderr = t001Stderr;
    console.log("  -> live data fetched: SHA=" + liveData.liveSha + " latestQaRun=" + liveData.latestObserverQaDetail?.conclusion);
  } catch (e) {
    console.error("  -> fetchLiveData error:", e.message);
    liveData = { t001Result, t001Stderr };
  }

  const user = "Timestamp: " + ts + "\n\n" +
    "--- CLAUDE_TEAM.md ---\n" + ctx.teamMd + "\n\n" +
    "--- TASK_BOARD.json ---\n" + ctx.taskBoard + "\n\n" +
    "--- QA_REPORT.md (last 2000 chars) ---\n" + ctx.qaReport.slice(-2000) + "\n\n" +
    "--- OBSERVER_INBOX.md ---\n" + ctx.observerInbox + "\n\n" +
    "--- LIVE DATA (pre-fetched by orchestrator — use this, do not say you lack network access) ---\n" +
    JSON.stringify(liveData, null, 2) + "\n\n" +
    "INSTRUCTIONS: The LIVE DATA above is real current state fetched this cycle. Use it to write an accurate report.\n" +
    "- liveSha: what is actually live on cuttingedgechat.com right now\n" +
    "- t001Result: OUTPUT OF THE T-001 TEST SCRIPT run this cycle — interpret this and write your QA_REPORT entry from it\n" +
    "- latestObserverQaDetail: full step-by-step result of the most recent observer-qa.yml run\n" +
    "- smokeTestRuns: recent smoke test results\n" +
    "- setVersionRuns: recent build deployments\n" +
    "Do NOT write 'PENDING — owner must check'. You have the data — use it.\n" +
    "If latestObserverQaDetail.conclusion is 'failure', identify exactly which steps failed and what to fix.\n" +
    "If latestObserverQaDetail.conclusion is 'success', declare T-001 PASS and instruct Operator to deploy T-007+T-010.\n" +
    "Update OBSERVER_INBOX.md only if you have something new to tell Manager (e.g. new failure, T-001 PASS signal).";

  let raw;
  try {
    raw = await callClaude(system, user, true);
  } catch (e) {
    const isRetryable = e.message.includes("Authentication error") 
      || e.message.includes("401") 
      || e.message.includes("400")
      || e.message.includes("aborted")
      || e.message.includes("502")
      || e.message.includes("503")
      || e.message.includes("ECONNRESET")
      || e.message.includes("fetch failed");
    if (isRetryable) {
      console.error("  -> MCP call failed, falling back to plain completion:", e.message.slice(0, 100));
      raw = await callClaude(system, user, false);
    } else {
      throw e;
    }
  }
  const parsed = parseJSON(raw, "Observer");
  if (!parsed) return;

  await syncToMain(REPO_OBSERVER);
  await writeRepoFile(REPO_OBSERVER, "agent_sync/QA_REPORT.md", parsed.qa_report);
  await writeRepoFile(REPO_OBSERVER, "agent_sync/.observer-heartbeat", new Date().toISOString() + "\n");
  await writeRepoFile(REPO_OBSERVER, "agent_sync/OBSERVER_INBOX.md", parsed.observer_inbox);

  const obsNeverTouch = ["agent_sync/TASK_BOARD.json", "agent_sync/BUILD_LOG.md", "agent_sync/OPERATOR_INBOX.md", "CLAUDE_TEAM.md", ".github/workflows/smoke-test.yml", ".github/workflows/set-version.yml", ".github/workflows/typecheck.yml"];
  for (const change of parsed.file_changes || []) {
    const blocked = obsNeverTouch.some(p => change.path === p || change.path.startsWith(p));
    if (blocked) { console.error("  BLOCKED Observer: " + change.path); continue; }
    console.log("  Observer writing: " + change.path);
    await writeRepoFile(REPO_OBSERVER, change.path, change.content);
  }

  await commitAndPush(REPO_OBSERVER, "ci: observer cycle " + ts, "AI QA for Cutting Edge Chat", "testercuttingedgechat@gmail.com");

  console.log("[" + ts + "] Observer complete");
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

cron.schedule("0 * * * *", () =>
  runManager().catch((e) => console.error("Manager error:", e.message))
);
cron.schedule("20 * * * *", () =>
  runOperator().catch((e) => console.error("Operator error:", e.message))
);
cron.schedule("40 * * * *", () =>
  runObserver().catch((e) => console.error("Observer error:", e.message))
);

console.log("Orchestrator running — Manager :00, Operator :20, Observer :40 (every 60 min)");
