/**
 * Exercises the GitHub read path against a stub api.github.com.
 *
 * Runs without any real credential: REPO_CONTEXT_TOKEN supplies a fake token
 * (bypassing the keychain entirely) and REPO_CONTEXT_API points every request
 * at this stub. The stub rejects any other token, so a leak would fail loudly.
 *
 *   npx tsx test/api.ts
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "repo-context-test-"));
process.env.REPO_CONTEXT_DATA = dir;
// Explicit stub credential, so the test can never pick up a real token from
// the keychain and send it anywhere — not even to the local stub below.
process.env.REPO_CONTEXT_TOKEN = "stub-token";

const routes: Record<string, unknown> = {
  "/user": { login: "octo" },
  "/repos/octo/app": {
    full_name: "octo/app",
    private: true,
    default_branch: "main",
    description: "The app",
    language: "TypeScript",
    pushed_at: "2026-08-01T00:00:00Z",
    size: 512,
  },
  "/repos/octo/app/languages": { TypeScript: 900, CSS: 100 },
  "/repos/octo/app/contents/": [
    { path: "src", type: "dir" },
    { path: "README.md", type: "file", size: 42 },
  ],
  "/repos/octo/app/git/trees/main": {
    truncated: false,
    tree: [
      { path: "src", type: "tree" },
      { path: "src/index.ts", type: "blob", size: 10 },
      { path: "src/lib/util.ts", type: "blob", size: 20 },
      { path: "README.md", type: "blob", size: 42 },
    ],
  },
  "/search/code": {
    total_count: 1,
    items: [{ path: "src/index.ts", text_matches: [{ fragment: "export const answer = 42" }] }],
  },
  "/user/repos": [
    {
      full_name: "octo/app",
      private: true,
      default_branch: "main",
      description: "The app",
      language: "TypeScript",
      pushed_at: "2026-08-01T00:00:00Z",
    },
    {
      full_name: "octo/site",
      private: false,
      default_branch: "main",
      description: null,
      language: "CSS",
      pushed_at: "2026-07-01T00:00:00Z",
    },
  ],
};

const raw: Record<string, string> = {
  "/repos/octo/app/contents/src/index.ts": "one\ntwo\nthree\nfour\n",
  "/repos/octo/app/readme": "# The app\nDocs.\n",
};

const server = http.createServer((req, res) => {
  if (req.headers.authorization !== "Bearer stub-token") {
    res.writeHead(401, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ message: "stub expected the fake token" }));
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  const key = url.pathname.replace(/\/$/, "") || "/";
  const lookup = routes[url.pathname] ?? routes[key + "/"] ?? routes[key];

  if (raw[key] !== undefined && req.headers.accept?.includes("raw")) {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end(raw[key]);
  }
  if (lookup === undefined) {
    res.writeHead(404, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ message: `no stub for ${key}` }));
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(lookup));
});

await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const address = server.address() as AddressInfo;
process.env.REPO_CONTEXT_API = `http://127.0.0.1:${address.port}`;

// Imported after the env vars are set — the modules read them at load time.
const { listRepos, listFiles, readFile, searchCode, overview, repoMeta } = await import(
  "../src/tools/github.js"
);
const { setActiveRepo, readState } = await import("../src/utils/store.js");

const repos = await listRepos({});
assert.equal(repos.length, 2);
assert.equal(repos[0].fullName, "octo/app");
assert.equal((await listRepos({ query: "site" })).length, 1, "query filters the list");

const meta = await repoMeta("octo/app");
assert.equal(meta.defaultBranch, "main");
await setActiveRepo(meta.fullName, meta.defaultBranch);
assert.equal((await readState()).repo, "octo/app", "selection persists");

const dirListing = await listFiles({});
assert.deepEqual(
  dirListing.entries.map((e) => e.path),
  ["src", "README.md"],
  "dirs sort first",
);
assert.equal(dirListing.ref, "main", "falls back to the stored default branch");

const tree = await listFiles({ recursive: true, path: "src" });
assert.deepEqual(
  tree.entries.map((e) => e.path),
  ["src/index.ts", "src/lib/util.ts"],
  "prefix filter",
);
assert.equal(tree.fileCount, 2);

const capped = await listFiles({ recursive: true, limit: 1 });
assert.equal(capped.entries.length, 1);
assert.ok(capped.truncated && capped.note?.includes("Narrow"), "truncation is reported");

const whole = await readFile({ path: "src/index.ts" });
assert.equal(whole.lines, 5);
assert.equal(whole.content, "one\ntwo\nthree\nfour\n");

const slice = await readFile({ path: "src/index.ts", startLine: 2, endLine: 3 });
assert.equal(slice.content, "two\nthree");
assert.equal(slice.shown, "2-3");

const clipped = await readFile({ path: "src/index.ts", maxChars: 5 });
assert.ok(clipped.truncated && clipped.content.length === 5, "maxChars clips");

const hits = await searchCode({ query: "answer" });
assert.equal(hits.totalCount, 1);
assert.deepEqual(hits.results[0].matches, ["export const answer = 42"]);

const primer = await overview({});
assert.deepEqual(primer.languages, ["TypeScript", "CSS"]);
assert.deepEqual(primer.topLevel, ["src/", "README.md"]);
assert.ok(primer.readme?.startsWith("# The app"));

await assert.rejects(
  () => readFile({ path: "nope.ts" }),
  /GitHub error: 404/,
  "404s surface readably",
);
await assert.rejects(
  () => listFiles({ repo: "not-a-repo" }),
  /owner\/name/,
  "repo form is validated",
);

server.close();
await fs.rm(dir, { recursive: true, force: true });
console.log("api tests passed");
