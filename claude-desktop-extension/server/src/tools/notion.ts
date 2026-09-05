/**
 * Notion integration and connection tools.
 *
 * Implements workspace resource discovery (pages and databases), self-describing filter
 * capability documents, deep recursive content rendering with inline databases and comments,
 * and schema-aware search.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readNotionKey } from "../utils/store.js";
import { readEnvConfig } from "../utils/env.js";
import { getAppConfig } from "../services/vector-db.js";
import { text, guarded, RepoContextError } from "../utils/helpers.js";
import type {
  ValidateNotionResult,
  NotionStatusResult,
  NotionResourceItem,
  NotionPageItem,
  NotionListResourcesResult,
  NotionFilterInstructionsResult,
  NotionResourceContentResult,
  NotionSearchResult,
} from "./types.js";

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const TTL_MS = 5 * 60 * 1000;
const MAX_SCAN_PAGES = 10; // up to 1000 rows scanned for schemas / filters
const MAX_CANDIDATE_PAGES = 10;
const CONTENT_CONCURRENCY = 6;
const MAX_CONTENT_PAGES = 500;

export class NotionError extends Error {
  status: number;
  code?: string;
  body?: any;

  constructor(status: number, body?: any) {
    super(body?.message || `Notion API error ${status}`);
    this.name = "NotionError";
    this.status = status;
    this.code = body?.code;
    this.body = body;
  }
}

export async function getEffectiveNotionKey(): Promise<string | null> {
  const env = await readEnvConfig().catch(() => ({} as Record<string, string>));
  const username = env.CURRENT_USER_NAME || env.USER_NAME || process.env.CURRENT_USER_NAME || process.env.USER_NAME;
  if (username) {
    try {
      const cfg = await getAppConfig(username);
      const conn = cfg?.connections?.notion;
      if (conn && conn.enabled !== false && conn.credentials?.NOTION_API_KEY) {
        return conn.credentials.NOTION_API_KEY.trim();
      }
    } catch {}
  }
  return readNotionKey();
}

/**
 * Retrieve active Notion API key or throw user-friendly error.
 */
export async function getActiveNotionKey(): Promise<string> {
  const key = await getEffectiveNotionKey();
  if (!key || !key.trim()) {
    throw new RepoContextError(
      "Notion API key is not configured. Please open settings (init_automate_work) to configure your Notion token.",
    );
  }
  return key.trim();
}

/**
 * Low-level authenticated Notion API request with 429 rate limit retries.
 */
async function notionRequest(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  pathname: string,
  body?: unknown,
  apiKeyOverride?: string,
  retries = 3,
): Promise<any> {
  const apiKey = apiKeyOverride?.trim() || (await getActiveNotionKey());
  const res = await fetch(`${NOTION_API}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey.trim()}`,
      "Notion-Version": NOTION_VERSION,
      "User-Agent": "claude-team-context",
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const json = (await res.json().catch(() => ({}))) as any;

  if (res.status === 429 && retries > 0) {
    const retryAfterSec = Number(res.headers.get("retry-after")) || 2;
    const waitMs = Math.min(retryAfterSec * 1000, 6000);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return notionRequest(method, pathname, body, apiKeyOverride, retries - 1);
  }

  if (!res.ok) {
    throw new NotionError(res.status, json);
  }

  return json;
}

/* ------------------------------------------------------------------ *
 * Low-level API Helpers
 * ------------------------------------------------------------------ */

export const searchObjects = (body: Record<string, any>, apiKeyOverride?: string) =>
  notionRequest("POST", "/search", body, apiKeyOverride);

export const getDatabase = (id: string, apiKeyOverride?: string) =>
  notionRequest("GET", `/databases/${id.trim()}`, undefined, apiKeyOverride);

export const queryDatabase = (id: string, body: Record<string, any>, apiKeyOverride?: string) =>
  notionRequest("POST", `/databases/${id.trim()}/query`, body, apiKeyOverride);

export const getPage = (id: string, apiKeyOverride?: string) =>
  notionRequest("GET", `/pages/${id.trim()}`, undefined, apiKeyOverride);

export const listUsers = (cursor?: string, apiKeyOverride?: string) =>
  notionRequest("GET", `/users?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`, undefined, apiKeyOverride);

export const getBlockChildren = (blockId: string, cursor?: string, apiKeyOverride?: string) =>
  notionRequest(
    "GET",
    `/blocks/${blockId.trim()}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`,
    undefined,
    apiKeyOverride,
  );

export const getComments = (blockId: string, cursor?: string, apiKeyOverride?: string) =>
  notionRequest(
    "GET",
    `/comments?block_id=${blockId.trim()}&page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`,
    undefined,
    apiKeyOverride,
  );

/** Query every database in workspace. */
export async function searchAllDatabases(apiKeyOverride?: string): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | undefined = undefined;
  do {
    const res = await searchObjects(
      {
        filter: { value: "database", property: "object" },
        page_size: 100,
        start_cursor: cursor,
      },
      apiKeyOverride,
    );
    out.push(...(res.results || []));
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return out;
}

/** Query every resource (pages and databases) in workspace. */
export async function searchAllResources(
  params?: { query?: string; filter?: Record<string, any>; limit?: number },
  apiKeyOverride?: string,
): Promise<any[]> {
  const out: any[] = [];
  const maxItems = params?.limit;
  let cursor: string | undefined = undefined;
  do {
    const pageSize = maxItems ? Math.min(100, maxItems - out.length) : 100;
    const body: Record<string, any> = {
      page_size: pageSize,
      start_cursor: cursor,
    };
    if (params?.query && params.query.trim()) body.query = params.query.trim();
    if (params?.filter) body.filter = params.filter;

    const res = await searchObjects(body, apiKeyOverride);
    out.push(...(res.results || []));
    cursor = res.has_more && (!maxItems || out.length < maxItems) ? res.next_cursor : undefined;
  } while (cursor);
  return out;
}

/** Query every page of a database (handles pagination). */
export async function queryAll(id: string, body: Record<string, any> = {}, apiKeyOverride?: string): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | undefined = undefined;
  do {
    const page = await queryDatabase(id, { ...body, page_size: 100, start_cursor: cursor }, apiKeyOverride);
    out.push(...(page.results || []));
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);
  return out;
}

/* ------------------------------------------------------------------ *
 * Property Readers & Formatting Helpers
 * ------------------------------------------------------------------ */

export const isUuid = (s: unknown): boolean =>
  /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(String(s || "").trim());

export const dashedUuid = (s: unknown): string => {
  const h = String(s || "").trim().replace(/-/g, "");
  if (h.length !== 32) return String(s || "").trim();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

export const plainText = (rich: any[]): string =>
  (rich || []).map((t: any) => t.plain_text || "").join("");

export function richTextToMarkdown(rich: any[]): string {
  if (!rich || !Array.isArray(rich)) return "";
  return rich
    .map((item: any) => {
      let content = item.plain_text ?? "";
      if (!content) return "";
      const ann = item.annotations || {};
      if (ann.code) content = `\`${content}\``;
      if (ann.bold && ann.italic) content = `***${content}***`;
      else if (ann.bold) content = `**${content}**`;
      else if (ann.italic) content = `*${content}*`;
      if (ann.strikethrough) content = `~~${content}~~`;
      if (ann.underline) content = `<u>${content}</u>`;
      if (item.href) content = `[${content}](${item.href})`;
      return content;
    })
    .join("");
}

export function extractTitle(obj: any): string {
  if (!obj) return "Untitled";
  if (obj.object === "database") {
    return plainText(obj.title) || "Untitled Database";
  }
  if (Array.isArray(obj.title) && obj.title.length > 0) {
    const str = plainText(obj.title).trim();
    if (str) return str;
  }
  if (obj.properties && typeof obj.properties === "object") {
    for (const p of Object.values(obj.properties) as any[]) {
      if (p && p.type === "title") {
        const str = plainText(p.title).trim();
        if (str) return str;
      }
    }
    // Fallback for common title property names
    for (const [key, val] of Object.entries(obj.properties) as [string, any][]) {
      if (val && val.type === "rich_text" && /^(title|name|topic|header|subject|prd|doc)$/i.test(key)) {
        const str = plainText(val.rich_text).trim();
        if (str) return str;
      }
    }
  }
  return obj.object === "database" ? "Untitled Database" : "Untitled Page";
}

export function extractIcon(icon: any): string | null {
  if (!icon) return null;
  if (icon.type === "emoji") return icon.emoji || "📄";
  if (icon.type === "external") return icon.external?.url ?? null;
  if (icon.type === "file") return icon.file?.url ?? null;
  return null;
}

export function extractCover(cover: any): string | null {
  if (!cover) return null;
  if (cover.type === "external") return cover.external?.url ?? null;
  if (cover.type === "file") return cover.file?.url ?? null;
  return null;
}

export const extractPageTitle = extractTitle;
export function extractPageIcon(page: any): string {
  const icon = extractIcon(page?.icon);
  if (icon) return icon;
  return page?.object === "database" ? "🗄️" : "📄";
}

export function readProperty(prop: any): any {
  if (!prop) return null;
  switch (prop.type) {
    case "title":
      return plainText(prop.title);
    case "rich_text":
      return plainText(prop.rich_text);
    case "number":
      return prop.number ?? null;
    case "checkbox":
      return Boolean(prop.checkbox);
    case "url":
      return prop.url ?? null;
    case "email":
      return prop.email ?? null;
    case "phone_number":
      return prop.phone_number ?? null;
    case "select":
      return prop.select ? { id: prop.select.id, name: prop.select.name, color: prop.select.color } : null;
    case "status":
      return prop.status ? { id: prop.status.id, name: prop.status.name, color: prop.status.color } : null;
    case "multi_select":
      return (prop.multi_select || []).map((o: any) => ({ id: o.id, name: o.name, color: o.color }));
    case "people":
      return (prop.people || []).map((u: any) => ({
        id: u.id,
        name: u.name ?? null,
        email: u.person?.email ?? null,
        avatar_url: u.avatar_url ?? null,
      }));
    case "relation":
      return (prop.relation || []).map((r: any) => r.id);
    case "date":
      return prop.date ? { start: prop.date.start, end: prop.date.end } : null;
    case "created_time":
      return prop.created_time ?? null;
    case "last_edited_time":
      return prop.last_edited_time ?? null;
    case "created_by":
      return prop.created_by ? { id: prop.created_by.id, name: prop.created_by.name ?? null } : null;
    case "last_edited_by":
      return prop.last_edited_by ? { id: prop.last_edited_by.id, name: prop.last_edited_by.name ?? null } : null;
    case "files":
      return (prop.files || []).map((f: any) => f.name || f.file?.url || f.external?.url || "file");
    case "unique_id":
      return prop.unique_id
        ? `${prop.unique_id.prefix ? prop.unique_id.prefix + "-" : ""}${prop.unique_id.number}`
        : null;
    case "formula":
      return prop.formula?.[prop.formula.type] ?? null;
    case "rollup":
      return prop.rollup?.[prop.rollup.type] ?? null;
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ *
 * Resource & Database Discovery
 * ------------------------------------------------------------------ */

let databaseCache: { at: number; value: any[] } | null = null;
const schemaCache = new Map<string, { at: number; value: any }>();

function shapeDatabase(db: any): any {
  const title = plainText(db.title).trim() || "Untitled Database";
  const description = plainText(db.description).trim() || null;
  const properties = db.properties || {};
  const propertyNames = Object.keys(properties);
  const propertyTypes = Object.fromEntries(
    propertyNames.map((name) => [name, properties[name]?.type || "unknown"]),
  );

  let icon: string | null = null;
  if (db.icon?.type === "emoji") {
    icon = db.icon.emoji || "🗄️";
  } else if (db.icon?.type === "external" || db.icon?.type === "file") {
    icon = db.icon.external?.url || db.icon.file?.url || null;
  }

  let cover: string | null = null;
  if (db.cover?.type === "external" || db.cover?.type === "file") {
    cover = db.cover.external?.url || db.cover.file?.url || null;
  }

  return {
    id: dashedUuid(db.id),
    title,
    icon: icon || "🗄️",
    cover,
    description,
    url: db.url || `https://www.notion.so/${db.id.replace(/-/g, "")}`,
    created_time: db.created_time || null,
    last_edited_time: db.last_edited_time || null,
    properties_count: propertyNames.length,
    property_names: propertyNames,
    property_types: propertyTypes,
  };
}

export async function listDatabases(
  options?: { refresh?: boolean; apiKeyOverride?: string },
): Promise<any[]> {
  if (!options?.refresh && databaseCache && Date.now() - databaseCache.at < TTL_MS) {
    return databaseCache.value;
  }
  const rawDatabases = await searchAllDatabases(options?.apiKeyOverride);
  const databases = rawDatabases.map(shapeDatabase);
  databaseCache = { at: Date.now(), value: databases };
  return databases;
}

export async function resolveDatabaseId(
  input?: string,
  options?: { refresh?: boolean; apiKeyOverride?: string },
): Promise<string> {
  const dbs = await listDatabases(options);
  if (dbs.length === 0) {
    throw new RepoContextError(
      "No Notion databases found. Make sure your Notion integration is invited/shared with at least one database.",
    );
  }

  const term = String(input || "").trim();
  if (term) {
    const formatted = dashedUuid(term).toLowerCase();
    const byId = dbs.find(
      (d) =>
        d.id.toLowerCase() === formatted ||
        d.id.replace(/-/g, "").toLowerCase() === term.replace(/-/g, "").toLowerCase(),
    );
    if (byId) return byId.id;

    const termLower = term.toLowerCase();
    const byTitle = dbs.find(
      (d) => d.title.toLowerCase() === termLower || d.title.toLowerCase().includes(termLower),
    );
    if (byTitle) return byTitle.id;

    if (isUuid(term)) return dashedUuid(term);
  }

  return dbs[0].id;
}

function shapeResource(item: any): NotionResourceItem {
  const isDb = item.object === "database";
  const id = dashedUuid(item.id);
  const title = extractTitle(item).trim() || (isDb ? "Untitled Database" : "Untitled Page");
  const icon = extractIcon(item.icon) || (isDb ? "🗄️" : "📄");
  const cover = extractCover(item.cover);
  const parent = item.parent || null;
  const isInline = isDb
    ? Boolean(item.is_inline || parent?.type === "page_id" || parent?.type === "block_id")
    : false;
  const description = isDb ? plainText(item.description).trim() || null : null;

  const shaped: NotionResourceItem = {
    id,
    type: isDb ? "database" : "page",
    title,
    icon,
    cover,
    url: item.url || `https://www.notion.so/${id.replace(/-/g, "")}`,
    parent,
    is_inline: isInline,
    archived: Boolean(item.archived),
    description,
    created_time: item.created_time || null,
    createdTime: item.created_time || null,
    last_edited_time: item.last_edited_time || null,
    lastEditedTime: item.last_edited_time || null,
    properties_count: Object.keys(item.properties || {}).length,
  };

  if (isDb) {
    shaped.property_names = Object.keys(item.properties || {});
  }

  return shaped;
}

/**
 * Discover and list all Notion resources (pages and databases) in workspace.
 */
export async function listResources(
  options?: { type?: "page" | "database" | "all" | string; query?: string; apiKeyOverride?: string },
): Promise<NotionListResourcesResult> {
  const normType = options?.type ? String(options.type).trim().toLowerCase() : null;

  let filter: Record<string, any> | undefined = undefined;
  if (normType === "page" || normType === "database") {
    filter = { value: normType, property: "object" };
  }

  const raw = await searchAllResources(
    { query: options?.query, filter },
    options?.apiKeyOverride,
  );
  const resources = raw.map(shapeResource);

  const pagesCount = resources.filter((r) => r.type === "page").length;
  const databasesCount = resources.filter((r) => r.type === "database").length;

  return {
    resources,
    count: resources.length,
    pages_count: pagesCount,
    databases_count: databasesCount,
  };
}

/* ------------------------------------------------------------------ *
 * Database Directory, Schema, and Filter Instructions
 * ------------------------------------------------------------------ */

async function listUsersSafe(apiKeyOverride?: string): Promise<any[]> {
  try {
    const out: any[] = [];
    let cursor: string | undefined = undefined;
    do {
      const page = await listUsers(cursor, apiKeyOverride);
      out.push(...(page.results || []));
      cursor = page.has_more ? page.next_cursor : undefined;
    } while (cursor);
    return out;
  } catch {
    return [];
  }
}

async function scanRows(databaseId: string, apiKeyOverride?: string): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | undefined = undefined;
  for (let i = 0; i < MAX_SCAN_PAGES; i++) {
    try {
      const page = await queryDatabase(databaseId, { page_size: 100, start_cursor: cursor }, apiKeyOverride);
      out.push(...(page.results || []));
      if (!page.has_more) break;
      cursor = page.next_cursor;
    } catch {
      break;
    }
  }
  return out;
}

async function buildSchema(databaseId: string, apiKeyOverride?: string): Promise<any> {
  const [db, users, rows] = await Promise.all([
    getDatabase(databaseId, apiKeyOverride),
    listUsersSafe(apiKeyOverride),
    scanRows(databaseId, apiKeyOverride),
  ]);

  const properties = db.properties || {};
  const schemaProperties: any[] = [];
  const optionsByProperty: Record<string, any[]> = {};
  const peopleByProperty: Record<string, any[]> = {};
  const relationsByProperty: Record<string, any[]> = {};

  const userMap = new Map<string, any>();
  for (const u of users) {
    if (u.type === "bot" && !u.name) continue;
    userMap.set(u.id, {
      id: u.id,
      name: u.name ?? null,
      email: u.person?.email ?? null,
      avatar_url: u.avatar_url ?? null,
      count: 0,
    });
  }

  for (const [propName, propDef] of Object.entries(properties) as [string, any][]) {
    const propType = propDef.type;
    const propInfo: Record<string, any> = {
      name: propName,
      type: propType,
      id: propDef.id,
      description: propDef.description || null,
    };

    if (propType === "select" || propType === "multi_select") {
      const schemaOpts = (propDef[propType]?.options || []).map((o: any) => ({
        id: o.id,
        name: o.name,
        color: o.color,
        count: 0,
      }));

      const counts = new Map<string, number>();
      for (const row of rows) {
        const val = row.properties?.[propName];
        if (!val) continue;
        if (propType === "select" && val.select?.name) {
          counts.set(val.select.name, (counts.get(val.select.name) || 0) + 1);
        } else if (propType === "multi_select" && Array.isArray(val.multi_select)) {
          for (const item of val.multi_select) {
            if (item?.name) {
              counts.set(item.name, (counts.get(item.name) || 0) + 1);
            }
          }
        }
      }

      for (const opt of schemaOpts) {
        opt.count = counts.get(opt.name) || 0;
      }

      optionsByProperty[propName] = schemaOpts;
      propInfo.options = schemaOpts;
    } else if (propType === "status") {
      const schemaOpts = (propDef.status?.options || []).map((o: any) => ({
        id: o.id,
        name: o.name,
        color: o.color,
        count: 0,
      }));
      const groups = (propDef.status?.groups || []).map((g: any) => ({
        id: g.id,
        name: g.name,
        color: g.color,
        option_ids: g.option_ids || [],
      }));

      const counts = new Map<string, number>();
      for (const row of rows) {
        const val = row.properties?.[propName];
        if (val?.status?.name) {
          counts.set(val.status.name, (counts.get(val.status.name) || 0) + 1);
        }
      }

      for (const opt of schemaOpts) {
        opt.count = counts.get(opt.name) || 0;
      }

      optionsByProperty[propName] = schemaOpts;
      propInfo.options = schemaOpts;
      propInfo.groups = groups;
    } else if (propType === "people") {
      const propUsers = new Map<string, any>();
      for (const [uid, u] of userMap.entries()) {
        propUsers.set(uid, { ...u });
      }

      for (const row of rows) {
        const val = row.properties?.[propName];
        for (const u of val?.people || []) {
          if (!propUsers.has(u.id)) {
            propUsers.set(u.id, {
              id: u.id,
              name: u.name ?? null,
              email: u.person?.email ?? null,
              avatar_url: u.avatar_url ?? null,
              count: 0,
            });
          }
          propUsers.get(u.id).count += 1;
        }
      }

      const usersList = [...propUsers.values()]
        .map((u) => ({
          ...u,
          label: u.name || u.email || `Unnamed member (${u.id.slice(0, 8)}…)`,
          resolvable: Boolean(u.name || u.email),
        }))
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

      peopleByProperty[propName] = usersList;
      propInfo.users = usersList;
    } else if (propType === "relation") {
      const relationTargetDbId = propDef.relation?.database_id;
      propInfo.relation_database_id = relationTargetDbId;

      let targetPages: any[] = [];
      if (relationTargetDbId) {
        try {
          targetPages = await queryAll(relationTargetDbId, {}, apiKeyOverride);
        } catch {
          targetPages = [];
        }
      }

      const counts = new Map<string, number>();
      for (const row of rows) {
        const val = row.properties?.[propName];
        for (const r of val?.relation || []) {
          if (r?.id) {
            counts.set(r.id, (counts.get(r.id) || 0) + 1);
          }
        }
      }

      const relationItems = targetPages
        .map((p) => {
          const titleProp = Object.values(p.properties || {}).find((v: any) => v.type === "title") as any;
          const title = plainText(titleProp?.title).trim();
          return {
            id: dashedUuid(p.id),
            label: title || `Untitled (${p.id.slice(0, 8)}…)`,
            title: title || null,
            count: counts.get(p.id) || 0,
          };
        })
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, undefined, { numeric: true }));

      relationsByProperty[propName] = relationItems;
      propInfo.targets = relationItems;
    } else if (propType === "number") {
      propInfo.format = propDef.number?.format || "number";
    }

    schemaProperties.push(propInfo);
  }

  const titleProp = schemaProperties.find((p) => p.type === "title");

  return {
    database: {
      id: dashedUuid(db.id),
      title: plainText(db.title).trim() || "Untitled Database",
      description: plainText(db.description).trim() || null,
      icon: db.icon,
      cover: db.cover,
      url: db.url || `https://www.notion.so/${db.id.replace(/-/g, "")}`,
    },
    title_property: titleProp?.name || null,
    properties: schemaProperties,
    options_by_property: optionsByProperty,
    people_by_property: peopleByProperty,
    relations_by_property: relationsByProperty,
    scanned_rows: rows.length,
    built_at: new Date().toISOString(),
  };
}

export async function getDatabaseSchema(
  databaseId: string,
  options?: { refresh?: boolean; apiKeyOverride?: string },
): Promise<any> {
  const normId = dashedUuid(databaseId).toLowerCase();
  const cached = schemaCache.get(normId);
  if (!options?.refresh && cached && Date.now() - cached.at < TTL_MS) {
    return cached.value;
  }
  const value = await buildSchema(normId, options?.apiKeyOverride);
  schemaCache.set(normId, { at: Date.now(), value });
  return value;
}

export function resolveValues(input: unknown, entries: any[] = []): string[] {
  const term = String(input || "").trim();
  if (!term) return [];
  if (isUuid(term)) return [dashedUuid(term)];
  const t = term.toLowerCase();
  return entries
    .filter((e) =>
      [e.label, e.name, e.email, e.title].filter(Boolean).some((v) => String(v).toLowerCase().includes(t)),
    )
    .map((e) => e.id);
}

/**
 * Self-describing search and filter capability document for AI agents and clients.
 */
export async function filterInstructions(
  options?: { databaseId?: string; refresh?: boolean; apiKeyOverride?: string },
): Promise<NotionFilterInstructionsResult> {
  const resolvedDbId = await resolveDatabaseId(options?.databaseId, options);
  const schema = await getDatabaseSchema(resolvedDbId, options);
  const db = schema.database;

  const filters: Record<string, any> = {};
  for (const p of schema.properties) {
    if (p.type === "select" || p.type === "multi_select" || p.type === "status") {
      const vals = (p.options || []).map((o: any) => o.name);
      filters[p.name] = {
        type: "array of values",
        accepted_values: [...vals, "none"],
      };
    } else if (p.type === "people") {
      const users = p.users || schema.people_by_property[p.name] || [];
      const vals = users.map((u: any) => u.name || u.label).filter(Boolean);
      filters[p.name] = {
        type: "array of values",
        accepted_values: [...vals, "none"],
      };
    } else if (p.type === "relation") {
      const targets = p.targets || schema.relations_by_property[p.name] || [];
      const vals = targets.map((t: any) => t.title || t.label).filter(Boolean);
      filters[p.name] = {
        type: "array of values",
        accepted_values: [...vals, "none"],
      };
    } else if (p.type === "date") {
      filters[p.name] = {
        type: "date (YYYY-MM-DD or relative keyword)",
        accepted_values: ["YYYY-MM-DD", "past_week", "this_week", "next_week", "past_month"],
      };
    } else if (p.type === "number") {
      filters[p.name] = {
        type: "number (number or comparison prefix)",
        accepted_values: ["number (e.g. 5)", "comparison (e.g. >=5, <=10, !=0)"],
      };
    } else if (p.type === "checkbox") {
      filters[p.name] = {
        type: "boolean",
        accepted_values: [true, false],
      };
    } else if (p.type === "rich_text" || p.type === "title") {
      filters[p.name] = {
        type: "free text",
      };
    }
  }

  const examples: Array<{ description: string; request: Record<string, any> }> = [
    {
      description: "Free text search across all fields",
      request: {
        databaseId: db.id,
        searchText: "access",
      },
    },
  ];

  const firstChoiceField = Object.entries(filters).find(
    ([, v]) => v.type === "array of values" && v.accepted_values.length > 1,
  );
  if (firstChoiceField) {
    const [fieldName, meta] = firstChoiceField;
    examples.push({
      description: `Filter by ${fieldName}`,
      request: {
        databaseId: db.id,
        filter: {
          [fieldName]: meta.accepted_values[0],
        },
      },
    });

    examples.push({
      description: `Search text across all fields + filter by ${fieldName}`,
      request: {
        databaseId: db.id,
        searchText: "test",
        filter: {
          [fieldName]: meta.accepted_values.slice(0, 2),
        },
      },
    });
  }

  return {
    database: {
      id: db.id,
      name: db.title,
    },
    how_to_search: {
      method: "POST",
      endpoint: "notion_search",
      body_format: {
        databaseId: db.id,
        searchText: "Case-insensitive search across all fields, page body, and comments",
        filter: "Map of field names to values. Pass an array of values to match any (OR).",
        pageSize: 25,
        offset: 0,
      },
    },
    filters,
    examples,
  };
}

/* ------------------------------------------------------------------ *
 * Full Page and Database Content Rendering
 * ------------------------------------------------------------------ */

export async function resolveResourceId(input: unknown, apiKeyOverride?: string): Promise<string> {
  if (!input) throw new RepoContextError("Resource ID or URL is required");

  const s = String(input).trim();
  const urlMatch = s.match(/[0-9a-f]{32}/i);
  if (urlMatch) {
    return dashedUuid(urlMatch[0]);
  }

  if (isUuid(s)) {
    return dashedUuid(s);
  }

  const { resources } = await listResources({ apiKeyOverride });
  const lower = s.toLowerCase();
  const match = resources.find(
    (r) => r.title.toLowerCase() === lower || r.title.toLowerCase().includes(lower),
  );
  if (match) return match.id;

  throw new RepoContextError(`Could not resolve Notion resource ID from "${input}"`);
}

function rowsToMarkdownTable(title: string, columns: string[], rows: any[]): string {
  if (!columns || columns.length === 0) return `### ${title}\n*(No columns)*\n`;
  if (!rows || rows.length === 0) return `### ${title}\n*(Empty database)*\n`;

  const header = `| ${columns.join(" | ")} |`;
  const divider = `| ${columns.map(() => ":---").join(" | ")} |`;

  const bodyLines = rows.map((row) => {
    const cells = columns.map((col) => {
      const val = row.properties?.[col];
      let str = "";
      if (val === null || val === undefined) {
        str = "";
      } else if (typeof val === "object") {
        if (Array.isArray(val)) {
          str = val
            .map((v) => (typeof v === "object" ? v.name || v.label || v.id || JSON.stringify(v) : String(v)))
            .join(", ");
        } else {
          str = val.name || val.start || val.plain_text || JSON.stringify(val);
        }
      } else {
        str = String(val);
      }
      return str.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
    });
    return `| ${cells.join(" | ")} |`;
  });

  return `### ${title} *(Inline Database)*\n\n${header}\n${divider}\n${bodyLines.join("\n")}\n`;
}

async function fetchBlocksRecursively(
  blockId: string,
  depth = 0,
  maxDepth = 4,
  apiKeyOverride?: string,
): Promise<{ blocks: any[]; inlineDatabases: any[] }> {
  if (depth > maxDepth) return { blocks: [], inlineDatabases: [] };

  const blocks: any[] = [];
  const inlineDatabases: any[] = [];
  let cursor: string | undefined = undefined;

  try {
    do {
      const res = await getBlockChildren(blockId, cursor, apiKeyOverride);
      for (const block of res.results || []) {
        if (block.type === "child_database") {
          const dbId = block.id;
          const dbTitle = block.child_database?.title || "Inline Database";

          try {
            const dbData = await getDatabase(dbId, apiKeyOverride);
            const queryRes = await queryDatabase(dbId, { page_size: 100 }, apiKeyOverride);
            const propNames = Object.keys(dbData.properties || {});
            const rows = (queryRes.results || []).map((page: any) => {
              const rowProps: Record<string, any> = {};
              for (const [pName, pVal] of Object.entries(page.properties || {})) {
                rowProps[pName] = readProperty(pVal);
              }
              return {
                id: dashedUuid(page.id),
                title: extractTitle(page),
                url: page.url || `https://www.notion.so/${page.id.replace(/-/g, "")}`,
                properties: rowProps,
              };
            });

            const inlineDbObj = {
              id: dashedUuid(dbId),
              title: dbTitle,
              columns: propNames,
              row_count: rows.length,
              rows,
              markdown_table: rowsToMarkdownTable(dbTitle, propNames, rows),
            };

            inlineDatabases.push(inlineDbObj);
            block.inline_database = inlineDbObj;
          } catch {
            // Unreadable child DB
          }
        }

        if (block.type === "table") {
          try {
            const tableRowsRes = await getBlockChildren(block.id, undefined, apiKeyOverride);
            const tableRows: string[][] = [];
            for (const rowBlock of tableRowsRes.results || []) {
              if (rowBlock.type === "table_row") {
                const cells = (rowBlock.table_row?.cells || []).map((cell: any) =>
                  richTextToMarkdown(cell).trim(),
                );
                tableRows.push(cells);
              }
            }
            block.table_rows = tableRows;
          } catch {
            // Unreadable table
          }
        }

        if (block.has_children && block.type !== "child_database") {
          try {
            const nested = await fetchBlocksRecursively(block.id, depth + 1, maxDepth, apiKeyOverride);
            block.children = nested.blocks;
            inlineDatabases.push(...nested.inlineDatabases);
          } catch {
            block.children = [];
          }
        }

        blocks.push(block);
      }
      cursor = res.has_more ? res.next_cursor : undefined;
    } while (cursor);
  } catch {
    // Unreadable blocks
  }

  return { blocks, inlineDatabases };
}

function blockToMarkdown(b: any, indentLevel = 0): string {
  const indent = "  ".repeat(indentLevel);
  const type = b.type;
  const data = b[type] || {};

  let textContent = "";
  if (data.rich_text) {
    textContent = richTextToMarkdown(data.rich_text);
  }

  let result = "";

  switch (type) {
    case "paragraph":
      result = `${indent}${textContent}\n`;
      break;
    case "heading_1":
      result = `\n# ${textContent}\n`;
      break;
    case "heading_2":
      result = `\n## ${textContent}\n`;
      break;
    case "heading_3":
      result = `\n### ${textContent}\n`;
      break;
    case "bulleted_list_item":
      result = `${indent}- ${textContent}\n`;
      break;
    case "numbered_list_item":
      result = `${indent}1. ${textContent}\n`;
      break;
    case "to_do":
      result = `${indent}- [${data.checked ? "x" : " "}] ${textContent}\n`;
      break;
    case "toggle": {
      let childMd = "";
      if (b.children && b.children.length > 0) {
        childMd = b.children.map((k: any) => blockToMarkdown(k, indentLevel + 1)).join("");
      }
      result = `${indent}<details>\n${indent}<summary>${textContent || "Toggle"}</summary>\n\n${childMd}\n${indent}</details>\n`;
      break;
    }
    case "code":
      result = `\n\`\`\`${data.language || ""}\n${plainText(data.rich_text)}\n\`\`\`\n`;
      break;
    case "quote":
      result = `${indent}> ${textContent.replace(/\n/g, `\n${indent}> `)}\n`;
      break;
    case "callout": {
      const icon = extractIcon(data.icon) || "💡";
      result = `\n> ${icon} **${textContent.replace(/\n/g, "\n> ")}**\n`;
      break;
    }
    case "divider":
      result = `\n---\n`;
      break;
    case "bookmark":
      result = `[${data.url}](${data.url})\n`;
      break;
    case "link_to_page": {
      const targetId = data.page_id || data.database_id;
      result = `[📄 Link to page](https://www.notion.so/${(targetId || "").replace(/-/g, "")})\n`;
      break;
    }
    case "child_page":
      result = `[📄 ${data.title || "Subpage"}](https://www.notion.so/${b.id.replace(/-/g, "")})\n`;
      break;
    case "child_database":
      if (b.inline_database?.markdown_table) {
        result = `\n${b.inline_database.markdown_table}\n`;
      } else {
        result = `\n### ${data.title || "Inline Database"}\n`;
      }
      break;
    case "table":
      if (b.table_rows && b.table_rows.length > 0) {
        const rows = b.table_rows as string[][];
        const colCount = Math.max(...rows.map((r) => r.length));
        const normalized = rows.map((r) => {
          const cells = [...r];
          while (cells.length < colCount) cells.push("");
          return `| ${cells.map((c) => c.replace(/\|/g, "\\|")).join(" | ")} |`;
        });
        const header = normalized[0];
        const divider = `| ${new Array(colCount).fill(":---").join(" | ")} |`;
        result = `\n${header}\n${divider}\n${normalized.slice(1).join("\n")}\n`;
      }
      break;
    case "image": {
      const url = data.external?.url || data.file?.url;
      const caption = data.caption ? richTextToMarkdown(data.caption) : "Image";
      result = url ? `![${caption}](${url})\n` : "";
      break;
    }
    default:
      if (textContent) {
        result = `${indent}${textContent}\n`;
      }
      break;
  }

  if (type !== "toggle" && b.children && b.children.length > 0) {
    const childrenMd = b.children.map((k: any) => blockToMarkdown(k, indentLevel + 1)).join("");
    result += childrenMd;
  }

  return result;
}

/**
 * Fetch and extract full content of a page or database (all blocks, inline DBs, and comments).
 */
export async function getResourceContent(
  resourceIdOrUrl: string,
  apiKeyOverride?: string,
): Promise<NotionResourceContentResult> {
  const id = await resolveResourceId(resourceIdOrUrl, apiKeyOverride);

  let isPage = false;
  let rawObject: any = null;

  try {
    rawObject = await getPage(id, apiKeyOverride);
    isPage = true;
  } catch (err) {
    if (err instanceof NotionError && err.status === 404) {
      try {
        rawObject = await getDatabase(id, apiKeyOverride);
        isPage = false;
      } catch {
        throw new RepoContextError(`Resource "${id}" was not found as a Page or Database in Notion.`);
      }
    } else {
      try {
        rawObject = await getDatabase(id, apiKeyOverride);
        isPage = false;
      } catch {
        throw err;
      }
    }
  }

  if (isPage) {
    const properties: Record<string, any> = {};
    for (const [pName, pVal] of Object.entries(rawObject.properties || {})) {
      properties[pName] = readProperty(pVal);
    }

    const title = extractTitle(rawObject);
    const icon = extractIcon(rawObject.icon) || "📄";
    const cover = extractCover(rawObject.cover);

    const { blocks, inlineDatabases } = await fetchBlocksRecursively(id, 0, 4, apiKeyOverride);

    let markdownBody = blocks.map((b) => blockToMarkdown(b, 0)).join("");
    markdownBody = markdownBody.replace(/\n{3,}/g, "\n\n").trim();

    const titlePrefix = icon ? `${icon} ${title}` : title;
    const fullMarkdown = `# ${titlePrefix}\n\n${markdownBody}`;

    let comments: any[] = [];
    try {
      const commentsRes = await getComments(id, undefined, apiKeyOverride);
      comments = (commentsRes.results || []).map((c: any) => ({
        id: c.id,
        text: richTextToMarkdown(c.rich_text),
        author_id: c.created_by?.id ?? null,
        created_time: c.created_time ?? null,
      }));
    } catch {
      // Ignore comment read failure
    }

    return {
      id: dashedUuid(id),
      type: "page",
      title,
      icon,
      cover,
      url: rawObject.url || `https://www.notion.so/${id.replace(/-/g, "")}`,
      parent: rawObject.parent || null,
      created_time: rawObject.created_time || null,
      last_edited_time: rawObject.last_edited_time || null,
      properties,
      markdown: fullMarkdown,
      inline_databases: inlineDatabases,
      inline_databases_count: inlineDatabases.length,
      blocks_count: blocks.length,
      comments,
    };
  } else {
    const title = extractTitle(rawObject);
    const icon = extractIcon(rawObject.icon) || "🗄️";
    const cover = extractCover(rawObject.cover);
    const propNames = Object.keys(rawObject.properties || {});

    const queryRes = await queryDatabase(id, { page_size: 100 }, apiKeyOverride);
    const rows = (queryRes.results || []).map((page: any) => {
      const rowProps: Record<string, any> = {};
      for (const [pName, pVal] of Object.entries(page.properties || {})) {
        rowProps[pName] = readProperty(pVal);
      }
      return {
        id: dashedUuid(page.id),
        title: extractTitle(page),
        url: page.url || `https://www.notion.so/${page.id.replace(/-/g, "")}`,
        properties: rowProps,
      };
    });

    const markdownTable = rowsToMarkdownTable(title, propNames, rows);

    return {
      id: dashedUuid(id),
      type: "database",
      title,
      icon,
      cover,
      url: rawObject.url || `https://www.notion.so/${id.replace(/-/g, "")}`,
      parent: rawObject.parent || null,
      is_inline: Boolean(rawObject.is_inline || rawObject.parent?.type === "page_id"),
      created_time: rawObject.created_time || null,
      last_edited_time: rawObject.last_edited_time || null,
      columns: propNames,
      row_count: rows.length,
      rows,
      markdown: `# ${icon ? `${icon} ` : ""}${title}\n\n${markdownTable}`,
    };
  }
}

/** Legacy / skill sync compatibility helper */
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
  const res = await getResourceContent(pageId, apiKeyOverride);
  return {
    id: res.id,
    title: res.title,
    url: res.url,
    icon: res.icon || (res.type === "database" ? "🗄️" : "📄"),
    content: res.markdown,
    createdTime: res.created_time || new Date().toISOString(),
    lastEditedTime: res.last_edited_time || new Date().toISOString(),
  };
}

/** Legacy / search backward-compatibility helper */
export async function searchNotionPages(params?: {
  query?: string;
  limit?: number;
  filterType?: "page" | "database";
  sortDirection?: "ascending" | "descending";
  apiKeyOverride?: string;
}): Promise<NotionPageItem[]> {
  const result = await listResources(
    {
      query: params?.query,
      type: params?.filterType,
      apiKeyOverride: params?.apiKeyOverride,
    },
  );

  const items = params?.limit !== undefined ? result.resources.slice(0, params.limit) : result.resources;

  return items.map((r) => ({
    id: r.id,
    type: r.type,
    title: r.title,
    url: r.url,
    icon: r.icon || (r.type === "database" ? "🗄️" : "📄"),
    description: r.description,
    createdTime: r.created_time || undefined,
    lastEditedTime: r.last_edited_time || undefined,
    properties_count: r.properties_count,
    property_names: r.property_names,
  }));
}

export async function fetchNotionBlocksToMarkdown(
  apiKey: string,
  blockId: string,
  depth = 0,
  maxDepth = 2,
): Promise<string> {
  const { blocks } = await fetchBlocksRecursively(blockId, depth, maxDepth, apiKey);
  return blocks.map((b) => blockToMarkdown(b, depth)).join("").trim();
}

/* ------------------------------------------------------------------ *
 * Content Indexing & Deep Search
 * ------------------------------------------------------------------ */

const contentCaches = new Map<string, { at: number; value: any }>();
const inFlightMap = new Map<string, Promise<any>>();

const asArray = (v: unknown): string[] => {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map(String);
  return String(v)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
};

const slugify = (s: string) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "_");

function blockText(block: any): string {
  const body = block[block.type];
  if (!body || typeof body !== "object") return "";
  const runs = [...(body.rich_text || []), ...(body.caption || [])];
  return runs.map((t: any) => t.plain_text ?? "").join("");
}

async function pageBody(pageId: string, apiKeyOverride?: string): Promise<{ text: string; blockIds: string[] }> {
  const parts: string[] = [];
  const blockIds: string[] = [];
  let cursor: string | undefined = undefined;
  try {
    do {
      const res = await getBlockChildren(pageId, cursor, apiKeyOverride);
      for (const b of res.results || []) {
        blockIds.push(b.id);
        const t = blockText(b).trim();
        if (t) parts.push(t);
        if (b.has_children) {
          try {
            const kids = await getBlockChildren(b.id, undefined, apiKeyOverride);
            for (const k of kids.results || []) {
              blockIds.push(k.id);
              const kt = blockText(k).trim();
              if (kt) parts.push(kt);
            }
          } catch {
            // Skip unreadable child
          }
        }
      }
      cursor = res.has_more ? res.next_cursor : undefined;
    } while (cursor);
  } catch {
    return { text: "", blockIds: [] };
  }
  return { text: parts.join("\n"), blockIds };
}

async function pageComments(
  pageId: string,
  blockIds: string[],
  state: { permission_denied: boolean },
  apiKeyOverride?: string,
): Promise<any[]> {
  const targets = [pageId, ...blockIds];
  const out: any[] = [];
  const seen = new Set<string>();

  for (const target of targets) {
    let cursor: string | undefined = undefined;
    try {
      do {
        const res = await getComments(target, cursor, apiKeyOverride);
        for (const c of res.results || []) {
          if (seen.has(c.id)) continue;
          seen.add(c.id);
          const commentText = (c.rich_text || []).map((t: any) => t.plain_text ?? "").join("").trim();
          if (!commentText) continue;
          out.push({
            id: c.id,
            text: commentText,
            author_id: c.created_by?.id ?? null,
            created_time: c.created_time ?? null,
            discussion_id: c.discussion_id ?? null,
            inline: target !== pageId,
          });
        }
        cursor = res.has_more ? res.next_cursor : undefined;
      } while (cursor);
    } catch (err: any) {
      if (err.status === 403 || (err.message && err.message.toLowerCase().includes("permission"))) {
        state.permission_denied = true;
      }
    }
  }
  out.sort((a, b) => String(a.created_time).localeCompare(String(b.created_time)));
  return out;
}

async function pool<T, R>(items: T[], worker: (item: T) => Promise<R>, size = CONTENT_CONCURRENCY): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await worker(items[i]);
      }
    }),
  );
  return out;
}

async function buildContent(databaseId: string, apiKeyOverride?: string): Promise<any> {
  const rows: any[] = [];
  let cursor: string | undefined = undefined;
  while (rows.length < MAX_CONTENT_PAGES) {
    try {
      const page = await queryDatabase(databaseId, { page_size: 100, start_cursor: cursor }, apiKeyOverride);
      rows.push(...(page.results || []));
      if (!page.has_more) break;
      cursor = page.next_cursor;
    } catch {
      break;
    }
  }

  const state = { permission_denied: false };
  const built = await pool(rows, async (p) => {
    const body = await pageBody(p.id, apiKeyOverride);
    const comments = await pageComments(p.id, body.blockIds, state, apiKeyOverride);
    return { text: body.text, comments };
  });

  const textById = new Map<string, string>();
  const commentsById = new Map<string, any[]>();
  rows.forEach((p, i) => {
    textById.set(p.id, built[i].text);
    commentsById.set(p.id, built[i].comments);
  });

  const commentTotal = built.reduce((n, b) => n + b.comments.length, 0);

  return {
    textById,
    commentsById,
    pages_indexed: rows.length,
    pages_with_body: built.filter((b) => b.text).length,
    pages_with_comments: built.filter((b) => b.comments.length).length,
    comments_indexed: commentTotal,
    comments_permission_denied: state.permission_denied,
    inline_comments_indexed: true,
    truncated: rows.length >= MAX_CONTENT_PAGES,
    built_at: new Date().toISOString(),
  };
}

export async function getContentIndex(
  databaseId?: string,
  options?: { refresh?: boolean; apiKeyOverride?: string },
): Promise<any> {
  const normId = dashedUuid(databaseId || (await resolveDatabaseId(undefined, options))).toLowerCase();

  const cached = contentCaches.get(normId);
  if (!options?.refresh && cached && Date.now() - cached.at < TTL_MS) {
    return cached.value;
  }
  if (inFlightMap.has(normId)) {
    return inFlightMap.get(normId);
  }

  const promise = buildContent(normId, options?.apiKeyOverride)
    .then((value) => {
      contentCaches.set(normId, { at: Date.now(), value });
      return value;
    })
    .finally(() => {
      inFlightMap.delete(normId);
    });

  inFlightMap.set(normId, promise);
  return promise;
}

export function snippet(text: string | null | undefined, term: string, radius = 90): string | null {
  if (!text || !term) return null;
  const i = text.toLowerCase().indexOf(term.toLowerCase());
  if (i === -1) return null;
  const start = Math.max(0, i - radius);
  const end = Math.min(text.length, i + term.length + radius);
  return (start > 0 ? "…" : "") + text.slice(start, end).replace(/\s+/g, " ").trim() + (end < text.length ? "…" : "");
}

function resolveIdFilter(values: string[], entries: any[], propertyName: string, notionKind: "people" | "relation") {
  const ids = new Set<string>();
  let includeEmpty = false;

  for (const raw of values) {
    const v = String(raw).trim();
    if (!v) continue;
    if (v.toLowerCase() === "none" || v.toLowerCase() === "unassigned" || v.toLowerCase() === "empty") {
      includeEmpty = true;
      continue;
    }
    const hits = resolveValues(v, entries);
    if (hits.length === 0 && !isUuid(v)) {
      return { unmatched: v, leaves: [], ids: [] };
    }
    if (hits.length > 0) {
      hits.forEach((id) => ids.add(id));
    } else if (isUuid(v)) {
      ids.add(v);
    }
  }

  const leaves = [...ids].map((id) => ({ property: propertyName, [notionKind]: { contains: id } }));
  if (includeEmpty) {
    leaves.push({ property: propertyName, [notionKind]: { is_empty: true } } as any);
  }

  return { leaves, ids: [...ids] };
}

export async function buildQuery(
  databaseId?: string,
  params: Record<string, any> = {},
  apiKeyOverride?: string,
): Promise<any> {
  const resolvedDbId = await resolveDatabaseId(databaseId, { apiKeyOverride });
  const schema = await getDatabaseSchema(resolvedDbId, { apiKeyOverride });
  const and: any[] = [];
  const resolved: Record<string, any> = {};

  const paramMap = new Map<string, any>();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") {
      paramMap.set(k, v);
      paramMap.set(k.toLowerCase(), v);
      paramMap.set(slugify(k), v);
    }
  }

  for (const prop of schema.properties) {
    const propName = prop.name;
    const propType = prop.type;
    const rawVal = paramMap.get(propName) ?? paramMap.get(propName.toLowerCase()) ?? paramMap.get(slugify(propName));

    if (rawVal === undefined || rawVal === null || rawVal === "") continue;

    if (propType === "people") {
      const vals = asArray(rawVal);
      if (vals.length) {
        const users = schema.people_by_property[propName] || [];
        const res = resolveIdFilter(vals, users, propName, "people");
        if (res.unmatched) {
          return { error: `Unknown ${propName} "${res.unmatched}". See filter-instructions for allowed values.` };
        }
        resolved[propName] = res.ids;
        if (res.leaves.length) {
          and.push(res.leaves.length === 1 ? res.leaves[0] : { or: res.leaves });
        }
      }
    } else if (propType === "relation") {
      const vals = asArray(rawVal);
      if (vals.length) {
        const targets = schema.relations_by_property[propName] || [];
        const res = resolveIdFilter(vals, targets, propName, "relation");
        if (res.unmatched) {
          return { error: `Unknown ${propName} "${res.unmatched}". See filter-instructions for allowed values.` };
        }
        resolved[propName] = res.ids;
        if (res.leaves.length) {
          and.push(res.leaves.length === 1 ? res.leaves[0] : { or: res.leaves });
        }
      }
    } else if (propType === "select" || propType === "status") {
      const vals = asArray(rawVal);
      if (vals.length) {
        const leaves: any[] = [];
        for (const v of vals) {
          if (v.toLowerCase() === "none" || v.toLowerCase() === "empty") {
            leaves.push({ property: propName, [propType]: { is_empty: true } });
          } else {
            leaves.push({ property: propName, [propType]: { equals: v } });
          }
        }
        if (leaves.length) {
          and.push(leaves.length === 1 ? leaves[0] : { or: leaves });
        }
      }
    } else if (propType === "multi_select") {
      const vals = asArray(rawVal);
      if (vals.length) {
        const leaves: any[] = [];
        for (const v of vals) {
          if (v.toLowerCase() === "none" || v.toLowerCase() === "empty") {
            leaves.push({ property: propName, multi_select: { is_empty: true } });
          } else {
            leaves.push({ property: propName, multi_select: { contains: v } });
          }
        }
        if (leaves.length) {
          and.push(leaves.length === 1 ? leaves[0] : { or: leaves });
        }
      }
    } else if (propType === "checkbox") {
      const b = typeof rawVal === "boolean" ? rawVal : String(rawVal).toLowerCase() === "true" || rawVal === "1";
      and.push({ property: propName, checkbox: { equals: b } });
    } else if (propType === "number") {
      if (typeof rawVal === "object" && rawVal !== null) {
        and.push({ property: propName, number: rawVal });
      } else {
        const str = String(rawVal).trim();
        const num = Number(str.replace(/^[<>=!]+/, ""));
        if (!isNaN(num)) {
          if (str.startsWith(">=")) and.push({ property: propName, number: { greater_than_or_equal_to: num } });
          else if (str.startsWith("<=")) and.push({ property: propName, number: { less_than_or_equal_to: num } });
          else if (str.startsWith(">")) and.push({ property: propName, number: { greater_than: num } });
          else if (str.startsWith("<")) and.push({ property: propName, number: { less_than: num } });
          else if (str.startsWith("!=")) and.push({ property: propName, number: { does_not_equal: num } });
          else and.push({ property: propName, number: { equals: num } });
        }
      }
    } else if (propType === "date") {
      if (typeof rawVal === "object" && rawVal !== null) {
        and.push({ property: propName, date: rawVal });
      } else {
        const str = String(rawVal).trim();
        if (str.toLowerCase() === "none" || str.toLowerCase() === "empty") {
          and.push({ property: propName, date: { is_empty: true } });
        } else if (str.startsWith(">=")) {
          and.push({ property: propName, date: { on_or_after: str.slice(2).trim() } });
        } else if (str.startsWith("<=")) {
          and.push({ property: propName, date: { on_or_before: str.slice(2).trim() } });
        } else if (str.startsWith(">")) {
          and.push({ property: propName, date: { after: str.slice(1).trim() } });
        } else if (str.startsWith("<")) {
          and.push({ property: propName, date: { before: str.slice(1).trim() } });
        } else {
          and.push({ property: propName, date: { equals: str } });
        }
      }
    } else if (propType === "rich_text" || propType === "title") {
      const str = String(rawVal).trim();
      if (str.toLowerCase() === "none" || str.toLowerCase() === "empty") {
        and.push({ property: propName, [propType]: { is_empty: true } });
      } else {
        and.push({ property: propName, [propType]: { contains: str } });
      }
    }
  }

  const filter = and.length === 0 ? undefined : and.length === 1 ? and[0] : { and };
  return { filter, resolved, schema, databaseId: resolvedDbId };
}

async function fetchCandidates(databaseId: string, filter: any, apiKeyOverride?: string) {
  const rows: any[] = [];
  let cursor: string | undefined = undefined;
  for (let i = 0; i < MAX_CANDIDATE_PAGES; i++) {
    const body: Record<string, any> = { page_size: 100 };
    if (filter) body.filter = filter;
    if (cursor) body.start_cursor = cursor;
    try {
      const res = await queryDatabase(databaseId, body, apiKeyOverride);
      rows.push(...(res.results || []));
      if (!res.has_more) return { rows, truncated: false };
      cursor = res.next_cursor;
    } catch (err) {
      if (rows.length > 0) return { rows, truncated: true };
      throw err;
    }
  }
  return { rows, truncated: true };
}

function shapeGeneric(page: any, schema: any, body: string | null, comments: any[]) {
  const p = page.properties || {};
  const shapedProps: Record<string, any> = {};
  let titleVal = "Untitled";

  for (const prop of schema.properties) {
    const name = prop.name;
    const rawProp = p[name];
    const val = readProperty(rawProp);

    if (prop.type === "title") {
      titleVal = val || "Untitled";
      shapedProps[name] = val;
    } else if (prop.type === "relation") {
      const targets = schema.relations_by_property[name] || [];
      const relIds = Array.isArray(val) ? val : [];
      shapedProps[name] = relIds.map((id: string) => {
        const found = targets.find((t: any) => t.id === id);
        return {
          id,
          label: found?.label || found?.title || `Page (${id.slice(0, 8)}…)`,
        };
      });
    } else if (prop.type === "people") {
      const users = schema.people_by_property[name] || [];
      const peopleList = Array.isArray(val) ? val : [];
      shapedProps[name] = peopleList.map((u: any) => {
        const found = users.find((x: any) => x.id === u.id);
        return {
          id: u.id,
          label: found?.label || u.name || u.email || `User (${u.id.slice(0, 8)}…)`,
          name: u.name,
          email: u.email,
          avatar_url: u.avatar_url,
        };
      });
    } else {
      shapedProps[name] = val;
    }
  }

  const firstPeople = schema.properties.find((pr: any) => pr.type === "people")?.name;
  const firstRelation = schema.properties.find((pr: any) => pr.type === "relation")?.name;
  const firstStatus = schema.properties.find((pr: any) => pr.type === "status")?.name;
  const firstSelect = schema.properties.find((pr: any) => pr.type === "select")?.name;

  return {
    id: dashedUuid(page.id),
    url: page.url || `https://www.notion.so/${page.id.replace(/-/g, "")}`,
    title: titleVal,
    properties: shapedProps,
    assignees: firstPeople ? shapedProps[firstPeople] || [] : [],
    relation_targets: firstRelation ? shapedProps[firstRelation] || [] : [],
    status: firstStatus ? shapedProps[firstStatus]?.name ?? shapedProps[firstStatus] : null,
    priority: firstSelect ? shapedProps[firstSelect]?.name ?? shapedProps[firstSelect] : null,
    created_time: page.created_time,
    last_edited_time: page.last_edited_time,
    page_content: body || null,
    comments: (comments || []).map((c: any) => {
      let authorLabel: string | null = null;
      if (c.author_id) {
        for (const userList of Object.values(schema.people_by_property) as any[][]) {
          const found = userList.find((u: any) => u.id === c.author_id);
          if (found) {
            authorLabel = found.label;
            break;
          }
        }
        if (!authorLabel) authorLabel = `User ${c.author_id.slice(0, 8)}…`;
      }
      return {
        ...c,
        author: authorLabel,
      };
    }),
  };
}

function matchFieldsGeneric(row: any, q: string, activeTextFields: any[], schema: any) {
  const t = q.toLowerCase();
  const hit = (v: any): boolean => {
    if (v == null) return false;
    if (typeof v === "string") return v.toLowerCase().includes(t);
    if (typeof v === "number" || typeof v === "boolean") return String(v).toLowerCase().includes(t);
    if (Array.isArray(v)) return v.some((item) => hit(item?.label || item?.name || item?.title || item));
    if (typeof v === "object") return hit(v.name || v.label || v.title);
    return false;
  };

  const out: string[] = [];

  for (const f of activeTextFields) {
    if (f.key === "page_content") {
      if (hit(row.page_content)) out.push("page_content");
    } else if (f.key === "comment") {
      if (row.comments && row.comments.some((c: any) => hit(c.text) || hit(c.author))) {
        out.push("comment");
      }
    } else if (f.notion_type === "people") {
      const users = schema.people_by_property[f.notion_property] || [];
      const userIds = resolveValues(q, users);
      const rowUsers = row.properties[f.notion_property] || [];
      if (rowUsers.some((u: any) => userIds.includes(u.id) || hit(u.label) || hit(u.name) || hit(u.email))) {
        out.push(f.key);
      }
    } else if (f.notion_type === "relation") {
      const targets = schema.relations_by_property[f.notion_property] || [];
      const targetIds = resolveValues(q, targets);
      const rowRelations = row.properties[f.notion_property] || [];
      if (rowRelations.some((r: any) => targetIds.includes(r.id) || hit(r.label) || hit(r.title))) {
        out.push(f.key);
      }
    } else {
      const val = row.properties[f.notion_property];
      if (hit(val)) {
        out.push(f.key);
      }
    }
  }

  return out;
}

/**
 * Deep, schema-aware search across Notion database properties, page bodies, and comments.
 */
export async function search(params: Record<string, any> = {}, apiKeyOverride?: string): Promise<NotionSearchResult> {
  const rawDb = params.databaseId || params.database_id || params.database;

  const filterParams: Record<string, any> = {};
  if (typeof params.filter === "object" && params.filter !== null) {
    Object.assign(filterParams, params.filter);
  }
  if (typeof params.filters === "object" && params.filters !== null) {
    Object.assign(filterParams, params.filters);
  }

  const RESERVED = new Set([
    "databaseId",
    "database_id",
    "database",
    "searchText",
    "search_text",
    "q",
    "query",
    "filter",
    "filters",
    "fields",
    "pageSize",
    "page_size",
    "offset",
    "startCursor",
    "start_cursor",
    "refresh",
  ]);

  for (const [k, v] of Object.entries(params)) {
    if (!RESERVED.has(k) && v !== undefined && v !== null && v !== "") {
      if (filterParams[k] === undefined) {
        filterParams[k] = v;
      }
    }
  }

  const built = await buildQuery(rawDb, filterParams, apiKeyOverride);
  if (built.error) {
    return {
      database: { id: "", title: "", url: "" },
      results: [],
      count: 0,
      total: 0,
      offset: 0,
      has_more: false,
      next_cursor: null,
      notice: built.error,
      filter_applied: null,
      notion_filter: null,
      text_matching: null,
    };
  }

  const { filter, resolved, schema, databaseId } = built;
  const q = String(params.searchText ?? params.search_text ?? params.q ?? params.query ?? "").trim();

  const allTextFields: any[] = [];
  for (const p of schema.properties) {
    allTextFields.push({
      key: slugify(p.name),
      label: p.name,
      notion_property: p.name,
      notion_type: p.type,
    });
  }
  allTextFields.push(
    { key: "page_content", label: "Page Content", notion_property: null, notion_type: "page_content" },
    { key: "comment", label: "Comments", notion_property: null, notion_type: "comments" },
  );

  const reqFieldKeys = asArray(params.fields).map(slugify);
  const activeFields = reqFieldKeys.length > 0
    ? allTextFields.filter((f) => reqFieldKeys.includes(f.key))
    : allTextFields;

  const wantsBody = activeFields.some((f) => f.key === "page_content");
  const wantsComments = activeFields.some((f) => f.key === "comment");

  const pageSize = Math.min(Math.max(Number(params.pageSize ?? params.page_size) || 25, 1), 100);
  const offset = Math.max(Number(params.offset ?? params.startCursor ?? params.start_cursor) || 0, 0);

  const [{ rows, truncated }, content] = await Promise.all([
    fetchCandidates(databaseId, filter, apiKeyOverride),
    getContentIndex(databaseId, { refresh: params.refresh, apiKeyOverride }),
  ]);

  let shaped = rows.map((p) =>
    shapeGeneric(
      p,
      schema,
      content?.textById?.get(p.id) ?? null,
      content?.commentsById?.get(p.id) ?? [],
    ),
  );

  let textMatching: any = null;
  if (q) {
    shaped = shaped
      .map((r) => ({ ...r, matched_fields: matchFieldsGeneric(r, q, activeFields, schema) }))
      .filter((r) => r.matched_fields.length > 0);

    textMatching = {
      term: q,
      fields: activeFields.map((f) => f.key),
      page_content: wantsBody
        ? {
            matched_in_process: true,
            pages_indexed: content?.pages_indexed ?? 0,
            indexed_at: content?.built_at ?? null,
          }
        : null,
      comment: wantsComments
        ? {
            matched_in_process: true,
            comments_indexed: content?.comments_indexed ?? 0,
            pages_with_comments: content?.pages_with_comments ?? 0,
            inline_comments_indexed: content?.inline_comments_indexed ?? false,
            permission_denied: content?.comments_permission_denied ?? false,
            caveat: content?.comments_permission_denied
              ? 'Notion integration token lacks "Read comments" capability.'
              : "Unresolved comments are included; resolved threads are excluded.",
            indexed_at: content?.built_at ?? null,
          }
        : null,
    };
  } else {
    shaped = shaped.map((r) => ({ ...r, matched_fields: [] }));
  }

  const total = shaped.length;
  const slice = shaped.slice(offset, offset + pageSize).map((r) => ({
    ...r,
    page_content: q ? snippet(r.page_content, q) : null,
    page_content_chars: r.page_content ? r.page_content.length : 0,
    comment_count: r.comments.length,
    comments: q
      ? r.comments
          .filter((c: any) => c.text.toLowerCase().includes(q.toLowerCase()))
          .map((c: any) => ({ ...c, excerpt: snippet(c.text, q) }))
      : [],
  }));

  return {
    database: {
      id: schema.database.id,
      title: schema.database.title,
      icon: schema.database.icon,
      url: schema.database.url,
    },
    results: slice,
    count: slice.length,
    total,
    offset,
    has_more: offset + slice.length < total,
    next_cursor: offset + slice.length < total ? String(offset + slice.length) : null,
    notice: truncated ? `Only the first ${rows.length} rows were scanned.` : null,
    filter_applied: filter ?? null,
    notion_filter: filter ?? null,
    text_matching: textMatching,
    resolved,
  };
}

/* ------------------------------------------------------------------ *
 * Credentials & Connection Status Validation
 * ------------------------------------------------------------------ */

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

export async function notionCheckConnection(apiKeyOverride?: string): Promise<NotionStatusResult> {
  const key = apiKeyOverride?.trim() || (await getEffectiveNotionKey());
  if (!key) {
    return {
      connected: false,
      reason: "No Notion API key configured yet. Open settings to configure your Notion token.",
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

/* ------------------------------------------------------------------ *
 * MCP Server Tool Registration
 * ------------------------------------------------------------------ */

export function registerNotionTools(server: McpServer): void {
  // 1. Connection check tool (kept)
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

  // 2. Discover and list all Notion resources (pages and databases)
  const listResourcesHandler = guarded(async ({ type, query }: { type?: "page" | "database" | "all"; query?: string }) => {
    const res = await listResources({ type, query });
    return text(res);
  });

  server.registerTool(
    "notion_list_resources",
    {
      title: "List Notion Resources",
      description:
        "Discover and list all accessible pages and databases in the connected Notion workspace, with property counts and types.",
      annotations: { title: "List Notion Resources", readOnlyHint: true },
      inputSchema: {
        type: z
          .enum(["page", "database", "all"])
          .optional()
          .describe("Filter resources by type ('page', 'database', or 'all')"),
        query: z
          .string()
          .optional()
          .describe("Optional title search term to filter Notion resources"),
      },
    },
    listResourcesHandler,
  );

  server.registerTool(
    "notion_list_resource",
    {
      title: "List Notion Resource",
      description:
        "Discover and list all accessible pages and databases in the connected Notion workspace (alias for notion_list_resources).",
      annotations: { title: "List Notion Resource", readOnlyHint: true },
      inputSchema: {
        type: z
          .enum(["page", "database", "all"])
          .optional()
          .describe("Filter resources by type ('page', 'database', or 'all')"),
        query: z
          .string()
          .optional()
          .describe("Optional title search term to filter Notion resources"),
      },
    },
    listResourcesHandler,
  );

  // 3. Get full content of a page or database
  const getPageHandler = guarded(async ({ pageId, resourceId }: { pageId?: string; resourceId?: string }) => {
    const id = (pageId || resourceId || "").trim();
    if (!id) {
      throw new RepoContextError("pageId or resourceId is required to fetch Notion content.");
    }
    const content = await getResourceContent(id);
    return text(content);
  });

  server.registerTool(
    "notion_get_page",
    {
      title: "Get Notion Page Content",
      description:
        "Fetch full Markdown content and metadata for a Notion page or database, including nested blocks, inline databases formatted as Markdown tables, and comments.",
      annotations: { title: "Get Notion Page", readOnlyHint: true },
      inputSchema: {
        pageId: z
          .string()
          .optional()
          .describe("Notion Page ID, Database ID, URL, or resource title"),
        resourceId: z
          .string()
          .optional()
          .describe("Alias for pageId: Notion Page ID, Database ID, URL, or resource title"),
      },
    },
    getPageHandler,
  );

  server.registerTool(
    "notion_get_resource_content",
    {
      title: "Get Notion Resource Content",
      description:
        "Fetch full Markdown content and metadata for a Notion page or database, including nested blocks, inline databases formatted as Markdown tables, and comments.",
      annotations: { title: "Get Notion Content", readOnlyHint: true },
      inputSchema: {
        resourceId: z
          .string()
          .optional()
          .describe("Notion Page ID, Database ID, URL, or resource title"),
        pageId: z
          .string()
          .optional()
          .describe("Alias for resourceId: Notion Page ID, Database ID, URL, or resource title"),
      },
    },
    getPageHandler,
  );

  // 5. Deep schema-aware search
  server.registerTool(
    "notion_search",
    {
      title: "Search Notion Workspace and Databases",
      description:
        "Deep search across database properties, text content, and comments with flexible schema-driven filtering and pagination.",
      annotations: { title: "Search Notion", readOnlyHint: true },
      inputSchema: {
        databaseId: z
          .string()
          .optional()
          .describe("Notion Database ID or name to search (defaults to first available database)"),
        searchText: z
          .string()
          .optional()
          .describe("Free-text search query across properties, body content, and comments"),
        filter: z
          .record(z.string(), z.any())
          .optional()
          .describe("Filter property mapping (e.g. { Status: 'Done', Priority: 'High' })"),
        fields: z
          .array(z.string())
          .optional()
          .describe("Specific field keys to search text within (e.g. ['page_content', 'comment'])"),
        pageSize: z
          .number()
          .optional()
          .describe("Number of results to return (default: 25, max: 100)"),
        offset: z
          .number()
          .optional()
          .describe("Offset / start index for pagination (default: 0)"),
        refresh: z
          .boolean()
          .optional()
          .describe("Force refresh cached schema and content index"),
      },
    },
    guarded(
      async (params: {
        databaseId?: string;
        searchText?: string;
        filter?: Record<string, any>;
        fields?: string[];
        pageSize?: number;
        offset?: number;
        refresh?: boolean;
      }) => {
        const results = await search(params);
        return text(results);
      },
    ),
  );
}
