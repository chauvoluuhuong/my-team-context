/**
 * Type definitions for the GitHub Repo Context MCP extension.
 */

/* ------------------------------------------------------------------ *
 * Storage & Credential Types
 * ------------------------------------------------------------------ */

export type BackendKind = "security" | "secret-tool" | "file";

export interface SaveTokenResult {
  stored: "keychain" | "file";
  warning?: string;
}

export interface StoreState {
  repo?: string;
  defaultBranch?: string;
  selectedAt?: string;
  recent?: string[];
}

export interface ProcessRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/* ------------------------------------------------------------------ *
 * Re-export Tool Types from tools/types.js
 * ------------------------------------------------------------------ */

export * from "./tools/types.js";
