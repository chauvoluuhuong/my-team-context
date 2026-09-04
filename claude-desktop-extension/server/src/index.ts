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

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { loadEnv } from "./utils/env.js";
import { buildPanel, buildSkillsPanel, buildConfigPanel } from "./utils/helpers.js";

// stdout is reserved for JSON-RPC transport. Redirect console.log to stderr.
console.log = (...args: any[]) => console.error(...args);

loadEnv();

import {
  registerInitTools,
  registerGitHubTools,
  registerNotionTools,
  registerSqlTools,
  registerSkillsTools,
  registerConfigTools,
  PANEL_URI,
  SKILLS_URI,
  CONFIG_URI,
} from "./tools/index.js";

const server = new McpServer({ name: "automate-work", version: "0.1.0" });

registerAppResource(server, "Team Context Settings", PANEL_URI, {}, async () => ({
  contents: [{ uri: PANEL_URI, mimeType: RESOURCE_MIME_TYPE, text: buildPanel() }],
}));

registerAppResource(server, "Team Skills Management", SKILLS_URI, {}, async () => ({
  contents: [{ uri: SKILLS_URI, mimeType: RESOURCE_MIME_TYPE, text: buildSkillsPanel() }],
}));

registerAppResource(server, "Application Configuration", CONFIG_URI, {}, async () => ({
  contents: [{ uri: CONFIG_URI, mimeType: RESOURCE_MIME_TYPE, text: buildConfigPanel() }],
}));

registerInitTools(server);
registerGitHubTools(server);
registerNotionTools(server);
registerSqlTools(server);
registerSkillsTools(server);
registerConfigTools(server);


const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("automate-work MCP server ready\n");
