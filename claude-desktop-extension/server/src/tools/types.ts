/**
 * Type definitions for tools in the GitHub Repo Context extension.
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
 * Tool Options & Output Types
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
  ref: string;
  path: string;
  entries: ListFilesEntry[];
  fileCount?: number;
  truncated?: boolean;
  note?: string;
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
  ref: string;
  path: string;
  lines: number;
  shown: string;
  truncated: boolean;
  note?: string;
  content: string;
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
}

export interface OverviewOptions {
  repo?: string;
}

export interface OverviewResult extends RepoMetaResult {
  ref: string;
  languages: string[];
  topLevel: string[];
  readme: string | null;
}

/* ------------------------------------------------------------------ *
 * MCP Tool Response Types
 * ------------------------------------------------------------------ */

export interface ToolTextResponse {
  [x: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}
