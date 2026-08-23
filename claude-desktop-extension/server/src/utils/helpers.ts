import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolTextResponse } from "../tools/types.js";

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
function loadBundle(): string {
  return readFileSync(
    require.resolve("@modelcontextprotocol/ext-apps/app-with-deps"),
    "utf8",
  ).replace(/export\{([^}]+)\};?\s*$/, (_: string, body: string) => {
    const pairs = body.split(",").map((part) => {
      const [local, exported] = part.split(" as ").map((s) => s.trim());
      return `${exported ?? local}:${local}`;
    });
    return `globalThis.ExtApps={${pairs.join(",")}};`;
  });
}

function resolveWidgetPath(widgetFileName: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidatePaths = [
    path.resolve(here, "..", "widgets", widgetFileName),
    path.resolve(here, "..", "..", "widgets", widgetFileName),
  ];

  const found = candidatePaths.find((p) => existsSync(p));
  if (!found) {
    throw new Error(`Could not find ${widgetFileName} in candidates: ${candidatePaths.join(", ")}`);
  }
  return found;
}

export function buildPanel(defaultTab: "credentials" | "config" = "credentials"): string {
  const bundle = loadBundle();
  const widgetPath = resolveWidgetPath("panel.html");
  let html = readFileSync(widgetPath, "utf8").replace("/*__EXT_APPS_BUNDLE__*/", () => bundle);
  if (defaultTab === "config") {
    html = html.replace('activeTopTab: "credentials"', 'activeTopTab: "config"');
  }
  return html;
}

export function buildSkillsPanel(): string {
  const bundle = loadBundle();
  const widgetPath = resolveWidgetPath("skills.html");
  return readFileSync(widgetPath, "utf8").replace("/*__EXT_APPS_BUNDLE__*/", () => bundle);
}

export function buildConfigPanel(): string {
  return buildPanel("config");
}


export function getDefaultSystemPrompt(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidatePaths = [
    path.resolve(here, "..", "DEFAULT_SYSTEM_PROMPT"),
    path.resolve(here, "..", "..", "DEFAULT_SYSTEM_PROMPT"),
    path.resolve(process.cwd(), "DEFAULT_SYSTEM_PROMPT"),
    path.resolve(process.cwd(), "claude-desktop-extension", "server", "DEFAULT_SYSTEM_PROMPT"),
  ];

  const found = candidatePaths.find((p) => existsSync(p));
  if (found) {
    return readFileSync(found, "utf8");
  }

  return `# Role & Purpose\n\nYou are an intelligent Team Assistant and Context-Aware Engineering Co-Pilot.`;
}

