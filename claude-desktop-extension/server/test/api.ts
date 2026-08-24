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
process.env.REPO_CONTEXT_BACKEND = "file";
process.env.ENV_FILE_PATH = path.join(dir, ".env");
// Explicit stub credential, so the test can never pick up a real token from
// the keychain and send it anywhere — not even to the local stub below.
process.env.REPO_CONTEXT_TOKEN = "stub-token";
delete process.env.NOTION_API_KEY;
delete process.env.QDRANT_URL;
delete process.env.QDRANT_API_KEY;
delete process.env.DATABASE_URL;
delete process.env.GEMINI_API_KEY;


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
const { listRepos, listFiles, readFile, searchCode, overview, repoMeta, resolveActiveRepos } = await import(
  "../src/tools/github.js"
);
const { setActiveRepo, readState } = await import("../src/utils/store.js");

const resolvedOverride = await resolveActiveRepos("octo/site");
assert.deepEqual(resolvedOverride, ["octo/site"], "explicit repo override resolved");

const repos = await listRepos({});
assert.equal(repos.length, 2);
assert.equal(repos[0].fullName, "octo/app");
assert.equal((await listRepos({ query: "site" })).length, 1, "query filters the list");

const meta = await repoMeta("octo/app");
assert.equal(meta.defaultBranch, "main");
await setActiveRepo(meta.fullName, meta.defaultBranch);
assert.equal((await readState()).repo, "octo/app", "selection persists");

const dirListings = await listFiles({});
assert.ok(Array.isArray(dirListings));
assert.equal(dirListings[0].repo, "octo/app");
assert.deepEqual(
  dirListings[0].entries.map((e) => e.path),
  ["src", "README.md"],
  "dirs sort first",
);
assert.equal(dirListings[0].ref, "main", "falls back to the stored default branch");

const trees = await listFiles({ recursive: true, path: "src" });
assert.ok(Array.isArray(trees));
assert.deepEqual(
  trees[0].entries.map((e) => e.path),
  ["src/index.ts", "src/lib/util.ts"],
  "prefix filter",
);
assert.equal(trees[0].fileCount, 2);

const capped = await listFiles({ recursive: true, limit: 1 });
assert.ok(Array.isArray(capped));
assert.equal(capped[0].entries.length, 1);
assert.ok(capped[0].truncated && capped[0].note?.includes("Narrow"), "truncation is reported");

const whole = await readFile({ path: "src/index.ts" });
assert.ok(Array.isArray(whole));
assert.equal(whole[0].lines, 5);
assert.equal(whole[0].content, "one\ntwo\nthree\nfour\n");

const slice = await readFile({ path: "src/index.ts", startLine: 2, endLine: 3 });
assert.ok(Array.isArray(slice));
assert.equal(slice[0].content, "two\nthree");
assert.equal(slice[0].shown, "2-3");

const clipped = await readFile({ path: "src/index.ts", maxChars: 5 });
assert.ok(Array.isArray(clipped));
assert.ok(clipped[0].truncated && clipped[0].content?.length === 5, "maxChars clips");

const hits = await searchCode({ query: "answer" });
assert.ok(Array.isArray(hits), "searchCode returns an array of repo search results");
assert.equal(hits.length, 1);
assert.equal(hits[0].repo, "octo/app");
assert.equal(hits[0].totalCount, 1);
assert.deepEqual(hits[0].results[0].matches, ["export const answer = 42"]);

// Explicit repo override test
const explicitHits = await searchCode({ repo: "octo/app", query: "answer" });
assert.ok(Array.isArray(explicitHits));
assert.equal(explicitHits.length, 1);
assert.equal(explicitHits[0].repo, "octo/app");
assert.equal(explicitHits[0].totalCount, 1);

const primers = await overview({});
assert.ok(Array.isArray(primers));
assert.equal(primers[0].repo, "octo/app");
assert.deepEqual(primers[0].languages, ["TypeScript", "CSS"]);
assert.deepEqual(primers[0].topLevel, ["src/", "README.md"]);
assert.ok(primers[0].readme?.startsWith("# The app"));

const missingRead = await readFile({ path: "nope.ts" });
assert.ok(
  missingRead[0].error?.includes("404") || missingRead[0].note?.includes("404"),
  "404s surface in result object",
);
await assert.rejects(
  () => listFiles({ repo: "not-a-repo" }),
  /owner\/name/,
  "repo form is validated",
);

// Notion validation tests
const {
  validateNotionKey,
  notionCheckConnection,
  richTextToMarkdown,
  extractPageTitle,
  extractPageIcon,
} = await import("../src/tools/notion.js");
assert.equal((await validateNotionKey("")).valid, false, "empty Notion key fails");
assert.equal((await notionCheckConnection()).connected, false, "unconfigured Notion reports disconnected");

// Notion rich text to markdown formatting tests
const richTextSample = [
  { plain_text: "Hello ", annotations: {} },
  { plain_text: "World", annotations: { bold: true } },
  { plain_text: "!", annotations: { italic: true } },
  { plain_text: " Click here", href: "https://notion.so", annotations: {} },
];
assert.equal(
  richTextToMarkdown(richTextSample),
  "Hello **World***!*[ Click here](https://notion.so)",
  "richTextToMarkdown converts formatted Notion rich text",
);

assert.equal(
  extractPageTitle({ properties: { title: { type: "title", title: [{ plain_text: "My Notion Page" }] } } }),
  "My Notion Page",
  "extractPageTitle extracts title properly",
);
assert.equal(
  extractPageIcon({ icon: { type: "emoji", emoji: "🎯" } }),
  "🎯",
  "extractPageIcon extracts emoji icon",
);

const { getNotionSkillPointId, formatNotionSkillName } = await import(
  "../src/services/vector-db.js"
);
const notionPointId1 = getNotionSkillPointId("c1f7b889-1234-5678-9abc-def012345678");
const notionPointId2 = getNotionSkillPointId("C1F7B889-1234-5678-9ABC-DEF012345678");
assert.equal(notionPointId1, notionPointId2, "notion point ID is case-insensitive deterministic UUID");
assert.match(
  notionPointId1,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  "notion point ID matches UUID format",
);
assert.equal(formatNotionSkillName("Architecture Overview"), "[notion: Architecture Overview]");

// Qdrant validation tests
const { validateQdrantConnection, qdrantCheckConnection } = await import(
  "../src/services/vector-db.js"
);
assert.equal((await validateQdrantConnection("")).valid, false, "empty Qdrant endpoint fails");
assert.equal((await qdrantCheckConnection()).connected, false, "unconfigured Qdrant reports disconnected");

// Serialization tests
const { serializeSkillDocument, serializeDocument } = await import(
  "../src/utils/serializer.js"
);
const serializedSkill = serializeSkillDocument({
  name: "db-migration",
  description: "How to run db migrations",
  content: "Run npm run migrate",
});
assert.equal(
  serializedSkill,
  "#name: db-migration\n\n#description: How to run db migrations\n\n#content: Run npm run migrate",
  "serializeSkillDocument produces #{fieldName}: {fieldValue}\\n\\n format",
);

const genericSerialized = serializeDocument({
  name: "auth",
  description: "Auth setup",
  content: "Use JWT tokens",
});
assert.equal(
  genericSerialized,
  "#name: auth\n\n#description: Auth setup\n\n#content: Use JWT tokens",
  "serializeDocument formats custom fields with #{k}: {v}\\n\\n",
);

// Gemini validation tests
const { validateGeminiKey, geminiCheckConnection } = await import(
  "../src/services/embedding.js"
);
assert.equal((await validateGeminiKey("")).valid, false, "empty Gemini key fails");
assert.equal((await geminiCheckConnection()).connected, false, "unconfigured Gemini reports disconnected");

// SQL validation tests
const { validateSqlConnection, sqlCheckConnection } = await import(
  "../src/tools/sql.js"
);
const sqliteCheck = await validateSqlConnection("sqlite:///tmp/test.db");
assert.equal(sqliteCheck.valid, true, "sqlite valid");
assert.equal(sqliteCheck.dialect, "sqlite");

// Team Context aggregate status test
const { getTeamContextStatus, getAuthState, setSessionUser, getSessionUser } = await import("../src/tools/init.js");
const aggregateStatus = await getTeamContextStatus();
assert.equal(aggregateStatus.github.authenticated, true);
assert.equal(aggregateStatus.github.login, "octo");
assert.equal(aggregateStatus.github.activeRepo, "octo/app");
assert.equal(aggregateStatus.notion.connected, false);
assert.equal(aggregateStatus.qdrant.connected, false);
assert.equal(aggregateStatus.sql.connected, false);
assert.equal(aggregateStatus.gemini.connected, false);

// Auth state and session tests
const { readEnvConfig, writeEnvConfig } = await import("../src/utils/env.js");
const initialAuth = await getAuthState();
assert.equal(initialAuth.isAuthenticated, false, "initially not authenticated");

setSessionUser("testadmin");
assert.equal(getSessionUser(), "testadmin");
const sessionAuth = await getAuthState();
assert.equal(sessionAuth.isAuthenticated, true);
assert.equal(sessionAuth.username, "testadmin");

setSessionUser(null);
assert.equal(getSessionUser(), null);

// User point ID and team users tests
const { getUserPointId } = await import("../src/services/vector-db.js");
const userPointId1 = getUserPointId("Huong");
const userPointId2 = getUserPointId("huong");
assert.equal(userPointId1, userPointId2, "user point ID is deterministic and case-insensitive");
assert.match(
  userPointId1,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  "user point ID matches UUID format",
);

// Centralized checkTeamContextSetup test
const { checkTeamContextSetup } = await import("../src/tools/init.js");
const initialSetup = await checkTeamContextSetup();
assert.equal(initialSetup.isSetupComplete, false, "setup is not complete when qdrant is not configured");
assert.equal(initialSetup.step, "qdrant_config");

// Test user profile in env
await writeEnvConfig({
  CURRENT_USER_NAME: "huong",
  CURRENT_USER_ROLE: "Full Stack Engineer",
});
const envWithUser = await readEnvConfig();
assert.equal(envWithUser.CURRENT_USER_NAME, "huong");
assert.equal(envWithUser.CURRENT_USER_ROLE, "Full Stack Engineer");

// Panel & Skills Component Builder tests
const { buildPanel, buildSkillsPanel, buildTeamContextSystemPrompt, getDefaultSystemPrompt } = await import("../src/utils/helpers.js");
const panelHtml = buildPanel("config");
assert.ok(panelHtml.includes("SkillsComponent"), "buildPanel injects reusable SkillsComponent");
assert.ok(panelHtml.includes("ExtApps"), "buildPanel inlines ExtApps bundle");
assert.ok(panelHtml.includes("buildDefaultSystemPrompt"), "buildPanel includes buildDefaultSystemPrompt");

const skillsPanelHtml = buildSkillsPanel();
assert.ok(skillsPanelHtml.includes("SkillsComponent"), "buildSkillsPanel injects reusable SkillsComponent");
assert.ok(skillsPanelHtml.includes("TeamSkillsManagement"), "buildSkillsPanel inlines standalone skills app");

// Test buildTeamContextSystemPrompt
const generatedPrompt = buildTeamContextSystemPrompt({
  userName: "Alice",
  userRole: "Staff Engineer",
  activeRepos: [{ name: "my-org/core-api", description: "Core backend" }],
  activeNotionPages: [{ id: "p-1", title: "Architecture RFC" }],
});
assert.ok(generatedPrompt.includes("Current User: Alice (Staff Engineer)"));
assert.ok(generatedPrompt.includes("Active Repositories: my-org/core-api"));
assert.ok(generatedPrompt.includes("Notion Workspace: All workspace documentation accessible"));
assert.ok(generatedPrompt.includes("SQL Database Querying: Use `sql_get_schema` and `sql_execute_query`"));
assert.ok(generatedPrompt.includes("Always ask for explicit user approval before executing any actions that edit or modify data"));
assert.ok(generatedPrompt.includes("my-team-context-mcp-server"));
assert.equal(getDefaultSystemPrompt({ userName: "Alice" }), buildTeamContextSystemPrompt({ userName: "Alice" }));

// SQL Tools Tests (SQLite file/memory test)
const testDbPath = path.join(dir, "test.sqlite");
const sqliteMod = await import("node:sqlite");
const testDb = new sqliteMod.DatabaseSync(testDbPath);
testDb.exec(`
  CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, email TEXT);
  INSERT INTO users (username, email) VALUES ('alice', 'alice@team.com'), ('bob', 'bob@team.com');
  CREATE TABLE posts (id INTEGER PRIMARY KEY, user_id INTEGER, title TEXT, content TEXT);
`);
testDb.close();

// Test sqlCheckConnection and validateSqlConnection with SQLite
const sqliteValidation = await validateSqlConnection(`sqlite://${testDbPath}`);
assert.equal(sqliteValidation.valid, true);
assert.equal(sqliteValidation.dialect, "sqlite");

server.close();
await fs.rm(dir, { recursive: true, force: true });
console.log("api tests passed");




