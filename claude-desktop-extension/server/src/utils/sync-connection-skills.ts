/**
 * Utilities for synchronizing connection guide skills into Qdrant.
 */

import type { SkillItem } from "../tools/types.js";
import { upsertSkill, getConnectionGuideSkillPointId } from "../services/vector-db.js";
import { buildConnectionSkillName, getConnectionServiceName, isSystemConnection } from "./helpers.js";
import { syncGitHubGuideSkill } from "./github-guide.js";
import { syncNotionGuideSkill } from "./notion-guide.js";
import { syncSqlGuideSkill } from "./sql-guide.js";

export async function syncConnectionGuideSkill(options: {
  connectionId: string;
  username?: string;
  serviceName?: string;
}): Promise<SkillItem | null> {
  const id = options.connectionId.trim().toLowerCase();
  if (isSystemConnection(id)) return null;

  const username = options.username || "default";
  const skillName = buildConnectionSkillName(id);
  const serviceName = options.serviceName || getConnectionServiceName(id);

  try {
    const pointId = getConnectionGuideSkillPointId(id, username);
    const content = `# ${skillName}

## Overview
Guidelines, operational instructions, and best practices for interacting with ${serviceName} in our workspace.

## Operating Workflow
1. Use the relevant tools and credentials configured for ${serviceName}.
2. Follow standard automation procedures and project guidelines.
3. Always ask for explicit user approval before executing actions that modify or delete data.
`;

    const skill = await upsertSkill({
      id: pointId,
      name: skillName,
      description: `Integration guidelines and workflows for ${serviceName}`,
      content,
      metadata: {
        source: `${id}-guide`,
        author: username,
        category: id,
        tags: [id, "guide", "tools", "workflow"],
      },
    });

    return skill;
  } catch (err) {
    console.warn(`Could not sync guide skill for connection "${id}" to Qdrant:`, err);
    return null;
  }
}

export async function syncAllConnectionSkills(options: {
  username?: string;
  connections?: Record<string, any> | string[];
  activeRepos?: any[];
  activeNotionPages?: any[];
  apiKeyOverride?: string;
}): Promise<void> {
  const username = options.username || "default";
  const activeIds = new Set<string>();

  if (Array.isArray(options.connections)) {
    options.connections.forEach((id) => {
      if (typeof id === "string" && id.trim()) {
        const clean = id.trim().toLowerCase();
        if (!isSystemConnection(clean)) activeIds.add(clean);
      }
    });
  } else if (options.connections && typeof options.connections === "object") {
    Object.entries(options.connections).forEach(([key, conn]) => {
      if (!conn) return;
      const id = key.trim().toLowerCase();
      if (isSystemConnection(id)) return;
      if (conn.enabled !== false) {
        const hasCreds =
          conn.credentials &&
          typeof conn.credentials === "object" &&
          Object.values(conn.credentials).some((v) => Boolean(v && String(v).trim()));
        if (hasCreds || conn.enabled === true) activeIds.add(id);
      }
    });
  }

  if (options.activeRepos && options.activeRepos.length > 0) activeIds.add("github");
  if (options.activeNotionPages && options.activeNotionPages.length > 0) activeIds.add("notion");

  const syncPromises: Promise<any>[] = [];

  for (const id of activeIds) {
    if (id === "github") {
      syncPromises.push(
        syncGitHubGuideSkill({
          username,
          activeRepos: options.activeRepos,
        }).catch((err) => console.warn("Failed to sync GitHub guide skill:", err)),
      );
    } else if (id === "notion") {
      syncPromises.push(
        syncNotionGuideSkill({
          username,
          activeNotionPages: options.activeNotionPages,
          apiKeyOverride: options.apiKeyOverride,
        }).catch((err) => console.warn("Failed to sync Notion guide skill:", err)),
      );
    } else if (id === "sql") {
      syncPromises.push(
        syncSqlGuideSkill({ username }).catch((err) => console.warn("Failed to sync SQL guide skill:", err)),
      );
    } else {
      syncPromises.push(
        syncConnectionGuideSkill({ connectionId: id, username }).catch((err) =>
          console.warn(`Failed to sync guide skill for ${id}:`, err),
        ),
      );
    }
  }

  await Promise.all(syncPromises);
}
