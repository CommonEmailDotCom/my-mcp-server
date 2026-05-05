#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "http";
import fs from "fs/promises";
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

if (!BEARER_TOKEN) {
  console.error("ERROR: BEARER_TOKEN env var is required");
  process.exit(1);
}

const execAsync = promisify(exec);

// ── In-memory stores ──────────────────────────────────────────────────────────
const authCodes = new Map();   // code → { codeChallenge, redirectUri, clientId }
const tokens = new Set();      // valid access tokens

// ── Clone repo on startup ─────────────────────────────────────────────────────
async function ensureRepo() {
  if (!GITHUB_REPO || !GITHUB_TOKEN) {
    console.log("ℹ️  No GITHUB_REPO/GITHUB_TOKEN set — skipping clone");
    return;
  }
  try {
    await fs.access(path.join(REPO_PATH, ".git"));
    console.log("✅ Repo already cloned, pulling latest...");
    await execAsync(`git -C ${REPO_PATH} pull`, {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  } catch {
    console.log("📦 Cloning repo...");
    await fs.mkdir(REPO_PATH, { recursive: true });
    const url = `https://${GITHUB_TOKEN}@github.com/${GITHUB_REPO}.git`;
    await execAsync(`git clone ${url} ${REPO_PATH}`, {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    await execAsync(
      `git -C ${REPO_PATH} remote set-url origin https://${GITHUB_TOKEN}@github.com/${GITHUB_REPO}.git`
    );
    console.log("✅ Repo cloned successfully");
  }
}

// ── Postgres ──────────────────────────────────────────────────────────────────
let pgClient = null;
async function getDb() {
  if (!PG_CONNECTION_STRING) return null;
  if (!pgClient) {
    pgClient = new pg.Client({ connectionString: PG_CONNECTION_STRING });
    await pgClient.connect();
  }
  return pgClient;
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
      const children = await listDir(fullPath, depth + 1, maxDepth);
      result.push(...children);
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
  const hash = crypto
    .createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  return hash === codeChallenge;
}

// ── Tools ─────────────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: "list_directory",
    description: "List files and directories in the repo.",
    inputSchema: {
      type: "object",
      properties: {
        subpath: { type: "string" },
        max_depth: { type: "number" },
      },
    },
  },
  {
    name: "read_file",
    description: "Read the contents of a file in the repo.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write or overwrite a file in the repo.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "delete_file",
    description: "Delete a file from the repo.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "run_command",
    description: "Run a shell command in the repo directory.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        cwd: { type: "string" },
      },
      required: ["command"],
    },
  },
  {
    name: "query_postgres",
    description: "Run a SQL query against the connected Postgres database.",
    inputSchema: {
      type: "object",
      properties: {
        sql: { type: "string" },
        params: { type: "array", items: {} },
      },
      required: ["sql"],
    },
  },
  {
    name: "git_commit_push",
    description: "Stage all changes, commit, and push to GitHub.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string" },
        branch: { type: "string" },
      },
      required: ["message"],
    },
  },
  {
    name: "git_pull",
    description: "Pull latest changes from GitHub.",
    inputSchema: { type: "object", properties: {} },
  },
];

async function handleTool(name, args) {
  switch (name) {
    case "list_directory": {
      const base = args.subpath ? safePath(args.subpath) : REPO_PATH;
      const entries = await listDir(base, 0, args.max_depth ?? 3);
      return entries.map((e) => `${e.type === "dir" ? "📁" : "📄"} ${e.path}`).join("\n");
    }
    case "read_file":
      return await fs.readFile(safePath(args.path), "utf-8");
    case "write_file": {
      const full = safePath(args.path);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, args.content, "utf-8");
      return `✅ Written: ${args.path}`;
    }
    case "delete_file":
      await fs.unlink(safePath(args.path));
      return `✅ Deleted: ${args.path}`;
    case "run_command": {
      const cwd = args.cwd ? safePath(args.cwd) : REPO_PATH;
      const { stdout, stderr } = await execAsync(args.command, {
        cwd,
        timeout: 60000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      return [stdout, stderr].filter(Boolean).join("\n--- stderr ---\n");
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
        const { stdout, stderr } = await execAsync(cmd, {
          timeout: 30000,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        });
        results.push((stdout + stderr).trim());
      }
      return results.join("\n");
    }
    case "git_pull": {
      const { stdout, stderr } = await execAsync(`git -C ${REPO_PATH} pull`, {
        timeout: 30000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      return (stdout + stderr).trim();
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── MCP Server ────────────────────────────────────────────────────────────────
const server = new Server(
  { name: "hetzner-dev-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const result = await handleTool(request.params.name, request.params.arguments || {});
    return { content: [{ type: "text", text: String(result) }] };
  } catch (err) {
    return {
      content: [{ type: "text", text: `❌ Error: ${err.message}` }],
      isError: true,
    };
  }
});

// ── HTTP server ───────────────────────────────────────────────────────────────
const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url, BASE_URL);

  // ── OAuth metadata ──
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

  // ── Authorization endpoint — show login form ──
  if (url.pathname === "/authorize" && req.method === "GET") {
    const clientId = url.searchParams.get("client_id");
    const redirectUri = url.searchParams.get("redirect_uri");
    const codeChallenge = url.searchParams.get("code_challenge");
    const state = url.searchParams.get("state");

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize Claude</title>
  <style>
    body { font-family: sans-serif; max-width: 400px; margin: 80px auto; padding: 20px; }
    h2 { margin-bottom: 8px; }
    p { color: #555; margin-bottom: 24px; }
    input { width: 100%; padding: 10px; font-size: 16px; border: 1px solid #ccc; border-radius: 6px; box-sizing: border-box; margin-bottom: 12px; }
    button { width: 100%; padding: 12px; background: #6c47ff; color: white; border: none; border-radius: 6px; font-size: 16px; cursor: pointer; }
    button:hover { background: #5a3de0; }
    .error { color: red; margin-top: 12px; }
  </style>
</head>
<body>
  <h2>🔌 Authorize Claude</h2>
  <p>Enter your Bearer token to give Claude access to your server.</p>
  <form method="POST" action="/authorize">
    <input type="hidden" name="client_id" value="${clientId}" />
    <input type="hidden" name="redirect_uri" value="${redirectUri}" />
    <input type="hidden" name="code_challenge" value="${codeChallenge}" />
    <input type="hidden" name="state" value="${state}" />
    <input type="password" name="token" placeholder="Bearer token" autofocus />
    <button type="submit">Authorize</button>
  </form>
</body>
</html>`);
    return;
  }

  // ── Authorization POST — validate token, issue code ──
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
      res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:400px;margin:80px auto;padding:20px">
        <h2>❌ Invalid token</h2><p>The token you entered is incorrect.</p>
        <a href="/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${codeChallenge}&state=${state}&code_challenge_method=S256">Try again</a>
      </body></html>`);
      return;
    }

    // Issue auth code
    const code = crypto.randomBytes(32).toString("hex");
    authCodes.set(code, { codeChallenge, redirectUri, clientId });
    setTimeout(() => authCodes.delete(code), 5 * 60 * 1000); // expire in 5 min

    const redirect = new URL(redirectUri);
    redirect.searchParams.set("code", code);
    redirect.searchParams.set("state", state);

    res.writeHead(302, { Location: redirect.toString() });
    res.end();
    return;
  }

  // ── Token endpoint — exchange code for access token ──
  if (url.pathname === "/token" && req.method === "POST") {
    const body = await readBody(req);
    const params = new URLSearchParams(body);
    const code = params.get("code");
    const codeVerifier = params.get("code_verifier");

    const stored = authCodes.get(code);
    if (!stored) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_grant" }));
      return;
    }

    if (!verifyPKCE(codeVerifier, stored.codeChallenge)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_grant", error_description: "PKCE verification failed" }));
      return;
    }

    authCodes.delete(code);
    const accessToken = crypto.randomBytes(32).toString("hex");
    tokens.add(accessToken);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 86400,
    }));
    return;
  }

  // ── All other routes require Bearer token ──
  const auth = req.headers["authorization"] || "";
  const token = auth.replace("Bearer ", "");
  if (token !== BEARER_TOKEN && !tokens.has(token)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  if (url.pathname === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", repo: REPO_PATH, github: GITHUB_REPO || "not set" }));
    return;
  }

  if (url.pathname === "/mcp") {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res);
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
    console.log(`   Postgres: ${PG_CONNECTION_STRING ? "configured" : "not configured"}`);
  });
});
