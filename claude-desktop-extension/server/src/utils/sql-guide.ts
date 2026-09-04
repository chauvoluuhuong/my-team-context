/**
 * Utilities for generating and synchronizing the "How to use SQL Database tools" skill.
 */

import type { SkillItem } from "../tools/types.js";
import { upsertSkill, getConnectionGuideSkillPointId } from "../services/vector-db.js";
import { buildConnectionSkillName } from "./helpers.js";

export function buildSqlGuideSkillContent(): string {
  const skillName = buildConnectionSkillName("sql");
  return `# ${skillName}

## Overview
This skill provides guidelines and operational procedures for inspecting schemas and executing SQL database queries in our workspace using the \`sql_get_schema\` and \`sql_execute_query\` MCP tools.

## Available Tools
- \`sql_get_schema\`: Retrieve full database schemas, tables, column names, data types, primary keys, and foreign keys.
- \`sql_execute_query\`: Execute parameterized SQL queries against the active database connection.

## Operating Guidelines & Workflows
1. **Always Inspect Schema First**: Before formulating or running SQL queries, run \`sql_get_schema\` to verify exact table definitions and column names.
2. **Safe Read Queries**: Use \`SELECT\` queries with appropriate \`LIMIT\` clauses to avoid retrieving excessively large result sets.
3. **Explicit User Approval for Modifications**: Always ask for explicit user approval before executing any data-modifying or structural operations (\`INSERT\`, \`UPDATE\`, \`DELETE\`, \`ALTER\`, \`DROP\`, \`CREATE\`).
4. **Error Handling**: If a query encounters a syntax or type error, re-check table constraints and schema types via \`sql_get_schema\` before retrying.
`;
}

/**
 * Synchronize the "How to use SQL Database tools" skill into Qdrant.
 */
export async function syncSqlGuideSkill(options?: {
  username?: string;
  connectionConfig?: Record<string, any>;
}): Promise<SkillItem | null> {
  const username = options?.username || "default";
  const skillName = buildConnectionSkillName("sql");

  try {
    const pointId = getConnectionGuideSkillPointId("sql", username);
    const content = buildSqlGuideSkillContent();

    const skill = await upsertSkill({
      id: pointId,
      name: skillName,
      description: "Database querying, schema inspection, and safety guidelines for SQL Database tools",
      content,
      metadata: {
        source: "sql-guide",
        author: username,
        category: "sql",
        tags: ["sql", "database", "guide", "tools", "schema", "workflow"],
      },
    });

    return skill;
  } catch (err) {
    console.warn("Could not sync SQL guide skill to Qdrant:", err);
    return null;
  }
}
