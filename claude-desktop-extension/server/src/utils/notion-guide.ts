/**
 * Utilities for generating and synchronizing the "How to use Notion tools" skill.
 */

import type { ActiveNotionPageConfigItem, SkillItem } from "../tools/types.js";
import { filterInstructions } from "../tools/notion.js";
import { upsertSkill, getNotionGuideSkillPointId } from "../services/vector-db.js";
import { buildConnectionSkillName } from "./helpers.js";

/**
 * Build the structured Markdown guide for using Notion tools with active resources.
 */
export async function buildNotionGuideSkillContent(
  activeNotionPages: ActiveNotionPageConfigItem[] = [],
  apiKeyOverride?: string,
): Promise<string> {
  const pages = activeNotionPages.filter((p) => p.type !== "database");
  const databases = activeNotionPages.filter((p) => p.type === "database");

  const skillName = buildConnectionSkillName("notion");
  const lines: string[] = [
    `# ${skillName}`,
    "",
    "This guide explains how to access, read, and query our team's active Notion workspace resources using the available Notion MCP tools.",
    "",
    "## Tool Reference",
    "- `notion_get_page`: Retrieve full Markdown content, blocks, inline databases, and comments for any Notion page or database.",
    "- `notion_search`: Deep schema-aware search across Notion database properties, page bodies, and comments with structured filtering and pagination.",
    "- `notion_list_resources`: Discover and list all accessible pages and databases across the workspace.",
    "- `notion_check_connection`: Test connectivity to the Notion workspace.",
    "",
  ];

  if (pages.length === 0 && databases.length === 0) {
    lines.push(
      "## Active Notion Resources",
      "",
      "No specific Notion resources are currently selected as active in the application configuration.",
      "- To discover accessible pages and databases in the workspace, call `notion_list_resources({ type: 'all' })`.",
      "- To read any page content, call `notion_get_page({ pageId: '<page-id>' })`.",
      "- To search across a database, call `notion_search({ databaseId: '<db-id>', searchText: '...' })`.",
      "",
    );
    return lines.join("\n");
  }

  lines.push("## Active Notion Resources & Usage Instructions", "");

  // Pages section
  if (pages.length > 0) {
    lines.push(
      "### Active Pages",
      "When inspecting product specs, RFCs, design docs, or team guidelines, use the **`notion_get_page`** tool with the page ID. This retrieves the complete document structure including subheadings, nested blocks, code snippets, callouts, and comments.",
      "",
    );

    for (const page of pages) {
      const icon = page.icon || "📄";
      const title = page.title || "Untitled Page";
      lines.push(`#### ${icon} ${title}`);
      lines.push(`- **ID**: \`${page.id}\``);
      lines.push(`- **Type**: \`Page\``);
      if (page.description && page.description.trim()) {
        lines.push(`- **Description**: ${page.description.trim()}`);
      }
      if (page.url) {
        lines.push(`- **URL**: [Open in Notion](${page.url})`);
      }
      lines.push(
        `- **How to fetch content**:`,
        "  ```json",
        `  notion_get_page({ "pageId": "${page.id}" })`,
        "  ```",
        "",
      );
    }
  }

  // Databases section
  if (databases.length > 0) {
    lines.push(
      "### Active Databases",
      "When searching tasks, sprints, roadmaps, or inventories, use the **`notion_search`** tool with the database ID. Use `filter` to narrow records by status, assignee, priority, or tags, and `searchText` for free-text search.",
      "",
    );

    for (const db of databases) {
      const icon = db.icon || "🗄️";
      const title = db.title || "Untitled Database";
      lines.push(`#### ${icon} ${title}`);
      lines.push(`- **Database ID**: \`${db.id}\``);
      lines.push(`- **Type**: \`Database\``);
      if (db.description && db.description.trim()) {
        lines.push(`- **Description**: ${db.description.trim()}`);
      }
      if (db.url) {
        lines.push(`- **URL**: [Open in Notion](${db.url})`);
      }
      lines.push(
        `- **Basic Search Example**:`,
        "  ```json",
        `  notion_search({ "databaseId": "${db.id}", "searchText": "search query" })`,
        "  ```",
        "",
      );

      // Filter Instructions section for this database
      lines.push(`##### Filter Instructions for "${title}"`);
      try {
        const instructions = await filterInstructions({
          databaseId: db.id,
          apiKeyOverride,
        });

        if (instructions?.filters && Object.keys(instructions.filters).length > 0) {
          lines.push(
            "Use the `filter` argument in `notion_search` to target specific properties. Below are the supported filter fields and accepted values for this database:",
            "",
            "| Property Name | Filter Type | Accepted Values / Formats |",
            "| :--- | :--- | :--- |",
          );

          for (const [propName, filterMeta] of Object.entries(instructions.filters) as [string, any][]) {
            let acceptedStr = "-";
            if (Array.isArray(filterMeta.accepted_values)) {
              acceptedStr = filterMeta.accepted_values.map((v: any) => `\`${v}\``).join(", ");
            } else if (filterMeta.type) {
              acceptedStr = filterMeta.type;
            }
            lines.push(`| **${propName}** | \`${filterMeta.type || "unknown"}\` | ${acceptedStr} |`);
          }
          lines.push("");
        }

        if (instructions?.examples && instructions.examples.length > 0) {
          lines.push("**Filter Query Examples**:", "");
          for (const ex of instructions.examples) {
            lines.push(`- *${ex.description}*:`);
            lines.push("  ```json");
            lines.push(`  notion_search(${JSON.stringify(ex.request, null, 2)})`);
            lines.push("  ```");
          }
          lines.push("");
        }
      } catch (err: any) {
        lines.push(
          `*(Filter instructions could not be fetched dynamically: ${err?.message || "Check Notion connectivity"})*`,
          "",
        );
      }
    }
  }

  return lines.join("\n");
}

/**
 * Synchronize the "How to use Notion tools" skill into Qdrant.
 * Always syncs/overwrites the single document point identified by getNotionGuideSkillPointId(username).
 */
export async function syncNotionGuideSkill(options: {
  username?: string;
  activeNotionPages?: ActiveNotionPageConfigItem[];
  apiKeyOverride?: string;
}): Promise<SkillItem | null> {
  const username = options.username || "default";
  const pages = options.activeNotionPages || [];

  try {
    const pointId = getNotionGuideSkillPointId(username);
    const content = await buildNotionGuideSkillContent(pages, options.apiKeyOverride);

    const skill = await upsertSkill({
      id: pointId,
      name: buildConnectionSkillName("notion"),
      description: "Instructions, active pages/databases guide, and filter instructions for Notion workspace",
      content,
      metadata: {
        source: "notion-guide",
        author: username,
        category: "notion",
        tags: ["notion", "guide", "tools", "filter-instructions"],
      },
    });

    return skill;
  } catch (err) {
    // If Qdrant is not configured or offline, log warning without failing configuration save
    console.warn("Could not sync Notion guide skill to Qdrant:", err);
    return null;
  }
}
