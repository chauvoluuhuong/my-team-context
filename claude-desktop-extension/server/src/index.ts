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
import { buildPanel } from "./utils/helpers.js";

loadEnv();
import {
  registerInitTools,
  registerGitHubTools,
  registerNotionTools,
  registerSqlTools,
  PANEL_URI,
} from "./tools/index.js";

const server = new McpServer({ name: "my-team-context", version: "0.1.0" });

registerAppResource(server, "Team Context Settings", PANEL_URI, {}, async () => ({
  contents: [{ uri: PANEL_URI, mimeType: RESOURCE_MIME_TYPE, text: buildPanel() }],
}));

registerInitTools(server);
registerGitHubTools(server);
registerNotionTools(server);
registerSqlTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("repo-context MCP server ready\n");
