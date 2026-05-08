#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "http";
import fs from "fs/promises";
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import crypto from "crypto";
import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

const REPO_PATH = process.env.REPO_PATH || "/repo";
const BEARER_TOKEN = process.env.BEARER_TOKEN;
const PORT = parseInt(process.env.PORT || "3100");
const PG_CONNECTION_STRING = process.env.PG_CONNECTION_STRING;
const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const BASE_URL = process.env.BASE_URL || "https://mcp.joefuentes.me";
const COOLIFY_URL = process.env.COOLIFY_URL || "http://coolify:8000";
const COOLIFY_API_TOKEN = process.env.COOLIFY_API_TOKEN;
const SERVER_START = Date.now();

if (!BEARER_TOKEN) {
  console.error("ERROR: BEARER_TOKEN env var is required");
  process.exit(1);
}

const execAsync = promisify(exec);

// ── FIX 3: Catch all unhandled errors so the process exits cleanly ────────────
// Docker/Coolify restarts automatically. Better than a zombie process.
process.on("uncaughtException", (err) => {
  console.error("[FATAL] uncaughtException:", err.message, err.stack);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] unhandledRejection:", reason);
  process.exit(1);
});

// ── Active connection tracking ────────────────────────────────────────────────
let activeConnections = 0;

// ── In-memory stores ──────────────────────────────────────────────────────────
const authCodes = new Map();
const TOKENS_FILE = '/data/mcp-tokens.json';
function loadTokens() {
  try { return new Set(JSON.parse(readFileSync(TOKENS_FILE, 'utf8'))); }
  catch { return new Set(); }
}
function saveTokens(set) {
  try { writeFileSync(TOKENS_FILE, JSON.stringify([...set])); }
  catch(e) { console.error("saveTokens failed:", e.message); }
}
const tokens = loadTokens();

// ── Coolify API helper ────────────────────────────────────────────────────────
async function coolifyFetch(endpoint, options = {}) {
  if (!COOLIFY_API_TOKEN) throw new Error("COOLIFY_API_TOKEN not set");
  const url = `${COOLIFY_URL}/api/v1${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Authorization": `Bearer ${COOLIFY_API_TOKEN}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

// ── Clone repo on startup ─────────────────────────────────────────────────────
async function ensureRepo() {
  if (!GITHUB_REPO || !GITHUB_TOKEN) {
    console.log("ℹ️  No GITHUB_REPO/GITHUB_TOKEN set — skipping clone");
    return;
  }
  try {
    await fs.access(path.join(REPO_PATH, ".git"));
    console.log("✅ Repo already cloned, pulling latest...");
    await execAsync(`git -C ${REPO_PATH} pull`, { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  } catch {
    console.log("📦 Cloning repo...");
    await fs.mkdir(REPO_PATH, { recursive: true });
    const url = `https://${GITHUB_TOKEN}@github.com/${GITHUB_REPO}.git`;
    await execAsync(`git clone ${url} ${REPO_PATH}`, { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    await execAsync(`git -C ${REPO_PATH} remote set-url origin https://${GITHUB_TOKEN}@github.com/${GITHUB_REPO}.git`);
    console.log("✅ Repo cloned successfully");
  }
  const gitName = process.env.GIT_AUTHOR_NAME || "CommonEmailDotCom";
  const gitEmail = process.env.GIT_AUTHOR_EMAIL || "github@commonemail.com";
  try {
    await execAsync(`git -C ${REPO_PATH} config user.name "${gitName}"`);
    await execAsync(`git -C ${REPO_PATH} config user.email "${gitEmail}"`);
  } catch {}
}

// ── FIX 2: pg.Pool instead of pg.Client ──────────────────────────────────────
// pg.Client is a single persistent connection with no reconnect logic.
// When the connection drops, pgClient still exists so !pgClient is false —
// getDb() returns the broken object and every query throws, poisoning the
// transport layer and causing all tools to fail.
// pg.Pool handles reconnection, idle timeouts, and connection limits automatically.
const pgPool = PG_CONNECTION_STRING ? new pg.Pool({
  connectionString: PG_CONNECTION_STRING,
  max: 3,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
}) : null;

if (pgPool) {
  pgPool.on("error", (err) => {
    console.error("[postgres] pool error (non-fatal):", err.message);
  });
}

async function getDb() {
  if (!pgPool) return null;
  return pgPool;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function safePath(filePath) {
  const resolved = path.resolve(REPO_PATH, filePath.replace(/^\//, ""));
  if (!resolved.startsWith(path.resolve(REPO_PATH))) {
    throw new Error("Path traversal attempt blocked");
  }
  return resolved;
}

async function listDir(dirPath, depth = 0, maxDepth = 3) {
  if (depth > maxDepth) return [];
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const fullPath = path.join(dirPath, entry.name);
    const rel = path.relative(REPO_PATH, fullPath);
    if (entry.isDirectory()) {
      result.push({ type: "dir", path: rel });
      result.push(...await listDir(fullPath, depth + 1, maxDepth));
    } else {
      result.push({ type: "file", path: rel });
    }
  }
  return result;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function verifyPKCE(codeVerifier, codeChallenge) {
  const hash = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  return hash === codeChallenge;
}

// ── Tools ─────────────────────────────────────────────────────────────────────
const TOOLS = [
  { name: "list_directory", description: "List files and directories in the repo.", inputSchema: { type: "object", properties: { subpath: { type: "string" }, max_depth: { type: "number" } } } },
  {
    name: "read_file",
    description: "Read the contents of a file in the repo. Supports pagination via start_line/end_line to avoid token limits on large files. Always check total_lines in the response and paginate if needed.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to repo root" },
        start_line: { type: "number", description: "1-based line number to start from (default: 1)" },
        end_line: { type: "number", description: "1-based line number to end at (default: read all). Use with start_line to paginate large files." },
      },
      required: ["path"]
    }
  },
  { name: "write_file", description: "Write or overwrite a file in the repo.", inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "delete_file", description: "Delete a file from the repo.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "run_command", description: "Run a shell command in the repo directory.", inputSchema: { type: "object", properties: { command: { type: "string" }, cwd: { type: "string" } }, required: ["command"] } },
  { name: "query_postgres", description: "Run a SQL query against the connected Postgres database.", inputSchema: { type: "object", properties: { sql: { type: "string" }, params: { type: "array", items: {} } }, required: ["sql"] } },
  { name: "git_commit_push", description: "Stage all changes, commit, and push to GitHub.", inputSchema: { type: "object", properties: { message: { type: "string" }, branch: { type: "string" } }, required: ["message"] } },
  { name: "git_pull", description: "Pull latest changes from GitHub.", inputSchema: { type: "object", properties: {} } },
  { name: "coolify_list_deployments", description: "List recent deployments for an application in Coolify.", inputSchema: { type: "object", properties: { app_uuid: { type: "string", description: "Coolify application UUID" } }, required: ["app_uuid"] } },
  { name: "coolify_deployment_logs", description: "Get the logs for a specific Coolify deployment.", inputSchema: { type: "object", properties: { deployment_uuid: { type: "string" } }, required: ["deployment_uuid"] } },
  { name: "coolify_list_envs", description: "List environment variables for a Coolify application.", inputSchema: { type: "object", properties: { app_uuid: { type: "string" } }, required: ["app_uuid"] } },
  { name: "coolify_create_env", description: "Create an environment variable for a Coolify application.", inputSchema: { type: "object", properties: { app_uuid: { type: "string" }, key: { type: "string" }, value: { type: "string" } }, required: ["app_uuid", "key", "value"] } },
  { name: "coolify_update_env", description: "Update an environment variable for a Coolify application.", inputSchema: { type: "object", properties: { app_uuid: { type: "string" }, key: { type: "string" }, value: { type: "string" } }, required: ["app_uuid", "key", "value"] } },
  { name: "coolify_trigger_deploy", description: "Trigger a new deployment for a Coolify application.", inputSchema: { type: "object", properties: { app_uuid: { type: "string" } }, required: ["app_uuid"] } },
];

async function handleTool(name, args) {
  switch (name) {
    case "list_directory": {
      const base = args.subpath ? safePath(args.subpath) : REPO_PATH;
      const entries = await listDir(base, 0, args.max_depth ?? 3);
      return entries.map((e) => `${e.type === "dir" ? "📁" : "📄"} ${e.path}`).join("\n");
    }
    case "read_file": {
      const content = await fs.readFile(safePath(args.path), "utf-8");
      const lines = content.split("\n");
      const totalLines = lines.length;
      const startLine = args.start_line ? Math.max(1, args.start_line) : 1;
      const endLine = args.end_line ? Math.min(totalLines, args.end_line) : totalLines;

      // If no pagination requested and file is small, return as-is
      if (!args.start_line && !args.end_line && content.length <= 8000) {
        return `[File: ${args.path} | ${totalLines} lines]\n\n` + content;
      }

      // Paginate: return requested line range
      const slice = lines.slice(startLine - 1, endLine).join("\n");
      const header = `[File: ${args.path} | Lines ${startLine}-${endLine} of ${totalLines}]`;
      const footer = endLine < totalLines
        ? `\n\n[...more content below — call read_file with start_line=${endLine + 1} to continue...]`
        : `\n[end of file]`;

      // Still cap the slice at 8000 chars as a safety net
      if (slice.length > 8000) {
        const truncated = slice.slice(0, 8000);
        const truncLine = startLine + truncated.split("\n").length - 1;
        return header + "\n\n" + truncated +
          `\n\n[...slice truncated at 8000 chars (~line ${truncLine}). Use end_line=${truncLine} and start_line=${truncLine+1} to continue...]`;
      }

      return header + "\n\n" + slice + footer;
    }
    case "write_file": {
      const full = safePath(args.path);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, args.content, "utf-8");
      return `✅ Written: ${args.path}`;
    }
    case "delete_file": {
      const delPath = safePath(args.path);
      try { await fs.unlink(delPath); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      return `✅ Deleted: ${args.path}`;
    }
    case "run_command": {
      const cwd = args.cwd ? safePath(args.cwd) : REPO_PATH;
      const { stdout, stderr } = await execAsync(args.command, {
        cwd, timeout: 60000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      const combined = [stdout, stderr].filter(Boolean).join("\n--- stderr ---\n");
      // Cap at 5000 chars to prevent verbose output blowing up tool conversation context
      if (combined.length > 5000) {
        return combined.slice(0, 5000) + `\n[...output truncated at 5000 chars, total: ${combined.length} chars]`;
      }
      return combined;
    }
    case "query_postgres": {
      const db = await getDb();
      if (!db) return "❌ No PG_CONNECTION_STRING configured.";
      const result = await db.query(args.sql, args.params || []);
      return JSON.stringify({ rowCount: result.rowCount, rows: result.rows }, null, 2);
    }
    case "git_commit_push": {
      const cmds = [
        `git -C ${REPO_PATH} add -A`,
        `git -C ${REPO_PATH} commit -m ${JSON.stringify(args.message)}`,
        `git -C ${REPO_PATH} push origin HEAD${args.branch ? " " + args.branch : ""}`,
      ];
      const results = [];
      for (const cmd of cmds) {
        const { stdout, stderr } = await execAsync(cmd, { timeout: 30000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
        results.push((stdout + stderr).trim());
      }
      return results.join("\n");
    }
    case "git_pull": {
      const { stdout, stderr } = await execAsync(`git -C ${REPO_PATH} pull`, { timeout: 30000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
      return (stdout + stderr).trim();
    }
    case "coolify_list_deployments": {
      const data = await coolifyFetch(`/deployments/applications/${args.app_uuid}?take=10`);
      return typeof data === "string" ? data : JSON.stringify(data, null, 2);
    }
    case "coolify_deployment_logs": {
      const data = await coolifyFetch(`/deployments/${args.deployment_uuid}`);
      return typeof data === "string" ? data : JSON.stringify(data, null, 2);
    }
    case "coolify_list_envs": {
      const data = await coolifyFetch(`/applications/${args.app_uuid}/envs`);
      return typeof data === "string" ? data : JSON.stringify(data, null, 2);
    }
    case "coolify_create_env": {
      const data = await coolifyFetch(`/applications/${args.app_uuid}/envs`, { method: "POST", body: JSON.stringify({ key: args.key, value: args.value }) });
      return typeof data === "string" ? data : JSON.stringify(data, null, 2);
    }
    case "coolify_update_env": {
      const envs = await coolifyFetch(`/applications/${args.app_uuid}/envs`);
      const env = Array.isArray(envs) ? envs.find(e => e.key === args.key) : null;
      if (!env) return `❌ Env var '${args.key}' not found`;
      const data = await coolifyFetch(`/applications/${args.app_uuid}/envs`, { method: "PATCH", body: JSON.stringify({ key: args.key, value: args.value, uuid: env.uuid }) });
      return typeof data === "string" ? data : JSON.stringify(data, null, 2);
    }
    case "coolify_trigger_deploy": {
      const data = await coolifyFetch(`/deploy?uuid=${args.app_uuid}&force=false`);
      return typeof data === "string" ? data : JSON.stringify(data, null, 2);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── FIX 1: Per-connection Server factory ─────────────────────────────────────
// ORIGINAL BUG: Single shared Server instance. server.connect() called on it
// for every /mcp request. The MCP SDK throws "Already connected to a transport"
// on the second concurrent connection — this was an uncaught throw that killed
// the entire Node process (including the orchestrator cron).
//
// FIX: Create a fresh Server instance per connection. Each connection gets its
// own Server + transport pair, fully isolated. Handlers close over the shared
// TOOLS array and handleTool function so behaviour is identical.
function createMcpServer() {
  const s = new Server(
    { name: "hetzner-dev-mcp", version: "1.0.6" },
    { capabilities: { tools: {} } }
  );
  s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  s.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const result = await handleTool(request.params.name, request.params.arguments || {});
      return { content: [{ type: "text", text: String(result) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `❌ Error: ${err.message}` }], isError: true };
    }
  });
  return s;
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url, BASE_URL);

  if (url.pathname === "/.well-known/oauth-authorization-server" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      issuer: BASE_URL,
      authorization_endpoint: `${BASE_URL}/authorize`,
      token_endpoint: `${BASE_URL}/token`,
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      response_types_supported: ["code"],
    }));
    return;
  }

  if (url.pathname === "/authorize" && req.method === "GET") {
    const clientId = url.searchParams.get("client_id");
    const redirectUri = url.searchParams.get("redirect_uri");
    const codeChallenge = url.searchParams.get("code_challenge");
    const state = url.searchParams.get("state");
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Authorize Claude</title><style>body{font-family:sans-serif;max-width:400px;margin:80px auto;padding:20px}h2{margin-bottom:8px}p{color:#555;margin-bottom:24px}input{width:100%;padding:10px;font-size:16px;border:1px solid #ccc;border-radius:6px;box-sizing:border-box;margin-bottom:12px}button{width:100%;padding:12px;background:#6c47ff;color:white;border:none;border-radius:6px;font-size:16px;cursor:pointer}button:hover{background:#5a3de0}</style></head><body><h2>🔌 Authorize Claude</h2><p>Enter your Bearer token to give Claude access to your server.</p><form method="POST" action="/authorize"><input type="hidden" name="client_id" value="${clientId}"/><input type="hidden" name="redirect_uri" value="${redirectUri}"/><input type="hidden" name="code_challenge" value="${codeChallenge}"/><input type="hidden" name="state" value="${state}"/><input type="password" name="token" placeholder="Bearer token" autofocus/><button type="submit">Authorize</button></form></body></html>`);
    return;
  }

  if (url.pathname === "/authorize" && req.method === "POST") {
    const body = await readBody(req);
    const params = new URLSearchParams(body);
    const token = params.get("token");
    const redirectUri = params.get("redirect_uri");
    const codeChallenge = params.get("code_challenge");
    const state = params.get("state");
    const clientId = params.get("client_id");
    if (token !== BEARER_TOKEN) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:400px;margin:80px auto;padding:20px"><h2>❌ Invalid token</h2><p>The token you entered is incorrect.</p><a href="/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${codeChallenge}&state=${state}&code_challenge_method=S256">Try again</a></body></html>`);
      return;
    }
    const code = crypto.randomBytes(32).toString("hex");
    authCodes.set(code, { codeChallenge, redirectUri, clientId });
    setTimeout(() => authCodes.delete(code), 5 * 60 * 1000);
    const redirect = new URL(redirectUri);
    redirect.searchParams.set("code", code);
    redirect.searchParams.set("state", state);
    res.writeHead(302, { Location: redirect.toString() });
    res.end();
    return;
  }

  if (url.pathname === "/token" && req.method === "POST") {
    const body = await readBody(req);
    const params = new URLSearchParams(body);
    const code = params.get("code");
    const codeVerifier = params.get("code_verifier");
    const stored = authCodes.get(code);
    if (!stored) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "invalid_grant" })); return; }
    if (!verifyPKCE(codeVerifier, stored.codeChallenge)) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "invalid_grant", error_description: "PKCE verification failed" })); return; }
    authCodes.delete(code);
    const accessToken = crypto.randomBytes(32).toString("hex");
    tokens.add(accessToken);
    saveTokens(tokens);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ access_token: accessToken, token_type: "Bearer", expires_in: 86400 }));
    return;
  }

  // ── Auth check — public endpoints skip ───────────────────────────────────
  const PUBLIC_PATHS = [
    '/.well-known/oauth-authorization-server',
    '/badge/smoke', '/smoke-status', '/smoke-latest', '/badge/coolify',
    '/health', '/healthz', '/status', '/save-tokens',
  ];
  if (!PUBLIC_PATHS.includes(url.pathname)) {
    const auth = req.headers["authorization"] || "";
    const token = auth.replace("Bearer ", "");
    if (token !== BEARER_TOKEN && !tokens.has(token)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
  }

  // ── Smoke badge ───────────────────────────────────────────────────────────
  if (url.pathname === '/badge/smoke' && req.method === 'GET') {
    try {
      const statusRes = await fetch('https://api.github.com/repos/CommonEmailDotCom/SaaS-Boilerplate/contents/smoke-status.json', {
        headers: { 'Authorization': 'Bearer ' + process.env.GITHUB_TOKEN, 'Accept': 'application/vnd.github.raw+json', 'Cache-Control': 'no-cache' }
      });
      const status = await statusRes.json();
      const passing = status.status === 'passing';
      const message = passing ? 'passing' : 'failing';
      const color = passing ? '#2ea44f' : '#e53e3e';
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="156" height="20" role="img"><title>smoke test: ${message}</title><linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient><clipPath id="r"><rect width="156" height="20" rx="3" fill="#fff"/></clipPath><g clip-path="url(#r)"><rect width="82" height="20" fill="#555"/><rect x="82" width="74" height="20" fill="${color}"/><rect width="156" height="20" fill="url(#s)"/></g><g fill="#fff" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="11"><text x="41" y="14">smoke test</text><text x="119" y="14">${message}</text></g></svg>`;
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0' });
      res.end(svg);
    } catch {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      res.end('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="20"><rect width="82" height="20" fill="#555" rx="3"/><rect x="82" width="38" height="20" fill="#9f9f9f" rx="3"/><g fill="#fff" font-family="Verdana,sans-serif" font-size="11"><text x="41" y="14" text-anchor="middle">smoke test</text><text x="101" y="14" text-anchor="middle">?</text></g></svg>');
    }
    return;
  }

  if (url.pathname === '/smoke-status' && req.method === 'GET') {
    try {
      const r = await fetch('https://api.github.com/repos/CommonEmailDotCom/SaaS-Boilerplate/contents/smoke-status.json', {
        headers: { 'Authorization': 'Bearer ' + process.env.GITHUB_TOKEN, 'Accept': 'application/vnd.github.raw+json', 'Cache-Control': 'no-cache' }
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(await r.json()));
    } catch {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Status not found' }));
    }
    return;
  }

  if (url.pathname === '/smoke-latest' && req.method === 'GET') {
    try {
      const r = await fetch('https://api.github.com/repos/CommonEmailDotCom/SaaS-Boilerplate/contents/smoke-status.json', {
        headers: { 'Authorization': 'Bearer ' + process.env.GITHUB_TOKEN, 'Accept': 'application/vnd.github.raw+json', 'Cache-Control': 'no-cache' }
      });
      const status = await r.json();
      res.writeHead(302, { 'Location': status.runUrl || 'https://github.com/CommonEmailDotCom/SaaS-Boilerplate/actions/workflows/smoke-test.yml', 'Cache-Control': 'no-cache' });
      res.end();
    } catch {
      res.writeHead(302, { 'Location': 'https://github.com/CommonEmailDotCom/SaaS-Boilerplate/actions/workflows/smoke-test.yml' });
      res.end();
    }
    return;
  }

  if (url.pathname === '/badge/coolify' && req.method === 'GET') {
    try {
      const depRes = await fetch(COOLIFY_URL + '/api/v1/deployments/applications/tuk1rcjj16vlk33jrbx3c9d3?take=1', {
        headers: { 'Authorization': 'Bearer ' + COOLIFY_API_TOKEN }
      });
      const latest = (await depRes.json()).deployments?.[0];
      let message = 'unknown', color = '#9f9f9f';
      if (latest?.status === 'in_progress' || latest?.status === 'queued') { message = 'deploying'; color = '#0075ca'; }
      else if (latest?.status === 'finished') { message = 'deployed · ' + (latest.commit?.slice(0,7) || ''); color = '#2ea44f'; }
      else if (latest?.status === 'failed') { message = 'failed · ' + (latest.commit?.slice(0,7) || ''); color = '#e53e3e'; }
      else if (latest?.status === 'cancelled-by-user') { message = 'cancelled'; color = '#9f9f9f'; }
      const lw = 58, mw = message.length * 7 + 14, tw = lw + mw;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${tw}" height="20" role="img"><title>coolify: ${message}</title><linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient><clipPath id="r"><rect width="${tw}" height="20" rx="3" fill="#fff"/></clipPath><g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${mw}" height="20" fill="${color}"/><rect width="${tw}" height="20" fill="url(#s)"/></g><g fill="#fff" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="11"><text x="${Math.round(lw/2)}" y="14">coolify</text><text x="${Math.round(lw+mw/2)}" y="14">${message}</text></g></svg>`;
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0' });
      res.end(svg);
    } catch {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      res.end('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="20"><rect width="58" height="20" fill="#555" rx="3"/><rect x="58" width="62" height="20" fill="#9f9f9f" rx="3"/><g fill="#fff" font-family="Verdana,sans-serif" font-size="11" text-anchor="middle"><text x="29" y="14">coolify</text><text x="89" y="14">unknown</text></g></svg>');
    }
    return;
  }

  if (url.pathname === '/save-tokens' && req.method === 'GET') {
    saveTokens(tokens);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ saved: tokens.size, file: TOKENS_FILE }));
    return;
  }

  if (url.pathname === "/trigger-deploy" && req.method === "POST") {
    try {
      const appUuid = url.searchParams.get("uuid") || "tuk1rcjj16vlk33jrbx3c9d3";
      const data = await coolifyFetch("/deploy?uuid=" + appUuid + "&force=false");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (url.pathname === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      repo: REPO_PATH,
      github: GITHUB_REPO || "not set",
      coolify: COOLIFY_API_TOKEN ? "configured" : "not configured",
      tools: TOOLS.length,
    }));
    return;
  }

  // ── FIX 4: /healthz with real postgres connectivity check ─────────────────
  if (url.pathname === "/healthz" && req.method === "GET") {
    const expected = ["list_directory","read_file","write_file","delete_file","run_command","query_postgres","git_commit_push","git_pull","coolify_list_deployments","coolify_deployment_logs","coolify_trigger_deploy","coolify_list_envs","coolify_create_env","coolify_update_env"];
    const missing = expected.filter(n => !TOOLS.map(t => t.name).includes(n));
    let pgOk = true, pgError = null;
    if (pgPool) { try { await pgPool.query('SELECT 1'); } catch (e) { pgOk = false; pgError = e.message; } }
    const ok = missing.length === 0 && pgOk;
    res.writeHead(ok ? 200 : 503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: ok ? "ok" : "degraded",
      tools_registered: TOOLS.length,
      tools_expected: expected.length,
      missing,
      postgres: pgPool ? (pgOk ? "ok" : `error: ${pgError}`) : "not configured",
      active_connections: activeConnections,
      uptime_seconds: Math.floor((Date.now() - SERVER_START) / 1000),
    }));
    return;
  }

  // ── /status — public visibility for all users ─────────────────────────────
  // Shows server state so users can check before attempting a reset.
  // Reset coordination lock is planned for next release.
  if (url.pathname === "/status" && req.method === "GET") {
    let pgOk = true;
    if (pgPool) { try { await pgPool.query('SELECT 1'); } catch { pgOk = false; } }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      version: "1.0.6",
      uptime_seconds: Math.floor((Date.now() - SERVER_START) / 1000),
      active_mcp_connections: activeConnections,
      postgres: pgPool ? (pgOk ? "ok" : "error") : "not configured",
      tools: TOOLS.length,
      note: "Reset coordination lock coming in next release",
    }));
    return;
  }

  // ── FIX 1 + FIX 5: Per-connection Server with transport error handling ────
  if (url.pathname === "/mcp") {
    activeConnections++;
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      activeConnections = Math.max(0, activeConnections - 1);
      transport.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      activeConnections = Math.max(0, activeConnections - 1);
      console.error("[MCP] transport error:", err.message);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    }
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

// ── Start ─────────────────────────────────────────────────────────────────────
ensureRepo().then(() => {
  httpServer.listen(PORT, () => {
    console.log(`✅ MCP server running on port ${PORT}`);
    console.log(`   Repo: ${GITHUB_REPO || "not set"} → ${REPO_PATH}`);
    console.log(`   Postgres: ${PG_CONNECTION_STRING ? "configured (pool, max 3)" : "not configured"}`);
    console.log(`   Coolify: ${COOLIFY_API_TOKEN ? "configured" : "not configured"}`);
    console.log(`   Fixes: FIX1=per-connection-Server FIX2=pg.Pool FIX3=uncaughtException FIX4=healthz+postgres FIX5=transport-error-handling`);
  });
});
