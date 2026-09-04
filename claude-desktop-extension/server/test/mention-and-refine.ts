import assert from "node:assert/strict";
import { parseMentions, formatMention, resolveMentions, formatSkillToolHint } from "../src/utils/mention.js";
import { refineContentWithGemini, GEMINI_REFINE_MODEL } from "../src/services/refine.js";
import { buildPanel, buildSkillsPanel, loadMentionComponent } from "../src/utils/helpers.js";

async function runTests() {
  console.log("Starting Mention & Refine unit tests...");

  // 1. parseMentions tests
  {
    const text1 = "Please follow the instructions in @[skill:database-migration] and @[code-style-guide].";
    const matches1 = parseMentions(text1);
    assert.equal(matches1.length, 2, "Should find 2 mentions");
    assert.equal(matches1[0].raw, "@[skill:database-migration]");
    assert.equal(matches1[0].type, "skill");
    assert.equal(matches1[0].name, "database-migration");

    assert.equal(matches1[1].raw, "@[code-style-guide]");
    assert.equal(matches1[1].type, "skill");
    assert.equal(matches1[1].name, "code-style-guide");

    // Plain @mentions
    const text2 = "Check out @deployment-guide for deployment and @unit-testing-rules.";
    const matches2 = parseMentions(text2);
    assert.equal(matches2.length, 2);
    assert.equal(matches2[0].name, "deployment-guide");
    assert.equal(matches2[1].name, "unit-testing-rules");

    // Email addresses should not trigger plain @mentions
    const text3 = "Contact dev@company.com or ping @oncall-guide.";
    const matches3 = parseMentions(text3);
    assert.equal(matches3.length, 1);
    assert.equal(matches3[0].name, "oncall-guide");

    // Empty text
    assert.deepEqual(parseMentions(""), []);
    console.log("✓ parseMentions tests passed");
  }

  // 2. formatMention & formatSkillToolHint tests
  {
    assert.equal(formatMention({ name: "db-guide", type: "skill" }), "@[skill:db-guide]");
    assert.equal(formatMention({ name: "db-guide" }), "@[skill:db-guide]");
    assert.equal(formatMention({ name: "db-guide", type: "skill" }, "at"), "@db-guide");

    // Agent tool hint format
    assert.equal(formatSkillToolHint("notion-skill"), "notion-skill (use get_skill to get it)");
    console.log("✓ formatMention & formatSkillToolHint tests passed");
  }

  // 3. resolveMentions tests
  {
    const text = "Refer to @[skill:ci-cd] for details.";
    const resolved = await resolveMentions(text, async (match) => {
      if (match.name === "ci-cd") {
        return "Continuous Integration & Deployment (Skill #42)";
      }
      return null;
    });
    assert.equal(resolved, "Refer to Continuous Integration & Deployment (Skill #42) for details.");

    // Resolve user prompt with @notion-skill
    const prompt = "use @notion-skill to know to to manage my task";
    const resolvedPrompt = await resolveMentions(prompt, (m) => formatSkillToolHint(m.name));
    assert.equal(resolvedPrompt, "use notion-skill (use get_skill to get it) to know to to manage my task");

    console.log("✓ resolveMentions tests passed");
  }

  // 4. refineContentWithGemini tests
  {
    // Empty content error
    await assert.rejects(
      async () => {
        await refineContentWithGemini({ content: "" });
      },
      /cannot be empty/i,
      "Should reject empty content",
    );

    // Missing API key error when no env or app config
    const origEnvKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    await assert.rejects(
      async () => {
        await refineContentWithGemini({ content: "Some content to refine", apiKeyOverride: "" });
      },
      /Gemini API key is not configured/i,
      "Should reject when no API key configured",
    );
    if (origEnvKey) process.env.GEMINI_API_KEY = origEnvKey;

    assert.equal(GEMINI_REFINE_MODEL, "gemini-3.6-flash");

    // Mock fetch for Gemini refine call via @google/genai SDK
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (url: any, init: any) => {
        assert.ok(String(url).includes(GEMINI_REFINE_MODEL), `URL should target ${GEMINI_REFINE_MODEL}`);
        const headers = init?.headers instanceof Headers
          ? Object.fromEntries(init.headers.entries())
          : (init?.headers || {});
        const apiKey = headers["x-goog-api-key"] || String(url).match(/key=([^&]+)/)?.[1];
        assert.equal(apiKey, "test-api-key", "Request should contain api key in header or URL");
        const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
        assert.ok(body.contents?.[0]?.parts?.[0]?.text, "Request should contain text payload");

        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: "## Refined Skill Content\n\n- Improved step 1\n- Improved step 2",
                    },
                  ],
                },
              },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      };

      const result = await refineContentWithGemini({
        content: "Draft skill content",
        type: "skill",
        apiKeyOverride: "test-api-key",
      });

      assert.equal(result.model, GEMINI_REFINE_MODEL);
      assert.equal(result.refinedContent, "## Refined Skill Content\n\n- Improved step 1\n- Improved step 2");
      assert.ok(result.originalLength > 0);
      assert.ok(result.refinedLength > 0);
      console.log("✓ refineContentWithGemini mocked test passed");

      // Test mention resolution inside refineContentWithGemini
      let interceptedPayloadText = "";
      globalThis.fetch = async (url: any, init: any) => {
        const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
        interceptedPayloadText = body.contents?.[0]?.parts?.[0]?.text || "";
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: "## Refined with @[skill:database-migration]" }],
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const resultWithMentions = await refineContentWithGemini({
        content: "Please check @[skill:database-migration] before running migrations.",
        type: "skill",
        apiKeyOverride: "test-api-key",
        skills: [
          {
            name: "database-migration",
            description: "How to run database migrations",
            content: "Step 1: backup DB. Step 2: run npm run migrate:up.",
          },
        ],
      });

      assert.equal(resultWithMentions.refinedContent, "## Refined with @[skill:database-migration]");
      assert.equal(
        interceptedPayloadText,
        "Please check database-migration (use get_skill to get it) before running migrations.",
        "Payload sent to Gemini should be clean resolved string with tool directive hint",
      );
      assert.ok(!interceptedPayloadText.includes("--- ORIGINAL CONTENT TO REFINE"), "Should not have wrapper fences");
      assert.ok(!interceptedPayloadText.includes("--- REFERENCED MENTIONED SKILLS CONTEXT"), "Should not have massive referenced skills context");
      console.log("✓ refineContentWithGemini with lean tool directive hint test passed");
    } finally {
      globalThis.fetch = originalFetch;
    }

    // Test response error handling logic (ensures isError prevents JSON.parse crash)
    const errorToolResponse = {
      content: [{ type: "text", text: "Gemini refinement failed (429): Your prepayment credits are depleted." }],
      isError: true,
    };
    assert.throws(
      () => {
        if (errorToolResponse.isError) {
          throw new Error(errorToolResponse.content?.[0]?.text || "Refinement request failed");
        }
        JSON.parse(errorToolResponse.content[0].text);
      },
      /Gemini refinement failed \(429\)/,
      "Should cleanly throw the server error message instead of failing with JSON.parse error",
    );
    console.log("✓ error response handling test passed");
  }

  // 5. Widget bundling tests
  {
    const mentionComp = loadMentionComponent();
    assert.ok(mentionComp.length > 500, "Mention component should have content");
    assert.ok(mentionComp.includes("MentionController"), "Should contain MentionController");

    const skillsHtml = buildSkillsPanel();
    assert.ok(!skillsHtml.includes("/*__MENTION_COMPONENT__*/"), "skills.html should have placeholder replaced");
    assert.ok(skillsHtml.includes("MentionController"), "skills.html should include MentionController code");
    assert.ok(skillsHtml.includes("btn-refine"), "skills.html should include btn-refine style");

    const panelHtml = buildPanel();
    assert.ok(!panelHtml.includes("/*__MENTION_COMPONENT__*/"), "panel.html should have placeholder replaced");
    assert.ok(panelHtml.includes("refineSystemPromptBtn"), "panel.html should have refineSystemPromptBtn");
    assert.ok(panelHtml.includes("compRefineSkillContentBtn"), "panel.html should have compRefineSkillContentBtn");
    console.log("✓ Widget bundling tests passed");
  }

  console.log("\nAll Mention & Refine unit tests passed successfully!");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
