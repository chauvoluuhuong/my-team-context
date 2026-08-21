# My Team Context

A Claude Desktop extension that gives Claude a live view of how your team
actually works: the source code on GitHub, the docs and specs in Notion, and
the team's shared library of skills — all as context in one place.

## Goal

Today, answering "what's going on with X" or "build me a mockup of Y" means
manually pulling context from three different tools and pasting it into a
prompt. This project aims to remove that step, so the team can just ask:

- **Ask what's going on** — prompt Claude and have it pull the real answer
  from the codebase (GitHub) and the team's specs/decisions (Notion), instead
  of asking a person to summarize it.
- **Generate UI mockups quickly** — grounded in the team's actual data
  structures, visual style, and business context, and checked against real
  data on staging, so a mockup isn't just plausible-looking, it's consistent
  with what the team already has.
- **Manage the team's skills centrally** — skills live in a vector database
  so they can be searched, reused, and kept up to date across the team rather
  than copy-pasted between individual setups.

## GitHub Repo Context

An MCP bundle that lets Claude read one of your GitHub repositories as context.

You paste a personal access token into a panel, pick a repo from the list of
everything that token can see, and from then on Claude can list, read, and
search that repo's files — no local checkout required, and the choice sticks
across sessions.

## The flow

Say something like *"list my repos"*, *"connect my GitHub repo"*, or ask a
question about your code before anything is connected:

1. **A panel opens.** Paste a personal access token. It is validated against
   `api.github.com`, then stored in this machine's keychain.
2. **The panel lists your repos** — most recently pushed first, with a filter
   box. Click one and press **Use this repo**.
3. **The choice is saved** to `~/.claude/repo-context/state.json`, and the panel
   tells Claude to start with an overview of the repo.

After that, `owner/name` is the active repo for every later session until you
pick a different one.

## Tools

| Tool | What it does |
|---|---|
| `connect_github_repo` | Opens the panel — sign in and pick the active repo |
| `github_repo_status` | Who is signed in, which repo is active |
| `repo_overview` | Branch, languages, top-level layout, README — one call |
| `list_repo_files` | One directory, or every file under a path with `recursive: true` |
| `read_repo_file` | One file, optionally a line range |
| `search_repo_code` | GitHub code search scoped to the active repo |
| `set_active_repo` | Switch repos by name, skipping the panel |
| `github_disconnect` | Delete the token and clear the active repo |

Every read tool takes an optional `repo` argument to hit a different repository
without changing the active one.

## The token

Create one at **github.com → Settings → Developer settings → Personal access
tokens** (the panel's *Create a token* button links straight there):

- **Classic:** `repo` scope.
- **Fine-grained:** `Contents: Read-only`, granted to the repos you want
  readable. Note that a fine-grained token only lists the repos it was granted —
  if the list looks short, that's the token's scope, not a bug.

The token goes from the panel straight to the extension's own process. It never
passes through the conversation, is never used as a command-line argument, and
is stored in the macOS login keychain, libsecret on Linux, or a `0600` file as a
last resort (with a warning when that happens).

`github_disconnect` deletes it.

## Build

```bash
npm --prefix server run build
```

Installs production dependencies, validates `manifest.json` against the MCPB
schema, runs the tests, and writes `../dist/repo-context.mcpb`. Install that
file by opening it, or drag it into the extensions settings pane.

Bump `version` in `manifest.json` before rebuilding — the output filename stays
the same, so the manifest version is the only thing that distinguishes builds.

| Script | Does |
|---|---|
| `npm --prefix server run build` | The whole chain: deps → validate → test → pack |
| `npm --prefix server run validate` | Manifest schema check on its own |
| `npm --prefix server run build:pack` | Re-zip only, skipping deps and tests |
| `npm --prefix server run info` | Size and signature status of the built bundle |

`build:deps` installs with `--omit=dev`, because everything in
`server/node_modules` ends up inside the bundle — a dev dependency added here
ships to every user.

## Layout

```
manifest.json               # MCPB manifest — entry point, tool list, metadata
server/src/index.js         # MCP server: tool registration, panel resource
server/src/github.js        # GitHub REST calls (read-only)
server/src/store.js         # Keychain token storage + active-repo state
server/widgets/panel.html   # The sign-in / repo-picker panel
server/test/api.mjs         # Read path against a stub GitHub — no credential
server/test/smoke.mjs       # Server starts, tools register, panel renders
```

## Tests

```bash
npm --prefix server test
npm --prefix server run smoke
```

Neither test touches a real token or reaches github.com: `api.mjs` runs against
a local stub that rejects anything but its fake credential, and `smoke.mjs`
drives the server over stdio with a throwaway data directory.

## Environment overrides

| Variable | Effect |
|---|---|
| `REPO_CONTEXT_TOKEN` | Use this token instead of the keychain (headless runs, CI) |
| `REPO_CONTEXT_DATA` | Where the active-repo state and fallback token file live |
| `REPO_CONTEXT_API` | Point at a different GitHub API base (testing, GHE) |

## Limits worth knowing

- **Code search matches whole tokens, not substrings**, and skips very large
  files. A miss is not proof a string is absent — fall back to
  `list_repo_files` then `read_repo_file`.
- `list_repo_files` with `recursive: true` returns at most 400 entries per call
  and says so when it truncates; narrow with `path`.
- `read_repo_file` cuts output at 60,000 characters and tells you the line range
  to re-request.
