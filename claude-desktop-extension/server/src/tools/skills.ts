/**
 * Skills & Knowledge Base Management Tools.
 *
 * Provides full CRUD operations for team skills stored in Qdrant (knowledge-base collection)
 * embedded via Gemini embeddings, and renders an interactive ext-apps UI widget.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { text, guarded, RepoContextError } from "../utils/helpers.js";
import { serializeSkillDocument, serializeDocument } from "../utils/serializer.js";
import {
  listSkills,
  getSkill,
  upsertSkill,
  deleteSkill,
  searchSkills,
  KNOWLEDGE_BASE_COLLECTION,
} from "../services/vector-db.js";

export const SKILLS_URI = "ui://repo-context/skills.html";

export function registerSkillsTools(server: McpServer): void {
  /* ------------------- Interactive Skills UI Tool ------------------- */

  registerAppTool(
    server,
    "manage_skills",
    {
      title: "Manage Team Skills & Knowledge Base",
      description:
        "Open the interactive UI to list, create, edit, delete, and semantically search team skills and guidelines in Qdrant vector database (knowledge-base collection).",
      annotations: { title: "Manage Team Skills", readOnlyHint: false, openWorldHint: true },
      inputSchema: {},
      _meta: { ui: { resourceUri: SKILLS_URI } },
    },
    guarded(async () => {
      const data = await listSkills();
      return text({
        status: "ok",
        collection: data.collection,
        total: data.total,
        skills: data.skills,
      });
    }),
  );

  /* ------------------- App Internal CRUD & Search Tools ------------------- */

  registerAppTool(
    server,
    "skills_list",
    {
      title: "List Skills",
      description: "Internal: list all skills stored in Qdrant knowledge-base.",
      annotations: { title: "List Skills", readOnlyHint: true },
      inputSchema: {
        limit: z.number().optional().describe("Maximum number of skills to return"),
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    guarded(async ({ limit }: { limit?: number }) => {
      const result = await listSkills(limit || 100);
      return text(result);
    }),
  );

  registerAppTool(
    server,
    "skills_create",
    {
      title: "Create Skill",
      description: "Internal: create a new skill, serialize document fields, generate Gemini embedding, and store in Qdrant.",
      annotations: { title: "Create Skill", readOnlyHint: false },
      inputSchema: {
        name: z.string().min(1).describe("Skill name or title"),
        description: z.string().optional().describe("Brief summary of skill"),
        content: z.string().min(1).describe("Skill guidelines/instructions in Markdown"),
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    guarded(async ({ name, description, content }: { name: string; description?: string; content: string }) => {
      const skill = await upsertSkill({
        name,
        description: description || "",
        content,
      });
      return text(skill);
    }),
  );

  registerAppTool(
    server,
    "skills_update",
    {
      title: "Update Skill",
      description: "Internal: update an existing skill, re-serialize, re-embed with Gemini, and update Qdrant point.",
      annotations: { title: "Update Skill", readOnlyHint: false },
      inputSchema: {
        id: z.string().min(1).describe("Skill UUID"),
        name: z.string().min(1).describe("Skill name"),
        description: z.string().optional().describe("Skill description"),
        content: z.string().min(1).describe("Skill markdown content"),
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    guarded(async ({ id, name, description, content }: { id: string; name: string; description?: string; content: string }) => {
      const existing = await getSkill(id);
      const skill = await upsertSkill({
        id,
        name,
        description: description ?? existing?.description ?? "",
        content,
        createdAt: existing?.createdAt,
      });
      return text(skill);
    }),
  );

  registerAppTool(
    server,
    "skills_delete",
    {
      title: "Delete Skill",
      description: "Internal: delete a skill from Qdrant knowledge-base collection.",
      annotations: { title: "Delete Skill", readOnlyHint: false, destructiveHint: true },
      inputSchema: {
        id: z.string().min(1).describe("Skill UUID to delete"),
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    guarded(async ({ id }: { id: string }) => {
      await deleteSkill(id);
      return text({ status: "ok", message: `Skill "${id}" deleted.` });
    }),
  );

  registerAppTool(
    server,
    "skills_search",
    {
      title: "Semantic Search Skills",
      description: "Internal: perform vector similarity search across team skills in Qdrant using Gemini query embeddings.",
      annotations: { title: "Semantic Search Skills", readOnlyHint: true },
      inputSchema: {
        query: z.string().min(1).describe("Search query / question"),
        limit: z.number().optional().describe("Maximum number of results to return"),
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    guarded(async ({ query, limit }: { query: string; limit?: number }) => {
      const results = await searchSkills(query, limit || 10);
      return text({ status: "ok", query, results });
    }),
  );

  /* ------------------- Conversational Agent MCP Tools ------------------- */

  server.registerTool(
    "search_team_skills",
    {
      title: "Search Team Skills",
      description:
        "Semantically search team skills, coding guidelines, workflows, and procedures stored in the Qdrant knowledge base using Gemini embeddings.",
      annotations: { title: "Search Team Skills", readOnlyHint: true },
      inputSchema: {
        query: z.string().min(1).describe("Search query or task topic to find relevant skills for"),
        limit: z.number().optional().describe("Maximum number of matches (default: 5)"),
      },
    },
    guarded(async ({ query, limit }: { query: string; limit?: number }) => {
      const results = await searchSkills(query, limit || 5);
      return text({
        query,
        count: results.length,
        skills: results.map((r) => ({
          name: r.name,
          description: r.description,
          content: r.content,
          score: r.score,
        })),
      });
    }),
  );

  server.registerTool(
    "list_team_skills",
    {
      title: "List Team Skills",
      description: "List all skills and guideline documents available in the team knowledge base.",
      annotations: { title: "List Team Skills", readOnlyHint: true },
      inputSchema: {
        limit: z.number().optional().describe("Maximum skills to list (default: 50)"),
      },
    },
    guarded(async ({ limit }: { limit?: number }) => {
      const data = await listSkills(limit || 50);
      return text({
        total: data.total,
        collection: data.collection,
        skills: data.skills.map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description,
          updatedAt: s.updatedAt,
        })),
      });
    }),
  );

  server.registerTool(
    "get_team_skill",
    {
      title: "Get Team Skill",
      description: "Retrieve full content and details for a specific skill from the knowledge base by ID.",
      annotations: { title: "Get Team Skill", readOnlyHint: true },
      inputSchema: {
        id: z.string().min(1).describe("Skill UUID"),
      },
    },
    guarded(async ({ id }: { id: string }) => {
      const skill = await getSkill(id);
      if (!skill) {
        throw new RepoContextError(`Skill with ID "${id}" was not found in knowledge base.`);
      }
      return text(skill);
    }),
  );
}

export { serializeSkillDocument, serializeDocument };
