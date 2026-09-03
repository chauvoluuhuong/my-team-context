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

export interface NotionResourceItem {
  id: string;
  type: "page" | "database";
  title: string;
  icon?: string | null;
  cover?: string | null;
  url: string;
  parent?: any;
  is_inline?: boolean;
  archived?: boolean;
  created_time?: string | null;
  last_edited_time?: string | null;
  properties_count?: number;
  property_names?: string[];
  description?: string | null;
  isSynced?: boolean;
  pointId?: string;
}

export interface NotionPageItem {
  id: string;
  type?: "page" | "database";
  title: string;
  url: string;
  icon?: string;
  description?: string | null;
  createdTime?: string;
  lastEditedTime?: string;
  properties_count?: number;
  property_names?: string[];
  isSynced?: boolean;
  pointId?: string;
}

export interface NotionListResourcesResult {
  resources: NotionResourceItem[];
  count: number;
  pages_count: number;
  databases_count: number;
}

export interface NotionFilterInstructionsResult {
  database: {
    id: string;
    name: string;
  };
  how_to_search: {
    method: string;
    endpoint: string;
    body_format: Record<string, unknown>;
  };
  filters: Record<string, unknown>;
  examples: Array<{
    description: string;
    request: Record<string, unknown>;
  }>;
}

export interface NotionResourceContentResult {
  id: string;
  type: "page" | "database";
  title: string;
  icon?: string | null;
  cover?: string | null;
  url: string;
  parent?: any;
  is_inline?: boolean;
  created_time?: string | null;
  last_edited_time?: string | null;
  properties?: Record<string, any>;
  markdown: string;
  inline_databases?: any[];
  inline_databases_count?: number;
  blocks_count?: number;
  comments?: any[];
  columns?: string[];
  row_count?: number;
  rows?: any[];
}

export interface NotionSearchResult {
  database: {
    id: string;
    title: string;
    icon?: any;
    url: string;
  };
  results: any[];
  count: number;
  total: number;
  offset: number;
  has_more: boolean;
  next_cursor: string | null;
  notice?: string | null;
  filter_applied?: any;
  notion_filter?: any;
  text_matching?: any;
  resolved?: Record<string, any>;
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

export interface TeamUserItem {
  id: string;
  name: string;
  role: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface SetupStatusResult {
  isSetupComplete: boolean;
  step: "qdrant_config" | "user_selection" | "completed";
  qdrant: {
    configured: boolean;
    connected: boolean;
    endpoint?: string | null;
    error?: string | null;
  };
  currentUser: {
    name: string | null;
    role: string | null;
  };
  users: TeamUserItem[];
  error?: string | null;
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
  type?: "page" | "database";
}

export interface ConnectionConfigItem {
  id?: string;
  enabled?: boolean;
  credentials?: Record<string, string>;
  updatedAt?: string;
}

export interface AppConfigPayload {
  username: string;
  "active-repos": ActiveRepoConfigItem[];
  "active-notion-pages"?: ActiveNotionPageConfigItem[];
  connections?: Record<string, ConnectionConfigItem>;
  systemPrompt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AppConfigItem {
  id: string;
  username: string;
  activeRepos: ActiveRepoConfigItem[];
  activeNotionPages: ActiveNotionPageConfigItem[];
  connections: Record<string, ConnectionConfigItem>;
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

