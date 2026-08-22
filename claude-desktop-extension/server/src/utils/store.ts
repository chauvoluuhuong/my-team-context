/**
 * Per-user credential and selection storage.
 *
 * The GitHub token is a credential for private source code, so it stays out of
 * the transcript and out of `ps` output. Nothing here passes the token as a
 * command-line argument — the OS keychain helpers read it from stdin instead,
 * because argv is world-readable on both macOS and Linux.
 *
 * Backends, in order of preference:
 *   macOS   → login keychain via `security`
 *   Linux   → libsecret via `secret-tool` (when installed)
 *   neither → a 0600 file, with a warning surfaced to the user
 *
 * The active repo is not a secret and lives in a plain JSON file next to it.
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BackendKind, ProcessRunResult, SaveTokenResult, StoreState } from "../types.js";

const SERVICE = "claude-repo-context";
const ACCOUNT = "github-pat";

/**
 * Writable per-extension directory. Claude sets CLAUDE_PLUGIN_DATA for plugin
 * processes; outside that we fall back to a stable path so the server still
 * works when run by hand.
 */
export function dataDir(): string {
  return (
    process.env.REPO_CONTEXT_DATA ||
    process.env.CLAUDE_PLUGIN_DATA ||
    path.join(os.homedir(), ".claude", "repo-context")
  );
}

/* ------------------------------------------------------------------ *
 * Token
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
  if (process.platform === "darwin") return "security";
  if (process.platform === "linux" && (await has("secret-tool"))) return "secret-tool";
  return "file";
}

function tokenPath(): string {
  return path.join(dataDir(), "token");
}

export async function saveToken(token: string): Promise<SaveTokenResult> {
  const kind = await backend();

  if (kind === "security") {
    // `-U` must precede `-w`; `-w` with no value makes `security` read the
    // password from stdin (twice — it asks for confirmation).
    const { code } = await run(
      "security",
      ["add-generic-password", "-U", "-a", ACCOUNT, "-s", SERVICE, "-w"],
      `${token}\n${token}\n`,
    );
    if (code === 0) return { stored: "keychain" };
  }

  if (kind === "secret-tool") {
    const { code } = await run(
      "secret-tool",
      ["store", "--label=Claude repo-context", "service", SERVICE, "account", ACCOUNT],
      `${token}\n`,
    );
    if (code === 0) return { stored: "keychain" };
  }

  await fs.mkdir(dataDir(), { recursive: true, mode: 0o700 });
  await fs.writeFile(tokenPath(), token, { mode: 0o600 });
  return {
    stored: "file",
    warning:
      `No OS keychain available on this platform, so the token was written to ` +
      `${tokenPath()} with 0600 permissions. Install libsecret (secret-tool) for ` +
      `keychain storage.`,
  };
}

export async function readToken(): Promise<string | null> {
  // Escape hatch for headless runs and tests, where prompting through a panel
  // isn't possible and the keychain may not be unlocked.
  if (process.env.REPO_CONTEXT_TOKEN) return process.env.REPO_CONTEXT_TOKEN.trim();

  const kind = await backend();

  if (kind === "security") {
    const { code, stdout } = await run("security", [
      "find-generic-password",
      "-a",
      ACCOUNT,
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
      ACCOUNT,
    ]);
    if (code === 0 && stdout.trim()) return stdout.trim();
  }

  try {
    const token = await fs.readFile(tokenPath(), "utf8");
    return token.trim() || null;
  } catch {
    return null;
  }
}

export async function clearToken(): Promise<void> {
  const kind = await backend();
  if (kind === "security") {
    await run("security", ["delete-generic-password", "-a", ACCOUNT, "-s", SERVICE]);
  }
  if (kind === "secret-tool") {
    await run("secret-tool", ["clear", "service", SERVICE, "account", ACCOUNT]);
  }
  await fs.rm(tokenPath(), { force: true });
}

/* ------------------------------------------------------------------ *
 * Active repo
 *
 * Survives restarts on purpose: the point of picking a repo once is that every
 * later session already knows which codebase the user means.
 * ------------------------------------------------------------------ */

function statePath(): string {
  return path.join(dataDir(), "state.json");
}

export async function readState(): Promise<StoreState> {
  try {
    return JSON.parse(await fs.readFile(statePath(), "utf8")) as StoreState;
  } catch {
    return {};
  }
}

async function writeState(state: StoreState): Promise<void> {
  await fs.mkdir(dataDir(), { recursive: true, mode: 0o700 });
  await fs.writeFile(statePath(), JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}

/** Record the repo the user picked, keeping a short history for quick re-selection. */
export async function setActiveRepo(repo: string, defaultBranch?: string): Promise<StoreState> {
  const previous = await readState();
  const recent = [repo, ...(previous.recent ?? []).filter((r) => r !== repo)].slice(0, 8);
  const state: StoreState = { repo, defaultBranch, selectedAt: new Date().toISOString(), recent };
  await writeState(state);
  return state;
}

export async function clearActiveRepo(): Promise<void> {
  const previous = await readState();
  await writeState({ recent: previous.recent ?? [] });
}
