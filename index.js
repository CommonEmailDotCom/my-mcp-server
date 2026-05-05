#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "http";
import fs from "fs/promises";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

const REPO_PATH = process.env.REPO_PATH || "/repo";
const BEARER_TOKEN = process.env.BEARER_TOKEN;
const PORT = parseInt(process.env.PORT || "3100");
const PG_CONNECTION_STRING = process.env.PG_CONNECTION_STRING;
const GITHUB_REPO = process.env.GITHUB_REPO; // e.g. CommonEmailDotCom/SaaS-Boilerplate
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

if (!BEARER_TOKEN) {
  console.error("ERROR: BEARER_TOKEN env var is required");
  process.exit(1);
}

const execAsync = promisify(exec);

// ── Clone repo on startup ────────────────────────────────────────────────────
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
    // Store credentials for future pushes
    await execAsync(
      `git -C ${REPO_PATH} remote set-url origin https://${GITHUB_TOKEN}@github.com/${GITHUB_REPO}.git`
    );
    console.log("✅ Repo cloned successfully");
  }
}

// ── Postgres ─────────────────────────────────────────────────────────────────
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
    description: "Stage all changes, commit, and push to GitHub. Triggers Coolify redeploy.",
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
    description: "Pull latest changes from GitHub into the local clone.",
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
  const auth = req.headers["authorization"] || "";
  if (auth !== `Bearer ${BEARER_TOKEN}`) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  if (req.url === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", repo: REPO_PATH, github: GITHUB_REPO || "not set" }));
    return;
  }

  if (req.url === "/mcp") {
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
