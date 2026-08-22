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
import { buildPanel } from "./utils/helpers.js";
import { registerGitHubTools, PANEL_URI } from "./tools/github.js";

const server = new McpServer({ name: "innostaas-repo-context", version: "0.1.0" });

registerAppResource(server, "GitHub repo picker", PANEL_URI, {}, async () => ({
  contents: [{ uri: PANEL_URI, mimeType: RESOURCE_MIME_TYPE, text: buildPanel() }],
}));

registerGitHubTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("repo-context MCP server ready\n");
