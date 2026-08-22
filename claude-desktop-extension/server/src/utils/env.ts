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
  GITHUB_TOKEN?: string;
  NOTION_API_KEY?: string;
  QDRANT_URL?: string;
  QDRANT_API_KEY?: string;
  DATABASE_URL?: string;
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

  return {
    GITHUB_TOKEN: fileConfig.GITHUB_TOKEN || process.env.GITHUB_TOKEN || process.env.REPO_CONTEXT_TOKEN || "",
    NOTION_API_KEY: fileConfig.NOTION_API_KEY || process.env.NOTION_API_KEY || "",
    QDRANT_URL: fileConfig.QDRANT_URL || fileConfig.QDRANT_ENDPOINT || process.env.QDRANT_URL || process.env.QDRANT_ENDPOINT || "",
    QDRANT_API_KEY: fileConfig.QDRANT_API_KEY || process.env.QDRANT_API_KEY || "",
    DATABASE_URL: fileConfig.DATABASE_URL || process.env.DATABASE_URL || "",
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
