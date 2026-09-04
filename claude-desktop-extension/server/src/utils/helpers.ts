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

export function loadSkillsComponent(): string {
  const compPath = resolveWidgetPath("components/skills-component.js");
  return readFileSync(compPath, "utf8");
}

export function loadMentionComponent(): string {
  const compPath = resolveWidgetPath("components/mention-component.js");
  return readFileSync(compPath, "utf8");
}

export function buildPanel(defaultTab: "credentials" | "config" = "credentials"): string {
  const bundle = loadBundle();
  const mentionComp = loadMentionComponent();
  const skillsComp = loadSkillsComponent();
  const widgetPath = resolveWidgetPath("panel.html");
  let html = readFileSync(widgetPath, "utf8")
    .replace("/*__EXT_APPS_BUNDLE__*/", () => bundle)
    .replace("/*__MENTION_COMPONENT__*/", () => mentionComp)
    .replace("/*__SKILLS_COMPONENT__*/", () => skillsComp);
  if (defaultTab === "config") {
    html = html.replace('activeTopTab: "credentials"', 'activeTopTab: "config"');
  }
  return html;
}

export function buildSkillsPanel(): string {
  const bundle = loadBundle();
  const mentionComp = loadMentionComponent();
  const skillsComp = loadSkillsComponent();
  const widgetPath = resolveWidgetPath("skills.html");
  return readFileSync(widgetPath, "utf8")
    .replace("/*__EXT_APPS_BUNDLE__*/", () => bundle)
    .replace("/*__MENTION_COMPONENT__*/", () => mentionComp)
    .replace("/*__SKILLS_COMPONENT__*/", () => skillsComp);
}

export function buildConfigPanel(): string {
  return buildPanel("config");
}


export const SYSTEM_CONNECTIONS = new Set(["qdrant", "gemini"]);

/**
 * Check whether a connection ID is a system-internal connection (e.g. Qdrant, Gemini).
 * System connections are omitted from AI system prompts and user-facing guide skills.
 */
export function isSystemConnection(connectionId: string): boolean {
  return SYSTEM_CONNECTIONS.has(connectionId.trim().toLowerCase());
}

/**
 * Format connection ID into human-readable service name.
 * e.g. "github" -> "GitHub", "sql" -> "SQL Database", "notion" -> "Notion"
 */
export function getConnectionServiceName(connectionId: string): string {
  const id = connectionId.trim().toLowerCase();
  switch (id) {
    case "github":
      return "GitHub";
    case "notion":
      return "Notion";
    case "sql":
      return "SQL Database";
    default:
      return id
        .split(/[-_]+/)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
  }
}

/**
 * Centralized function to build the standardized guide skill name for using a connection.
 * e.g. "github" -> "How to use GitHub tools"
 *      "notion" -> "How to use Notion tools"
 *      "sql" -> "How to use SQL Database tools"
 *      "slack" -> "How to use Slack tools"
 */
export function buildConnectionSkillName(connectionId: string): string {
  const id = connectionId.trim().toLowerCase();
  switch (id) {
    case "github":
      return "How to use GitHub tools";
    case "notion":
      return "How to use Notion tools";
    case "sql":
      return "How to use SQL Database tools";
    default: {
      const serviceName = getConnectionServiceName(id);
      return `How to use ${serviceName} tools`;
    }
  }
}

export interface ConnectionSkillItem {
  connectionId: string;
  serviceName: string;
  skillName: string;
  description: string;
  readInstruction: string;
}

/**
 * Resolve the guide skill and agent instruction for a specific connection.
 */
export function resolveSkillOfConnection(connectionId: string): ConnectionSkillItem | null {
  const id = connectionId.trim().toLowerCase();
  if (isSystemConnection(id)) return null;

  const skillName = buildConnectionSkillName(id);
  const serviceName = getConnectionServiceName(id);

  switch (id) {
    case "github":
      return {
        connectionId: "github",
        serviceName,
        skillName,
        description: "Usage guidelines, repository architecture, and code navigation rules",
        readInstruction: `${skillName} (use get_skill to get it)`,
      };

    case "notion":
      return {
        connectionId: "notion",
        serviceName,
        skillName,
        description: "Active pages, databases, and database filter specifications",
        readInstruction: `${skillName} (use get_skill to get it)`,
      };

    case "sql":
      return {
        connectionId: "sql",
        serviceName,
        skillName,
        description: "Database querying, schema inspection, and safety guidelines",
        readInstruction: `${skillName} (use get_skill to get it)`,
      };

    default:
      return null;
  }
}

/**
 * Resolve all guide skills for added/active connections.
 */
export function resolveConnectionSkills(
  connections?: Record<string, any> | string[],
  options?: SystemPromptContextOptions,
): ConnectionSkillItem[] {
  const activeIds = new Set<string>();

  // 1. Check connections parameter if provided
  if (Array.isArray(connections)) {
    connections.forEach((id) => {
      if (typeof id === "string" && id.trim()) {
        const clean = id.trim().toLowerCase();
        if (!isSystemConnection(clean)) activeIds.add(clean);
      }
    });
  } else if (connections && typeof connections === "object") {
    Object.entries(connections).forEach(([key, conn]) => {
      if (!conn) return;
      const id = key.trim().toLowerCase();
      if (isSystemConnection(id)) return;
      if (conn.enabled !== false) {
        const hasCreds =
          conn.credentials &&
          typeof conn.credentials === "object" &&
          Object.values(conn.credentials).some((v) => Boolean(v && String(v).trim()));
        if (hasCreds || conn.enabled === true) {
          activeIds.add(id);
        }
      }
    });
  }

  // 2. Fall back to / augment with active options items
  if (options?.activeRepos && options.activeRepos.length > 0) {
    activeIds.add("github");
  }
  if (options?.activeNotionPages && options.activeNotionPages.length > 0) {
    activeIds.add("notion");
  }

  const result: ConnectionSkillItem[] = [];
  const orderedIds = ["github", "notion", "sql"];

  for (const id of orderedIds) {
    if (activeIds.has(id)) {
      const item = resolveSkillOfConnection(id);
      if (item) result.push(item);
    }
  }

  for (const id of activeIds) {
    if (!orderedIds.includes(id) && !isSystemConnection(id)) {
      const item =
        resolveSkillOfConnection(id) || {
          connectionId: id,
          serviceName: getConnectionServiceName(id),
          skillName: buildConnectionSkillName(id),
          description: `Integration guidelines and workflows for ${getConnectionServiceName(id)}`,
          readInstruction: `Use get_skill to retrieve "${buildConnectionSkillName(id)}" to learn how to interact with ${id} and follow the workflow to help automate work.`,
        };
      result.push(item);
    }
  }

  return result;
}

export interface SystemPromptContextOptions {
  userName?: string;
  userRole?: string;
  activeRepos?: (string | { name: string; description?: string })[];
  activeNotionPages?: (
    | string
    | {
        title?: string;
        id?: string;
        description?: string;
        icon?: string;
        type?: "page" | "database";
      }
  )[];
  connections?: Record<string, any> | string[];
}

export function buildTeamContextSystemPrompt(options?: SystemPromptContextOptions): string {
  const userName = options?.userName || "Team Member";
  const userRole = options?.userRole ? ` (${options.userRole})` : "";

  // Collect all active connection IDs (ignoring system connections: qdrant, gemini)
  const activeIds = new Set<string>();
  if (Array.isArray(options?.connections)) {
    options.connections.forEach((id) => {
      if (typeof id === "string" && id.trim()) {
        const clean = id.trim().toLowerCase();
        if (!isSystemConnection(clean)) activeIds.add(clean);
      }
    });
  } else if (options?.connections && typeof options.connections === "object") {
    Object.entries(options.connections).forEach(([key, conn]) => {
      if (!conn) return;
      const id = key.trim().toLowerCase();
      if (isSystemConnection(id)) return;
      if (conn.enabled !== false) {
        const hasCreds =
          conn.credentials &&
          typeof conn.credentials === "object" &&
          Object.values(conn.credentials).some((v) => Boolean(v && String(v).trim()));
        if (hasCreds || conn.enabled === true) {
          activeIds.add(id);
        }
      }
    });
  }

  if (options?.activeRepos && options.activeRepos.length > 0) {
    activeIds.add("github");
  }
  if (options?.activeNotionPages && options.activeNotionPages.length > 0) {
    activeIds.add("notion");
  }

  let connectionsSection = "";
  if (activeIds.size > 0) {
    const lines: string[] = [];
    const orderedIds = ["github", "notion", "sql"];
    const allIds = [
      ...orderedIds.filter((id) => activeIds.has(id)),
      ...Array.from(activeIds).filter((id) => !orderedIds.includes(id)),
    ];

    for (const id of allIds) {
      const skill = resolveSkillOfConnection(id);
      if (skill) {
        lines.push(`- **${skill.serviceName}**: ${skill.skillName} (use get_skill to get it)`);
      } else {
        const serviceName = getConnectionServiceName(id);
        lines.push(`- **${serviceName}**`);
      }
    }

    connectionsSection = `\nActive Connections:\n${lines.join("\n")}\n`;
  }

  return `You are my assistant helping me automate my work.

Current User: ${userName}${userRole}
${connectionsSection}
Read through the skill (using \`get_skill\`) and find the relevant workflow before doing your work. Always ask for user confirmation before executing any actions that modify or delete data.\n
Confirm if you understand the context and are ready to assist me with my work.
`;
}

export const buildDefaultSystemPrompt = buildTeamContextSystemPrompt;

export function getDefaultSystemPrompt(options?: SystemPromptContextOptions): string {
  return buildTeamContextSystemPrompt(options);
}

export * from "./notion-guide.js";
export * from "./github-guide.js";
export * from "./sql-guide.js";
export * from "./sync-connection-skills.js";
export * from "./mention.js";

