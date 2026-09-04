/**
 * Gemini Content Refinement Service.
 *
 * Uses Gemini gemini-3.5-flash-lite to polish and refine skill markdown content
 * and AI system prompts using the API key stored in app config.
 */

import { GoogleGenAI } from "@google/genai";
import { RepoContextError } from "../utils/helpers.js";
import { getAppConfig, getSkill, listSkills } from "./vector-db.js";
import { parseMentions, resolveMentions, formatSkillToolHint } from "../utils/mention.js";
import { readGeminiKey } from "../utils/store.js";
import { readEnvConfig } from "../utils/env.js";
import { getSessionUser } from "../tools/init.js";

export const GEMINI_REFINE_MODEL = "gemini-3.6-flash";

export interface RefineContentOptions {
  content: string;
  type?: "skill" | "system_prompt" | "general";
  instruction?: string;
  username?: string;
  apiKeyOverride?: string;
  model?: string;
  skills?: Array<{ name: string; description?: string; content?: string }>;
}

export interface RefineContentResult {
  refinedContent: string;
  model: string;
  originalLength: number;
  refinedLength: number;
}

function maskKey(k: string | null | undefined): string {
  if (!k) return "<none>";
  const trimmed = k.trim();
  if (!trimmed) return "<empty>";
  if (trimmed.length <= 8) return `${trimmed.slice(0, 2)}***${trimmed.slice(-2)} (len: ${trimmed.length})`;
  return `${trimmed.slice(0, 6)}...${trimmed.slice(-4)} (len: ${trimmed.length})`;
}

/**
 * Retrieve the active Gemini API key from appConfig, stored secret, or environment.
 */
export async function getEffectiveGeminiApiKey(preferredUsername?: string): Promise<string | null> {
  const env = await readEnvConfig().catch(() => ({} as Record<string, string>));
  const sessionUser = getSessionUser();
  const username =
    preferredUsername?.trim() ||
    sessionUser ||
    env.CURRENT_USER_NAME ||
    env.USER_NAME ||
    process.env.CURRENT_USER_NAME ||
    process.env.USER_NAME ||
    "admin";

  console.log(`[GeminiRefine:KeyLookup] Resolving Gemini API key...`);
  console.log(`[GeminiRefine:KeyLookup] Context usernames: preferred="${preferredUsername || ""}", sessionUser="${sessionUser || ""}", resolved="${username}"`);

  if (username) {
    try {
      console.log(`[GeminiRefine:KeyLookup] 1. Checking appConfig for user "${username}"...`);
      const cfg = await getAppConfig(username);
      const conn = cfg?.connections?.gemini;
      const key = conn?.credentials?.GEMINI_API_KEY?.trim();
      if (conn && conn.enabled !== false && key) {
        console.log(`[GeminiRefine:KeyLookup] -> Found active key in appConfig: ${maskKey(key)}`);
        return key;
      } else {
        console.log(`[GeminiRefine:KeyLookup] -> No active key in appConfig (conn exists: ${!!conn}, enabled: ${conn?.enabled}, hasKey: ${!!key})`);
      }
    } catch (err) {
      console.warn(`[GeminiRefine:KeyLookup] -> Error reading appConfig for "${username}":`, err);
    }
  }

  console.log(`[GeminiRefine:KeyLookup] 2. Checking stored secret store (readGeminiKey)...`);
  const storedKey = await readGeminiKey();
  if (storedKey && storedKey.trim()) {
    console.log(`[GeminiRefine:KeyLookup] -> Found key in stored secret store: ${maskKey(storedKey.trim())}`);
    return storedKey.trim();
  } else {
    console.log(`[GeminiRefine:KeyLookup] -> No key found in stored secret store.`);
  }

  console.log(`[GeminiRefine:KeyLookup] 3. Checking process.env.GEMINI_API_KEY...`);
  if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim()) {
    const envKey = process.env.GEMINI_API_KEY.trim();
    console.log(`[GeminiRefine:KeyLookup] -> Found key in process.env.GEMINI_API_KEY: ${maskKey(envKey)}`);
    return envKey;
  } else {
    console.log(`[GeminiRefine:KeyLookup] -> No key in process.env.GEMINI_API_KEY.`);
  }

  console.error(`[GeminiRefine:KeyLookup] -> FAILED: No Gemini API key found in any source!`);
  return null;
}

/**
 * Refine content using the Google Gen AI SDK and gemini-3.6-flash model.
 */
export async function refineContentWithGemini({
  content,
  type = "skill",
  instruction,
  username,
  apiKeyOverride,
  model,
  skills,
}: RefineContentOptions): Promise<RefineContentResult> {
  const targetModel = model?.trim() || GEMINI_REFINE_MODEL;
  console.log(`\n========================================`);
  console.log(`[GeminiRefine] Starting Content Refinement`);
  console.log(`[GeminiRefine] Options:`, {
    type,
    model: targetModel,
    username: username || "<none>",
    hasApiKeyOverride: Boolean(apiKeyOverride && apiKeyOverride.trim()),
    instruction: instruction ? `"${instruction.slice(0, 50)}..."` : "<none>",
    contentLength: content ? content.length : 0,
    skillsCount: skills ? skills.length : 0,
  });

  if (!content || !content.trim()) {
    console.warn(`[GeminiRefine] ERROR: Content to refine is empty.`);
    throw new RepoContextError("Content to refine cannot be empty.");
  }

  let apiKey: string | null = null;
  if (apiKeyOverride !== undefined) {
    apiKey = apiKeyOverride.trim() || null;
    if (apiKey) {
      console.log(`[GeminiRefine] Using explicit apiKeyOverride: ${maskKey(apiKey)}`);
    } else {
      console.log(`[GeminiRefine] Explicit apiKeyOverride was provided but empty.`);
    }
  } else {
    apiKey = await getEffectiveGeminiApiKey(username);
  }

  if (!apiKey) {
    console.error(`[GeminiRefine] ERROR: Gemini API key is missing! Cannot proceed.`);
    throw new RepoContextError(
      "Gemini API key is not configured in app config. Please configure your GEMINI_API_KEY in the Connections tab to enable AI refinement.",
    );
  }

  console.log(`[GeminiRefine] API key selected: ${maskKey(apiKey)}`);
  console.log(`[GeminiRefine] Target model: ${targetModel}`);

  // 1. Resolve mentions in content to concise directive hints: "skill-name (use get_skill to get it)"
  const matches = parseMentions(content);
  let resolvedContent = content;

  if (matches.length > 0) {
    console.log(
      `[GeminiRefine:Mentions] Found ${matches.length} mention(s) in content:`,
      matches.map((m) => m.raw),
    );

    resolvedContent = await resolveMentions(content, async (match) => {
      // Check in-memory skills first
      let foundSkill = skills?.find(
        (s) => s.name.toLowerCase() === match.name.toLowerCase(),
      );

      // Fallback to vector DB lookup
      if (!foundSkill) {
        try {
          const dbSkill = await getSkill(match.name).catch(() => null);
          if (dbSkill) {
            foundSkill = dbSkill;
          } else {
            const all = await listSkills(100).catch(() => ({ skills: [] }));
            foundSkill = all.skills.find(
              (s) => s.name.toLowerCase() === match.name.toLowerCase() || s.id === match.name,
            );
          }
        } catch (err) {
          console.warn(`[GeminiRefine:Mentions] Could not fetch skill "${match.name}" from vector DB:`, err);
        }
      }

      const skillName = foundSkill ? foundSkill.name : match.name;
      const hint = formatSkillToolHint(skillName);
      console.log(
        `[GeminiRefine:Mentions] Resolved mention "${match.raw}" -> "${hint}"`,
      );
      return hint;
    });
  } else {
    console.log(`[GeminiRefine:Mentions] No mentions found in content to resolve.`);
  }

  // Build system instruction and prompt depending on context
  let systemContext = "You will help me to refine, write it in markdown format. fix typo, gramma, make it more readable\nOutput ONLY the refined text directly without conversational commentary.";
if (type === 'system_prompt') {
    systemContext =
      "You are an expert AI prompt engineer specializing in LLM system prompts and behavioral guidelines.\n" +
      "Your task is to refine and optimize the provided AI System Prompt.\n" +
      "- Enhance clarity, authoritative tone, modular organization, and instruction-following effectiveness.\n" +
      "- Keep all specific persona guidelines, tool constraints, project references, tool directives (e.g. '(use get_skill to get it)'), and custom rules intact.\n" +
      "- Ensure markdown formatting is crisp and effective for LLM consumption.\n" +
      "- Do NOT wrap the entire response in a top-level code fence. Output ONLY the refined raw system prompt directly.";
  } 

  if (instruction && instruction.trim()) {
    systemContext += `\nAdditional user instruction: ${instruction.trim()}`;
  }

  const userContent = resolvedContent.trim();

  // Print full message sent to Gemini
  console.log(`\n================== FULL MESSAGE SENT TO GEMINI ==================`);
  console.log(`[System Instruction]:\n${systemContext}`);
  console.log(`-----------------------------------------------------------------`);
  console.log(`[User Content (Resolved with Mentions)]:\n${userContent}`);
  console.log(`=================================================================\n`);

  const ai = new GoogleGenAI({ apiKey });

  console.log(`[GeminiRefine] Calling ai.models.generateContent({ model: "${targetModel}" })...`);
  const startTime = Date.now();

  let response: any;
  try {
    response = await ai.models.generateContent({
      model: targetModel,
      contents: userContent,
      config: {
        systemInstruction: systemContext,
        temperature: 0.2,
        maxOutputTokens: 8192,
        tools: [], // No tools needed for refinement
      },
    });
    const elapsed = Date.now() - startTime;
    console.log(`[GeminiRefine] generateContent succeeded in ${elapsed}ms.`);
  } catch (err: unknown) {
    const elapsed = Date.now() - startTime;
    console.error(`[GeminiRefine] generateContent FAILED after ${elapsed}ms.`);
    console.error(`[GeminiRefine] Raw caught error:`, err);

    let status: number | undefined;
    let detail = "";
    if (err && typeof err === "object") {
      if ("status" in err && typeof (err as any).status === "number") {
        status = (err as any).status;
      }
      const rawMsg = "message" in err ? String((err as any).message) : String(err);
      try {
        const parsed = JSON.parse(rawMsg);
        detail = parsed?.error?.message || rawMsg;
      } catch {
        detail = rawMsg;
      }
    } else {
      detail = String(err);
    }

    console.error(`[GeminiRefine] Extracted error info: status=${status}, detail="${detail}"`);

    if (status === 400 || status === 403) {
      throw new RepoContextError(`Gemini API key rejected or invalid (${status}): ${detail}`);
    }
    if (status) {
      throw new RepoContextError(`Gemini refinement failed (${status}): ${detail}`);
    }
    throw new RepoContextError(`Gemini refinement failed: ${detail}`);
  }

  const refinedText = response?.text || response?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!refinedText || typeof refinedText !== "string") {
    console.error(`[GeminiRefine] ERROR: Gemini API returned an empty or invalid candidate text. Full response:`, response);
    throw new RepoContextError("Gemini API returned an empty or invalid candidate text.");
  }

  let cleaned = refinedText.trim();
  // Strip accidental outer code block if the LLM wrapped markdown in ```markdown ... ```
  if (cleaned.startsWith("```markdown\n") && cleaned.endsWith("```")) {
    cleaned = cleaned.slice("```markdown\n".length, cleaned.length - 3).trim();
  } else if (cleaned.startsWith("```\n") && cleaned.endsWith("```") && !content.trim().startsWith("```")) {
    cleaned = cleaned.slice(4, cleaned.length - 3).trim();
  }

  console.log(`[GeminiRefine] Refinement completed successfully: originalLength=${content.length}, refinedLength=${cleaned.length}`);
  console.log(`========================================\n`);

  return {
    refinedContent: cleaned,
    model: targetModel,
    originalLength: content.length,
    refinedLength: cleaned.length,
  };
}
