#!/usr/bin/env node
/**
 * MCP server for the GitHub Repo Context extension.
 *
 * Runs locally over stdio, so nothing listens on a port and the token never
 * crosses a network boundary except to github.com.
 *
 * IMPORTANT: stdout is the MCP transport. Anything this process prints to
 * stdout that is not a protocol message corrupts the session — all diagnostics
 * go to stderr.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";

import {
  saveToken,
  clearToken,
  readState,
  setActiveRepo,
  clearActiveRepo,
} from "./store.js";
import {
  RepoContextError,
  validateToken,
  whoami,
  listRepos,
  repoMeta,
  listFiles,
  readFile,
  searchCode,
  overview,
} from "./github.js";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

const PANEL_URI = "ui://repo-context/panel.html";

/* ------------------------------------------------------------------ *
 * Widget HTML
 *
 * The iframe's CSP blocks CDN fetches, so the ext-apps browser bundle is
 * inlined into the HTML rather than imported. The rewrite turns the bundle's
 * trailing `export{...}` into a global assignment the widget can read.
 * ------------------------------------------------------------------ */
function buildPanel() {
  const bundle = readFileSync(
    require.resolve("@modelcontextprotocol/ext-apps/app-with-deps"),
    "utf8",
  ).replace(/export\{([^}]+)\};?\s*$/, (_, body) => {
    const pairs = body.split(",").map((part) => {
      const [local, exported] = part.split(" as ").map((s) => s.trim());
      return `${exported ?? local}:${local}`;
    });
    return `globalThis.ExtApps={${pairs.join(",")}};`;
  });

  return readFileSync(path.join(here, "..", "widgets", "panel.html"), "utf8").replace(
    "/*__EXT_APPS_BUNDLE__*/",
    () => bundle,
  );
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const text = (value) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
});

const failure = (message) => ({
  content: [{ type: "text", text: message }],
  isError: true,
});

/**
 * Missing token, missing repo, and GitHub's own errors are all user-fixable and
 * come back as readable tool errors rather than crashing the handler — the
 * message tells the model which tool to call to recover.
 */
function guarded(handler) {
  return async (args, extra) => {
    try {
      return await handler(args ?? {}, extra);
    } catch (err) {
      if (err instanceof RepoContextError) return failure(err.message);
      return failure(`repo-context failed: ${err.message}`);
    }
  };
}

/* ------------------------------------------------------------------ *
 * Server
 * ------------------------------------------------------------------ */

const server = new McpServer({ name: "innostaas-repo-context", version: "0.1.0" });

registerAppResource(server, "GitHub repo picker", PANEL_URI, {}, async () => ({
  contents: [{ uri: PANEL_URI, mimeType: RESOURCE_MIME_TYPE, text: buildPanel() }],
}));

/* ---------------------------- the panel ---------------------------- */

registerAppTool(
  server,
  "connect_github_repo",
  {
    title: "Connect a GitHub repo",
    description:
      "Open a panel where the user pastes a GitHub personal access token, sees every repo that " +
      "token can read, and picks one as the active repo. The choice is remembered across " +
      "sessions. Use when the user asks to list their repos, connect or switch a GitHub repo, " +
      "sign in to GitHub, or asks a question about their code when no repo is active yet — " +
      "any other tool here that reports 'not signed in' or 'no active repo' means call this.",
    annotations: { title: "Connect a GitHub repo", readOnlyHint: false, openWorldHint: true },
    inputSchema: {},
    _meta: { ui: { resourceUri: PANEL_URI } },
  },
  guarded(async () => {
    const [user, state] = await Promise.all([whoami(), readState()]);
    return text({
      authenticated: user.authenticated,
      login: user.login ?? null,
      activeRepo: state.repo ?? null,
      recent: state.recent ?? [],
    });
  }),
);

registerAppTool(
  server,
  "panel_save_pat",
  {
    title: "Save GitHub token",
    description: "Internal: validate and store a token pasted into the panel.",
    annotations: { title: "Save GitHub token", readOnlyHint: false },
    inputSchema: { token: z.string().min(1).describe("Personal access token pasted by the user") },
    // Panel-only, so the raw token never passes through the conversation.
    _meta: { ui: { visibility: ["app"] } },
  },
  guarded(async ({ token }) => {
    const check = await validateToken(token);
    if (!check.valid) return text({ status: "error", detail: check.reason });

    const { stored, warning } = await saveToken(token);
    return text({ status: "ok", login: check.login, storage: stored, warning });
  }),
);

registerAppTool(
  server,
  "panel_list_repos",
  {
    title: "Load repo list",
    description: "Internal: list repos for rendering inside the panel.",
    annotations: { title: "Load repo list", readOnlyHint: true },
    inputSchema: {},
    // Panel-only: the full list is UI data, not something worth spending
    // context on when the user is about to narrow it to one repo anyway.
    _meta: { ui: { visibility: ["app"] } },
  },
  guarded(async () => {
    const [repos, state] = await Promise.all([listRepos({}), readState()]);
    return text({ status: "ok", repos, activeRepo: state.repo ?? null });
  }),
);

registerAppTool(
  server,
  "panel_select_repo",
  {
    title: "Set the picked repo",
    description: "Internal: store the repo the user clicked in the panel.",
    annotations: { title: "Set the picked repo", readOnlyHint: false },
    inputSchema: { repo: z.string().min(1).describe('Repo as "owner/name"') },
    _meta: { ui: { visibility: ["app"] } },
  },
  guarded(async ({ repo }) => {
    const meta = await repoMeta(repo);
    await setActiveRepo(meta.fullName, meta.defaultBranch);
    return text({ status: "ok", repo: meta.fullName, defaultBranch: meta.defaultBranch });
  }),
);

/* --------------------------- code access --------------------------- */

server.registerTool(
  "github_repo_status",
  {
    title: "GitHub connection status",
    description:
      "Report whether a GitHub token is stored, whose it is, and which repo is currently " +
      "active. Use to check what codebase is connected before answering a question about " +
      "'my code', or to diagnose why a repo tool failed.",
    annotations: { title: "GitHub connection status", readOnlyHint: true },
    inputSchema: {},
  },
  guarded(async () => {
    const [user, state] = await Promise.all([whoami(), readState()]);
    return text({
      signedIn: user.authenticated,
      githubLogin: user.login ?? null,
      signInProblem: user.authenticated ? null : user.reason,
      activeRepo: state.repo ?? null,
      defaultBranch: state.defaultBranch ?? null,
      selectedAt: state.selectedAt ?? null,
      recentRepos: state.recent ?? [],
      hint: state.repo ? undefined : "Call connect_github_repo to let the user pick a repo.",
    });
  }),
);

server.registerTool(
  "repo_overview",
  {
    title: "Overview of the active repo",
    description:
      "Get a first orientation on the active repo: default branch, languages, top-level " +
      "layout, and the README. Use this before the other repo tools when you need context on " +
      "an unfamiliar codebase — one call replaces several list/read round trips.",
    annotations: { title: "Overview of the active repo", readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      repo: z.string().optional().describe('Override the active repo, as "owner/name".'),
    },
  },
  guarded(async ({ repo }) => text(await overview({ repo }))),
);

server.registerTool(
  "list_repo_files",
  {
    title: "List files in the repo",
    description:
      "List what is inside the active GitHub repo — one directory at a time, or every file " +
      "under a path with recursive=true. Use to find where something lives before reading it, " +
      "or to see how the project is laid out.",
    annotations: { title: "List files in the repo", readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      path: z.string().optional().describe("Directory path; omit for the repo root."),
      recursive: z
        .boolean()
        .optional()
        .describe("List every file underneath instead of one directory level."),
      ref: z.string().optional().describe("Branch, tag, or commit; omit for the default branch."),
      repo: z.string().optional().describe('Override the active repo, as "owner/name".'),
    },
  },
  guarded(async (args) => text(await listFiles(args))),
);

server.registerTool(
  "read_repo_file",
  {
    title: "Read a file from the repo",
    description:
      "Read one file out of the active GitHub repo, optionally just a line range of it. Use " +
      "whenever a question depends on what the code actually says — implementation details, " +
      "config values, dependencies, docs.",
    annotations: { title: "Read a file from the repo", readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      path: z.string().describe("File path within the repo, e.g. src/index.js."),
      startLine: z.number().int().positive().optional().describe("First line to return (1-based)."),
      endLine: z.number().int().positive().optional().describe("Last line to return, inclusive."),
      ref: z.string().optional().describe("Branch, tag, or commit; omit for the default branch."),
      repo: z.string().optional().describe('Override the active repo, as "owner/name".'),
    },
  },
  guarded(async (args) => text(await readFile(args))),
);

server.registerTool(
  "search_repo_code",
  {
    title: "Search code in the repo",
    description:
      "Search the active repo's code through GitHub's index and get matching files with " +
      "snippets. Use to locate a symbol, string, or config key when you don't know which file " +
      "holds it. Matches whole tokens rather than substrings, so no result is not proof of " +
      "absence — fall back to list_repo_files then read_repo_file.",
    annotations: { title: "Search code in the repo", readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      query: z
        .string()
        .describe('Search terms. GitHub qualifiers work too, e.g. "useAuth path:src extension:ts".'),
      limit: z.number().int().positive().max(50).optional().describe("Max files to return (default 20)."),
      repo: z.string().optional().describe('Override the active repo, as "owner/name".'),
    },
  },
  guarded(async (args) => text(await searchCode(args))),
);

server.registerTool(
  "set_active_repo",
  {
    title: "Set the active repo",
    description:
      "Point the repo tools at a specific repo by name, without opening the panel. Use when " +
      "the user names a repo outright ('use my acme/api repo'). When they are vague or want to " +
      "browse, call connect_github_repo instead so they can pick from a list.",
    annotations: { title: "Set the active repo", readOnlyHint: false, openWorldHint: true },
    inputSchema: { repo: z.string().describe('Repo as "owner/name".') },
  },
  guarded(async ({ repo }) => {
    const meta = await repoMeta(repo);
    await setActiveRepo(meta.fullName, meta.defaultBranch);
    return text({
      status: "ok",
      activeRepo: meta.fullName,
      defaultBranch: meta.defaultBranch,
      private: meta.private,
      description: meta.description,
      message: `Active repo is now ${meta.fullName} (branch ${meta.defaultBranch}).`,
    });
  }),
);

server.registerTool(
  "github_disconnect",
  {
    title: "Disconnect GitHub",
    description:
      "Delete the stored GitHub token from this machine and clear the active repo. Use when " +
      "the user wants to sign out or switch accounts.",
    annotations: { title: "Disconnect GitHub", readOnlyHint: false, destructiveHint: true },
    inputSchema: {},
  },
  guarded(async () => {
    await clearToken();
    await clearActiveRepo();
    return text("Disconnected — the stored GitHub token was deleted and no repo is active.");
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("repo-context MCP server ready\n");
