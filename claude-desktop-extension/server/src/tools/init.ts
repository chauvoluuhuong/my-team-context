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
  clearToken,
  clearNotionKey,
  clearQdrantConfig,
  clearSqlConnectionString,
  clearGeminiKey,
  clearAllCredentials,
} from "../utils/store.js";
import { readEnvConfig, writeEnvConfig, clearEnvConfig } from "../utils/env.js";
import { text, guarded } from "../utils/helpers.js";
import { whoami, validateToken } from "./github.js";
import { notionCheckConnection, validateNotionKey } from "./notion.js";
import {
  qdrantCheckConnection,
  validateQdrantConnection,
  listUsers,
  createUser,
  getUser,
  ensureUsersCollection,
  getAppConfig,
  saveAppConfig,
} from "../services/vector-db.js";
import { sqlCheckConnection, validateSqlConnection } from "./sql.js";
import { validateGeminiKey, geminiCheckConnection } from "../services/embedding.js";
import type {
  TeamContextStatusResult,
  NotionStatusResult,
  QdrantStatusResult,
  SqlStatusResult,
  GeminiStatusResult,
  SetupStatusResult,
  TeamUserItem,
} from "./types.js";

export const PANEL_URI = "ui://repo-context/panel.html";

let currentSessionUser: string | null = null;
let currentSessionRole: string | null = null;

export function getSessionUser(): string | null {
  return currentSessionUser;
}

export function setSessionUser(user: string | null, role: string | null = null): void {
  currentSessionUser = user;
  currentSessionRole = role;
}

export async function getAuthState() {
  const env = await readEnvConfig();
  const currentUserName = env.CURRENT_USER_NAME || env.USER_NAME || currentSessionUser || null;
  const currentUserRole = env.CURRENT_USER_ROLE || env.USER_ROLE || currentSessionRole || "Member";
  return {
    hasAccount: Boolean(currentUserName),
    isAuthenticated: Boolean(currentUserName),
    username: currentUserName,
    role: currentUserRole,
  };
}

/**
 * Centralized utility function to check Team Context settings, credentials, and connectivity.
 */
export async function checkTeamContextSetup(): Promise<SetupStatusResult> {
  const envConfig = await readEnvConfig();
  const qdrantConfig = await readQdrantConfig();

  const endpoint = envConfig.QDRANT_URL || qdrantConfig.endpoint;
  const apiKey = envConfig.QDRANT_API_KEY || qdrantConfig.apiKey;

  const currentUserName = envConfig.CURRENT_USER_NAME || envConfig.USER_NAME || currentSessionUser || null;
  const currentUserRole = envConfig.CURRENT_USER_ROLE || envConfig.USER_ROLE || currentSessionRole || null;

  // 1. Check if Qdrant endpoint is provided
  if (!endpoint || !endpoint.trim()) {
    return {
      isSetupComplete: false,
      step: "qdrant_config",
      qdrant: {
        configured: false,
        connected: false,
        endpoint: null,
        error: "Qdrant cluster endpoint URL is missing. Please configure Qdrant endpoint.",
      },
      currentUser: {
        name: currentUserName,
        role: currentUserRole,
      },
      users: [],
      error: "Qdrant cluster endpoint URL is not configured in server/.env.",
    };
  }

  // 2. Validate connection to Qdrant cluster
  const qdrantCheck = await validateQdrantConnection(endpoint, apiKey);
  if (!qdrantCheck.valid) {
    return {
      isSetupComplete: false,
      step: "qdrant_config",
      qdrant: {
        configured: true,
        connected: false,
        endpoint,
        error: qdrantCheck.reason || "Could not connect to Qdrant.",
      },
      currentUser: {
        name: currentUserName,
        role: currentUserRole,
      },
      users: [],
      error: qdrantCheck.reason || "Failed to reach Qdrant vector database.",
    };
  }

  // 3. Check Gemini API key (obligatory for vector embeddings)
  const geminiKey = envConfig.GEMINI_API_KEY || (await readGeminiKey());
  if (!geminiKey || !geminiKey.trim()) {
    return {
      isSetupComplete: false,
      step: "qdrant_config",
      qdrant: {
        configured: true,
        connected: true,
        endpoint: qdrantCheck.endpoint || endpoint,
        error: "Gemini API key is required. Google Gemini is obligatory for embeddings.",
      },
      currentUser: {
        name: currentUserName,
        role: currentUserRole,
      },
      users: [],
      error: "Gemini API key is not configured. Google Gemini is obligatory for embeddings.",
    };
  }

  // 4. Qdrant is connected. Fetch users from Qdrant 'users' collection
  let users: TeamUserItem[] = [];
  try {
    users = await listUsers();
  } catch {
    users = [];
  }

  // 5. Check if active user identity is selected in .env
  if (!currentUserName || !currentUserName.trim()) {
    return {
      isSetupComplete: false,
      step: "user_selection",
      qdrant: {
        configured: true,
        connected: true,
        endpoint: qdrantCheck.endpoint || endpoint,
      },
      currentUser: {
        name: null,
        role: null,
      },
      users,
      error: null,
    };
  }

  // Setup is complete
  currentSessionUser = currentUserName.trim();
  currentSessionRole = currentUserRole?.trim() || "Member";

  return {
    isSetupComplete: true,
    step: "completed",
    qdrant: {
      configured: true,
      connected: true,
      endpoint: qdrantCheck.endpoint || endpoint,
    },
    currentUser: {
      name: currentUserName.trim(),
      role: currentSessionRole,
    },
    users,
    error: null,
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

      const username = envConfig.CURRENT_USER_NAME || envConfig.USER_NAME || auth.username || currentSessionUser || "";
      let appConfig = null;
      if (username) {
        appConfig = await getAppConfig(username).catch(() => null);
      }
      const connections = appConfig?.connections || {};

      return text({
        status: "ok",
        auth,
        connections,
        config: {
          CURRENT_USER_NAME: envConfig.CURRENT_USER_NAME || envConfig.USER_NAME || auth.username || "",
          CURRENT_USER_ROLE: envConfig.CURRENT_USER_ROLE || envConfig.USER_ROLE || auth.role || "Member",
          USER_NAME: envConfig.CURRENT_USER_NAME || envConfig.USER_NAME || auth.username || "",
          USER_ROLE: envConfig.CURRENT_USER_ROLE || envConfig.USER_ROLE || auth.role || "Member",
          AUTH_USERNAME: envConfig.CURRENT_USER_NAME || envConfig.USER_NAME || auth.username || "",
          GITHUB_TOKEN: connections.github?.credentials?.GITHUB_TOKEN || envConfig.GITHUB_TOKEN || ghToken || "",
          NOTION_API_KEY: connections.notion?.credentials?.NOTION_API_KEY || envConfig.NOTION_API_KEY || notionKey || "",
          QDRANT_URL: envConfig.QDRANT_URL || qdrantConfig.endpoint || "",
          QDRANT_API_KEY: envConfig.QDRANT_API_KEY || qdrantConfig.apiKey || "",
          DATABASE_URL: connections.sql?.credentials?.DATABASE_URL || envConfig.DATABASE_URL || sqlConn || "",
          GEMINI_API_KEY: envConfig.GEMINI_API_KEY || geminiKey || "",
          activeRepo: state.repo || "",
        },
      });
    }),
  );

  registerAppTool(
    server,
    "panel_check_setup",
    {
      title: "Check Setup Status",
      description: "Internal: check Qdrant connection and user identity setup state for the panel widget.",
      annotations: { title: "Check Setup Status", readOnlyHint: true },
      inputSchema: {},
      _meta: { ui: { visibility: ["app"] } },
    },
    guarded(async () => text(await checkTeamContextSetup())),
  );

  registerAppTool(
    server,
    "panel_save_qdrant_config",
    {
      title: "Save Qdrant Config",
      description: "Internal: validate Qdrant endpoint and API key, save to server/.env and initialize users collection.",
      annotations: { title: "Save Qdrant Config", readOnlyHint: false },
      inputSchema: {
        qdrantUrl: z.string().min(1).describe("Qdrant Cluster Endpoint URL"),
        qdrantApiKey: z.string().optional().describe("Qdrant API Key"),
        geminiApiKey: z.string().min(1).describe("Google Gemini API Key (obligatory)"),
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    guarded(async (args: { qdrantUrl: string; qdrantApiKey?: string; geminiApiKey: string }) => {
      const url = args.qdrantUrl?.trim();
      const apiKey = args.qdrantApiKey?.trim() || "";
      const geminiApiKey = args.geminiApiKey?.trim();

      if (!url) {
        return text({ success: false, reason: "Qdrant endpoint URL cannot be empty." });
      }
      if (!geminiApiKey) {
        return text({ success: false, reason: "Gemini API key is obligatory. Please provide your Google AI Studio API key." });
      }

      const check = await validateQdrantConnection(url, apiKey);
      if (!check.valid) {
        return text({
          success: false,
          reason: check.reason || "Failed to connect to Qdrant with the provided URL / API key.",
        });
      }

      const geminiCheck = await validateGeminiKey(geminiApiKey);
      if (!geminiCheck.valid) {
        return text({
          success: false,
          reason: geminiCheck.reason || "Invalid Gemini API key. Please check your API key at Google AI Studio.",
        });
      }

      // Save to .env and keychain
      await writeEnvConfig({
        QDRANT_URL: check.endpoint || url,
        QDRANT_API_KEY: apiKey || undefined,
        GEMINI_API_KEY: geminiApiKey,
      });
      await saveQdrantConfig(check.endpoint || url, apiKey || undefined);
      await saveGeminiKey(geminiApiKey);

      // Ensure users collection is ready and retrieve existing users
      await ensureUsersCollection().catch(() => {});
      let users: TeamUserItem[] = [];
      try {
        users = await listUsers();
      } catch {
        users = [];
      }

      return text({
        success: true,
        endpoint: check.endpoint || url,
        users,
        message: "Qdrant and Gemini successfully configured and connected.",
      });
    }),
  );

  registerAppTool(
    server,
    "panel_list_users",
    {
      title: "List Team Users",
      description: "Internal: list all team users from the Qdrant users collection.",
      annotations: { title: "List Team Users", readOnlyHint: true },
      inputSchema: {},
      _meta: { ui: { visibility: ["app"] } },
    },
    guarded(async () => {
      const users = await listUsers();
      return text({
        success: true,
        users,
      });
    }),
  );

  registerAppTool(
    server,
    "panel_select_user",
    {
      title: "Select Active User",
      description: "Internal: select active user identity and save to server/.env.",
      annotations: { title: "Select Active User", readOnlyHint: false },
      inputSchema: {
        name: z.string().min(1).describe("User Name"),
        role: z.string().optional().describe("User Role"),
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    guarded(async (args: { name: string; role?: string }) => {
      const name = args.name?.trim();
      const role = args.role?.trim() || "Member";

      if (!name) {
        return text({ success: false, reason: "User name cannot be empty." });
      }

      await writeEnvConfig({
        CURRENT_USER_NAME: name,
        CURRENT_USER_ROLE: role,
        USER_NAME: name,
        USER_ROLE: role,
      });

      setSessionUser(name, role);

      return text({
        success: true,
        user: { name, role },
        message: `Active user set to ${name} (${role}).`,
      });
    }),
  );

  registerAppTool(
    server,
    "panel_create_user",
    {
      title: "Create Team User",
      description: "Internal: create a new user in Qdrant users collection and select them as active user.",
      annotations: { title: "Create Team User", readOnlyHint: false },
      inputSchema: {
        name: z.string().min(1).describe("User Name"),
        role: z.string().min(1).describe("User Role (e.g. Developer, Lead, QA)"),
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    guarded(async (args: { name: string; role: string }) => {
      const name = args.name?.trim();
      const role = args.role?.trim() || "Member";

      if (!name) {
        return text({ success: false, reason: "User name cannot be empty." });
      }

      const user = await createUser({ name, role });

      await writeEnvConfig({
        CURRENT_USER_NAME: name,
        CURRENT_USER_ROLE: role,
        USER_NAME: name,
        USER_ROLE: role,
      });

      setSessionUser(name, role);

      return text({
        success: true,
        user,
        message: `Created user ${name} (${role}) and selected as active.`,
      });
    }),
  );

  registerAppTool(
    server,
    "panel_logout",
    {
      title: "Logout & Reset Environment",
      description: "Internal: clear server/.env completely, clear stored credentials, and reset active session.",
      annotations: { title: "Logout", readOnlyHint: false },
      inputSchema: {},
      _meta: { ui: { visibility: ["app"] } },
    },
    guarded(async () => {
      await clearEnvConfig();
      await clearAllCredentials();
      setSessionUser(null, null);
      return text({
        success: true,
        message: "Successfully logged out. server/.env has been wiped clean.",
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
      // 1. Write to server/.env (if key is empty string, clear it from process.env and .env)
      const envUpdate: Record<string, string | undefined> = {};
      if (args.GITHUB_TOKEN !== undefined) envUpdate.GITHUB_TOKEN = args.GITHUB_TOKEN.trim();
      if (args.NOTION_API_KEY !== undefined) envUpdate.NOTION_API_KEY = args.NOTION_API_KEY.trim();
      if (args.QDRANT_URL !== undefined) envUpdate.QDRANT_URL = args.QDRANT_URL.trim();
      if (args.QDRANT_API_KEY !== undefined) envUpdate.QDRANT_API_KEY = args.QDRANT_API_KEY.trim();
      if (args.DATABASE_URL !== undefined) envUpdate.DATABASE_URL = args.DATABASE_URL.trim();
      if (args.GEMINI_API_KEY !== undefined) envUpdate.GEMINI_API_KEY = args.GEMINI_API_KEY.trim();

      await writeEnvConfig(envUpdate);

      // 2. Sync with keychain storage
      if (args.GITHUB_TOKEN?.trim()) {
        await saveToken(args.GITHUB_TOKEN.trim());
      } else if (args.GITHUB_TOKEN === "") {
        await clearToken();
      }

      if (args.NOTION_API_KEY?.trim()) {
        await saveNotionKey(args.NOTION_API_KEY.trim());
      } else if (args.NOTION_API_KEY === "") {
        await clearNotionKey();
      }

      if (args.QDRANT_URL?.trim()) {
        await saveQdrantConfig(args.QDRANT_URL.trim(), args.QDRANT_API_KEY?.trim());
      } else if (args.QDRANT_URL === "") {
        await clearQdrantConfig();
      }

      if (args.DATABASE_URL?.trim()) {
        await saveSqlConnectionString(args.DATABASE_URL.trim());
      } else if (args.DATABASE_URL === "") {
        await clearSqlConnectionString();
      }

      if (args.GEMINI_API_KEY?.trim()) {
        await saveGeminiKey(args.GEMINI_API_KEY.trim());
      } else if (args.GEMINI_API_KEY === "") {
        await clearGeminiKey();
      }

      return text({
        status: "ok",
        message: "Credentials successfully validated and saved to server/.env",
      });
    }),
  );

  registerAppTool(
    server,
    "panel_save_connection",
    {
      title: "Save Connection to App Config",
      description: "Internal: save or update a connection and its credentials in appConfig (not in environment variables).",
      annotations: { title: "Save Connection", readOnlyHint: false },
      inputSchema: {
        service: z.string().describe("Target service name (e.g. github, notion, sql)"),
        credentials: z.record(z.string()).describe("Service credentials"),
        enabled: z.boolean().optional().default(true).describe("Whether connection is enabled"),
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    guarded(async (args: { service: string; credentials: Record<string, string>; enabled?: boolean }) => {
      const envConfig = await readEnvConfig();
      const username = envConfig.CURRENT_USER_NAME || envConfig.USER_NAME || getSessionUser() || "admin";
      const existing = await getAppConfig(username).catch(() => null);
      const connections = existing?.connections || {};

      connections[args.service] = {
        id: args.service,
        enabled: args.enabled !== false,
        credentials: args.credentials || {},
        updatedAt: new Date().toISOString(),
      };

      await saveAppConfig({
        username,
        activeRepos: existing?.activeRepos || [],
        activeNotionPages: existing?.activeNotionPages || [],
        systemPrompt: existing?.systemPrompt,
        connections,
      });

      return text({
        status: "ok",
        message: `Connection for ${args.service} saved to appConfig successfully.`,
        connections,
      });
    }),
  );

  registerAppTool(
    server,
    "panel_remove_connection",
    {
      title: "Remove Connection from App Config",
      description: "Internal: remove a connection from appConfig and clean up its credentials.",
      annotations: { title: "Remove Connection", readOnlyHint: false },
      inputSchema: {
        service: z.string().describe("Target service name (e.g. github, notion, sql)"),
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    guarded(async (args: { service: string }) => {
      const envConfig = await readEnvConfig();
      const username = envConfig.CURRENT_USER_NAME || envConfig.USER_NAME || getSessionUser() || "admin";
      const existing = await getAppConfig(username).catch(() => null);
      const connections = existing?.connections || {};

      delete connections[args.service];

      await saveAppConfig({
        username,
        activeRepos: existing?.activeRepos || [],
        activeNotionPages: existing?.activeNotionPages || [],
        systemPrompt: existing?.systemPrompt,
        connections,
      });

      // Clear any legacy env / keychain
      if (args.service === "github") {
        await clearToken();
        await writeEnvConfig({ GITHUB_TOKEN: "" });
      } else if (args.service === "notion") {
        await clearNotionKey();
        await writeEnvConfig({ NOTION_API_KEY: "" });
      } else if (args.service === "sql") {
        await clearSqlConnectionString();
        await writeEnvConfig({ DATABASE_URL: "" });
      }

      return text({
        status: "ok",
        message: `Connection ${args.service} removed from appConfig successfully.`,
        connections,
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
