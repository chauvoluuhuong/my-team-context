# Automate Work

> **Bridging the gap between engineering context, product ideation, and collaborative team intelligence in Claude Desktop.**

---

## 💡 Overview

**Automate Work** transforms Claude Desktop into a fully context-aware team member that bridges engineering reality with product vision. It unifies:

- 🐙 **GitHub Repositories**: Source code, component trees, branches, and code search.
- 📝 **Notion Workspace**: PRDs, tickets, sprint backlogs, and workspace databases.
- 🗄️ **SQL Databases**: Live schema discovery, tables, and secure querying.
- 🧠 **Team Knowledge Base & Skills**: Semantic search and shared guidelines powered by Qdrant vector database and Google Gemini embeddings.
- 🖥️ **Interactive UI Panels**: In-chat configuration and skill management widgets (`config.html`, `skills.html`, `panel.html`).

---

## 📽️ Interactive Presentation Deck

An interactive slide deck is included at [`presentation.html`](./presentation.html).

- **View**: Open [`presentation.html`](./presentation.html) in any modern web browser.
- **Controls**:
  - `◀` / `▶` or `Space`: Navigate slides
  - `S`: Toggle presenter script / speaker notes
  - `F`: Toggle full screen

---

## 📁 Project Structure

```
automate-work/
├── package.json                   # Root package script runner
├── presentation.html              # Interactive presentation slide deck
└── claude-desktop-extension/      # Claude Desktop MCP extension
    ├── manifest.json              # Extension manifest
    ├── README.md                  # Extension documentation
    └── server/                    # MCP TypeScript server & UI widgets
```

---

## 🛠️ Quick Start & Development

### Prerequisites
- Node.js (v20+)
- Claude Desktop App

### Scripts

From the root directory:

```bash
# Build TypeScript server
npm run build:ts

# Run test suite
npm test

# Run smoke test
npm run smoke

# Build and package Claude Desktop extension (.mcpb & .pmcp)
npm run build
```

The compiled extension bundles are generated in `dist/automate-work.mcpb` and `dist/automate-work.pmcp`.

---

## 📄 Documentation

For in-depth details on MCP tools, interactive widgets, credential security, and architecture, see [claude-desktop-extension/README.md](./claude-desktop-extension/README.md).
