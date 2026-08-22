/**
 * Application Configuration Tools.
 *
 * Provides interactive configuration widget (`configure_app`) and tools for managing
 * multi-session app configuration (GitHub active repos with descriptions, System Prompt, Notion)
 * persisted in Qdrant's `app-config` collection.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { text, guarded, getDefaultSystemPrompt, RepoContextError } from "../utils/helpers.js";
import { whoami, listRepos } from "./github.js";
import { getAuthState, getSessionUser } from "./init.js";
import { getAppConfig, saveAppConfig } from "../services/vector-db.js";
import type { ActiveRepoConfigItem } from "./types.js";

export const CONFIG_URI = "ui://repo-context/config.html";

async function resolveEffectiveUsername(providedUsername?: string): Promise<string> {
  if (providedUsername && providedUsername.trim()) {
    return providedUsername.trim();
  }

  const sessionUser = getSessionUser();
  if (sessionUser && sessionUser.trim()) {
    return sessionUser.trim();
  }

  const gh = await whoami().catch(() => ({ authenticated: false, login: undefined }));
  if (gh.login && gh.login.trim()) {
    return gh.login.trim();
  }

  const auth = await getAuthState().catch(() => ({ username: null }));
  if (auth.username && auth.username.trim()) {
    return auth.username.trim();
  }

  return "admin";
}

export function registerConfigTools(server: McpServer): void {
  /* ------------------- Interactive Configuration UI Tool ------------------- */

  registerAppTool(
    server,
    "configure_app",
    {
      title: "Configure Application",
      description:
        "Open the interactive configuration widget to manage multi-session app settings: " +
        "select active GitHub repositories with custom descriptions, customize the AI system prompt in Markdown, and configure integrations.",
      annotations: { title: "Configure Application", readOnlyHint: false, openWorldHint: true },
      inputSchema: {},
      _meta: { ui: { resourceUri: CONFIG_URI } },
    },
    guarded(async () => {
      const username = await resolveEffectiveUsername();
      let repos: any[] = [];

      let ghUser: { authenticated: boolean; login?: string } = { authenticated: false };
      let githubError: string | null = null;

      try {
        ghUser = await whoami();
        if (ghUser.authenticated) {
          repos = await listRepos({ limit: 200 });
        }
      } catch (err: unknown) {
        githubError = err instanceof Error ? err.message : String(err);
      }

      const [appConfig, defaultPrompt, auth] = await Promise.all([
        getAppConfig(username).catch(() => null),
        Promise.resolve(getDefaultSystemPrompt()),
        getAuthState().catch(() => ({ hasAccount: false, isAuthenticated: false, username: null })),
      ]);

      return text({
        status: "ok",
        username,
        githubLogin: ghUser.login || null,
        isGitHubConnected: Boolean(ghUser.authenticated),
        githubError,
        auth,
        appConfig: appConfig
          ? {
            ...appConfig,
            systemPrompt: appConfig.systemPrompt || defaultPrompt,
          }
          : {
            id: "",
            username,
            activeRepos: [],
            systemPrompt: defaultPrompt,
            createdAt: "",
            updatedAt: "",
          },
        defaultSystemPrompt: defaultPrompt,
        repos,
        reposCount: repos.length,
      });
    }),
  );

  /* ------------------- App Internal Support Tools ------------------- */

  registerAppTool(
    server,
    "config_get_app_state",
    {
      title: "Get App Configuration State",
      description: "Internal: load current user, saved app-config (active-repos and systemPrompt), and GitHub repository list.",
      annotations: { title: "Get App Config State", readOnlyHint: true },
      inputSchema: {
        username: z.string().optional().describe("Target username"),
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    guarded(async ({ username: inputUsername }: { username?: string }) => {
      const username = await resolveEffectiveUsername(inputUsername);
      let repos: any[] = [];
      let ghUser: { authenticated: boolean; login?: string } = { authenticated: false };
      let githubError: string | null = null;

      try {
        ghUser = await whoami();
        if (ghUser.authenticated) {
          repos = await listRepos({ limit: 200 });
        } else {
          githubError = "Not signed in to GitHub. Please configure your GitHub Personal Access Token.";
        }
      } catch (err: unknown) {
        githubError = err instanceof Error ? err.message : String(err);
      }

      const [appConfig, defaultPrompt, auth] = await Promise.all([
        getAppConfig(username).catch((e) => {
          return null;
        }),
        Promise.resolve(getDefaultSystemPrompt()),
        getAuthState().catch(() => ({ hasAccount: false, isAuthenticated: false, username: null })),
      ]);

      return text({
        status: "ok",
        username,
        githubLogin: ghUser.login || null,
        isGitHubConnected: Boolean(ghUser.authenticated),
        githubError,
        auth,
        appConfig: appConfig
          ? {
            ...appConfig,
            systemPrompt: appConfig.systemPrompt || defaultPrompt,
          }
          : {
            id: "",
            username,
            activeRepos: [],
            systemPrompt: defaultPrompt,
            createdAt: "",
            updatedAt: "",
          },
        defaultSystemPrompt: defaultPrompt,
        repos,
      });
    }),
  );

  registerAppTool(
    server,
    "config_list_repos",
    {

      title: "List GitHub Repositories",
      description: "Internal: retrieve GitHub repositories for selection in the configuration widget.",
      annotations: { title: "List Repositories", readOnlyHint: true },
      inputSchema: {
        query: z.string().optional().describe("Search filter for repository name"),
        limit: z.number().optional().describe("Maximum repositories to return"),
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    guarded(async ({ query, limit }: { query?: string; limit?: number }) => {
      const repos = await listRepos({ query, limit: limit || 200 });
      return text({
        status: "ok",
        total: repos.length,
        repos,
      });
    }),
  );

  registerAppTool(
    server,
    "config_save_app_config",
    {
      title: "Save Application Configuration",
      description:
        "Internal: save or update active repositories and system prompt inside the app-config Qdrant collection.",
      annotations: { title: "Save App Config", readOnlyHint: false },
      inputSchema: {
        username: z.string().optional().describe("User identity / username"),
        activeRepos: z
          .array(
            z.object({
              name: z.string().min(1).describe("Repository name (owner/repo)"),
              description: z.string().optional().default("").describe("Description or context for this repo"),
            }),
          )
          .describe("Selected active repositories"),
        systemPrompt: z.string().optional().describe("Custom system prompt in Markdown"),
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    guarded(
      async ({
        username: inputUsername,
        activeRepos,
        systemPrompt,
      }: {
        username?: string;
        activeRepos: ActiveRepoConfigItem[];
        systemPrompt?: string;
      }) => {
        const username = await resolveEffectiveUsername(inputUsername);
        const saved = await saveAppConfig({
          username,
          activeRepos: activeRepos || [],
          systemPrompt,
        });

        return text({
          status: "ok",
          message: `Application configuration for @${username} saved successfully with ${saved.activeRepos.length} active repos.`,
          config: saved,
        });
      },
    ),
  );

  /* ------------------- Conversational Agent Tools ------------------- */

  server.registerTool(
    "get_app_config",
    {
      title: "Get App Configuration",
      description:
        "Retrieve the saved application configuration (active repositories with descriptions, system prompt, and update timestamps) from the app-config collection.",
      annotations: { title: "Get App Config", readOnlyHint: true },
      inputSchema: {
        username: z.string().optional().describe("Target username (defaults to current user)"),
      },
    },
    guarded(async ({ username: inputUsername }: { username?: string }) => {
      const username = await resolveEffectiveUsername(inputUsername);
      const config = await getAppConfig(username);
      if (!config) {
        return text({
          status: "not_found",
          username,
          message: `No app configuration found for user "${username}". Call configure_app to configure active repositories.`,
        });
      }
      return text(config);
    }),
  );

  server.registerTool(
    "save_app_config",
    {
      title: "Save App Configuration",
      description:
        "Store or update the application configuration (active repositories and system prompt) for a user in the app-config collection.",
      annotations: { title: "Save App Config", readOnlyHint: false },
      inputSchema: {
        username: z.string().optional().describe("Username (defaults to current active user)"),
        activeRepos: z
          .array(
            z.object({
              name: z.string().describe("Repository full name (e.g. 'owner/repo')"),
              description: z.string().describe("Description/context notes for this repository"),
            }),
          )
          .describe("List of active repositories"),
        systemPrompt: z.string().optional().describe("Markdown system prompt"),
      },
    },
    guarded(
      async ({
        username: inputUsername,
        activeRepos,
        systemPrompt,
      }: {
        username?: string;
        activeRepos: ActiveRepoConfigItem[];
        systemPrompt?: string;
      }) => {
        const username = await resolveEffectiveUsername(inputUsername);
        const saved = await saveAppConfig({
          username,
          activeRepos,
          systemPrompt,
        });
        return text({
          status: "ok",
          message: `Configuration saved for @${username}`,
          config: saved,
        });
      },
    ),
  );
}
