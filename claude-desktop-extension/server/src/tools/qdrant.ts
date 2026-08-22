/**
 * Qdrant vector database integration and connection tools.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readQdrantConfig, saveQdrantConfig, clearQdrantConfig } from "../utils/store.js";
import { text, guarded, RepoContextError } from "../utils/helpers.js";
import type { ValidateQdrantResult, QdrantStatusResult } from "./types.js";

/**
 * Clean endpoint URL to ensure proper protocol and no trailing slash.
 */
function normalizeEndpoint(endpoint: string): string {
  let url = endpoint.trim().replace(/\/+$/, "");
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = `https://${url}`;
  }
  return url;
}

/**
 * Validate connection to a Qdrant cluster (Cloud Qdrant or self-hosted).
 */
export async function validateQdrantConnection(
  endpoint: string,
  apiKey?: string,
): Promise<ValidateQdrantResult> {
  if (!endpoint || !endpoint.trim()) {
    return { valid: false, reason: "Qdrant endpoint URL is required." };
  }

  const url = normalizeEndpoint(endpoint);
  const headers: Record<string, string> = {
    "User-Agent": "claude-team-context",
  };
  if (apiKey && apiKey.trim()) {
    headers["api-key"] = apiKey.trim();
  }

  try {
    const res = await fetch(`${url}/collections`, {
      method: "GET",
      headers,
    });

    if (res.status === 401 || res.status === 403) {
      return {
        valid: false,
        reason: "Qdrant rejected the credentials — check your API key.",
      };
    }

    if (!res.ok) {
      return {
        valid: false,
        reason: `Qdrant returned HTTP ${res.status}: ${res.statusText}.`,
      };
    }

    const data = (await res.json()) as {
      result?: { collections?: Array<{ name: string }> };
      status?: string;
    };

    const collections = (data.result?.collections ?? []).map((c) => c.name);
    return {
      valid: true,
      endpoint: url,
      collections,
      collectionsCount: collections.length,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      valid: false,
      reason: `Could not reach Qdrant cluster at ${url}: ${message}`,
    };
  }
}

/**
 * Check the connection status with stored or provided Qdrant credentials.
 */
export async function qdrantCheckConnection(
  endpointOverride?: string,
  apiKeyOverride?: string,
): Promise<QdrantStatusResult> {
  const stored = await readQdrantConfig();
  const endpoint = endpointOverride?.trim() || stored.endpoint;
  const apiKey = apiKeyOverride?.trim() || stored.apiKey;

  if (!endpoint) {
    return {
      connected: false,
      reason:
        "No Qdrant endpoint configured yet. Call save_qdrant_config to set your endpoint and API key.",
    };
  }

  const check = await validateQdrantConnection(endpoint, apiKey);
  if (!check.valid) {
    return {
      connected: false,
      endpoint,
      reason: check.reason,
    };
  }

  return {
    connected: true,
    endpoint: check.endpoint,
    collectionsCount: check.collectionsCount ?? 0,
    collections: check.collections ?? [],
  };
}

export function registerQdrantTools(server: McpServer): void {
  server.registerTool(
    "qdrant_check_connection",
    {
      title: "Check Qdrant connection",
      description:
        "Test connection to the Qdrant vector database (Cloud Qdrant or local instance), and list available collections.",
      annotations: { title: "Check Qdrant connection", readOnlyHint: true },
      inputSchema: {
        endpoint: z
          .string()
          .optional()
          .describe("Optional Qdrant cluster endpoint to test without saving."),
        apiKey: z
          .string()
          .optional()
          .describe("Optional Qdrant API key to test without saving."),
      },
    },
    guarded(async ({ endpoint, apiKey }: { endpoint?: string; apiKey?: string }) => {
      const status = await qdrantCheckConnection(endpoint, apiKey);
      return text({
        connected: status.connected,
        endpoint: status.endpoint ?? null,
        collectionsCount: status.collectionsCount ?? 0,
        collections: status.collections ?? [],
        status: status.connected ? "ok" : "error",
        detail: status.connected
          ? `Successfully connected to Qdrant at ${status.endpoint} (${status.collectionsCount} collections found).`
          : status.reason,
      });
    }),
  );

  server.registerTool(
    "save_qdrant_config",
    {
      title: "Save Qdrant configuration",
      description: "Validate and store the Qdrant endpoint and API key.",
      annotations: { title: "Save Qdrant configuration", readOnlyHint: false },
      inputSchema: {
        endpoint: z.string().min(1).describe("Qdrant cluster URL, e.g. https://xxx.cloud.qdrant.io"),
        apiKey: z.string().optional().describe("Qdrant API key (required for Cloud clusters)"),
      },
    },
    guarded(async ({ endpoint, apiKey }: { endpoint: string; apiKey?: string }) => {
      const check = await validateQdrantConnection(endpoint, apiKey);
      if (!check.valid) {
        throw new RepoContextError(`Invalid Qdrant configuration: ${check.reason}`);
      }

      const { stored, warning } = await saveQdrantConfig(endpoint, apiKey);
      return text({
        status: "ok",
        endpoint: check.endpoint,
        collectionsCount: check.collectionsCount,
        storage: stored,
        warning,
        message: `Qdrant connection validated and stored successfully (${check.collectionsCount} collections available).`,
      });
    }),
  );

  server.registerTool(
    "qdrant_disconnect",
    {
      title: "Disconnect Qdrant",
      description: "Remove the stored Qdrant endpoint and API key from this machine.",
      annotations: { title: "Disconnect Qdrant", readOnlyHint: false, destructiveHint: true },
      inputSchema: {},
    },
    guarded(async () => {
      await clearQdrantConfig();
      return text("Qdrant disconnected — the stored endpoint and API key were removed.");
    }),
  );
}
