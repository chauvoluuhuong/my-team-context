/**
 * Vector database service (Qdrant integration & Knowledge Base management).
 */

import crypto from "node:crypto";
import path from "node:path";
import { readQdrantConfig, saveQdrantConfig, clearQdrantConfig } from "../utils/store.js";

import { RepoContextError } from "../utils/helpers.js";
import { serializeSkillDocument } from "../utils/serializer.js";
import { generateGeminiEmbedding, GEMINI_VECTOR_SIZE } from "./embedding.js";
import type {
  ValidateQdrantResult,
  QdrantStatusResult,
  SkillDocument,
  SkillDocumentMetadata,
  SkillItem,
  SkillSearchResult,
  ListSkillsResult,
  ActiveRepoConfigItem,
  ActiveNotionPageConfigItem,
  AppConfigItem,
  AppConfigPayload,
  TeamUserItem,
} from "../tools/types.js";

export const KNOWLEDGE_BASE_COLLECTION = "knowledge-base";
export const APP_CONFIG_COLLECTION = "app-config";
export const USERS_COLLECTION = "users";


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
            metadata?: SkillDocumentMetadata;
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
      metadata: p.payload?.metadata,
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
 * Get a single skill by ID or Name from the knowledge-base collection.
 */
export async function getSkill(
  idOrName: string,
  collectionName: string = KNOWLEDGE_BASE_COLLECTION,
): Promise<SkillItem | null> {
  const { endpoint, apiKey } = await getActiveQdrantConfig();
  const headers = qdrantHeaders(apiKey);

  const clean = idOrName.trim();
  if (!clean) return null;

  try {
    const res = await fetch(`${endpoint}/collections/${collectionName}/points/${encodeURIComponent(clean)}`, {
      method: "GET",
      headers,
    });

    if (res.ok) {
      const data = (await res.json()) as {
        result?: {
          id: string | number;
          payload?: {
            name?: string;
            description?: string;
            content?: string;
            metadata?: SkillDocumentMetadata;
            serialized?: string;
            createdAt?: string;
            updatedAt?: string;
          };
        };
      };

      if (data.result) {
        const p = data.result;
        return {
          id: String(p.id),
          name: p.payload?.name || "Untitled Skill",
          description: p.payload?.description || "",
          content: p.payload?.content || "",
          metadata: p.payload?.metadata,
          serialized: p.payload?.serialized || "",
          createdAt: p.payload?.createdAt,
          updatedAt: p.payload?.updatedAt,
        };
      }
    }

    // Fallback: find by name matching
    const list = await listSkills(100, collectionName);
    const found = list.skills.find(
      (s) => s.name.toLowerCase() === clean.toLowerCase() || s.id === clean,
    );
    return found || null;
  } catch (err: unknown) {
    if (err instanceof RepoContextError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new RepoContextError(`Failed to get skill "${idOrName}": ${message}`);
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
  const payload: {
    name: string;
    description: string;
    content: string;
    serialized: string;
    createdAt: string;
    updatedAt: string;
    metadata?: SkillDocumentMetadata;
  } = {
    name: doc.name.trim(),
    description: (doc.description || "").trim(),
    content: doc.content.trim(),
    serialized,
    createdAt: doc.createdAt || now,
    updatedAt: now,
  };

  if (doc.metadata !== undefined) {
    payload.metadata = doc.metadata;
  }

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
      metadata: payload.metadata,
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
          metadata?: SkillDocumentMetadata;
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
      metadata: r.payload?.metadata,
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

/* ------------------------------------------------------------------ *
 * App Configuration Collection Management (app-config)
 * ------------------------------------------------------------------ */

/**
 * Generate deterministic UUID for a user's app-config document in Qdrant.
 */
export function getAppConfigPointId(username: string): string {
  const hash = crypto
    .createHash("md5")
    .update(`app-config:${username.trim().toLowerCase()}`)
    .digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

/**
 * Generate deterministic UUID for a skill imported from a repository file.
 */
export function getSkillPointId(repo: string, filePath: string): string {
  const hash = crypto
    .createHash("md5")
    .update(`github-skill:${repo.trim().toLowerCase()}:${filePath.trim().toLowerCase()}`)
    .digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

/**
 * Generate deterministic UUID for a skill imported from a Notion page.
 */
export function getNotionSkillPointId(pageId: string): string {
  const hash = crypto
    .createHash("md5")
    .update(`notion-skill:${pageId.trim().toLowerCase()}`)
    .digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

/**
 * Generate deterministic UUID for a user document in Qdrant users collection.
 */
export function getUserPointId(name: string): string {
  const hash = crypto
    .createHash("md5")
    .update(`user:${name.trim().toLowerCase()}`)
    .digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}


/**
 * Centralized skill name suggestion and formatting function for GitHub files.
 * Prefix contains Git repo and file path, followed by the skill title.
 * e.g., "[github-repo: owner/repo, path: docs/guide.md] Architecture Overview"
 */
export function formatSkillName(repo: string, filePath: string, title?: string): string {
  const cleanRepo = repo.trim();
  const cleanPath = filePath.trim().replace(/^\/+/, "");
  const baseName = title && title.trim()
    ? title.trim()
    : path.basename(cleanPath, path.extname(cleanPath));
  return `[github-repo: ${cleanRepo}, path: ${cleanPath}] ${baseName}`;
}

/**
 * Centralized skill name suggestion and formatting function for Notion pages.
 * e.g., "[notion: Architecture & Design Decisions]"
 */
export function formatNotionSkillName(title: string): string {
  const cleanTitle = (title || "").trim() || "Untitled Page";
  return `[notion: ${cleanTitle}]`;
}

/**
 * Retrieve app configuration for a user from the app-config Qdrant collection.
 */
export async function getAppConfig(
  username?: string,
  collectionName: string = APP_CONFIG_COLLECTION,
): Promise<AppConfigItem | null> {
  const { endpoint, apiKey } = await getActiveQdrantConfig();
  await ensureCollection(collectionName);

  const headers = qdrantHeaders(apiKey);

  if (username && username.trim()) {
    const pointId = getAppConfigPointId(username);
    try {
      const res = await fetch(
        `${endpoint}/collections/${collectionName}/points/${encodeURIComponent(pointId)}`,
        {
          method: "GET",
          headers,
        },
      );

      if (res.ok) {
        const data = (await res.json()) as {
          result?: {
            id: string | number;
            payload?: {
              username?: string;
              "active-repos"?: Array<{ name?: string; description?: string }>;
              activeRepos?: Array<{ name?: string; description?: string }>;
              "active-notion-pages"?: Array<{
                id?: string;
                title?: string;
                url?: string;
                description?: string;
                lastEditedTime?: string;
                icon?: string;
              }>;
              activeNotionPages?: Array<{
                id?: string;
                title?: string;
                url?: string;
                description?: string;
                lastEditedTime?: string;
                icon?: string;
              }>;
              systemPrompt?: string;
              createdAt?: string;
              updatedAt?: string;
            };
          };
        };

        if (data.result?.payload) {
          const p = data.result.payload;
          const rawRepos = p["active-repos"] || p.activeRepos || [];
          const activeRepos: ActiveRepoConfigItem[] = rawRepos.map((r) => ({
            name: r.name || "",
            description: r.description || "",
          }));

          const rawNotion = p["active-notion-pages"] || p.activeNotionPages || [];
          const activeNotionPages: ActiveNotionPageConfigItem[] = rawNotion.map((n) => ({
            id: n.id || "",
            title: n.title || "",
            url: n.url || "",
            description: n.description || "",
            lastEditedTime: n.lastEditedTime || "",
            icon: n.icon || "📄",
          }));

          return {
            id: String(data.result.id),
            username: p.username || username,
            activeRepos,
            activeNotionPages,
            systemPrompt: p.systemPrompt || "",
            createdAt: p.createdAt || new Date().toISOString(),
            updatedAt: p.updatedAt || new Date().toISOString(),
          };
        }
      }
    } catch {
      // Fallback to scroll below
    }
  }

  // Scroll fallback or get latest configured
  try {
    const res = await fetch(`${endpoint}/collections/${collectionName}/points/scroll`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        limit: 10,
        with_payload: true,
        with_vector: false,
      }),
    });

    if (!res.ok) return null;

    const data = (await res.json()) as {
      result?: {
        points?: Array<{
          id: string | number;
          payload?: {
            username?: string;
            "active-repos"?: Array<{ name?: string; description?: string }>;
            activeRepos?: Array<{ name?: string; description?: string }>;
            "active-notion-pages"?: Array<{
              id?: string;
              title?: string;
              url?: string;
              description?: string;
              lastEditedTime?: string;
              icon?: string;
            }>;
            activeNotionPages?: Array<{
              id?: string;
              title?: string;
              url?: string;
              description?: string;
              lastEditedTime?: string;
              icon?: string;
            }>;
            systemPrompt?: string;
            createdAt?: string;
            updatedAt?: string;
          };
        }>;
      };
    };

    const points = data.result?.points ?? [];
    if (points.length === 0) return null;

    const matched = username?.trim()
      ? points.find(
          (p) => p.payload?.username?.toLowerCase() === username.trim().toLowerCase(),
        )
      : points[0];

    if (!matched || !matched.payload) return null;

    const rawRepos = matched.payload["active-repos"] || matched.payload.activeRepos || [];
    const activeRepos: ActiveRepoConfigItem[] = rawRepos.map((r) => ({
      name: r.name || "",
      description: r.description || "",
    }));

    const rawNotion = matched.payload["active-notion-pages"] || matched.payload.activeNotionPages || [];
    const activeNotionPages: ActiveNotionPageConfigItem[] = rawNotion.map((n) => ({
      id: n.id || "",
      title: n.title || "",
      url: n.url || "",
      description: n.description || "",
      lastEditedTime: n.lastEditedTime || "",
      icon: n.icon || "📄",
    }));

    return {
      id: String(matched.id),
      username: matched.payload.username || username || "",
      activeRepos,
      activeNotionPages,
      systemPrompt: matched.payload.systemPrompt || "",
      createdAt: matched.payload.createdAt || new Date().toISOString(),
      updatedAt: matched.payload.updatedAt || new Date().toISOString(),
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new RepoContextError(`Failed to retrieve app config: ${message}`);
  }
}

/**
 * Save or update app configuration in the app-config Qdrant collection.
 */
export async function saveAppConfig(
  params: {
    username: string;
    activeRepos: ActiveRepoConfigItem[];
    activeNotionPages?: ActiveNotionPageConfigItem[];
    systemPrompt?: string;
  },
  collectionName: string = APP_CONFIG_COLLECTION,
): Promise<AppConfigItem> {
  const username = params.username?.trim();
  if (!username) {
    throw new RepoContextError("Username is required to save application configuration.");
  }

  const { endpoint, apiKey } = await getActiveQdrantConfig();
  await ensureCollection(collectionName);

  const pointId = getAppConfigPointId(username);
  const existing = await getAppConfig(username, collectionName).catch(() => null);

  const now = new Date().toISOString();
  const createdAt = existing?.createdAt || now;
  const updatedAt = now;

  const cleanRepos: ActiveRepoConfigItem[] = (params.activeRepos || []).map((r) => ({
    name: (r.name || "").trim(),
    description: (r.description || "").trim(),
  }));

  const cleanNotionPages: ActiveNotionPageConfigItem[] = (
    params.activeNotionPages !== undefined
      ? params.activeNotionPages
      : existing?.activeNotionPages || []
  ).map((n) => ({
    id: (n.id || "").trim(),
    title: (n.title || "").trim(),
    url: (n.url || "").trim(),
    description: (n.description || "").trim(),
    lastEditedTime: (n.lastEditedTime || "").trim(),
    icon: (n.icon || "📄").trim(),
  }));

  const systemPrompt =
    params.systemPrompt !== undefined
      ? params.systemPrompt
      : existing?.systemPrompt || "";

  const payload: AppConfigPayload = {
    username,
    "active-repos": cleanRepos,
    "active-notion-pages": cleanNotionPages,
    systemPrompt,
    createdAt,
    updatedAt,
  };

  // Generate embedding vector or fallback to zero vector
  let vector: number[];
  try {
    const reposSummary = cleanRepos.map((r) => `${r.name} (${r.description})`).join(", ");
    const notionSummary = cleanNotionPages.map((n) => `${n.title} (${n.description})`).join(", ");
    const summary = `App config for @${username}. Active repos: ${reposSummary || "none"}. Active Notion pages: ${notionSummary || "none"}.`;
    vector = await generateGeminiEmbedding(summary);
  } catch {
    vector = new Array(GEMINI_VECTOR_SIZE).fill(0);
  }

  const headers = qdrantHeaders(apiKey);
  try {
    const res = await fetch(`${endpoint}/collections/${collectionName}/points?wait=true`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        points: [
          {
            id: pointId,
            vector,
            payload,
          },
        ],
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText);
      throw new RepoContextError(
        `Failed to save app config into Qdrant collection "${collectionName}": ${errText}`,
      );
    }

    return {
      id: pointId,
      username,
      activeRepos: cleanRepos,
      activeNotionPages: cleanNotionPages,
      systemPrompt,
      createdAt,
      updatedAt,
    };
  } catch (err: unknown) {
    if (err instanceof RepoContextError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new RepoContextError(`Could not save app config: ${message}`);
  }
}

/* ------------------------------------------------------------------ *
 * Team Users Collection Management (users)
 * ------------------------------------------------------------------ */

/**
 * Ensure the users collection exists in Qdrant.
 */
export async function ensureUsersCollection(collectionName: string = USERS_COLLECTION): Promise<void> {
  await ensureCollection(collectionName);
}

/**
 * List all users stored in the Qdrant users collection.
 */
export async function listUsers(collectionName: string = USERS_COLLECTION): Promise<TeamUserItem[]> {
  const { endpoint, apiKey } = await getActiveQdrantConfig();
  await ensureUsersCollection(collectionName);

  const headers = qdrantHeaders(apiKey);
  try {
    const res = await fetch(`${endpoint}/collections/${collectionName}/points/scroll`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        limit: 200,
        with_payload: true,
        with_vector: false,
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText);
      throw new RepoContextError(`Failed to retrieve users from Qdrant: ${errText}`);
    }

    const data = (await res.json()) as {
      result?: {
        points?: Array<{
          id: string | number;
          payload?: {
            name?: string;
            role?: string;
            createdAt?: string;
            updatedAt?: string;
          };
        }>;
      };
    };

    const points = data.result?.points ?? [];
    return points
      .map((p) => ({
        id: String(p.id),
        name: p.payload?.name || "",
        role: p.payload?.role || "Member",
        createdAt: p.payload?.createdAt,
        updatedAt: p.payload?.updatedAt,
      }))
      .filter((u) => u.name.length > 0)
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (err: unknown) {
    if (err instanceof RepoContextError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new RepoContextError(`Could not list users from Qdrant: ${message}`);
  }
}

/**
 * Get a user by name from Qdrant users collection.
 */
export async function getUser(name: string, collectionName: string = USERS_COLLECTION): Promise<TeamUserItem | null> {
  const cleanName = name?.trim();
  if (!cleanName) return null;

  const { endpoint, apiKey } = await getActiveQdrantConfig();
  await ensureUsersCollection(collectionName);

  const pointId = getUserPointId(cleanName);
  const headers = qdrantHeaders(apiKey);

  try {
    const res = await fetch(`${endpoint}/collections/${collectionName}/points/${pointId}`, {
      method: "GET",
      headers,
    });

    if (!res.ok) {
      if (res.status === 404) return null;
      // Scroll fallback if point retrieval fails
      const allUsers = await listUsers(collectionName).catch(() => []);
      return allUsers.find((u) => u.name.toLowerCase() === cleanName.toLowerCase()) || null;
    }

    const data = (await res.json()) as {
      result?: {
        id: string | number;
        payload?: {
          name?: string;
          role?: string;
          createdAt?: string;
          updatedAt?: string;
        };
      };
    };

    if (!data.result || !data.result.payload?.name) return null;

    return {
      id: String(data.result.id),
      name: data.result.payload.name,
      role: data.result.payload.role || "Member",
      createdAt: data.result.payload.createdAt,
      updatedAt: data.result.payload.updatedAt,
    };
  } catch {
    return null;
  }
}

/**
 * Create or update a team user in the Qdrant users collection.
 */
export async function createUser(
  params: { name: string; role: string },
  collectionName: string = USERS_COLLECTION,
): Promise<TeamUserItem> {
  const name = params.name?.trim();
  const role = params.role?.trim() || "Member";

  if (!name) {
    throw new RepoContextError("User name is required.");
  }

  const { endpoint, apiKey } = await getActiveQdrantConfig();
  await ensureUsersCollection(collectionName);

  const pointId = getUserPointId(name);
  const existing = await getUser(name, collectionName).catch(() => null);

  const now = new Date().toISOString();
  const createdAt = existing?.createdAt || now;
  const updatedAt = now;

  const payload = {
    name,
    role,
    createdAt,
    updatedAt,
  };

  const vector = new Array(GEMINI_VECTOR_SIZE).fill(0);
  const headers = qdrantHeaders(apiKey);

  try {
    const res = await fetch(`${endpoint}/collections/${collectionName}/points?wait=true`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        points: [
          {
            id: pointId,
            vector,
            payload,
          },
        ],
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText);
      throw new RepoContextError(`Failed to save user into Qdrant collection "${collectionName}": ${errText}`);
    }

    return {
      id: pointId,
      name,
      role,
      createdAt,
      updatedAt,
    };
  } catch (err: unknown) {
    if (err instanceof RepoContextError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new RepoContextError(`Could not create user: ${message}`);
  }
}

export { readQdrantConfig, saveQdrantConfig, clearQdrantConfig };


