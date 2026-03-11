# ASO MCP Development

This package exposes `aso-mcp`, a minimal MCP server for ASO keyword evaluation.

## Tooling

Current MCP tool surface:

- `aso_suggest`: evaluates explicit ASO keyword candidates and returns only accepted keywords.

## Local Run

```bash
npm run build
npm run mcp
```

or from `cli/` directly:

```bash
npm run build
npm run mcp
```

## Inspector

```bash
npm run mcp:test
```

## Example MCP Client Config

```json
{
  "mcpServers": {
    "aso": {
      "command": "aso-mcp"
    }
  }
}
```

## Notes

- If keyword evaluation requires interactive auth, run `aso auth` in a terminal and retry.
