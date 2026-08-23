/**
 * Application Configuration Tools.
 *
 * Provides interactive configuration widget (`configure_app`) and tools for managing
 * multi-session app configuration (GitHub active repos with descriptions, System Prompt, Notion)
 * persisted in Qdrant's `app-config` collection.
 */

import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { text, guarded, getDefaultSystemPrompt, RepoContextError } from "../utils/helpers.js";
import { whoami, listRepos, listFiles, readFile } from "./github.js";
import { getAuthState, getSessionUser } from "./init.js";
import {
  getAppConfig,
  saveAppConfig,
  upsertSkill,
  getSkill,
  getSkillPointId,
  formatSkillName,
} from "../services/vector-db.js";
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
      console.error('>>>>>>>>>>>>>>');
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

  registerAppTool(
    server,
    "config_list_repo_md_files",
    {
      title: "List Repository Markdown Files",
      description: "Internal: recursively find all .md and .mdx files inside a GitHub repository.",
      annotations: { title: "List Markdown Files", readOnlyHint: true },
      inputSchema: {
        repo: z.string().min(1).describe("Repository name (owner/repo)"),
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    guarded(async ({ repo }: { repo: string }) => {
      const res = await listFiles({ repo, recursive: true, limit: 1000 });
      const mdEntries = (res.entries || []).filter((e) => {
        const lower = e.path.toLowerCase();
        return lower.endsWith(".md") || lower.endsWith(".mdx");
      });

      const mdFiles = await Promise.all(
        mdEntries.map(async (e) => {
          const pointId = getSkillPointId(repo, e.path);
          let isSynced = false;
          try {
            const existing = await getSkill(pointId);
            if (existing) isSynced = true;
          } catch {
            // Not in Qdrant yet
          }
          return {
            path: e.path,
            size: e.size,
            isSynced,
            pointId,
          };
        }),
      );

      return text({
        status: "ok",
        repo,
        count: mdFiles.length,
        mdFiles,
      });
    }),
  );

  registerAppTool(
    server,
    "config_preview_repo_md_file",
    {
      title: "Preview Repository Markdown File for Skill Sync",
      description:
        "Internal: fetch file content, suggest formatted skill name and description, and check existing Qdrant skill status.",
      annotations: { title: "Preview Markdown Skill", readOnlyHint: true },
      inputSchema: {
        repo: z.string().min(1).describe("Repository name (owner/repo)"),
        filePath: z.string().min(1).describe("File path within the repository"),
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    guarded(async ({ repo, filePath }: { repo: string; filePath: string }) => {
      const fileData = await readFile({ repo, path: filePath });
      const content = fileData.content || "";

      // Extract title from first markdown heading or filename
      const titleMatch = content.match(/^#+\s+(.+)$/m);
      const defaultTitle = titleMatch
        ? titleMatch[1].trim()
        : path.basename(filePath, path.extname(filePath));

      // Centralized naming suggestion
      const suggestedName = formatSkillName(repo, filePath, defaultTitle);
      const prefix = `[github-repo: ${repo.trim()}, path: ${filePath.trim()}]`;


      // Extract description from first non-header text line
      const lines = content
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith("#"));
      const suggestedDescription = lines[0]
        ? lines[0].slice(0, 200) + (lines[0].length > 200 ? "..." : "")
        : `Imported from ${repo}/${filePath}`;

      const pointId = getSkillPointId(repo, filePath);
      let existingSkill = null;
      try {
        existingSkill = await getSkill(pointId);
      } catch {
        // Does not exist yet
      }

      return text({
        status: "ok",
        repo,
        filePath,
        prefix,
        defaultTitle,
        suggestedName,
        suggestedDescription,
        content,
        exists: Boolean(existingSkill),
        existingSkill,
      });
    }),
  );

  registerAppTool(
    server,
    "config_sync_repo_md_files",
    {
      title: "Sync Markdown Files to Qdrant Skills",
      description:
        "Internal: fetch selected .md files from a GitHub repository and upsert them into Qdrant vector DB skills collection with deterministic UUIDs and location metadata.",
      annotations: { title: "Sync Markdown to Skills", readOnlyHint: false },
      inputSchema: {
        repo: z.string().min(1).describe("Repository name (owner/repo)"),
        items: z
          .array(
            z.object({
              filePath: z.string().min(1).describe("File path in repository"),
              name: z.string().optional().describe("Custom skill name (suggested prefix + title)"),
              description: z.string().optional().describe("Custom skill description"),
              content: z.string().optional().describe("Skill content markdown"),
            }),
          )
          .optional()
          .describe("Items to sync with custom names/descriptions"),
        filePaths: z
          .array(z.string().min(1))
          .optional()
          .describe("List of file paths to sync (fallback)"),
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    guarded(
      async ({
        repo,
        items,
        filePaths,
      }: {
        repo: string;
        items?: Array<{ filePath: string; name?: string; description?: string; content?: string }>;
        filePaths?: string[];
      }) => {
        const syncList: Array<{
          filePath: string;
          name?: string;
          description?: string;
          content?: string;
        }> =
          items && items.length > 0
            ? items
            : (filePaths || []).map((fp) => ({ filePath: fp }));

        if (syncList.length === 0) {
          throw new RepoContextError("No markdown files specified to sync.");
        }

        const results: Array<{
          path: string;
          status: "upserted" | "failed";
          name?: string;
          skillId?: string;
          error?: string;
        }> = [];

        for (const item of syncList) {
          const { filePath } = item;
          try {
            let content = item.content;
            if (!content || !content.trim()) {
              const fileData = await readFile({ repo, path: filePath });
              content = fileData.content || "";
            }

            if (!content.trim()) {
              results.push({ path: filePath, status: "failed", error: "File content is empty." });
              continue;
            }

            // Extract title from first markdown header or filename
            const titleMatch = content.match(/^#+\s+(.+)$/m);
            const defaultTitle = titleMatch
              ? titleMatch[1].trim()
              : path.basename(filePath, path.extname(filePath));

            const skillName =
              item.name && item.name.trim()
                ? item.name.trim()
                : formatSkillName(repo, filePath, defaultTitle);

            // Extract description from first non-header line or summary
            const lines = content
              .split("\n")
              .map((l) => l.trim())
              .filter((l) => l.length > 0 && !l.startsWith("#"));
            const skillDescription =
              item.description && item.description.trim()
                ? item.description.trim()
                : lines[0]
                  ? lines[0].slice(0, 200) + (lines[0].length > 200 ? "..." : "")
                  : `Imported from ${repo}/${filePath}`;

            const skillId = getSkillPointId(repo, filePath);

            await upsertSkill({
              id: skillId,
              name: skillName,
              description: skillDescription,
              content,
              metadata: {
                source: "github",
                location: {
                  repo: repo.trim(),
                  filePath: filePath.trim(),
                  fullPath: `github:${repo.trim()}:${filePath.trim()}`,
                },
                repo: repo.trim(),
                filePath: filePath.trim(),
                syncedAt: new Date().toISOString(),
              },
            });

            results.push({ path: filePath, status: "upserted", name: skillName, skillId });
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            results.push({ path: filePath, status: "failed", error: msg });
          }
        }

        const successCount = results.filter((r) => r.status === "upserted").length;

        return text({
          status: "ok",
          synced: successCount,
          total: syncList.length,
          results,
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
