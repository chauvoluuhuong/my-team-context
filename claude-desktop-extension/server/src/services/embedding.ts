/**
 * Gemini Embedding Service.
 *
 * Uses Gemini gemini-embedding-2 (3072-dimension vectors) to generate
 * embeddings for skills, knowledge base documents, and semantic search queries.
 */

import { readGeminiKey } from "../utils/store.js";
import { readEnvConfig } from "../utils/env.js";
import { getAppConfig } from "./vector-db.js";
import { RepoContextError } from "../utils/helpers.js";
import type { ValidateGeminiResult, GeminiStatusResult } from "../tools/types.js";

export const GEMINI_EMBEDDING_MODEL = "gemini-embedding-2";
export const GEMINI_VECTOR_SIZE = 3072;
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

export async function getEffectiveGeminiKey(): Promise<string | null> {
  const env = await readEnvConfig().catch(() => ({} as Record<string, string>));
  const username = env.CURRENT_USER_NAME || env.USER_NAME || process.env.CURRENT_USER_NAME || process.env.USER_NAME;
  if (username) {
    try {
      const cfg = await getAppConfig(username);
      const conn = cfg?.connections?.gemini;
      if (conn && conn.enabled !== false && conn.credentials?.GEMINI_API_KEY) {
        return conn.credentials.GEMINI_API_KEY.trim();
      }
    } catch {}
  }
  return readGeminiKey();
}

/**
 * Validate a Gemini API key against Google Generative Language API.
 */
export async function validateGeminiKey(apiKey: string): Promise<ValidateGeminiResult> {
  if (!apiKey || !apiKey.trim()) {
    return { valid: false, reason: "Gemini API key is required." };
  }

  const key = apiKey.trim();
  try {
    const res = await fetch(`${GEMINI_API_BASE}/models/${GEMINI_EMBEDDING_MODEL}?key=${encodeURIComponent(key)}`, {
      method: "GET",
      headers: { "User-Agent": "claude-team-context" },
    });

    if (res.status === 400 || res.status === 401 || res.status === 403) {
      return {
        valid: false,
        reason: "Gemini rejected the API key — please verify your Google AI Studio API key.",
      };
    }

    if (!res.ok) {
      return {
        valid: false,
        reason: `Gemini API returned HTTP ${res.status}: ${res.statusText}.`,
      };
    }

    const data = (await res.json()) as { name?: string; displayName?: string };
    return {
      valid: true,
      model: data.name || `models/${GEMINI_EMBEDDING_MODEL}`,
      displayName: data.displayName || "Gemini Embedding 2",
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      valid: false,
      reason: `Could not reach Gemini API: ${message}`,
    };
  }
}

/**
 * Check the connection status with stored or provided Gemini API key.
 */
export async function geminiCheckConnection(apiKeyOverride?: string): Promise<GeminiStatusResult> {
  const apiKey = apiKeyOverride?.trim() || (await getEffectiveGeminiKey());
  if (!apiKey) {
    return {
      connected: false,
      reason: "No Gemini API key configured. Provide an API key to enable vector embeddings.",
    };
  }

  const check = await validateGeminiKey(apiKey);
  if (!check.valid) {
    return {
      connected: false,
      reason: check.reason,
    };
  }

  return {
    connected: true,
    model: check.model,
  };
}

/**
 * Generate a 3072-dimensional vector embedding for the provided text using Gemini gemini-embedding-2.
 */
export async function generateGeminiEmbedding(
  text: string,
  apiKeyOverride?: string,
): Promise<number[]> {
  const trimmedText = text?.trim();
  if (!trimmedText) {
    throw new RepoContextError("Cannot generate vector embedding for empty text.");
  }

  const apiKey = apiKeyOverride?.trim() || (await getEffectiveGeminiKey());
  if (!apiKey) {
    throw new RepoContextError(
      "Gemini API key is not configured. Please add your GEMINI_API_KEY in the settings panel to generate embeddings.",
    );
  }

  const url = `${GEMINI_API_BASE}/models/${GEMINI_EMBEDDING_MODEL}:embedContent?key=${encodeURIComponent(apiKey.trim())}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "claude-team-context",
      },
      body: JSON.stringify({
        model: `models/${GEMINI_EMBEDDING_MODEL}`,
        content: {
          parts: [{ text: trimmedText }],
        },
      }),
    });

    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw new RepoContextError(
        "Gemini API key rejected while creating embedding. Please check your GEMINI_API_KEY.",
      );
    }

    if (!res.ok) {
      const errorMsg = await res.text().catch(() => res.statusText);
      throw new RepoContextError(`Gemini embedding request failed (${res.status}): ${errorMsg}`);
    }

    const data = (await res.json()) as {
      embedding?: {
        values?: number[];
      };
    };

    if (!data.embedding?.values || !Array.isArray(data.embedding.values)) {
      throw new RepoContextError("Unexpected response structure from Gemini embedding API.");
    }

    return data.embedding.values;
  } catch (err: unknown) {
    if (err instanceof RepoContextError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new RepoContextError(`Failed to generate Gemini embedding: ${message}`);
  }
}
