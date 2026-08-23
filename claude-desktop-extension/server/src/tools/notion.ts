/**
 * Notion integration and connection tools.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readNotionKey, saveNotionKey, clearNotionKey } from "../utils/store.js";
import { text, guarded, RepoContextError } from "../utils/helpers.js";
import type {
  ValidateNotionResult,
  NotionStatusResult,
  NotionPageItem,
} from "./types.js";

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

/**
 * Helper to build Notion API request headers.
 */
function notionHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey.trim()}`,
    "Notion-Version": NOTION_VERSION,
    "User-Agent": "claude-team-context",
    "Content-Type": "application/json",
  };
}

/**
 * Retrieve active Notion API key or throw user-friendly error.
 */
export async function getActiveNotionKey(): Promise<string> {
  const key = await readNotionKey();
  if (!key || !key.trim()) {
    throw new RepoContextError(
      "Notion API key is not configured. Please open settings (connect_team_context) to configure your Notion token.",
    );
  }
  return key.trim();
}

/**
 * Extract plain-text title from Notion page properties.
 */
export function extractPageTitle(page: any): string {
  if (!page || !page.properties) return "Untitled Page";
  for (const key of Object.keys(page.properties)) {
    const prop = page.properties[key];
    if (
      prop &&
      prop.type === "title" &&
      Array.isArray(prop.title) &&
      prop.title.length > 0
    ) {
      const titleStr = prop.title.map((t: any) => t.plain_text || "").join("").trim();
      if (titleStr) return titleStr;
    }
  }
  return "Untitled Page";
}

/**
 * Extract icon representation from Notion page.
 */
export function extractPageIcon(page: any): string {
  if (!page?.icon) return "📄";
  if (page.icon.type === "emoji") return page.icon.emoji || "📄";
  if (page.icon.type === "external") return "🔗";
  if (page.icon.type === "file") return "📎";
  return "📄";
}

/**
 * Convert Notion rich_text objects to Markdown format.
 */
export function richTextToMarkdown(richTextArray?: any[]): string {
  if (!Array.isArray(richTextArray) || richTextArray.length === 0) return "";
  return richTextArray
    .map((t: any) => {
      let content = t.plain_text || "";
      if (!content) return "";

      const annotations = t.annotations || {};
      if (annotations.code) content = `\`${content}\``;
      if (annotations.bold && annotations.italic) content = `***${content}***`;
      else if (annotations.bold) content = `**${content}**`;
      else if (annotations.italic) content = `*${content}*`;
      if (annotations.strikethrough) content = `~~${content}~~`;

      if (t.href) {
        content = `[${content}](${t.href})`;
      }
      return content;
    })
    .join("");
}

/**
 * Recursively fetch and convert Notion blocks to Markdown lines.
 */
export async function fetchNotionBlocksToMarkdown(
  apiKey: string,
  blockId: string,
  depth = 0,
  maxDepth = 2,
): Promise<string> {
  const headers = notionHeaders(apiKey);
  const cleanId = blockId.trim();

  let allBlocks: any[] = [];
  let startCursor: string | undefined = undefined;
  let hasMore = true;

  while (hasMore && allBlocks.length < 500) {
    const url = new URL(`${NOTION_API}/blocks/${cleanId}/children`);
    url.searchParams.set("page_size", "100");
    if (startCursor) {
      url.searchParams.set("start_cursor", startCursor);
    }

    const res = await fetch(url.toString(), { method: "GET", headers });
    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText);
      throw new RepoContextError(`Failed to fetch Notion blocks for ${cleanId}: ${errText}`);
    }

    const data = (await res.json()) as {
      results?: any[];
      has_more?: boolean;
      next_cursor?: string | null;
    };

    allBlocks.push(...(data.results || []));
    hasMore = Boolean(data.has_more && data.next_cursor);
    startCursor = data.next_cursor || undefined;
  }

  const lines: string[] = [];
  const indent = "  ".repeat(depth);

  for (const block of allBlocks) {
    const type = block.type;
    const blockData = block[type] || {};
    const text = richTextToMarkdown(blockData.rich_text);

    switch (type) {
      case "paragraph":
        lines.push(`${indent}${text}`);
        lines.push("");
        break;
      case "heading_1":
        lines.push("");
        lines.push(`${indent}# ${text}`);
        lines.push("");
        break;
      case "heading_2":
        lines.push("");
        lines.push(`${indent}## ${text}`);
        lines.push("");
        break;
      case "heading_3":
        lines.push("");
        lines.push(`${indent}### ${text}`);
        lines.push("");
        break;
      case "bulleted_list_item":
        lines.push(`${indent}- ${text}`);
        break;
      case "numbered_list_item":
        lines.push(`${indent}1. ${text}`);
        break;
      case "to_do":
        lines.push(`${indent}- [${blockData.checked ? "x" : " "}] ${text}`);
        break;
      case "toggle":
        lines.push(`${indent}> ${text}`);
        break;
      case "quote":
        lines.push(`${indent}> ${text}`);
        break;
      case "callout":
        lines.push(`${indent}> 💡 ${text}`);
        break;
      case "code":
        lines.push(`${indent}\`\`\`${blockData.language || ""}`);
        lines.push(`${indent}${text}`);
        lines.push(`${indent}\`\`\``);
        lines.push("");
        break;
      case "divider":
        lines.push(`${indent}---`);
        lines.push("");
        break;
      case "bookmark":
        lines.push(`${indent}[${blockData.url || "Bookmark"}](${blockData.url || ""})`);
        break;
      case "image": {
        const imgUrl = blockData.file?.url || blockData.external?.url || "";
        lines.push(`${indent}![image](${imgUrl})`);
        break;
      }
      case "child_page":
        lines.push(`${indent}📄 **${blockData.title || "Child Page"}**`);
        break;
      case "child_database":
        lines.push(`${indent}🗄️ **${blockData.title || "Child Database"}**`);
        break;
      default:
        if (text) {
          lines.push(`${indent}${text}`);
        }
        break;
    }

    // Recursively process nested child blocks
    if (block.has_children && depth < maxDepth) {
      try {
        const childMd = await fetchNotionBlocksToMarkdown(
          apiKey,
          block.id,
          depth + 1,
          maxDepth,
        );
        if (childMd) {
          lines.push(childMd);
        }
      } catch {
        // Skip child error
      }
    }
  }

  return lines.join("\n");
}

/**
 * Validate a Notion API key against the official Notion REST API.
 */
export async function validateNotionKey(apiKey: string): Promise<ValidateNotionResult> {
  if (!apiKey || !apiKey.trim()) {
    return { valid: false, reason: "Notion API key cannot be empty." };
  }

  try {
    const res = await fetch(`${NOTION_API}/users/me`, {
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
        "Notion-Version": NOTION_VERSION,
        "User-Agent": "claude-team-context",
      },
    });

    if (res.status === 401) {
      return {
        valid: false,
        reason: "Notion rejected the API key — please check that it is an active integration token.",
      };
    }

    if (!res.ok) {
      return {
        valid: false,
        reason: `Notion returned ${res.status} ${res.statusText}.`,
      };
    }

    const data = (await res.json()) as {
      name?: string;
      id?: string;
      bot?: { owner?: { user?: { name?: string } } };
    };

    const botName = data.name || data.bot?.owner?.user?.name || "Notion Bot";
    return {
      valid: true,
      botName,
      botId: data.id,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { valid: false, reason: `Could not reach Notion API: ${message}` };
  }
}

/**
 * Check the connection status with the stored or provided Notion API key.
 */
export async function notionCheckConnection(apiKeyOverride?: string): Promise<NotionStatusResult> {
  const key = apiKeyOverride?.trim() || (await readNotionKey());
  if (!key) {
    return {
      connected: false,
      reason: "No Notion API key configured yet. Call save_notion_key to save one.",
    };
  }

  const check = await validateNotionKey(key);
  if (!check.valid) {
    return {
      connected: false,
      reason: check.reason,
    };
  }

  return {
    connected: true,
    botName: check.botName,
    botId: check.botId,
  };
}

/**
 * Search and list pages in the Notion workspace.
 */
export async function searchNotionPages(params?: {
  query?: string;
  limit?: number;
  apiKeyOverride?: string;
}): Promise<NotionPageItem[]> {
  const apiKey = params?.apiKeyOverride?.trim() || (await getActiveNotionKey());
  const headers = notionHeaders(apiKey);

  const body: Record<string, any> = {
    filter: { value: "page", property: "object" },
    page_size: params?.limit || 100,
    sort: {
      direction: "descending",
      timestamp: "last_edited_time",
    },
  };

  if (params?.query && params.query.trim()) {
    body.query = params.query.trim();
  }

  try {
    const res = await fetch(`${NOTION_API}/search`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText);
      throw new RepoContextError(`Notion search failed (${res.status}): ${errText}`);
    }

    const data = (await res.json()) as { results?: any[] };
    const rawPages = data.results || [];

    return rawPages.map((page) => {
      const id = page.id;
      const title = extractPageTitle(page);
      const icon = extractPageIcon(page);
      const url =
        page.url || `https://www.notion.so/${id.replace(/-/g, "")}`;
      return {
        id,
        title,
        url,
        icon,
        createdTime: page.created_time,
        lastEditedTime: page.last_edited_time,
      };
    });
  } catch (err: unknown) {
    if (err instanceof RepoContextError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new RepoContextError(`Failed to search Notion workspace: ${message}`);
  }
}

/**
 * Fetch full page details and converted Markdown content for a Notion page.
 */
export async function fetchNotionPageContent(
  pageId: string,
  apiKeyOverride?: string,
): Promise<{
  id: string;
  title: string;
  url: string;
  icon: string;
  content: string;
  createdTime: string;
  lastEditedTime: string;
}> {
  const apiKey = apiKeyOverride?.trim() || (await getActiveNotionKey());
  const headers = notionHeaders(apiKey);
  const cleanId = pageId.trim();

  // 1. Fetch page metadata
  const pageRes = await fetch(`${NOTION_API}/pages/${cleanId}`, {
    method: "GET",
    headers,
  });

  if (!pageRes.ok) {
    const errText = await pageRes.text().catch(() => pageRes.statusText);
    throw new RepoContextError(`Failed to fetch Notion page ${cleanId}: ${errText}`);
  }

  const page = (await pageRes.json()) as any;
  const title = extractPageTitle(page);
  const icon = extractPageIcon(page);
  const url = page.url || `https://www.notion.so/${cleanId.replace(/-/g, "")}`;

  // 2. Fetch page blocks and convert to Markdown
  const bodyMarkdown = await fetchNotionBlocksToMarkdown(apiKey, cleanId);

  // Combine title header with body markdown
  const header = `# ${icon ? `${icon} ` : ""}${title}\n\n`;
  const fullContent = (header + bodyMarkdown).trim();

  return {
    id: cleanId,
    title,
    url,
    icon,
    content: fullContent,
    createdTime: page.created_time || new Date().toISOString(),
    lastEditedTime: page.last_edited_time || new Date().toISOString(),
  };
}

export function registerNotionTools(server: McpServer): void {
  server.registerTool(
    "notion_check_connection",
    {
      title: "Check Notion connection",
      description:
        "Test connectivity to the Notion workspace using the stored integration token, or test a newly provided token.",
      annotations: { title: "Check Notion connection", readOnlyHint: true },
      inputSchema: {
        apiKey: z
          .string()
          .optional()
          .describe("Optional Notion integration token (secret_...) to test without saving."),
      },
    },
    guarded(async ({ apiKey }: { apiKey?: string }) => {
      const status = await notionCheckConnection(apiKey);
      return text({
        connected: status.connected,
        botName: status.botName ?? null,
        botId: status.botId ?? null,
        status: status.connected ? "ok" : "error",
        detail: status.connected
          ? `Successfully connected to Notion as "${status.botName}".`
          : status.reason,
      });
    }),
  );

  server.registerTool(
    "save_notion_key",
    {
      title: "Save Notion API key",
      description: "Validate and store a Notion internal integration token in the OS keychain.",
      annotations: { title: "Save Notion API key", readOnlyHint: false },
      inputSchema: {
        apiKey: z.string().min(1).describe("Notion internal integration token (secret_...)"),
      },
    },
    guarded(async ({ apiKey }: { apiKey: string }) => {
      const check = await validateNotionKey(apiKey);
      if (!check.valid) {
        throw new RepoContextError(`Invalid Notion key: ${check.reason}`);
      }

      const { stored, warning } = await saveNotionKey(apiKey);
      return text({
        status: "ok",
        botName: check.botName,
        botId: check.botId,
        storage: stored,
        warning,
        message: `Notion API key validated and stored successfully (authenticated as "${check.botName}").`,
      });
    }),
  );

  server.registerTool(
    "notion_disconnect",
    {
      title: "Disconnect Notion",
      description: "Remove the stored Notion API key from this machine.",
      annotations: { title: "Disconnect Notion", readOnlyHint: false, destructiveHint: true },
      inputSchema: {},
    },
    guarded(async () => {
      await clearNotionKey();
      return text("Notion disconnected — the stored API key was removed.");
    }),
  );

  server.registerTool(
    "notion_list_pages",
    {
      title: "List Notion Pages",
      description: "Search and list accessible pages in the connected Notion workspace.",
      annotations: { title: "List Notion Pages", readOnlyHint: true },
      inputSchema: {
        query: z.string().optional().describe("Optional search query to filter Notion pages"),
        limit: z.number().optional().describe("Maximum number of pages to retrieve (default: 50)"),
      },
    },
    guarded(async ({ query, limit }: { query?: string; limit?: number }) => {
      const pages = await searchNotionPages({ query, limit: limit || 50 });
      return text({
        status: "ok",
        total: pages.length,
        pages,
      });
    }),
  );

  server.registerTool(
    "notion_get_page",
    {
      title: "Get Notion Page Content",
      description: "Fetch full Markdown content and metadata for a specific Notion page.",
      annotations: { title: "Get Notion Page", readOnlyHint: true },
      inputSchema: {
        pageId: z.string().min(1).describe("Notion Page ID (UUID format)"),
      },
    },
    guarded(async ({ pageId }: { pageId: string }) => {
      const pageData = await fetchNotionPageContent(pageId);
      return text(pageData);
    }),
  );
}
