import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolTextResponse } from "../types.js";

const require = createRequire(import.meta.url);

/** Failures the user can act on — surfaced as tool errors, not stack traces. */
export class RepoContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoContextError";
  }
}

export const text = (value: unknown): ToolTextResponse => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
});

export const failure = (message: string): ToolTextResponse => ({
  content: [{ type: "text", text: message }],
  isError: true,
});

/**
 * Missing token, missing repo, and GitHub's own errors are all user-fixable and
 * come back as readable tool errors rather than crashing the handler — the
 * message tells the model which tool to call to recover.
 */
export function guarded<TArgs extends Record<string, any>, TExtra = unknown>(
  handler: (args: TArgs, extra?: TExtra) => Promise<ToolTextResponse>,
) {
  return async (args: TArgs, extra?: TExtra): Promise<ToolTextResponse> => {
    try {
      return await handler(args ?? ({} as TArgs), extra);
    } catch (err: unknown) {
      if (err instanceof RepoContextError) return failure(err.message);
      const message = err instanceof Error ? err.message : String(err);
      return failure(`repo-context failed: ${message}`);
    }
  };
}

/* ------------------------------------------------------------------ *
 * Widget HTML
 *
 * The iframe's CSP blocks CDN fetches, so the ext-apps browser bundle is
 * inlined into the HTML rather than imported. The rewrite turns the bundle's
 * trailing `export{...}` into a global assignment the widget can read.
 * ------------------------------------------------------------------ */
export function buildPanel(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));

  const bundle = readFileSync(
    require.resolve("@modelcontextprotocol/ext-apps/app-with-deps"),
    "utf8",
  ).replace(/export\{([^}]+)\};?\s*$/, (_: string, body: string) => {
    const pairs = body.split(",").map((part) => {
      const [local, exported] = part.split(" as ").map((s) => s.trim());
      return `${exported ?? local}:${local}`;
    });
    return `globalThis.ExtApps={${pairs.join(",")}};`;
  });

  const candidatePaths = [
    path.resolve(here, "..", "widgets", "panel.html"),
    path.resolve(here, "..", "..", "widgets", "panel.html"),
  ];

  const widgetPath = candidatePaths.find((p) => existsSync(p));
  if (!widgetPath) {
    throw new Error(`Could not find panel.html in candidates: ${candidatePaths.join(", ")}`);
  }

  return readFileSync(widgetPath, "utf8").replace("/*__EXT_APPS_BUNDLE__*/", () => bundle);
}
