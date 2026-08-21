/**
 * End-to-end check that the extension's MCP server starts, advertises its
 * tools, renders the panel with the ext-apps bundle inlined, and fails
 * readably when nothing is connected yet.
 *
 * Uses a throwaway data directory and no credential, so it never touches a
 * real token or reaches github.com.
 *
 *   node test/smoke.mjs
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "repo-context-smoke-"));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(here, "..", "src", "index.js")],
  env: { ...process.env, REPO_CONTEXT_DATA: dir, REPO_CONTEXT_TOKEN: "" },
});
const client = new Client({ name: "smoke", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);

const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));

const { resources } = await client.listResources();
console.log("resources:", resources.map((r) => r.uri).join(", "));

const panel = await client.readResource({ uri: "ui://repo-context/panel.html" });
const html = panel.contents[0].text;
console.log(
  "panel:",
  `${Math.round(html.length / 1024)} KB`,
  "| bundle inlined:", !html.includes("/*__EXT_APPS_BUNDLE__*/"),
  "| ExtApps global:", html.includes("globalThis.ExtApps="),
);

for (const [name, args] of [
  ["github_repo_status", {}],
  ["list_repo_files", { path: "src" }],
  ["read_repo_file", { path: "README.md" }],
]) {
  const res = await client.callTool({ name, arguments: args });
  console.log(`\n${name} → isError=${res.isError ?? false}\n  ${res.content[0].text.slice(0, 200)}`);
}

await client.close();
await fs.rm(dir, { recursive: true, force: true });
