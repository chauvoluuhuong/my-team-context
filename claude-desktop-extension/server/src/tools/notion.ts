/**
 * Notion integration and connection tools.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readNotionKey, saveNotionKey, clearNotionKey } from "../utils/store.js";
import { text, guarded, RepoContextError } from "../utils/helpers.js";
import type { ValidateNotionResult, NotionStatusResult } from "./types.js";

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

/**
 * Validate a Notion API key against the official Notion REST API.
 */
export async function validateNotionKey(apiKey: string): Promise<ValidateNotionResult> {
  if (!apiKey || !apiKey.trim()) {
    return { valid: false, reason: "Notion API key cannot be empty." };
  }

  try {
    const res = await fetch(`${NOTION_API}/users/me`, {
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
        "Notion-Version": NOTION_VERSION,
        "User-Agent": "claude-team-context",
      },
    });

    if (res.status === 401) {
      return {
        valid: false,
        reason: "Notion rejected the API key — please check that it is an active integration token.",
      };
    }

    if (!res.ok) {
      return {
        valid: false,
        reason: `Notion returned ${res.status} ${res.statusText}.`,
      };
    }

    const data = (await res.json()) as {
      name?: string;
      id?: string;
      bot?: { owner?: { user?: { name?: string } } };
    };

    const botName = data.name || data.bot?.owner?.user?.name || "Notion Bot";
    return {
      valid: true,
      botName,
      botId: data.id,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { valid: false, reason: `Could not reach Notion API: ${message}` };
  }
}

/**
 * Check the connection status with the stored or provided Notion API key.
 */
export async function notionCheckConnection(apiKeyOverride?: string): Promise<NotionStatusResult> {
  const key = apiKeyOverride?.trim() || (await readNotionKey());
  if (!key) {
    return {
      connected: false,
      reason: "No Notion API key configured yet. Call save_notion_key to save one.",
    };
  }

  const check = await validateNotionKey(key);
  if (!check.valid) {
    return {
      connected: false,
      reason: check.reason,
    };
  }

  return {
    connected: true,
    botName: check.botName,
    botId: check.botId,
  };
}

export function registerNotionTools(server: McpServer): void {
  server.registerTool(
    "notion_check_connection",
    {
      title: "Check Notion connection",
      description:
        "Test connectivity to the Notion workspace using the stored integration token, or test a newly provided token.",
      annotations: { title: "Check Notion connection", readOnlyHint: true },
      inputSchema: {
        apiKey: z
          .string()
          .optional()
          .describe("Optional Notion integration token (secret_...) to test without saving."),
      },
    },
    guarded(async ({ apiKey }: { apiKey?: string }) => {
      const status = await notionCheckConnection(apiKey);
      return text({
        connected: status.connected,
        botName: status.botName ?? null,
        botId: status.botId ?? null,
        status: status.connected ? "ok" : "error",
        detail: status.connected
          ? `Successfully connected to Notion as "${status.botName}".`
          : status.reason,
      });
    }),
  );

  server.registerTool(
    "save_notion_key",
    {
      title: "Save Notion API key",
      description: "Validate and store a Notion internal integration token in the OS keychain.",
      annotations: { title: "Save Notion API key", readOnlyHint: false },
      inputSchema: {
        apiKey: z.string().min(1).describe("Notion internal integration token (secret_...)"),
      },
    },
    guarded(async ({ apiKey }: { apiKey: string }) => {
      const check = await validateNotionKey(apiKey);
      if (!check.valid) {
        throw new RepoContextError(`Invalid Notion key: ${check.reason}`);
      }

      const { stored, warning } = await saveNotionKey(apiKey);
      return text({
        status: "ok",
        botName: check.botName,
        botId: check.botId,
        storage: stored,
        warning,
        message: `Notion API key validated and stored successfully (authenticated as "${check.botName}").`,
      });
    }),
  );

  server.registerTool(
    "notion_disconnect",
    {
      title: "Disconnect Notion",
      description: "Remove the stored Notion API key from this machine.",
      annotations: { title: "Disconnect Notion", readOnlyHint: false, destructiveHint: true },
      inputSchema: {},
    },
    guarded(async () => {
      await clearNotionKey();
      return text("Notion disconnected — the stored API key was removed.");
    }),
  );
}
