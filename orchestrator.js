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
    "YOUR ROLE: Strategic oversight only. Do NOT write code or run tests.",
    "FILES YOU OWN (the ONLY files you may write):",
    "  CLAUDE_TEAM.md, agent_sync/TASK_BOARD.json, agent_sync/OPERATOR_INBOX.md, agent_sync/OBSERVER_INBOX.md",
    "",
    "FILES YOU MUST NEVER TOUCH:",
    "  src/, migrations/, .github/workflows/, playwright.config.ts, scripts/,",
    "  agent_sync/BUILD_LOG.md, agent_sync/QA_REPORT.md, package.json",
    "",
    "MANAGEMENT PRINCIPLES — apply every single cycle:",
    "  1. ASSUME NOTHING IS GOING WELL. Read BUILD_LOG and QA_REPORT critically every cycle.",
    "  2. If an agent had the same status as last cycle, they are stuck — intervene immediately.",
    "  3. Blockers must be narrow and specific. A blocker on X never justifies idling on Y.",
    "  4. If Operator has no in_progress tasks, assign work — tech debt, perf, error handling, dead code.",
    "  5. If Observer has no active run, tell them to run headless checks or increase test depth.",
    "  6. Never let an agent coast on a vague waiting status for more than one cycle.",
    "  7. T-001 gate is NARROW: ONLY T-007 and T-010 are blocked. All other Operator work ships now.",
    "  8. T-007 must never ship before T-010.",
    "  9. Both Clerk and Authentik are permanent — never instruct removal of either.",
    " 10. Update CLAUDE_TEAM.md Current Objectives every cycle — reality not aspiration.",
    " 11. If an agent wrote a file they do not own, flag it in their inbox immediately.",
    " 12. Keep file contents concise to stay within token limits.",
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
    "  ✅ Using authentikAuth() not getServerSession()",
    "  ✅ Not importing authOptions (does not exist)",
    "  ✅ Importing from '@/libs/DB' not '@/libs/db'",
    "  ✅ Importing from '@/models/Schema' not '@/libs/schema'",
    "  ✅ Using organizationMemberSchema not organizationMemberTable",
    "  ✅ Using .orgId not .organizationId on organizationMemberSchema",
    "  ✅ organization_member insert includes id: crypto.randomUUID()",
    "  ✅ Not gutting existing exports from auth-provider/index.ts (getSession, setActiveProvider, getAuthProvider, AUTH_PROVIDER must all remain exported)",
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
    "Respond with ONE JSON object, no markdown fences, no extra text:",
    "{\"build_log\":\"...\",\"operator_inbox\":\"...\",\"file_changes\":[]}",
    "file_changes is an EMPTY ARRAY when you have no code to write. Only add entries when you have real code changes.",
    "NEVER invent placeholder or marker files just to populate file_changes. Empty array is correct for standby cycles.",
    "file_changes entries must ONLY use paths starting with src/ or migrations/."
  ].join("\n");
  // Fetch live data so Operator has real build/deploy state
  let liveData = {};
  try {
    liveData = await fetchLiveData(GITHUB_TOKEN, GITHUB_REPO);
    console.log("  -> live data fetched: SHA=" + liveData.liveSha + " latestQaRun=" + liveData.latestObserverQaDetail?.conclusion);
  } catch (e) {
    console.error("  -> fetchLiveData error:", e.message);
  }

  const user = "Timestamp: " + ts + "\n\n" +
    "--- CLAUDE_TEAM.md ---\n" + ctx.teamMd + "\n\n" +
    "--- TASK_BOARD.json ---\n" + ctx.taskBoard + "\n\n" +
    "--- BUILD_LOG.md (last 2000 chars) ---\n" + ctx.buildLog.slice(-2000) + "\n\n" +
    "--- OPERATOR_INBOX.md ---\n" + ctx.operatorInbox + "\n\n" +
    "--- LIVE DATA (pre-fetched by orchestrator) ---\n" +
    JSON.stringify(liveData, null, 2) + "\n\n" +
    "INSTRUCTIONS: Use the LIVE DATA to inform your work this cycle.\n" +
    "- liveSha: what is actually deployed right now — compare to expected SHA\n" +
    "- setVersionRuns: did the last build succeed or fail?\n" +
    "- latestObserverQaDetail: has T-001 passed? If conclusion is 'success', deploy T-007+T-010 NOW.\n" +
    "- smokeTestRuns: is the smoke badge healthy?\n" +
    "Check inbox, execute tasks, update BUILD_LOG.md with real data from above.";

  const raw = await callClaude(system, user);
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
    results.smokeStatus = JSON.parse(fs.readFileSync("/repo-observer/smoke-status.json", "utf8"));
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
    "  - NEVER communicate via commit messages — use OBSERVER_INBOX.md replies only",
    "  - Commit messages must be exactly: ci: observer cycle [timestamp]",
    "",
    "Respond with ONE JSON object, no markdown fences, no extra text:",
    "{\"qa_report\":\"...\",\"observer_inbox\":\"...\"}"
  ].join("\n");
  // Fetch real live data so Observer has actual facts
  let liveData = {};
  try {
    liveData = await fetchLiveData(GITHUB_TOKEN, GITHUB_REPO);
    console.log("  -> live data fetched: SHA=" + liveData.liveSha + " latestQaRun=" + liveData.latestObserverQaDetail?.conclusion);
  } catch (e) {
    console.error("  -> fetchLiveData error:", e.message);
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
    "- latestObserverQaDetail: full step-by-step result of the most recent observer-qa.yml run\n" +
    "- smokeTestRuns: recent smoke test results\n" +
    "- setVersionRuns: recent build deployments\n" +
    "Do NOT write 'PENDING — owner must check'. You have the data — use it.\n" +
    "If latestObserverQaDetail.conclusion is 'failure', identify exactly which steps failed and what to fix.\n" +
    "If latestObserverQaDetail.conclusion is 'success', declare T-001 PASS and instruct Operator to deploy T-007+T-010.\n" +
    "Update OBSERVER_INBOX.md only if you have something new to tell Manager (e.g. new failure, T-001 PASS signal).";

  const raw = await callClaude(system, user);
  const parsed = parseJSON(raw, "Observer");
  if (!parsed) return;

  await syncToMain(REPO_OBSERVER);
  await writeRepoFile(REPO_OBSERVER, "agent_sync/QA_REPORT.md", parsed.qa_report);
  await writeRepoFile(REPO_OBSERVER, "agent_sync/.observer-heartbeat", new Date().toISOString() + "\n");
  await writeRepoFile(REPO_OBSERVER, "agent_sync/OBSERVER_INBOX.md", parsed.observer_inbox);
  await commitAndPush(REPO_OBSERVER, "ci: observer cycle " + ts, "AI QA for Cutting Edge Chat", "testercuttingedgechat@gmail.com");

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
