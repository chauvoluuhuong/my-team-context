/**
 * Mention utility for parsing, formatting, and resolving resource mentions.
 *
 * Supports typed resource mentions such as @[skill:name] or @skill-name.
 */

export interface MentionResource {
  id?: string;
  name: string;
  type: "skill" | string;
  title?: string;
  description?: string;
  icon?: string;
  metadata?: Record<string, unknown>;
}

export interface MentionMatch {
  raw: string;
  type: string;
  name: string;
  id?: string;
  startIndex: number;
  endIndex: number;
}

export type MentionResolver = (
  match: MentionMatch,
) => Promise<string | null | undefined> | string | null | undefined;

/**
 * Regex matching mentions:
 * 1. Explicit bracketed typed mention: @[skill:some-name] or @[type:id:name]
 * 2. Explicit bracketed untyped mention: @[some-name]
 * 3. Standard @name mention: @my-skill-name (terminated by whitespace, punctuation, or end-of-string)
 */
const BRACKET_TYPED_REGEX = /@\[([a-zA-Z0-9_\-\.]+):([^\]]+)\]/g;
const BRACKET_SIMPLE_REGEX = /@\[([^\]:]+)\]/g;
const PLAIN_AT_REGEX = /(^|[^a-zA-Z0-9_\-\./@])@([a-zA-Z0-9_\-\.]{2,})/g;

/**
 * Parse all mentions in a text string.
 */
export function parseMentions(text: string): MentionMatch[] {
  if (!text || typeof text !== "string") return [];

  const results: MentionMatch[] = [];
  const occupiedRanges: [number, number][] = [];

  const isOverlapping = (start: number, end: number) => {
    return occupiedRanges.some(([s, e]) => Math.max(start, s) < Math.min(end, e));
  };

  // 1. Bracketed typed mentions: @[type:name]
  let m: RegExpExecArray | null;
  const typedRegex = new RegExp(BRACKET_TYPED_REGEX.source, "g");
  while ((m = typedRegex.exec(text)) !== null) {
    const raw = m[0];
    const type = m[1].toLowerCase();
    const name = m[2].trim();
    const startIndex = m.index;
    const endIndex = startIndex + raw.length;

    occupiedRanges.push([startIndex, endIndex]);
    results.push({ raw, type, name, startIndex, endIndex });
  }

  // 2. Bracketed simple mentions: @[name]
  const simpleRegex = new RegExp(BRACKET_SIMPLE_REGEX.source, "g");
  while ((m = simpleRegex.exec(text)) !== null) {
    const raw = m[0];
    const name = m[1].trim();
    const startIndex = m.index;
    const endIndex = startIndex + raw.length;

    if (!isOverlapping(startIndex, endIndex)) {
      occupiedRanges.push([startIndex, endIndex]);
      results.push({ raw, type: "skill", name, startIndex, endIndex });
    }
  }

  // 3. Plain @name mentions: @some-name
  const plainRegex = new RegExp(PLAIN_AT_REGEX.source, "g");
  while ((m = plainRegex.exec(text)) !== null) {
    const prefix = m[1];
    let name = m[2].trim();
    // Strip trailing sentence punctuation
    while (/[.,;:!?]$/.test(name)) {
      name = name.slice(0, -1);
    }
    if (name.length < 2) continue;

    const raw = "@" + name;
    const startIndex = m.index + prefix.length;
    const endIndex = startIndex + raw.length;

    // Skip if it looks like an email address (e.g. user@domain.com)
    if (startIndex > 0 && text[startIndex - 1] && /[a-zA-Z0-9]/.test(text[startIndex - 1])) {
      continue;
    }

    if (!isOverlapping(startIndex, endIndex)) {
      occupiedRanges.push([startIndex, endIndex]);
      results.push({ raw, type: "skill", name, startIndex, endIndex });
    }
  }

  // Sort by occurrence order
  return results.sort((a, b) => a.startIndex - b.startIndex);
}

/**
 * Format a resource into an unambiguous mention string.
 */
export function formatMention(
  resource: { name: string; type?: string },
  style: "bracket" | "at" = "bracket",
): string {
  const name = resource.name.trim();
  const type = (resource.type || "skill").trim().toLowerCase();

  if (style === "at") {
    return `@${name}`;
  }
  return `@[${type}:${name}]`;
}

/**
 * Format a skill mention into an actionable directive hint for AI agents.
 * e.g. "notion-skill" -> "notion-skill (use get_skill to get it)"
 */
export function formatSkillToolHint(skillName: string): string {
  const clean = (skillName || "").trim();
  return `${clean} (use get_skill to get it)`;
}

/**
 * Replace mentions in text with content provided by a resolver function.
 */
export async function resolveMentions(
  text: string,
  resolver: MentionResolver,
): Promise<string> {
  const matches = parseMentions(text);
  if (matches.length === 0) return text;

  let result = "";
  let lastIndex = 0;

  for (const match of matches) {
    result += text.slice(lastIndex, match.startIndex);
    const resolved = await resolver(match);
    if (resolved !== null && resolved !== undefined) {
      result += resolved;
    } else {
      result += match.raw;
    }
    lastIndex = match.endIndex;
  }

  result += text.slice(lastIndex);
  return result;
}
