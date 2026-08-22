/**
 * Vector database service (Qdrant integration & Knowledge Base management).
 */

import crypto from "node:crypto";
import { readQdrantConfig, saveQdrantConfig, clearQdrantConfig } from "../utils/store.js";
import { RepoContextError } from "../utils/helpers.js";
import { serializeSkillDocument } from "../utils/serializer.js";
import { generateGeminiEmbedding, GEMINI_VECTOR_SIZE } from "./embedding.js";
import type {
  ValidateQdrantResult,
  QdrantStatusResult,
  SkillDocument,
  SkillItem,
  SkillSearchResult,
  ListSkillsResult,
} from "../tools/types.js";

export const KNOWLEDGE_BASE_COLLECTION = "knowledge-base";

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
 * Helper to build Qdrant API request headers.
 */
function qdrantHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "claude-team-context",
  };
  if (apiKey && apiKey.trim()) {
    headers["api-key"] = apiKey.trim();
  }
  return headers;
}

/**
 * Get active Qdrant credentials or throw user-friendly error.
 */
async function getActiveQdrantConfig(): Promise<{ endpoint: string; apiKey?: string }> {
  const config = await readQdrantConfig();
  if (!config.endpoint || !config.endpoint.trim()) {
    throw new RepoContextError(
      "Qdrant endpoint is not configured. Please open settings (connect_team_context) to configure your Qdrant URL.",
    );
  }
  return {
    endpoint: normalizeEndpoint(config.endpoint),
    apiKey: config.apiKey?.trim(),
  };
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
  const headers = qdrantHeaders(apiKey);

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

/**
 * Ensure the target Qdrant collection exists (creates it with Cosine distance if absent).
 */
export async function ensureCollection(
  collectionName: string = KNOWLEDGE_BASE_COLLECTION,
  vectorSize: number = GEMINI_VECTOR_SIZE,
): Promise<void> {
  const { endpoint, apiKey } = await getActiveQdrantConfig();
  const headers = qdrantHeaders(apiKey);

  try {
    const checkRes = await fetch(`${endpoint}/collections/${collectionName}`, {
      method: "GET",
      headers,
    });

    if (checkRes.status === 200) {
      const collData = (await checkRes.json()) as {
        result?: {
          config?: {
            params?: {
              vectors?: { size?: number } | Record<string, { size?: number }>;
            };
          };
        };
      };
      const vectorsConfig = collData.result?.config?.params?.vectors;
      const existingSize =
        typeof vectorsConfig === "object" && vectorsConfig !== null && "size" in vectorsConfig
          ? (vectorsConfig as { size?: number }).size
          : undefined;

      if (existingSize && existingSize !== vectorSize) {
        // Re-create collection with correct vector dimensions for gemini-embedding-2 (3072)
        await fetch(`${endpoint}/collections/${collectionName}`, {
          method: "DELETE",
          headers,
        });
        const recreateRes = await fetch(`${endpoint}/collections/${collectionName}`, {
          method: "PUT",
          headers,
          body: JSON.stringify({
            vectors: {
              size: vectorSize,
              distance: "Cosine",
            },
          }),
        });
        if (!recreateRes.ok) {
          const errText = await recreateRes.text().catch(() => recreateRes.statusText);
          throw new RepoContextError(
            `Failed to recreate Qdrant collection "${collectionName}" with ${vectorSize} dimensions: ${errText}`,
          );
        }
      }
      return;
    }

    if (checkRes.status === 404) {
      const createRes = await fetch(`${endpoint}/collections/${collectionName}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          vectors: {
            size: vectorSize,
            distance: "Cosine",
          },
        }),
      });

      if (!createRes.ok) {
        const errText = await createRes.text().catch(() => createRes.statusText);
        throw new RepoContextError(`Failed to create Qdrant collection "${collectionName}": ${errText}`);
      }
      return;
    }

    const text = await checkRes.text().catch(() => checkRes.statusText);
    throw new RepoContextError(`Error checking Qdrant collection "${collectionName}": ${text}`);
  } catch (err: unknown) {
    if (err instanceof RepoContextError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new RepoContextError(`Could not access Qdrant collection "${collectionName}": ${message}`);
  }
}

/**
 * List all skills stored in Qdrant knowledge-base collection.
 */
export async function listSkills(
  limit: number = 100,
  collectionName: string = KNOWLEDGE_BASE_COLLECTION,
): Promise<ListSkillsResult> {
  const { endpoint, apiKey } = await getActiveQdrantConfig();
  await ensureCollection(collectionName);

  const headers = qdrantHeaders(apiKey);
  try {
    const res = await fetch(`${endpoint}/collections/${collectionName}/points/scroll`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        limit,
        with_payload: true,
        with_vector: false,
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText);
      throw new RepoContextError(`Failed to scroll points from collection "${collectionName}": ${errText}`);
    }

    const data = (await res.json()) as {
      result?: {
        points?: Array<{
          id: string | number;
          payload?: {
            name?: string;
            description?: string;
            content?: string;
            serialized?: string;
            createdAt?: string;
            updatedAt?: string;
          };
        }>;
      };
    };

    const points = data.result?.points ?? [];
    const skills: SkillItem[] = points.map((p) => ({
      id: String(p.id),
      name: p.payload?.name || "Untitled Skill",
      description: p.payload?.description || "",
      content: p.payload?.content || "",
      serialized: p.payload?.serialized || "",
      createdAt: p.payload?.createdAt,
      updatedAt: p.payload?.updatedAt,
    }));

    // Sort newest updated first
    skills.sort((a, b) => {
      const timeA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const timeB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      return timeB - timeA;
    });

    return {
      skills,
      total: skills.length,
      collection: collectionName,
    };
  } catch (err: unknown) {
    if (err instanceof RepoContextError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new RepoContextError(`Failed to fetch skills from Qdrant: ${message}`);
  }
}

/**
 * Get a single skill by ID from the knowledge-base collection.
 */
export async function getSkill(
  id: string,
  collectionName: string = KNOWLEDGE_BASE_COLLECTION,
): Promise<SkillItem | null> {
  const { endpoint, apiKey } = await getActiveQdrantConfig();
  const headers = qdrantHeaders(apiKey);

  try {
    const res = await fetch(`${endpoint}/collections/${collectionName}/points/${encodeURIComponent(id)}`, {
      method: "GET",
      headers,
    });

    if (res.status === 404) return null;
    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText);
      throw new RepoContextError(`Failed to retrieve skill with ID "${id}": ${errText}`);
    }

    const data = (await res.json()) as {
      result?: {
        id: string | number;
        payload?: {
          name?: string;
          description?: string;
          content?: string;
          serialized?: string;
          createdAt?: string;
          updatedAt?: string;
        };
      };
    };

    if (!data.result) return null;
    const p = data.result;
    return {
      id: String(p.id),
      name: p.payload?.name || "Untitled Skill",
      description: p.payload?.description || "",
      content: p.payload?.content || "",
      serialized: p.payload?.serialized || "",
      createdAt: p.payload?.createdAt,
      updatedAt: p.payload?.updatedAt,
    };
  } catch (err: unknown) {
    if (err instanceof RepoContextError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new RepoContextError(`Failed to get skill "${id}": ${message}`);
  }
}

/**
 * Create or update a skill in Qdrant knowledge-base collection.
 * 1. Serializes name, description, content using serializeSkillDocument (#name: ...\n\n#description: ...\n\n#content: ...)
 * 2. Generates Gemini embedding vector (768-dim)
 * 3. Ensures collection exists and upserts point with payload
 */
export async function upsertSkill(
  doc: SkillDocument,
  collectionName: string = KNOWLEDGE_BASE_COLLECTION,
): Promise<SkillItem> {
  if (!doc.name || !doc.name.trim()) {
    throw new RepoContextError("Skill name is required.");
  }
  if (!doc.content || !doc.content.trim()) {
    throw new RepoContextError("Skill content is required.");
  }

  const { endpoint, apiKey } = await getActiveQdrantConfig();
  await ensureCollection(collectionName);

  const id = doc.id && doc.id.trim() ? doc.id.trim() : crypto.randomUUID();
  const serialized = serializeSkillDocument({
    name: doc.name,
    description: doc.description || "",
    content: doc.content,
  });

  // Generate vector embedding via Gemini text-embedding-004
  const vector = await generateGeminiEmbedding(serialized);

  const now = new Date().toISOString();
  const payload = {
    name: doc.name.trim(),
    description: (doc.description || "").trim(),
    content: doc.content.trim(),
    serialized,
    createdAt: doc.createdAt || now,
    updatedAt: now,
  };

  const headers = qdrantHeaders(apiKey);
  try {
    const res = await fetch(`${endpoint}/collections/${collectionName}/points?wait=true`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        points: [
          {
            id,
            vector,
            payload,
          },
        ],
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText);
      throw new RepoContextError(`Failed to save skill into Qdrant collection "${collectionName}": ${errText}`);
    }

    return {
      id,
      name: payload.name,
      description: payload.description,
      content: payload.content,
      serialized: payload.serialized,
      createdAt: payload.createdAt,
      updatedAt: payload.updatedAt,
    };
  } catch (err: unknown) {
    if (err instanceof RepoContextError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new RepoContextError(`Failed to upsert skill "${doc.name}": ${message}`);
  }
}

/**
 * Delete a skill from Qdrant knowledge-base collection.
 */
export async function deleteSkill(
  id: string,
  collectionName: string = KNOWLEDGE_BASE_COLLECTION,
): Promise<boolean> {
  if (!id || !id.trim()) {
    throw new RepoContextError("Skill ID is required for deletion.");
  }

  const { endpoint, apiKey } = await getActiveQdrantConfig();
  const headers = qdrantHeaders(apiKey);

  try {
    const res = await fetch(`${endpoint}/collections/${collectionName}/points/delete?wait=true`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        points: [id.trim()],
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText);
      throw new RepoContextError(`Failed to delete skill from Qdrant: ${errText}`);
    }

    return true;
  } catch (err: unknown) {
    if (err instanceof RepoContextError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new RepoContextError(`Failed to delete skill "${id}": ${message}`);
  }
}

/**
 * Semantic search skills in Qdrant knowledge-base collection using Gemini query embeddings.
 */
export async function searchSkills(
  query: string,
  limit: number = 10,
  collectionName: string = KNOWLEDGE_BASE_COLLECTION,
): Promise<SkillSearchResult[]> {
  if (!query || !query.trim()) {
    throw new RepoContextError("Search query cannot be empty.");
  }

  const { endpoint, apiKey } = await getActiveQdrantConfig();
  await ensureCollection(collectionName);

  // Generate embedding for search query
  const queryVector = await generateGeminiEmbedding(query.trim());

  const headers = qdrantHeaders(apiKey);
  try {
    const res = await fetch(`${endpoint}/collections/${collectionName}/points/search`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        vector: queryVector,
        limit,
        with_payload: true,
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText);
      throw new RepoContextError(`Semantic search query failed in Qdrant: ${errText}`);
    }

    const data = (await res.json()) as {
      result?: Array<{
        id: string | number;
        score: number;
        payload?: {
          name?: string;
          description?: string;
          content?: string;
          serialized?: string;
          createdAt?: string;
          updatedAt?: string;
        };
      }>;
    };

    const results = data.result ?? [];
    return results.map((r) => ({
      id: String(r.id),
      score: r.score,
      name: r.payload?.name || "Untitled Skill",
      description: r.payload?.description || "",
      content: r.payload?.content || "",
      serialized: r.payload?.serialized || "",
      createdAt: r.payload?.createdAt,
      updatedAt: r.payload?.updatedAt,
    }));
  } catch (err: unknown) {
    if (err instanceof RepoContextError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new RepoContextError(`Failed to perform semantic search: ${message}`);
  }
}

export { readQdrantConfig, saveQdrantConfig, clearQdrantConfig };
