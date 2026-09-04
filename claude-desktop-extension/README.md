# Automate Work

> **Bridging the gap between engineering context, product ideation, and collaborative team intelligence in Claude Desktop.**

---

## 💡 The Problem: Fragmented Work & Context Silos

In modern software teams, critical project context is fragmented across disconnected tools and applications:

- **Code & Architecture** live in **GitHub** (repositories, branches, components, file trees).
- **Product Specs & Tasks** live in **Notion** (PRDs, sprint backlogs, design guidelines, meeting notes).
- **Data Models** live in **SQL Databases** (schemas, tables, relationships).
- **Team Knowledge & Standards** are scattered across chats, docs, or trapped as tribal knowledge.

### The Real-World Costs:

1. **High Synchronization Overhead**: Teams waste countless hours hunting for context, copying information between tools, and constantly aligning on "what exists" vs. "what is being built".
2. **The Non-Technical Gap in Ideation & Mockup UI**:
   - For non-technical team members (Product Managers, Designers, Marketers, QA), it is notoriously difficult to translate ideas into realistic UI mockups or actionable specs that align with the actual codebase.
   - Prototyping often results in disconnects: proposed UI designs disregard existing reusable components, break design systems, or mismatch current backend schemas and sprint tickets.
3. **Siloed AI Prompts & Lack of Shared Team Skills**:
   - AI assistants usually operate in isolation with zero institutional memory.
   - Team members repeat the same prompts, re-teach coding standards, or miss critical team guidelines.
   - Teams need a shared, collaborative way to **manage, evolve, and execute team skills together**.

---

## 🚀 The Solution: A Unified Team Context for AI

**Automate Work** transforms Claude Desktop into a fully context-aware team member that bridges engineering reality with product vision.

```
       ┌─────────────────────────────────────────────────────────────┐
       │                     Claude Desktop App                      │
       └──────────────────────────────┬──────────────────────────────┘
                                      │
                         [ MCP / Interactive UI ]
                                      │
     ┌────────────────────────────────┼────────────────────────────────┐
     ▼                                ▼                                ▼
┌──────────────┐             ┌──────────────────┐             ┌─────────────────┐
│ 🐙 GitHub     │             │ 🧠 Shared Skills │             │ 📝 Notion & SQL │
│ Repositories │             │  & Guidelines    │             │ Specs & Schemas │
│ Components   │             │ (Qdrant Vectors) │             │ Live Tickets    │
└──────────────┘             └──────────────────┘             └─────────────────┘
```

### Key Value Drivers:

- **🎨 Grounded UI Mockups & Ideation**: Non-technical team members can easily brainstorm, generate realistic UI mockups, and draft feature requirements grounded directly in existing frontend components, design guidelines, and active Notion tickets.
- **🤝 Collaborative Skill Management**: Centrally manage, search, and share team skills, SOPs, and coding conventions across the entire team using vector embeddings.
- **⚡ Seamless Multi-Tool Sync**: Claude connects GitHub repositories, Notion workspaces, and SQL databases into a single conversational session.
- **🖥️ Interactive UI Panels**: Visual in-chat widgets (`config.html`, `skills.html`, `panel.html`) so anyone—technical or not—can configure credentials, select repositories, and curate skills without touching CLI configs.

---

## 🌟 Core Capabilities

### 1. Collaborative Team Skills (`manage_skills`)
- **Shared Knowledge Base**: Create, edit, tag, and organize team guidelines, prompt workflows, and engineering conventions.
- **Semantic Vector Search**: Powered by Qdrant and Google Gemini 3072-dimensional embeddings, Claude automatically pulls relevant skills and SOPs into conversation.
- **Crowdsourced Team Intelligence**: Everyone on the team can contribute skills so the whole team benefits from shared best practices.

### 2. Cross-Functional UI Prototyping & Ideation
- **Component-Aware Mockups**: Claude inspects active GitHub UI components and styling guidelines to propose UI changes that actually match the codebase.
- **Spec-to-Ticket Alignment**: Cross-reference Notion PRDs and database schemas when creating mockups or technical implementation plans.

### 3. Multi-Session App & Repository Configuration (`configure_app`)
- Select multiple active GitHub repositories simultaneously.
- Assign custom contextual descriptions for each repo so Claude knows how they interconnect.
- Customize shared AI system prompts stored centrally in Qdrant (`app-config`).

### 4. Direct GitHub, Notion & Database Integrations
- **GitHub**: Search code, explore file trees, read files with line slicing, and inspect repo layout.
- **Notion**: Query databases and search pages directly from the prompt.
- **SQL Databases**: Inspect table schemas and query relational data securely.

---

## 🛠️ Interactive Widgets & Tools Reference

### 1. Interactive Widgets

| Widget Tool | URI | Purpose & Experience |
|---|---|---|
| `configure_app` | `ui://repo-context/config.html` | Multi-select active GitHub repositories with custom context notes, edit team system prompt, and configure integrations. |
| `manage_skills` | `ui://repo-context/skills.html` | Visual CRUD and semantic search interface for managing shared team skills and guidelines. |
| `connect_team_context` | `ui://repo-context/panel.html` | Unified credential management and instant connection testing for GitHub, Notion, Qdrant, SQL, and Gemini. |

### 2. Team Skills Tools

| Tool | Description |
|---|---|
| `search_skills` | Semantically searches team skills and guidelines in Qdrant using vector similarity. |
| `list_skills` | Lists all available skills and guideline documents in the knowledge base. |
| `get_skill` | Retrieves full instructions and content for a specific skill by name or UUID. |

### 3. Application Configuration Tools

| Tool | Description |
|---|---|
| `get_app_config` | Retrieves the active repositories, contextual descriptions, and system prompt. |
| `save_app_config` | Saves or updates active repository configurations and system prompts in Qdrant. |

### 4. GitHub Tools

| Tool | Description |
|---|---|
| `github_repo_status` | Checks sign-in state and active repository status. |
| `repo_overview` | Summarizes branch, language breakdown, top-level layout, and README. |
| `list_repo_files` | Explores files and directories with recursive tree support. |
| `read_repo_file` | Reads file contents with line slicing support. |
| `search_repo_code` | Performs full-text code search across the active repository. |
| `set_active_repo` | Switches the active repository (`owner/repo`). |
| `github_disconnect` | Clears stored token and resets repository state. |

---

## 🔒 Security & Credential Storage

- **Local & OS Keychain Storage**: Credentials entered via extension panels are stored securely in macOS Keychain (or Linux Secret Service) and local configuration files.
- **Direct Validation**: API keys and tokens are validated directly against provider endpoints (GitHub, Notion, Qdrant, Gemini).
- **Privacy First**: Sensitive credentials are never exposed in conversation prompts or sent to third-party tracking services.

---

## 📦 Getting Started & Development

### Prerequisites
- Node.js (v18+)
- Claude Desktop App

### Build Commands

```bash
# Build TypeScript server
npm run build:ts

# Run test suite
npm test

# Build and bundle Claude Desktop extension (.mcpb & .pmcp)
npm run build
```

The output bundle is generated at `dist/automate-work.mcpb`.
