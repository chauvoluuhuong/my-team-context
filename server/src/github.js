/**
 * GitHub REST calls behind every tool in this extension.
 *
 * Everything here is read-only against api.github.com. The token is fetched
 * from the keychain per call rather than cached in a module variable, so a
 * sign-out takes effect immediately and a long-lived server never holds the
 * credential in memory between requests.
 */

import { readToken, readState } from "./store.js";

const API = process.env.REPO_CONTEXT_API || "https://api.github.com";
const UA = "claude-repo-context";

/** Failures the user can act on — surfaced as tool errors, not stack traces. */
export class RepoContextError extends Error {}

const NOT_SIGNED_IN =
  "Not signed in to GitHub yet. Call connect_github_repo to open the sign-in panel " +
  "so the user can paste a personal access token.";

const NO_REPO =
  "No active repo selected yet. Call connect_github_repo to open the panel and let " +
  "the user pick one, or set_active_repo if they already named it.";

async function tokenOrThrow() {
  const token = await readToken();
  if (!token) throw new RepoContextError(NOT_SIGNED_IN);
  return token;
}

/** Raw request. Callers decide how to read the body. */
async function request(token, url, { accept = "application/vnd.github+json" } = {}) {
  let res;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: accept, "User-Agent": UA },
    });
  } catch (err) {
    throw new RepoContextError(`Could not reach GitHub: ${err.message}`);
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
      const body = await res.json();
      if (body.message) detail += `: ${body.message}`;
    } catch {
      // Body wasn't JSON — the status line is all we get.
    }
    throw new RepoContextError(`GitHub error: ${detail}`);
  }
  return res;
}

async function gh(token, url, options) {
  return (await request(token, url, options)).json();
}

/* ------------------------------------------------------------------ *
 * Identity
 * ------------------------------------------------------------------ */

/**
 * Confirm a token works and identify whose it is, without storing it.
 * @returns {Promise<{valid: boolean, login?: string, reason?: string}>}
 */
export async function validateToken(token) {
  let res;
  try {
    res = await fetch(`${API}/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": UA,
      },
    });
  } catch (err) {
    return { valid: false, reason: `Could not reach GitHub: ${err.message}` };
  }

  if (res.status === 401) {
    return {
      valid: false,
      reason:
        "GitHub rejected that token — check it was pasted in full and hasn't expired or been revoked.",
    };
  }
  if (!res.ok) return { valid: false, reason: `GitHub returned ${res.status} ${res.statusText}.` };

  const user = await res.json();
  return { valid: true, login: user.login };
}

/** @returns {Promise<{authenticated: boolean, login?: string, reason?: string}>} */
export async function whoami() {
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

/**
 * Repos the signed-in token can see, most recently pushed first. A classic PAT
 * sees everything the account can reach; a fine-grained PAT only what it was
 * granted — which is why an unexpectedly short list is a token-scope problem,
 * not a bug.
 */
export async function listRepos({ query, limit = 200 } = {}) {
  const token = await tokenOrThrow();
  const perPage = 100;
  const repos = [];

  for (let page = 1; repos.length < limit; page += 1) {
    const batch = await gh(
      token,
      `${API}/user/repos?per_page=${perPage}&page=${page}&sort=pushed` +
        `&affiliation=owner,collaborator,organization_member`,
    );
    repos.push(...batch);
    if (batch.length < perPage) break;
  }

  const mapped = repos.slice(0, limit).map((r) => ({
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

function splitRepo(repo) {
  const [owner, name, ...rest] = String(repo).split("/");
  if (!owner || !name || rest.length) {
    throw new RepoContextError(`repo must be in "owner/name" form, got "${repo}".`);
  }
  return { owner, name };
}

/** Confirm a repo exists and is readable with this token; returns its metadata. */
export async function repoMeta(repo) {
  const token = await tokenOrThrow();
  const { owner, name } = splitRepo(repo);
  const data = await gh(token, `${API}/repos/${owner}/${name}`);
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
async function resolveTarget(repoOverride) {
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

/**
 * List one directory (default) or the whole tree under a path (`recursive`).
 *
 * The recursive path uses the git trees API — one request for the entire repo
 * instead of one per directory, which is what makes "show me the layout" cheap
 * on a large codebase.
 */
export async function listFiles({ repo, path: dirPath = "", ref, recursive = false, limit = 400 }) {
  const token = await tokenOrThrow();
  const target = await resolveTarget(repo);
  const { owner, name } = splitRepo(target.repo);
  const branch = ref || target.ref || (await repoMeta(target.repo)).defaultBranch;
  const clean = dirPath.replace(/^\/+|\/+$/g, "");

  if (!recursive) {
    const url =
      `${API}/repos/${owner}/${name}/contents/${clean.split("/").map(encodeURIComponent).join("/")}` +
      `?ref=${encodeURIComponent(branch)}`;
    const entries = await gh(token, url);

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

  const tree = await gh(
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
export async function readFile({ repo, path: filePath, ref, startLine, endLine, maxChars = MAX_CHARS }) {
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

/**
 * Code search scoped to the repo. GitHub's index, not a grep: it matches whole
 * tokens rather than substrings and skips very large files, so a miss here is
 * not proof the string is absent.
 */
export async function searchCode({ repo, query, limit = 20 }) {
  if (!query) throw new RepoContextError("query is required.");
  const token = await tokenOrThrow();
  const target = await resolveTarget(repo);

  const q = `${query} repo:${target.repo}`;
  const data = await gh(
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
      matches: (item.text_matches ?? []).map((m) => m.fragment?.trim()).filter(Boolean),
    })),
    note: data.total_count === 0 ? "No matches. GitHub code search matches whole tokens, not substrings — try a shorter term or list_repo_files instead." : undefined,
  };
}

/** Branch, languages, top-level layout, and README — a one-call primer. */
export async function overview({ repo } = {}) {
  const token = await tokenOrThrow();
  const target = await resolveTarget(repo);
  const { owner, name } = splitRepo(target.repo);

  const meta = await repoMeta(target.repo);
  const [languages, root, readme] = await Promise.all([
    gh(token, `${API}/repos/${owner}/${name}/languages`).catch(() => ({})),
    listFiles({ repo: target.repo, ref: meta.defaultBranch }).catch(() => ({ entries: [] })),
    request(token, `${API}/repos/${owner}/${name}/readme?ref=${encodeURIComponent(meta.defaultBranch)}`, {
      accept: "application/vnd.github.raw",
    })
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
