# App Store Optimization CLI

Standalone CLI for App Store Optimization workflows.

## Install

```bash
npm install -g app-store-optimization-cli
```

Or run locally in this repository:

```bash
npm install
npm run build
npm run start -- --help
```

## Commands

```bash
# Open ASO dashboard (default)
aso

# Fetch keyword metrics and persist accepted keywords
aso keywords "meditation,sleep sounds,white noise"

# Machine-safe output for agents/automation
aso keywords "meditation,sleep sounds,white noise" --stdout

# Reauthenticate Apple Search Ads session
aso auth

# Reset saved ASO credentials/cookies
aso reset-credentials

# Set or update primary app ID used for popularity requests
aso --primary-app-id 1234567890
```

## MCP Server

The package includes `aso-mcp` with one tool: `aso_suggest`.

Example MCP command config:

```json
{
  "mcpServers": {
    "aso": {
      "command": "aso-mcp"
    }
  }
}
```

## Storage

Runtime files are local under `~/.aso`:

- `aso-db.sqlite`
- `aso-cache.json`
- `aso-cookies.json`
- `version-cache.json`

Use `ASO_DB_PATH` to override database location.

## Development

```bash
npm run dev
```

`dev` runs watch mode for:
- Dashboard UI (`vite --watch`)
- CLI bundle (`esbuild --watch`)
- MCP bundle (`esbuild --watch`)

Project folders (single package):

- `cli`: CLI entrypoint, dashboard server/UI, MCP server, local services, shared utilities

## Notes

- Storefront is currently `US` only.
- If non-interactive keyword runs fail with auth-required errors, run `aso auth` once in an interactive terminal and retry.
