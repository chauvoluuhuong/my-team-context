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
  readGeminiKey,
  saveToken,
  saveNotionKey,
  saveQdrantConfig,
  saveSqlConnectionString,
  saveGeminiKey,
} from "../utils/store.js";
import { readEnvConfig, writeEnvConfig } from "../utils/env.js";
import { text, guarded } from "../utils/helpers.js";
import { whoami, validateToken } from "./github.js";
import { notionCheckConnection, validateNotionKey } from "./notion.js";
import { qdrantCheckConnection, validateQdrantConnection } from "../services/vector-db.js";
import { sqlCheckConnection, validateSqlConnection } from "./sql.js";
import { validateGeminiKey, geminiCheckConnection } from "../services/embedding.js";
import type {
  TeamContextStatusResult,
  NotionStatusResult,
  QdrantStatusResult,
  SqlStatusResult,
  GeminiStatusResult,
} from "./types.js";

export const PANEL_URI = "ui://repo-context/panel.html";

let currentSessionUser: string | null = null;

export function getSessionUser(): string | null {
  return currentSessionUser;
}

export function setSessionUser(user: string | null): void {
  currentSessionUser = user;
}

export async function getAuthState() {
  const env = await readEnvConfig();
  const hasAccount = Boolean(env.AUTH_USERNAME && env.AUTH_PASSWORD);
  return {
    hasAccount,
    isAuthenticated: Boolean(currentSessionUser),
    username: currentSessionUser,
  };
}


/**
 * Check connection status across all integrated services.
 */
export async function getTeamContextStatus(): Promise<TeamContextStatusResult> {
  const [ghUser, ghState, notionKey, qdrantConfig, sqlConn, geminiKey] = await Promise.all([
    whoami().catch(() => ({ authenticated: false, login: undefined as string | undefined })),
    readState().catch(() => ({} as Awaited<ReturnType<typeof readState>>)),
    readNotionKey().catch(() => null as string | null),
    readQdrantConfig().catch(() => ({} as Awaited<ReturnType<typeof readQdrantConfig>>)),
    readSqlConnectionString().catch(() => null as string | null),
    readGeminiKey().catch(() => null as string | null),
  ]);

  const [notionStatus, qdrantStatus, sqlStatus, geminiStatus]: [
    NotionStatusResult,
    QdrantStatusResult,
    SqlStatusResult,
    GeminiStatusResult,
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
    geminiKey
      ? geminiCheckConnection(geminiKey).catch(() => ({ connected: false }))
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
    gemini: {
      connected: geminiStatus.connected,
      model: geminiStatus.model ?? null,
    },
  };
}

export function registerInitTools(server: McpServer): void {
  /* ---------------------- Unified Panel Launcher ---------------------- */

  server.registerTool(
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
      const [status, envConfig, auth] = await Promise.all([
        getTeamContextStatus(),
        readEnvConfig(),
        getAuthState(),
      ]);
      return text({
        status: "ok",
        auth,
        teamStatus: status,
        config: envConfig,
      });
    }),
  );

  /* ------------------- Panel Internal Support Tools ------------------- */

  registerAppTool(
    server,
    "panel_get_auth_state",
    {
      title: "Get Panel Auth State",
      description: "Internal: check if user account is configured and session is authenticated.",
      annotations: { title: "Get Auth State", readOnlyHint: true },
      inputSchema: {},
      _meta: { ui: { visibility: ["app"] } },
    },
    guarded(async () => text(await getAuthState())),
  );

  registerAppTool(
    server,
    "panel_load_config",
    {
      title: "Load Team Context Settings",
      description: "Internal: load .env and existing connection configurations for the settings panel.",
      annotations: { title: "Load Team Context Settings", readOnlyHint: true },
      inputSchema: {},
      _meta: { ui: { visibility: ["app"] } },
    },
    guarded(async () => {
      const [envConfig, ghToken, notionKey, qdrantConfig, sqlConn, geminiKey, state, auth] = await Promise.all([
        readEnvConfig(),
        readToken(),
        readNotionKey(),
        readQdrantConfig(),
        readSqlConnectionString(),
        readGeminiKey(),
        readState(),
        getAuthState(),
      ]);

      return text({
        status: "ok",
        auth,
        config: {
          AUTH_USERNAME: envConfig.AUTH_USERNAME || "",
          GITHUB_TOKEN: envConfig.GITHUB_TOKEN || ghToken || "",
          NOTION_API_KEY: envConfig.NOTION_API_KEY || notionKey || "",
          QDRANT_URL: envConfig.QDRANT_URL || qdrantConfig.endpoint || "",
          QDRANT_API_KEY: envConfig.QDRANT_API_KEY || qdrantConfig.apiKey || "",
          DATABASE_URL: envConfig.DATABASE_URL || sqlConn || "",
          GEMINI_API_KEY: envConfig.GEMINI_API_KEY || geminiKey || "",
          activeRepo: state.repo || "",
        },
      });
    }),
  );

  registerAppTool(
    server,
    "panel_login",
    {
      title: "Panel Login",
      description: "Internal: verify username and password to log in to the settings panel.",
      annotations: { title: "Panel Login", readOnlyHint: false },
      inputSchema: {
        username: z.string().describe("Username"),
        password: z.string().describe("Password"),
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    guarded(async (args: { username: string; password: string }) => {
      const envConfig = await readEnvConfig();
      const storedUser = envConfig.AUTH_USERNAME?.trim();
      const storedPass = envConfig.AUTH_PASSWORD?.trim();

      if (!storedUser || !storedPass) {
        return text({
          success: false,
          reason: "No user account exists yet. Please create a new account.",
          needsAccountCreation: true,
        });
      }

      const inputUser = args.username?.trim() || "";
      const inputPass = args.password?.trim() || "";

      if (inputUser.toLowerCase() !== storedUser.toLowerCase()) {
        return text({
          success: false,
          reason: `Username "${inputUser}" does not exist. (Configured user is "${storedUser}")`,
          userNotFound: true,
        });
      }

      if (inputPass !== storedPass) {
        return text({
          success: false,
          reason: "Incorrect password.",
        });
      }

      currentSessionUser = storedUser;
      return text({
        success: true,
        message: `Logged in successfully as ${storedUser}.`,
        username: storedUser,
      });
    }),
  );

  registerAppTool(
    server,
    "panel_create_account",
    {
      title: "Create Account",
      description: "Internal: create new login username and password and store in server/.env.",
      annotations: { title: "Create Account", readOnlyHint: false },
      inputSchema: {
        username: z.string().min(1).describe("Username"),
        password: z.string().min(1).describe("Password"),
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    guarded(async (args: { username: string; password: string }) => {
      const username = args.username?.trim() || "";
      const password = args.password?.trim() || "";

      if (!username) {
        return text({ success: false, reason: "Username cannot be empty." });
      }
      if (!password) {
        return text({ success: false, reason: "Password cannot be empty." });
      }

      await writeEnvConfig({
        AUTH_USERNAME: username,
        AUTH_PASSWORD: password,
      });

      currentSessionUser = username;
      return text({
        success: true,
        message: "Account created and credentials saved to server/.env.",
        username,
      });
    }),
  );

  registerAppTool(
    server,
    "panel_signout",
    {
      title: "Sign Out",
      description: "Internal: sign out from current settings panel session.",
      annotations: { title: "Sign Out", readOnlyHint: false },
      inputSchema: {},
      _meta: { ui: { visibility: ["app"] } },
    },
    guarded(async () => {
      currentSessionUser = null;
      return text({
        success: true,
        message: "Signed out successfully.",
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
        service: z.enum(["github", "notion", "qdrant", "sql", "gemini"]).describe("Target service name"),
        githubToken: z.string().optional(),
        notionApiKey: z.string().optional(),
        qdrantUrl: z.string().optional(),
        qdrantApiKey: z.string().optional(),
        databaseUrl: z.string().optional(),
        geminiApiKey: z.string().optional(),
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    guarded(async (args: {
      service: "github" | "notion" | "qdrant" | "sql" | "gemini";
      githubToken?: string;
      notionApiKey?: string;
      qdrantUrl?: string;
      qdrantApiKey?: string;
      databaseUrl?: string;
      geminiApiKey?: string;
    }) => {
      if (args.service === "github") {
        if (!args.githubToken?.trim()) {
          return text({ ok: false, valid: false, reason: "GitHub token is empty." });
        }
        const check = await validateToken(args.githubToken.trim());
        return text({ ok: check.valid, ...check });
      }

      if (args.service === "notion") {
        if (!args.notionApiKey?.trim()) {
          return text({ ok: false, valid: false, reason: "Notion API key is empty." });
        }
        const check = await validateNotionKey(args.notionApiKey.trim());
        return text({ ok: check.valid, ...check });
      }

      if (args.service === "qdrant") {
        if (!args.qdrantUrl?.trim()) {
          return text({ ok: false, valid: false, reason: "Qdrant endpoint URL is empty." });
        }
        const check = await validateQdrantConnection(
          args.qdrantUrl.trim(),
          args.qdrantApiKey?.trim(),
        );
        return text({ ok: check.valid, ...check });
      }

      if (args.service === "sql") {
        if (!args.databaseUrl?.trim()) {
          return text({ ok: false, valid: false, reason: "Database connection string is empty." });
        }
        const check = await validateSqlConnection(args.databaseUrl.trim());
        return text({ ok: check.valid, ...check });
      }

      if (args.service === "gemini") {
        if (!args.geminiApiKey?.trim()) {
          return text({ ok: false, valid: false, reason: "Gemini API key is empty." });
        }
        const check = await validateGeminiKey(args.geminiApiKey.trim());
        return text({ ok: check.valid, ...check });
      }

      return text({ ok: false, valid: false, reason: "Unknown service." });

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
        GEMINI_API_KEY: z.string().optional().describe("Google Gemini API Key"),
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    guarded(async (args: {
      GITHUB_TOKEN?: string;
      NOTION_API_KEY?: string;
      QDRANT_URL?: string;
      QDRANT_API_KEY?: string;
      DATABASE_URL?: string;
      GEMINI_API_KEY?: string;
    }) => {
      // 1. Write to server/.env
      await writeEnvConfig({
        GITHUB_TOKEN: args.GITHUB_TOKEN?.trim() || undefined,
        NOTION_API_KEY: args.NOTION_API_KEY?.trim() || undefined,
        QDRANT_URL: args.QDRANT_URL?.trim() || undefined,
        QDRANT_API_KEY: args.QDRANT_API_KEY?.trim() || undefined,
        DATABASE_URL: args.DATABASE_URL?.trim() || undefined,
        GEMINI_API_KEY: args.GEMINI_API_KEY?.trim() || undefined,
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
      if (args.GEMINI_API_KEY?.trim()) {
        await saveGeminiKey(args.GEMINI_API_KEY.trim());
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
        "Report connection and authentication status for all team services (GitHub, Notion, Qdrant, SQL, Gemini).",
      annotations: { title: "Team Context Status", readOnlyHint: true },
      inputSchema: {},
    },
    guarded(async () => text(await getTeamContextStatus())),
  );
}
