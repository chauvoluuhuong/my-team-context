/**
 * Per-user credential and selection storage.
 *
 * Credentials for GitHub, Notion, Qdrant, and SQL are stored in OS keychain helpers
 * (macOS security / Linux secret-tool) or fallback to 0600 files.
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BackendKind, ProcessRunResult, SaveTokenResult, StoreState } from "../types.js";

const SERVICE = "claude-team-context";

const ACCOUNTS = {
  GITHUB: "github-pat",
  NOTION: "notion-api-key",
  QDRANT_KEY: "qdrant-api-key",
  SQL_CONN: "sql-connection-string",
} as const;

/**
 * Writable per-extension directory.
 */
export function dataDir(): string {
  return (
    process.env.TEAM_CONTEXT_DATA ||
    process.env.REPO_CONTEXT_DATA ||
    process.env.CLAUDE_PLUGIN_DATA ||
    path.join(os.homedir(), ".claude", "team-context")
  );
}

/* ------------------------------------------------------------------ *
 * Process Runner & Keychain Backends
 * ------------------------------------------------------------------ */

/** Run a command, feed it stdin, capture stdout. Never logs stdin. */
function run(cmd: string, args: string[], stdin: string | null = null): Promise<ProcessRunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", () => resolve({ code: -1, stdout: "", stderr: "" }));
    child.on("close", (code: number | null) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin ?? "");
  });
}

async function has(cmd: string): Promise<boolean> {
  const { code } = await run("which", [cmd]);
  return code === 0;
}

async function backend(): Promise<BackendKind> {
  if (process.env.REPO_CONTEXT_BACKEND === "file") return "file";
  if (process.platform === "darwin") return "security";
  if (process.platform === "linux" && (await has("secret-tool"))) return "secret-tool";
  return "file";
}

function secretPath(account: string): string {
  return path.join(dataDir(), `secret_${account}`);
}

/* ------------------------------------------------------------------ *
 * Generic Secret Storage
 * ------------------------------------------------------------------ */

export async function saveSecret(account: string, value: string): Promise<SaveTokenResult> {
  const kind = await backend();

  if (kind === "security") {
    const { code } = await run(
      "security",
      ["add-generic-password", "-U", "-a", account, "-s", SERVICE, "-w", value],
    );
    if (code === 0) return { stored: "keychain" };
  }

  if (kind === "secret-tool") {
    const { code } = await run(
      "secret-tool",
      ["store", `--label=Claude team-context ${account}`, "service", SERVICE, "account", account],
      `${value}\n`,
    );
    if (code === 0) return { stored: "keychain" };
  }

  const filePath = secretPath(account);
  await fs.mkdir(dataDir(), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, value, { mode: 0o600 });
  return {
    stored: "file",
    warning:
      `No OS keychain available on this platform, so the credential was written to ` +
      `${filePath} with 0600 permissions. Install libsecret (secret-tool) for keychain storage.`,
  };
}

export async function readSecret(account: string): Promise<string | null> {
  const kind = await backend();

  if (kind === "security") {
    const { code, stdout } = await run("security", [
      "find-generic-password",
      "-a",
      account,
      "-s",
      SERVICE,
      "-w",
    ]);
    if (code === 0 && stdout.trim()) return stdout.trim();
  }

  if (kind === "secret-tool") {
    const { code, stdout } = await run("secret-tool", [
      "lookup",
      "service",
      SERVICE,
      "account",
      account,
    ]);
    if (code === 0 && stdout.trim()) return stdout.trim();
  }

  try {
    const content = await fs.readFile(secretPath(account), "utf8");
    return content.trim() || null;
  } catch {
    return null;
  }
}

export async function clearSecret(account: string): Promise<void> {
  const kind = await backend();
  if (kind === "security") {
    await run("security", ["delete-generic-password", "-a", account, "-s", SERVICE]);
  }
  if (kind === "secret-tool") {
    await run("secret-tool", ["clear", "service", SERVICE, "account", account]);
  }
  await fs.rm(secretPath(account), { force: true });
}

/* ------------------------------------------------------------------ *
 * GitHub Credentials
 * ------------------------------------------------------------------ */

export async function saveToken(token: string): Promise<SaveTokenResult> {
  return saveSecret(ACCOUNTS.GITHUB, token);
}

export async function readToken(): Promise<string | null> {
  if (process.env.REPO_CONTEXT_TOKEN) return process.env.REPO_CONTEXT_TOKEN.trim();
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  return readSecret(ACCOUNTS.GITHUB);
}

export async function clearToken(): Promise<void> {
  return clearSecret(ACCOUNTS.GITHUB);
}

/* ------------------------------------------------------------------ *
 * Notion Credentials
 * ------------------------------------------------------------------ */

export async function saveNotionKey(apiKey: string): Promise<SaveTokenResult> {
  return saveSecret(ACCOUNTS.NOTION, apiKey);
}

export async function readNotionKey(): Promise<string | null> {
  if (process.env.NOTION_API_KEY) return process.env.NOTION_API_KEY.trim();
  return readSecret(ACCOUNTS.NOTION);
}

export async function clearNotionKey(): Promise<void> {
  return clearSecret(ACCOUNTS.NOTION);
}

/* ------------------------------------------------------------------ *
 * Qdrant Credentials & Settings
 * ------------------------------------------------------------------ */

export async function saveQdrantConfig(
  endpoint: string,
  apiKey?: string,
): Promise<{ stored: "keychain" | "file"; warning?: string }> {
  const state = await readState();
  await writeState({ ...state, qdrantEndpoint: endpoint.trim() });
  if (apiKey) {
    return saveSecret(ACCOUNTS.QDRANT_KEY, apiKey.trim());
  }
  return { stored: "file" };
}

export async function readQdrantConfig(): Promise<{ endpoint?: string; apiKey?: string }> {
  const state = await readState();
  const endpoint =
    process.env.QDRANT_URL?.trim() ||
    process.env.QDRANT_ENDPOINT?.trim() ||
    state.qdrantEndpoint;
  const apiKey =
    process.env.QDRANT_API_KEY?.trim() ||
    (await readSecret(ACCOUNTS.QDRANT_KEY)) ||
    undefined;
  return { endpoint, apiKey };
}

export async function clearQdrantConfig(): Promise<void> {
  const state = await readState();
  const { qdrantEndpoint, ...rest } = state;
  await writeState(rest);
  await clearSecret(ACCOUNTS.QDRANT_KEY);
}

/* ------------------------------------------------------------------ *
 * SQL Database Connection String
 * ------------------------------------------------------------------ */

export async function saveSqlConnectionString(connectionString: string): Promise<SaveTokenResult> {
  return saveSecret(ACCOUNTS.SQL_CONN, connectionString);
}

export async function readSqlConnectionString(): Promise<string | null> {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL.trim();
  return readSecret(ACCOUNTS.SQL_CONN);
}

export async function clearSqlConnectionString(): Promise<void> {
  return clearSecret(ACCOUNTS.SQL_CONN);
}

/* ------------------------------------------------------------------ *
 * State Storage
 * ------------------------------------------------------------------ */

function statePath(): string {
  return path.join(dataDir(), "state.json");
}

export interface ExtendedStoreState extends StoreState {
  qdrantEndpoint?: string;
  sqlDialect?: string;
}

export async function readState(): Promise<ExtendedStoreState> {
  try {
    return JSON.parse(await fs.readFile(statePath(), "utf8")) as ExtendedStoreState;
  } catch {
    return {};
  }
}

async function writeState(state: ExtendedStoreState): Promise<void> {
  await fs.mkdir(dataDir(), { recursive: true, mode: 0o700 });
  await fs.writeFile(statePath(), JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}

export async function setActiveRepo(repo: string, defaultBranch?: string): Promise<ExtendedStoreState> {
  const previous = await readState();
  const recent = [repo, ...(previous.recent ?? []).filter((r) => r !== repo)].slice(0, 8);
  const state: ExtendedStoreState = {
    ...previous,
    repo,
    defaultBranch,
    selectedAt: new Date().toISOString(),
    recent,
  };
  await writeState(state);
  return state;
}

export async function clearActiveRepo(): Promise<void> {
  const previous = await readState();
  const { repo, defaultBranch, selectedAt, ...rest } = previous;
  await writeState(rest);
}
