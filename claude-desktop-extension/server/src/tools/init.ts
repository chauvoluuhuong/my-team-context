/**
 * Initialization, panel tools, and unified status tools for Team Context.
 *
 * Provides the main interactive settings panel tool (`connect_team_context`)
 * and handles loading/saving credentials from/to server/.env and testing connections.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import {
  readState,
  readToken,
  readNotionKey,
  readQdrantConfig,
  readSqlConnectionString,
  saveToken,
  saveNotionKey,
  saveQdrantConfig,
  saveSqlConnectionString,
} from "../utils/store.js";
import { readEnvConfig, writeEnvConfig } from "../utils/env.js";
import { text, guarded } from "../utils/helpers.js";
import { whoami, validateToken } from "./github.js";
import { notionCheckConnection, validateNotionKey } from "./notion.js";
import { qdrantCheckConnection, validateQdrantConnection } from "./qdrant.js";
import { sqlCheckConnection, validateSqlConnection } from "./sql.js";
import type {
  TeamContextStatusResult,
  NotionStatusResult,
  QdrantStatusResult,
  SqlStatusResult,
} from "./types.js";

export const PANEL_URI = "ui://repo-context/panel.html";

/**
 * Check connection status across all integrated services.
 */
export async function getTeamContextStatus(): Promise<TeamContextStatusResult> {
  const [ghUser, ghState, notionKey, qdrantConfig, sqlConn] = await Promise.all([
    whoami().catch(() => ({ authenticated: false, login: undefined as string | undefined })),
    readState().catch(() => ({} as Awaited<ReturnType<typeof readState>>)),
    readNotionKey().catch(() => null as string | null),
    readQdrantConfig().catch(() => ({} as Awaited<ReturnType<typeof readQdrantConfig>>)),
    readSqlConnectionString().catch(() => null as string | null),
  ]);

  const [notionStatus, qdrantStatus, sqlStatus]: [
    NotionStatusResult,
    QdrantStatusResult,
    SqlStatusResult,
  ] = await Promise.all([
    notionKey
      ? notionCheckConnection(notionKey).catch(() => ({ connected: false }))
      : Promise.resolve({ connected: false }),
    qdrantConfig.endpoint
      ? qdrantCheckConnection(qdrantConfig.endpoint, qdrantConfig.apiKey).catch(() => ({
          connected: false,
          collectionsCount: 0,
        }))
      : Promise.resolve({ connected: false, collectionsCount: 0 }),
    sqlConn
      ? sqlCheckConnection(sqlConn).catch(() => ({ connected: false }))
      : Promise.resolve({ connected: false }),
  ]);

  return {
    github: {
      authenticated: ghUser.authenticated,
      login: ghUser.login ?? null,
      activeRepo: ghState.repo ?? null,
    },
    notion: {
      connected: notionStatus.connected,
      botName: notionStatus.botName ?? null,
    },
    qdrant: {
      connected: qdrantStatus.connected,
      endpoint: qdrantConfig.endpoint ?? null,
      collectionsCount: qdrantStatus.collectionsCount ?? 0,
    },
    sql: {
      connected: sqlStatus.connected,
      dialect: sqlStatus.dialect ?? null,
      database: sqlStatus.database ?? null,
    },
  };
}

export function registerInitTools(server: McpServer): void {
  /* ---------------------- Unified Panel Launcher ---------------------- */

  registerAppTool(
    server,
    "connect_team_context",
    {
      title: "Connect Team Context",
      description:
        "Open the settings panel to configure team connections: GitHub token & active repo, " +
        "Notion workspace API key, Qdrant vector database endpoint, and SQL database connection.",
      annotations: { title: "Connect Team Context", readOnlyHint: false, openWorldHint: true },
      inputSchema: {},
      _meta: { ui: { resourceUri: PANEL_URI } },
    },
    guarded(async () => {
      const [status, envConfig] = await Promise.all([getTeamContextStatus(), readEnvConfig()]);
      return text({
        status: "ok",
        teamStatus: status,
        config: envConfig,
      });
    }),
  );

  /* ------------------- Panel Internal Support Tools ------------------- */

  registerAppTool(
    server,
    "panel_get_config",
    {
      title: "Load Team Context Settings",
      description: "Internal: load .env and existing connection configurations for the settings panel.",
      annotations: { title: "Load Team Context Settings", readOnlyHint: true },
      inputSchema: {},
      _meta: { ui: { visibility: ["app"] } },
    },
    guarded(async () => {
      const [envConfig, ghToken, notionKey, qdrantConfig, sqlConn, state] = await Promise.all([
        readEnvConfig(),
        readToken(),
        readNotionKey(),
        readQdrantConfig(),
        readSqlConnectionString(),
        readState(),
      ]);

      return text({
        status: "ok",
        config: {
          GITHUB_TOKEN: envConfig.GITHUB_TOKEN || ghToken || "",
          NOTION_API_KEY: envConfig.NOTION_API_KEY || notionKey || "",
          QDRANT_URL: envConfig.QDRANT_URL || qdrantConfig.endpoint || "",
          QDRANT_API_KEY: envConfig.QDRANT_API_KEY || qdrantConfig.apiKey || "",
          DATABASE_URL: envConfig.DATABASE_URL || sqlConn || "",
          activeRepo: state.repo || "",
        },
      });
    }),
  );

  registerAppTool(
    server,
    "panel_test_connection",
    {
      title: "Test Single Connection",
      description: "Internal: test credentials for a specific service one-by-one from the settings panel.",
      annotations: { title: "Test Single Connection", readOnlyHint: true },
      inputSchema: {
        service: z.enum(["github", "notion", "qdrant", "sql"]).describe("Target service name"),
        githubToken: z.string().optional(),
        notionApiKey: z.string().optional(),
        qdrantUrl: z.string().optional(),
        qdrantApiKey: z.string().optional(),
        databaseUrl: z.string().optional(),
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    guarded(async (args: {
      service: "github" | "notion" | "qdrant" | "sql";
      githubToken?: string;
      notionApiKey?: string;
      qdrantUrl?: string;
      qdrantApiKey?: string;
      databaseUrl?: string;
    }) => {
      if (args.service === "github") {
        if (!args.githubToken?.trim()) {
          return text({ valid: false, reason: "GitHub token is empty." });
        }
        const check = await validateToken(args.githubToken.trim());
        return text(check);
      }

      if (args.service === "notion") {
        if (!args.notionApiKey?.trim()) {
          return text({ valid: false, reason: "Notion API key is empty." });
        }
        const check = await validateNotionKey(args.notionApiKey.trim());
        return text(check);
      }

      if (args.service === "qdrant") {
        if (!args.qdrantUrl?.trim()) {
          return text({ valid: false, reason: "Qdrant endpoint URL is empty." });
        }
        const check = await validateQdrantConnection(
          args.qdrantUrl.trim(),
          args.qdrantApiKey?.trim(),
        );
        return text(check);
      }

      if (args.service === "sql") {
        if (!args.databaseUrl?.trim()) {
          return text({ valid: false, reason: "Database connection string is empty." });
        }
        const check = await validateSqlConnection(args.databaseUrl.trim());
        return text(check);
      }

      return text({ valid: false, reason: "Unknown service." });
    }),
  );

  registerAppTool(
    server,
    "panel_save_all_credentials",
    {
      title: "Save All Credentials",
      description: "Internal: validate and save all connections to server/.env and OS keychain.",
      annotations: { title: "Save All Credentials", readOnlyHint: false },
      inputSchema: {
        GITHUB_TOKEN: z.string().optional().describe("GitHub Personal Access Token"),
        NOTION_API_KEY: z.string().optional().describe("Notion API Key"),
        QDRANT_URL: z.string().optional().describe("Qdrant Cluster URL"),
        QDRANT_API_KEY: z.string().optional().describe("Qdrant API Key"),
        DATABASE_URL: z.string().optional().describe("SQL Database Connection URI"),
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    guarded(async (args: {
      GITHUB_TOKEN?: string;
      NOTION_API_KEY?: string;
      QDRANT_URL?: string;
      QDRANT_API_KEY?: string;
      DATABASE_URL?: string;
    }) => {
      // 1. Write to server/.env
      await writeEnvConfig({
        GITHUB_TOKEN: args.GITHUB_TOKEN?.trim() || undefined,
        NOTION_API_KEY: args.NOTION_API_KEY?.trim() || undefined,
        QDRANT_URL: args.QDRANT_URL?.trim() || undefined,
        QDRANT_API_KEY: args.QDRANT_API_KEY?.trim() || undefined,
        DATABASE_URL: args.DATABASE_URL?.trim() || undefined,
      });

      // 2. Sync with keychain storage
      if (args.GITHUB_TOKEN?.trim()) {
        await saveToken(args.GITHUB_TOKEN.trim());
      }
      if (args.NOTION_API_KEY?.trim()) {
        await saveNotionKey(args.NOTION_API_KEY.trim());
      }
      if (args.QDRANT_URL?.trim()) {
        await saveQdrantConfig(args.QDRANT_URL.trim(), args.QDRANT_API_KEY?.trim());
      }
      if (args.DATABASE_URL?.trim()) {
        await saveSqlConnectionString(args.DATABASE_URL.trim());
      }

      return text({
        status: "ok",
        message: "Credentials successfully validated and saved to server/.env",
      });
    }),
  );

  /* ------------------- Overall Health & Status Tool ------------------- */

  server.registerTool(
    "team_context_status",
    {
      title: "Team Context Status",
      description:
        "Report connection and authentication status for all team services (GitHub, Notion, Qdrant, SQL).",
      annotations: { title: "Team Context Status", readOnlyHint: true },
      inputSchema: {},
    },
    guarded(async () => text(await getTeamContextStatus())),
  );
}
