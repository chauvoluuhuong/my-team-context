/**
 * Utilities for generating and synchronizing the "How to use GitHub tools" skill.
 */

import type { ActiveRepoConfigItem, SkillItem } from "../tools/types.js";
import { upsertSkill, getGitHubGuideSkillPointId } from "../services/vector-db.js";
import { buildConnectionSkillName } from "./helpers.js";

/**
 * Build the structured Markdown guide for using GitHub tools with active repositories.
 */
export async function buildGitHubGuideSkillContent(
  activeRepos: ActiveRepoConfigItem[] = [],
): Promise<string> {
  const skillName = buildConnectionSkillName("github");
  const lines: string[] = [
    `# ${skillName}`,
    "",
    "This guide explains how to navigate, inspect, and search our team's active GitHub repositories using the available GitHub MCP tools.",
    "",
    "## Tool Reference",
    "- `repo_overview`: Get a comprehensive first orientation on repositories (default branch, languages, top-level layout, README).",
    "- `list_repo_files`: Explore repository directories or recursively list file paths (`path`, `recursive`, `repo`).",
    "- `read_repo_file`: Read source code or specific line ranges from a repository file (`path`, `startLine`, `endLine`, `repo`).",
    "- `search_repo_code`: Search code tokens, symbols, or patterns across active repositories via GitHub index (`query`, `repo`).",
    "- `github_repo_status`: Check connection status, user login, and active repository.",
    "",
  ];

  if (activeRepos.length === 0) {
    lines.push(
      "## Active Repositories",
      "",
      "No specific GitHub repositories are currently selected as active in the application configuration.",
      "- To inspect any repository, call `repo_overview({ repo: '<owner/name>' })`.",
      "- To list files, call `list_repo_files({ repo: '<owner/name>', path: '' })`.",
      "- To search code, call `search_repo_code({ query: '<search term>' })`.",
      "",
    );
    return lines.join("\n");
  }

  lines.push(
    "## Active Repositories & Usage Instructions",
    "The following repositories are currently configured as active team context. When answering questions about our codebase, architecture, or implementation patterns, prioritize these repositories.",
    "",
  );

  for (const repo of activeRepos) {
    const name = repo.name || "Unknown Repository";
    lines.push(`### 🐙 ${name}`);
    if (repo.description && repo.description.trim()) {
      lines.push(`- **Context / Notes**: ${repo.description.trim()}`);
    }
    lines.push(
      `- **Repository Name**: \`${name}\``,
      "- **Recommended Tool Workflows**:",
      "  1. **Get Architecture & README Overview**:",
      "     ```json",
      `     repo_overview({ "repo": "${name}" })`,
      "     ```",
      "  2. **Explore Directory Structure / Find Files**:",
      "     ```json",
      `     list_repo_files({ "repo": "${name}", "path": "", "recursive": true })`,
      "     ```",
      "  3. **Read Specific File Content**:",
      "     ```json",
      `     read_repo_file({ "repo": "${name}", "path": "package.json" })`,
      "     ```",
      "  4. **Search Code Across This Repository**:",
      "     ```json",
      `     search_repo_code({ "repo": "${name}", "query": "symbolOrFunction" })`,
      "     ```",
      "",
    );
  }

  lines.push(
    "## Cross-Repository Code Search",
    "When searching across all active team repositories simultaneously, omit the `repo` parameter in `search_repo_code` or `list_repo_files`:",
    "```json",
    'search_repo_code({ "query": "authMiddleware" })',
    "```",
    "",
  );

  return lines.join("\n");
}

/**
 * Synchronize the "How to use GitHub tools" skill into Qdrant.
 * Always syncs/overwrites the single document point identified by getGitHubGuideSkillPointId(username).
 */
export async function syncGitHubGuideSkill(options: {
  username?: string;
  activeRepos?: ActiveRepoConfigItem[];
}): Promise<SkillItem | null> {
  const username = options.username || "default";
  const repos = options.activeRepos || [];

  try {
    const pointId = getGitHubGuideSkillPointId(username);
    const content = await buildGitHubGuideSkillContent(repos);

    const skill = await upsertSkill({
      id: pointId,
      name: buildConnectionSkillName("github"),
      description: "Instructions and code navigation guide for active team GitHub repositories",
      content,
      metadata: {
        source: "github-guide",
        author: username,
        category: "github",
        tags: ["github", "guide", "tools", "code-search", "repositories"],
      },
    });

    return skill;
  } catch (err) {
    // If Qdrant is not configured or offline, log warning without failing configuration save
    console.warn("Could not sync GitHub guide skill to Qdrant:", err);
    return null;
  }
}
