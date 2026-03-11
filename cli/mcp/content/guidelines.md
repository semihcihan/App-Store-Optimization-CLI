## ASO MCP Guidelines

Use `aso_suggest` to evaluate explicit ASO keyword candidates (US storefront only).

## Tool Input

- `keywords`: array of ASO search term candidates (single-word or long-tail phrases).
- `minPopularity` (optional): minimum popularity threshold.
- `maxDifficulty` (optional): maximum difficulty threshold.

## Behavior

- Keywords are normalized to lowercase, deduplicated, and invalid candidates are dropped.
- The tool runs `aso keywords <terms> --stdout` under the hood.
- Output is a JSON array containing only accepted keywords with compact fields:
  - `keyword`
  - `popularity`
  - `difficulty`
  - `minDifficultyScore`

## Auth Requirement

If machine-safe execution fails because interactive Apple Search Ads auth is required, the user must run:

```bash
aso auth
```

Then retry `aso_suggest`.
