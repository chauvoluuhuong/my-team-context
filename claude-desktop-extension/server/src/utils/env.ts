/**
 * Helpers for loading, parsing, and updating server/.env file.
 */

import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export function getEnvPath(): string {
  if (process.env.ENV_FILE_PATH) return process.env.ENV_FILE_PATH;

  const candidatePaths = [
    path.resolve(here, "..", "..", ".env"),
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), "server", ".env"),
  ];

  for (const p of candidatePaths) {
    if (fs.existsSync(p)) return p;
  }

  // Default to server/.env relative to module location
  return path.resolve(here, "..", "..", ".env");
}

export interface TeamEnvConfig {
  CURRENT_USER_NAME?: string;
  CURRENT_USER_ROLE?: string;
  USER_NAME?: string;
  USER_ROLE?: string;
  AUTH_USERNAME?: string;
  AUTH_PASSWORD?: string;
  GITHUB_TOKEN?: string;
  NOTION_API_KEY?: string;
  QDRANT_URL?: string;
  QDRANT_API_KEY?: string;
  DATABASE_URL?: string;
  GEMINI_API_KEY?: string;
  [key: string]: string | undefined;
}

/**
 * Parses a simple .env file into key-value pairs.
 */
export function parseEnvContent(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();

    // Remove quotes if present
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }

    if (key) {
      result[key] = val;
    }
  }

  return result;
}

/**
 * Loads .env file into process.env if not already present.
 */
export function loadEnv(): TeamEnvConfig {
  const envPath = getEnvPath();
  try {
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, "utf8");
      const parsed = parseEnvContent(content);
      for (const [k, v] of Object.entries(parsed)) {
        if (!process.env[k] && v) {
          process.env[k] = v;
        }
      }
      return parsed;
    }
  } catch {
    // Ignore error if .env does not exist
  }
  return {};
}

/**
 * Reads .env file and merges with existing process.env.
 */
export async function readEnvConfig(): Promise<TeamEnvConfig> {
  const envPath = getEnvPath();
  let fileConfig: Record<string, string> = {};

  try {
    if (fs.existsSync(envPath)) {
      const content = await fsPromises.readFile(envPath, "utf8");
      fileConfig = parseEnvContent(content);
    }
  } catch {
    // Return what's available
  }

  const currentUserName =
    fileConfig.CURRENT_USER_NAME ||
    fileConfig.USER_NAME ||
    fileConfig.AUTH_USERNAME ||
    process.env.CURRENT_USER_NAME ||
    process.env.USER_NAME ||
    process.env.AUTH_USERNAME ||
    "";

  const currentUserRole =
    fileConfig.CURRENT_USER_ROLE ||
    fileConfig.USER_ROLE ||
    process.env.CURRENT_USER_ROLE ||
    process.env.USER_ROLE ||
    "";

  return {
    CURRENT_USER_NAME: currentUserName,
    CURRENT_USER_ROLE: currentUserRole,
    USER_NAME: currentUserName,
    USER_ROLE: currentUserRole,
    AUTH_USERNAME: currentUserName,
    AUTH_PASSWORD: fileConfig.AUTH_PASSWORD || process.env.AUTH_PASSWORD || "",
    GITHUB_TOKEN: fileConfig.GITHUB_TOKEN || process.env.GITHUB_TOKEN || process.env.REPO_CONTEXT_TOKEN || "",
    NOTION_API_KEY: fileConfig.NOTION_API_KEY || process.env.NOTION_API_KEY || "",
    QDRANT_URL: fileConfig.QDRANT_URL || fileConfig.QDRANT_ENDPOINT || process.env.QDRANT_URL || process.env.QDRANT_ENDPOINT || "",
    QDRANT_API_KEY: fileConfig.QDRANT_API_KEY || process.env.QDRANT_API_KEY || "",
    DATABASE_URL: fileConfig.DATABASE_URL || process.env.DATABASE_URL || "",
    GEMINI_API_KEY: fileConfig.GEMINI_API_KEY || process.env.GEMINI_API_KEY || "",
  };
}

/**
 * Saves/updates credentials in server/.env and synchronizes process.env.
 */
export async function writeEnvConfig(newVars: TeamEnvConfig): Promise<void> {
  const envPath = getEnvPath();
  let existingLines: string[] = [];

  try {
    if (fs.existsSync(envPath)) {
      const content = await fsPromises.readFile(envPath, "utf8");
      existingLines = content.split("\n");
    }
  } catch {
    existingLines = [];
  }

  const updatedKeys = new Set<string>();
  const outputLines: string[] = [];

  for (const line of existingLines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      outputLines.push(line);
      continue;
    }

    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) {
      outputLines.push(line);
      continue;
    }

    const key = trimmed.slice(0, eqIdx).trim();
    if (key in newVars) {
      const val = newVars[key] ?? "";
      outputLines.push(`${key}=${val}`);
      updatedKeys.add(key);
      process.env[key] = val;
    } else {
      outputLines.push(line);
    }
  }

  // Append new variables that weren't present in existing .env
  for (const [k, v] of Object.entries(newVars)) {
    if (!updatedKeys.has(k) && v !== undefined) {
      outputLines.push(`${k}=${v}`);
      process.env[k] = v;
    }
  }

  await fsPromises.writeFile(envPath, outputLines.join("\n").trim() + "\n", {
    mode: 0o600,
  });
}

/**
 * Completely clears server/.env file contents and resets tracked environment variables.
 */
export async function clearEnvConfig(): Promise<void> {
  const envPath = getEnvPath();
  try {
    await fsPromises.writeFile(envPath, "", { mode: 0o600 });
  } catch {
    // Ignore error if file cannot be written
  }

  // Clear tracked keys from process.env
  const keysToClear = [
    "CURRENT_USER_NAME",
    "CURRENT_USER_ROLE",
    "USER_NAME",
    "USER_ROLE",
    "AUTH_USERNAME",
    "AUTH_PASSWORD",
    "GITHUB_TOKEN",
    "REPO_CONTEXT_TOKEN",
    "NOTION_API_KEY",
    "QDRANT_URL",
    "QDRANT_ENDPOINT",
    "QDRANT_API_KEY",
    "DATABASE_URL",
    "GEMINI_API_KEY",
  ];

  for (const key of keysToClear) {
    delete process.env[key];
  }
}

