/**
 * Type definitions for tools in the Team Context extension.
 */

/* ------------------------------------------------------------------ *
 * GitHub Identity & Repository Types
 * ------------------------------------------------------------------ */

export interface ValidateTokenResult {
  valid: boolean;
  login?: string;
  reason?: string;
}

export interface WhoamiResult {
  authenticated: boolean;
  login?: string;
  reason?: string;
}

export interface RepoSummary {
  fullName: string;
  private: boolean;
  defaultBranch: string;
  description: string | null;
  language: string | null;
  pushedAt: string;
}

export interface RepoMetaResult {
  fullName: string;
  private: boolean;
  defaultBranch: string;
  description: string | null;
  language: string | null;
  pushedAt: string;
  size?: number;
}

/* ------------------------------------------------------------------ *
 * Notion Types
 * ------------------------------------------------------------------ */

export interface ValidateNotionResult {
  valid: boolean;
  workspaceName?: string;
  botName?: string;
  botId?: string;
  reason?: string;
}

export interface NotionStatusResult {
  connected: boolean;
  botName?: string;
  botId?: string;
  reason?: string;
}

export interface NotionPageItem {
  id: string;
  title: string;
  url: string;
  icon?: string;
  createdTime?: string;
  lastEditedTime?: string;
  isSynced?: boolean;
  pointId?: string;
}

export interface NotionPagePreviewResult {
  id: string;
  title: string;
  url: string;
  icon?: string;
  prefix: string;
  suggestedName: string;
  suggestedDescription: string;
  content: string;
  exists: boolean;
  existingSkill?: SkillItem | null;
}

/* ------------------------------------------------------------------ *
 * Qdrant Types
 * ------------------------------------------------------------------ */

export interface ValidateQdrantResult {
  valid: boolean;
  endpoint?: string;
  version?: string;
  collections?: string[];
  collectionsCount?: number;
  reason?: string;
}

export interface QdrantStatusResult {
  connected: boolean;
  endpoint?: string;
  collectionsCount?: number;
  collections?: string[];
  reason?: string;
}

/* ------------------------------------------------------------------ *
 * SQL Database Types
 * ------------------------------------------------------------------ */

export interface ValidateSqlResult {
  valid: boolean;
  dialect?: string;
  database?: string;
  host?: string;
  port?: number;
  reason?: string;
}

export interface SqlStatusResult {
  connected: boolean;
  dialect?: string;
  database?: string;
  host?: string;
  reason?: string;
}

/* ------------------------------------------------------------------ *
 * Gemini Embedding Types
 * ------------------------------------------------------------------ */

export interface ValidateGeminiResult {
  valid: boolean;
  model?: string;
  displayName?: string;
  reason?: string;
}

export interface GeminiStatusResult {
  connected: boolean;
  model?: string;
  reason?: string;
}

/* ------------------------------------------------------------------ *
 * Skills & Knowledge Base Types
 * ------------------------------------------------------------------ */

export interface SkillDocumentMetadata {
  importFromFile?: string;
  [key: string]: unknown;
}

export interface SkillDocument {
  id?: string;
  name: string;
  description: string;
  content: string;
  metadata?: SkillDocumentMetadata;
  createdAt?: string;
  updatedAt?: string;
}

export interface SkillItem {
  id: string;
  name: string;
  description: string;
  content: string;
  metadata?: SkillDocumentMetadata;
  serialized?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface SkillSearchResult extends SkillItem {
  score: number;
}

export interface ListSkillsResult {
  skills: SkillItem[];
  total: number;
  collection: string;
}

/* ------------------------------------------------------------------ *
 * Team Context Init & Aggregate Status Types
 * ------------------------------------------------------------------ */

export interface TeamContextStatusResult {
  github: {
    authenticated: boolean;
    login: string | null;
    activeRepo: string | null;
  };
  notion: {
    connected: boolean;
    botName: string | null;
  };
  qdrant: {
    connected: boolean;
    endpoint: string | null;
    collectionsCount: number;
  };
  sql: {
    connected: boolean;
    dialect: string | null;
    database: string | null;
  };
  gemini: {
    connected: boolean;
    model: string | null;
  };
}

/* ------------------------------------------------------------------ *
 * GitHub Tool Options & Output Types
 * ------------------------------------------------------------------ */

export interface ListReposOptions {
  query?: string;
  limit?: number;
}

export interface ListFilesOptions {
  repo?: string;
  path?: string;
  ref?: string;
  recursive?: boolean;
  limit?: number;
}

export interface ListFilesEntry {
  path: string;
  type: string;
  size?: number;
}

export interface ListFilesResult {
  repo: string;
  ref?: string;
  path: string;
  entries: ListFilesEntry[];
  fileCount?: number;
  truncated?: boolean;
  note?: string;
  error?: string;
}

export interface ReadFileOptions {
  repo?: string;
  path: string;
  ref?: string;
  startLine?: number;
  endLine?: number;
  maxChars?: number;
}

export interface ReadFileResult {
  repo: string;
  ref?: string;
  path: string;
  lines?: number;
  shown?: string;
  truncated?: boolean;
  note?: string;
  content?: string;
  error?: string;
}

export interface SearchCodeOptions {
  repo?: string;
  query: string;
  limit?: number;
}

export interface SearchCodeMatch {
  path: string;
  matches: string[];
}

export interface SearchCodeResult {
  repo: string;
  query: string;
  totalCount: number;
  results: SearchCodeMatch[];
  note?: string;
  error?: string;
}

export interface OverviewOptions {
  repo?: string;
}

export interface OverviewResult extends Partial<RepoMetaResult> {
  repo: string;
  ref?: string;
  languages?: string[];
  topLevel?: string[];
  readme?: string | null;
  error?: string;
}

/* ------------------------------------------------------------------ *
 * Application Configuration Types
 * ------------------------------------------------------------------ */

export interface ActiveRepoConfigItem {
  name: string;
  description: string;
}

export interface ActiveNotionPageConfigItem {
  id: string;
  title: string;
  url?: string;
  description?: string;
  lastEditedTime?: string;
  icon?: string;
}

export interface AppConfigPayload {
  username: string;
  "active-repos": ActiveRepoConfigItem[];
  "active-notion-pages"?: ActiveNotionPageConfigItem[];
  systemPrompt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AppConfigItem {
  id: string;
  username: string;
  activeRepos: ActiveRepoConfigItem[];
  activeNotionPages: ActiveNotionPageConfigItem[];
  systemPrompt: string;
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------------------------------------------ *
 * MCP Tool Response Types
 * ------------------------------------------------------------------ */

export interface ToolTextResponse {
  [x: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

