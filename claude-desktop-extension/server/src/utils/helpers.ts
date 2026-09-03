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

export function buildPanel(defaultTab: "credentials" | "config" = "credentials"): string {
  const bundle = loadBundle();
  const skillsComp = loadSkillsComponent();
  const widgetPath = resolveWidgetPath("panel.html");
  let html = readFileSync(widgetPath, "utf8")
    .replace("/*__EXT_APPS_BUNDLE__*/", () => bundle)
    .replace("/*__SKILLS_COMPONENT__*/", () => skillsComp);
  if (defaultTab === "config") {
    html = html.replace('activeTopTab: "credentials"', 'activeTopTab: "config"');
  }
  return html;
}

export function buildSkillsPanel(): string {
  const bundle = loadBundle();
  const skillsComp = loadSkillsComponent();
  const widgetPath = resolveWidgetPath("skills.html");
  return readFileSync(widgetPath, "utf8")
    .replace("/*__EXT_APPS_BUNDLE__*/", () => bundle)
    .replace("/*__SKILLS_COMPONENT__*/", () => skillsComp);
}

export function buildConfigPanel(): string {
  return buildPanel("config");
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

  switch (id) {
    case "github":
      return {
        connectionId: "github",
        serviceName: "GitHub",
        skillName: "How to use GitHub tools",
        description: "Usage guidelines, repository architecture, and code navigation rules",
        readInstruction:
          'Before interacting with our codebases or searching code, read the skill "How to use GitHub tools" by calling skills_search({ query: "How to use GitHub tools" }) or get_skills to learn our active repositories, file structures, and code search rules.',
      };

    case "notion":
      return {
        connectionId: "notion",
        serviceName: "Notion",
        skillName: "How to use Notion tools",
        description: "Active pages, databases, and database filter specifications",
        readInstruction:
          'Before querying Notion or looking up project documentation, read the skill "How to use Notion tools" by calling skills_search({ query: "How to use Notion tools" }) or get_skills to learn our active documentation resources and exact database filter schemas.',
      };

    case "sql":
      return {
        connectionId: "sql",
        serviceName: "SQL Database",
        skillName: "How to use SQL Database tools",
        description: "Database querying, schema inspection, and safety guidelines",
        readInstruction:
          'Before writing or executing database queries, consult the database schema and guidelines using sql_get_schema to inspect table definitions, foreign keys, and query limits.',
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
        activeIds.add(id.trim().toLowerCase());
      }
    });
  } else if (connections && typeof connections === "object") {
    Object.entries(connections).forEach(([key, conn]) => {
      if (!conn) return;
      const id = key.trim().toLowerCase();
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
    if (!orderedIds.includes(id)) {
      const item = resolveSkillOfConnection(id);
      if (item) result.push(item);
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

  let activeReposStr = "None configured";
  if (options?.activeRepos && options.activeRepos.length > 0) {
    const names = options.activeRepos
      .map((r) => (typeof r === "string" ? r : r.description ? `${r.name} (${r.description})` : r.name))
      .filter(Boolean);
    if (names.length > 0) {
      activeReposStr = names.join(", ");
    }
  }

  let activeNotionStr = "All workspace documentation accessible";
  if (options?.activeNotionPages && options.activeNotionPages.length > 0) {
    const formatted = options.activeNotionPages
      .map((p) => {
        if (typeof p === "string") return p;
        const icon = p.icon || (p.type === "database" ? "🗄️" : "📄");
        const title = p.title || p.id || "Untitled";
        const desc = p.description ? ` (${p.description})` : "";
        const typeBadge = p.type === "database" ? " [Database]" : "";
        return `${icon} ${title}${typeBadge}${desc}`;
      })
      .filter(Boolean);
    if (formatted.length > 0) {
      activeNotionStr = formatted.join(", ");
    }
  }

  const connectionSkills = resolveConnectionSkills(options?.connections, options);

  let skillsSection = "";
  if (connectionSkills.length > 0) {
    const list = connectionSkills
      .map((s) => `- **${s.skillName}** (${s.serviceName}): ${s.readInstruction}`)
      .join("\n");

    skillsSection = `\nRequired Connection Skills to Read:\nBased on the connections configured for our team, you MUST read and consult these guide skills in our vector knowledge base before invoking tools for these services:\n${list}\n`;
  }

  return `You are my Team Assistant and Engineering Co-Pilot helping me understand and navigate the context of our team's work.

Current User: ${userName}${userRole}
Active Repositories: ${activeReposStr}
Active Notion Resources: ${activeNotionStr}
${skillsSection}
Please assist me throughout our work by using the \`my-team-context-mcp-server\` tools:
1. Team Knowledge & Skills: Query our vector knowledge base with \`skills_search\` and \`get_skills\` to retrieve relevant engineering procedures, guidelines, and playbooks.
2. Codebase Context: Consult our configured GitHub repositories for codebase architecture, style conventions, and implementation patterns.
3. Project Specifications: Access our Notion workspace documents for product requirements and specifications.
4. Design & Goals: When creating UI mockups, designing components, or building features, align strictly with our team's branding colors, design system, and project goals.
5. SQL Database Querying: Use \`sql_get_schema\` and \`sql_execute_query\` to inspect database schemas, write optimized SQL queries, and analyze data for our team.

Safety & Approvals:
- Always ask for explicit user approval before executing any actions that edit or modify data (including INSERT, UPDATE, DELETE, ALTER, DROP in the database, editing or creating Notion pages, or modifying skills/configurations).

Please confirm you are ready to assist with our team context and give a brief greeting!`;
}

export const buildDefaultSystemPrompt = buildTeamContextSystemPrompt;

export function getDefaultSystemPrompt(options?: SystemPromptContextOptions): string {
  return buildTeamContextSystemPrompt(options);
}

export * from "./notion-guide.js";
export * from "./github-guide.js";

