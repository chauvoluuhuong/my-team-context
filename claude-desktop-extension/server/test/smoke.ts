/**
 * End-to-end check that the extension's MCP server starts, advertises its
 * tools, renders the panel with the ext-apps bundle inlined, and fails
 * readably when nothing is connected yet.
 *
 * Uses a throwaway data directory and no credential, so it never touches a
 * real token or reaches github.com.
 *
 *   npx tsx test/smoke.ts
 */

import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "repo-context-smoke-"));

const distEntry = path.join(here, "..", "dist", "index.js");
const srcEntry = path.join(here, "..", "src", "index.ts");

const command = existsSync(distEntry) ? process.execPath : "npx";
const args = existsSync(distEntry) ? [distEntry] : ["tsx", srcEntry];

const transport = new StdioClientTransport({
  command,
  args,
  env: { ...process.env, REPO_CONTEXT_DATA: dir, REPO_CONTEXT_TOKEN: "" },
});
const client = new Client({ name: "smoke", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);

const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));

const { resources } = await client.listResources();
console.log("resources:", resources.map((r) => r.uri).join(", "));

const panel = await client.readResource({ uri: "ui://repo-context/panel.html" });
const content = panel.contents[0] as { text?: string };
const html = content.text ?? "";
console.log(
  "panel:",
  `${Math.round(html.length / 1024)} KB`,
  "| bundle inlined:",
  !html.includes("/*__EXT_APPS_BUNDLE__*/"),
  "| ExtApps global:",
  html.includes("globalThis.ExtApps="),
);

for (const [name, toolArgs] of [
  ["github_repo_status", {}],
  ["list_repo_files", { path: "src" }],
  ["read_repo_file", { path: "README.md" }],
] as const) {
  const res = (await client.callTool({ name, arguments: toolArgs })) as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
  console.log(
    `\n${name} → isError=${res.isError ?? false}\n  ${res.content[0].text.slice(0, 200)}`,
  );
}

await client.close();
await fs.rm(dir, { recursive: true, force: true });
