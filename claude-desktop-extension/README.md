# My Team Context

A Claude Desktop extension that gives Claude a live, unified view of how your team actually works: source code on GitHub, documentation and sprint tasks in Notion, relational databases via SQL, shared team skills in Qdrant vector database, and centralized AI application configuration.

## Features

- **⚡ Centralized Settings Panel (`connect_team_context`)**: Authenticate and configure all team credentials in one place (GitHub PAT, Notion API key, Qdrant cluster endpoint & key, SQL database connection string, and Google Gemini embedding key).
- **⚙️ Multi-Session App Configuration (`configure_app`)**: Interactive configuration widget to select multiple active GitHub repositories with custom context descriptions, customize the AI system prompt in Markdown, and configure integrations. Stored under the `app-config` collection in Qdrant.
- **🧠 Team Skills & Knowledge Base (`manage_skills`)**: Centrally manage, create, edit, delete, and semantically search team guidelines, coding standards, and SOPs in Qdrant vector database embedded with Google Gemini 3072-dimensional embeddings.
- **🐙 GitHub Code Context**: Browse file trees, read code files, and semantically or full-text search code across your active repositories.
- **📝 Notion Integration**: Query databases and search workspace documentation directly from chat.
- **🗄️ SQL Database Integration**: Query database tables and retrieve database schemas securely.

---

## Interactive Widgets & Tools

### 1. Interactive Widgets

| Widget Tool | URI | Description |
|---|---|---|
| `configure_app` | `ui://repo-context/config.html` | Multi-session app configuration: multi-select GitHub repositories with descriptions, edit system prompt, and Notion setup |
| `manage_skills` | `ui://repo-context/skills.html` | Full CRUD and vector similarity search for team skills and guidelines in Qdrant |
| `connect_team_context` | `ui://repo-context/panel.html` | Unified credential management and connection testing panel |

### 2. Team Skills & Knowledge Base Tools

| Tool | Description |
|---|---|
| `search_skills` | Semantically search skills and guidelines in Qdrant using vector embeddings |
| `list_skills` | List all skills and guideline documents in the knowledge base |
| `get_skill` | Retrieve full content and instructions for a specific skill by name or UUID |

### 3. Application Configuration Tools

| Tool | Description |
|---|---|
| `get_app_config` | Retrieve active repositories, custom descriptions, and system prompt from `app-config` |
| `save_app_config` | Programmatically save or update active repositories and system prompt in `app-config` |

### 4. GitHub Tools

| Tool | Description |
|---|---|
| `github_repo_status` | Report sign-in state and which repo is active |
| `repo_overview` | Summarize branch, languages, top-level layout, and README |
| `list_repo_files` | List files and directories (with recursive tree support) |
| `read_repo_file` | Read file contents (with line slicing support) |
| `search_repo_code` | Search code inside active repository |
| `set_active_repo` | Set active repository by name (`owner/name`) |
| `github_disconnect` | Delete stored token and clear active repository |

---

## Security & Credential Storage

Credentials entered into the extension panels are validated directly against service APIs and securely stored in:
- The macOS login keychain (or libsecret on Linux)
- Local `server/.env` file with restrictive permissions

Credentials are never exposed in conversation contexts or transmitted to third-party servers.

---

## Development & Build

```bash
# Build TypeScript
npm run build:ts

# Run tests
npm test

# Build and package Claude Desktop extension (.mcpb & .pmcp)
npm run build
```

The output bundle is generated at `dist/repo-context.mcpb`.
