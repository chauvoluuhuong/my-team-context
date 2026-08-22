/**
 * Centralized document serialization utility for vector embedding.
 *
 * Formats fields into standard representation:
 * #{fieldName}: {fieldvalue}\n\n
 */

export interface SkillDocumentInput {
  name: string;
  description: string;
  content: string;
  [key: string]: string | undefined;
}

/**
 * Generic field serializer for arbitrary document fields.
 * Produces "#{fieldName}: {fieldValue}\n\n" format.
 */
export function serializeDocument(fields: Record<string, string | undefined | null>): string {
  return Object.entries(fields)
    .filter(([_, v]) => v !== undefined && v !== null && String(v).trim().length > 0)
    .map(([k, v]) => `#${k}: ${String(v).trim()}`)
    .join("\n\n");
}

/**
 * Serializes a skill document containing name, description, and content.
 * Standard format:
 * #name: {name}\n\n#description: {description}\n\n#content: {content}
 */
export function serializeSkillDocument(doc: {
  name: string;
  description: string;
  content: string;
}): string {
  return `#name: ${(doc.name || "").trim()}\n\n#description: ${(doc.description || "").trim()}\n\n#content: ${(doc.content || "").trim()}`;
}
