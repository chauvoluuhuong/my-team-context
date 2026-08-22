/**
 * GitHub REST calls and MCP tool registrations behind every tool in this extension.
 *
 * Everything here is read-only against api.github.com. The token is fetched
 * from the keychain per call rather than cached in a module variable, so a
 * sign-out takes effect immediately and a long-lived server never holds the
 * credential in memory between requests.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import {
  readToken,
  readState,
  saveToken,
  setActiveRepo,
  clearToken,
  clearActiveRepo,
} from "../utils/store.js";
import { RepoContextError, text, guarded } from "../utils/helpers.js";
import type {
  ValidateTokenResult,
  WhoamiResult,
  RepoSummary,
  RepoMetaResult,
  ListReposOptions,
  ListFilesOptions,
  ListFilesResult,
  ReadFileOptions,
  ReadFileResult,
  SearchCodeOptions,
  SearchCodeResult,
  OverviewOptions,
  OverviewResult,
} from "./types.js";

export const PANEL_URI = "ui://repo-context/panel.html";

const API = process.env.REPO_CONTEXT_API || "https://api.github.com";
const UA = "claude-repo-context";

const NOT_SIGNED_IN =
  "Not signed in to GitHub yet. Call connect_github_repo to open the sign-in panel " +
  "so the user can paste a personal access token.";

const NO_REPO =
  "No active repo selected yet. Call connect_github_repo to open the panel and let " +
  "the user pick one, or set_active_repo if they already named it.";

async function tokenOrThrow(): Promise<string> {
  const token = await readToken();
  if (!token) throw new RepoContextError(NOT_SIGNED_IN);
  return token;
}

/** Raw request. Callers decide how to read the body. */
async function request(
  token: string,
  url: string,
  { accept = "application/vnd.github+json" }: { accept?: string } = {},
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: accept, "User-Agent": UA },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new RepoContextError(`Could not reach GitHub: ${message}`);
  }

  if (res.status === 401) {
    throw new RepoContextError(
      "GitHub rejected the stored token — it may have expired or been revoked. " +
      "Call connect_github_repo to paste a new one.",
    );
  }
  if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000;
    throw new RepoContextError(
      `GitHub rate limit reached. It resets at ${new Date(reset).toLocaleTimeString()}.`,
    );
  }
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body.message) detail += `: ${body.message}`;
    } catch {
      // Body wasn't JSON — the status line is all we get.
    }
    throw new RepoContextError(`GitHub error: ${detail}`);
  }
  return res;
}

async function gh<T>(token: string, url: string, options?: { accept?: string }): Promise<T> {
  const res = await request(token, url, options);
  return (await res.json()) as T;
}

/* ------------------------------------------------------------------ *
 * Identity
 * ------------------------------------------------------------------ */

/**
 * Confirm a token works and identify whose it is, without storing it.
 */
export async function validateToken(token: string): Promise<ValidateTokenResult> {
  let res: Response;
  try {
    res = await fetch(`${API}/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": UA,
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { valid: false, reason: `Could not reach GitHub: ${message}` };
  }

  if (res.status === 401) {
    return {
      valid: false,
      reason:
        "GitHub rejected that token — check it was pasted in full and hasn't expired or been revoked.",
    };
  }
  if (!res.ok) return { valid: false, reason: `GitHub returned ${res.status} ${res.statusText}.` };

  const user = (await res.json()) as { login: string };
  return { valid: true, login: user.login };
}

export async function whoami(): Promise<WhoamiResult> {
  const token = await readToken();
  if (!token) return { authenticated: false, reason: "No token stored yet." };

  const check = await validateToken(token);
  return check.valid
    ? { authenticated: true, login: check.login }
    : { authenticated: false, reason: check.reason };
}

/* ------------------------------------------------------------------ *
 * Repos
 * ------------------------------------------------------------------ */

interface RawGitHubRepo {
  full_name: string;
  private: boolean;
  default_branch: string;
  description: string | null;
  language: string | null;
  pushed_at: string;
  size?: number;
}

/**
 * Repos the signed-in token can see, most recently pushed first. A classic PAT
 * sees everything the account can reach; a fine-grained PAT only what it was
 * granted — which is why an unexpectedly short list is a token-scope problem,
 * not a bug.
 */
export async function listRepos({ query, limit = 200 }: ListReposOptions = {}): Promise<RepoSummary[]> {
  const token = await tokenOrThrow();
  const perPage = 100;
  const repos: RawGitHubRepo[] = [];

  for (let page = 1; repos.length < limit; page += 1) {
    const batch = await gh<RawGitHubRepo[]>(
      token,
      `${API}/user/repos?per_page=${perPage}&page=${page}&sort=pushed` +
      `&affiliation=owner,collaborator,organization_member`,
    );
    repos.push(...batch);
    if (batch.length < perPage) break;
  }

  const mapped: RepoSummary[] = repos.slice(0, limit).map((r) => ({
    fullName: r.full_name,
    private: r.private,
    defaultBranch: r.default_branch,
    description: r.description,
    language: r.language,
    pushedAt: r.pushed_at,
  }));

  if (!query) return mapped;
  const q = query.toLowerCase();
  return mapped.filter(
    (r) =>
      r.fullName.toLowerCase().includes(q) ||
      (r.description ?? "").toLowerCase().includes(q),
  );
}

function splitRepo(repo: string): { owner: string; name: string } {
  const [owner, name, ...rest] = String(repo).split("/");
  if (!owner || !name || rest.length) {
    throw new RepoContextError(`repo must be in "owner/name" form, got "${repo}".`);
  }
  return { owner, name };
}

/** Confirm a repo exists and is readable with this token; returns its metadata. */
export async function repoMeta(repo: string): Promise<RepoMetaResult> {
  const token = await tokenOrThrow();
  const { owner, name } = splitRepo(repo);
  const data = await gh<RawGitHubRepo>(token, `${API}/repos/${owner}/${name}`);
  return {
    fullName: data.full_name,
    private: data.private,
    defaultBranch: data.default_branch,
    description: data.description,
    language: data.language,
    pushedAt: data.pushed_at,
    size: data.size,
  };
}

/**
 * The repo every read/list/search tool operates on, unless one is passed
 * explicitly. Stored by the panel; falls back to nothing rather than guessing.
 */
async function resolveTarget(repoOverride?: string): Promise<{ repo: string; ref?: string }> {
  if (repoOverride) {
    splitRepo(repoOverride);
    return { repo: repoOverride, ref: undefined };
  }
  const state = await readState();
  if (!state.repo) throw new RepoContextError(NO_REPO);
  return { repo: state.repo, ref: state.defaultBranch };
}

/* ------------------------------------------------------------------ *
 * Reading code
 * ------------------------------------------------------------------ */

interface RawContentEntry {
  path: string;
  type: string;
  size?: number;
}

interface RawTreeEntry {
  path: string;
  type: string;
  size?: number;
}

interface RawTreeResponse {
  truncated?: boolean;
  tree?: RawTreeEntry[];
}

/**
 * List one directory (default) or the whole tree under a path (`recursive`).
 *
 * The recursive path uses the git trees API — one request for the entire repo
 * instead of one per directory, which is what makes "show me the layout" cheap
 * on a large codebase.
 */
export async function listFiles({
  repo,
  path: dirPath = "",
  ref,
  recursive = false,
  limit = 400,
}: ListFilesOptions = {}): Promise<ListFilesResult> {
  const token = await tokenOrThrow();
  const target = await resolveTarget(repo);
  const { owner, name } = splitRepo(target.repo);
  const branch = ref || target.ref || (await repoMeta(target.repo)).defaultBranch;
  const clean = dirPath.replace(/^\/+|\/+$/g, "");

  if (!recursive) {
    const url =
      `${API}/repos/${owner}/${name}/contents/${clean.split("/").map(encodeURIComponent).join("/")}` +
      `?ref=${encodeURIComponent(branch)}`;
    const entries = await gh<RawContentEntry[] | RawContentEntry>(token, url);

    if (!Array.isArray(entries)) {
      throw new RepoContextError(
        `"${clean || "/"}" in ${target.repo} is a file, not a directory — use read_repo_file.`,
      );
    }

    return {
      repo: target.repo,
      ref: branch,
      path: clean || "/",
      entries: entries
        .map((e) => ({ path: e.path, type: e.type, size: e.type === "file" ? e.size : undefined }))
        .sort((a, b) =>
          a.type === b.type ? a.path.localeCompare(b.path) : a.type === "dir" ? -1 : 1,
        ),
    };
  }

  const tree = await gh<RawTreeResponse>(
    token,
    `${API}/repos/${owner}/${name}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
  );

  const prefix = clean ? `${clean}/` : "";
  const all = (tree.tree ?? [])
    .filter((e) => e.type === "blob" && e.path.startsWith(prefix))
    .map((e) => ({ path: e.path, type: "file", size: e.size }));

  return {
    repo: target.repo,
    ref: branch,
    path: clean || "/",
    fileCount: all.length,
    truncated: Boolean(tree.truncated) || all.length > limit,
    entries: all.slice(0, limit),
    note:
      all.length > limit
        ? `Showing ${limit} of ${all.length} files. Narrow with the path argument.`
        : undefined,
  };
}

const MAX_CHARS = 60_000;

/** Read one file, optionally a line range of it. */
export async function readFile({
  repo,
  path: filePath,
  ref,
  startLine,
  endLine,
  maxChars = MAX_CHARS,
}: ReadFileOptions): Promise<ReadFileResult> {
  if (!filePath) throw new RepoContextError("path is required — the file to read.");
  const token = await tokenOrThrow();
  const target = await resolveTarget(repo);
  const { owner, name } = splitRepo(target.repo);
  const branch = ref || target.ref || (await repoMeta(target.repo)).defaultBranch;
  const clean = filePath.replace(/^\/+/, "");

  const url =
    `${API}/repos/${owner}/${name}/contents/${clean.split("/").map(encodeURIComponent).join("/")}` +
    `?ref=${encodeURIComponent(branch)}`;

  // The raw media type returns file bytes directly, which sidesteps the 1 MB
  // ceiling the JSON (base64) representation has.
  const res = await request(token, url, { accept: "application/vnd.github.raw" });
  const buffer = Buffer.from(await res.arrayBuffer());

  if (buffer.includes(0)) {
    throw new RepoContextError(`${clean} looks like a binary file (${buffer.length} bytes).`);
  }

  const lines = buffer.toString("utf8").split("\n");
  const from = startLine ? Math.max(1, startLine) : 1;
  const to = endLine ? Math.min(lines.length, endLine) : lines.length;
  let content = lines.slice(from - 1, to).join("\n");

  let truncated = false;
  if (content.length > maxChars) {
    content = content.slice(0, maxChars);
    truncated = true;
  }

  return {
    repo: target.repo,
    ref: branch,
    path: clean,
    lines: lines.length,
    shown: startLine || endLine ? `${from}-${to}` : "all",
    truncated,
    note: truncated
      ? `Output cut at ${maxChars} characters — re-read with startLine/endLine for the rest.`
      : undefined,
    content,
  };
}

interface RawSearchItem {
  path: string;
  text_matches?: Array<{ fragment?: string }>;
}

interface RawSearchResponse {
  total_count: number;
  items?: RawSearchItem[];
}

/**
 * Code search scoped to the repo. GitHub's index, not a grep: it matches whole
 * tokens rather than substrings and skips very large files, so a miss here is
 * not proof the string is absent.
 */
export async function searchCode({
  repo,
  query,
  limit = 20,
}: SearchCodeOptions): Promise<SearchCodeResult> {
  if (!query) throw new RepoContextError("query is required.");
  const token = await tokenOrThrow();
  const target = await resolveTarget(repo);

  const q = `${query} repo:${target.repo}`;
  const data = await gh<RawSearchResponse>(
    token,
    `${API}/search/code?q=${encodeURIComponent(q)}&per_page=${Math.min(limit, 50)}`,
    { accept: "application/vnd.github.text-match+json" },
  );

  return {
    repo: target.repo,
    query,
    totalCount: data.total_count,
    results: (data.items ?? []).map((item) => ({
      path: item.path,
      matches: (item.text_matches ?? []).map((m) => m.fragment?.trim() ?? "").filter(Boolean),
    })),
    note:
      data.total_count === 0
        ? "No matches. GitHub code search matches whole tokens, not substrings — try a shorter term or list_repo_files instead."
        : undefined,
  };
}

/** Branch, languages, top-level layout, and README — a one-call primer. */
export async function overview({ repo }: OverviewOptions = {}): Promise<OverviewResult> {
  const token = await tokenOrThrow();
  const target = await resolveTarget(repo);
  const { owner, name } = splitRepo(target.repo);

  const meta = await repoMeta(target.repo);
  const [languages, root, readme] = await Promise.all([
    gh<Record<string, number>>(token, `${API}/repos/${owner}/${name}/languages`).catch(() => ({})),
    listFiles({ repo: target.repo, ref: meta.defaultBranch }).catch(() => ({
      repo: target.repo,
      ref: meta.defaultBranch,
      path: "/",
      entries: [],
    })),
    request(
      token,
      `${API}/repos/${owner}/${name}/readme?ref=${encodeURIComponent(meta.defaultBranch)}`,
      { accept: "application/vnd.github.raw" },
    )
      .then((r) => r.text())
      .catch(() => null),
  ]);

  return {
    ...meta,
    ref: meta.defaultBranch,
    languages: Object.keys(languages),
    topLevel: root.entries.map((e) => (e.type === "dir" ? `${e.path}/` : e.path)),
    readme: readme ? readme.slice(0, 8000) : null,
  };
}

/* ------------------------------------------------------------------ *
 * Tool Registrations
 * ------------------------------------------------------------------ */

export function registerGitHubTools(server: McpServer): void {
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
      inputSchema: {
        token: z.string().min(1).describe("Personal access token pasted by the user"),
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    guarded(async ({ token }: { token: string }) => {
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
    guarded(async ({ repo }: { repo: string }) => {
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
    guarded(async ({ repo }: { repo?: string }) => text(await overview({ repo }))),
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
    guarded(async (args: { path?: string; recursive?: boolean; ref?: string; repo?: string }) =>
      text(await listFiles(args)),
    ),
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
        startLine: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("First line to return (1-based)."),
        endLine: z.number().int().positive().optional().describe("Last line to return, inclusive."),
        ref: z.string().optional().describe("Branch, tag, or commit; omit for the default branch."),
        repo: z.string().optional().describe('Override the active repo, as "owner/name".'),
      },
    },
    guarded(
      async (args: {
        path: string;
        startLine?: number;
        endLine?: number;
        ref?: string;
        repo?: string;
      }) => text(await readFile(args)),
    ),
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
          .describe(
            'Search terms. GitHub qualifiers work too, e.g. "useAuth path:src extension:ts".',
          ),
        limit: z
          .number()
          .int()
          .positive()
          .max(50)
          .optional()
          .describe("Max files to return (default 20)."),
        repo: z.string().optional().describe('Override the active repo, as "owner/name".'),
      },
    },
    guarded(async (args: { query: string; limit?: number; repo?: string }) =>
      text(await searchCode(args)),
    ),
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
    guarded(async ({ repo }: { repo: string }) => {
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
}
