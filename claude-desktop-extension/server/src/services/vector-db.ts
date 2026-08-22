/**
 * Vector database service (Qdrant integration).
 */

import { readQdrantConfig, saveQdrantConfig, clearQdrantConfig } from "../utils/store.js";
import type { ValidateQdrantResult, QdrantStatusResult } from "../tools/types.js";

/**
 * Clean endpoint URL to ensure proper protocol and no trailing slash.
 */
export function normalizeEndpoint(endpoint: string): string {
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
        "No Qdrant endpoint configured yet. Provide endpoint and API key to connect.",
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

export { readQdrantConfig, saveQdrantConfig, clearQdrantConfig };
