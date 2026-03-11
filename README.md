# App Store Optimization CLI

Research ASO keywords, inspect competition, and manage results from one local-first CLI.

## Why use it

- Fast, free keyword research and visibility tracking
- Keyword scoring with popularity + difficulty in one command
- Local dashboard for reviewing keyword/app data
- MCP tool (`aso_suggest`) for agent workflows and automated keyword research
- Local persistence and reusable auth session

## Install

```bash
npm install -g aso-cli
```

## Apple Search Ads Setup

ASO commands require Apple Search Ads setup.

### Prerequisites

- Apple Search Ads account
- Linked App Store Connect account
- App ID of a published app you can access
- No campaign creation or billing required

### Setup

1. Create/sign in: https://searchads.apple.com
2. Open Advanced: https://searchads.apple.com/advanced
3. Link your App Store Connect account in campaign group settings
4. Copy an App ID from your App Store URL (number after `id`)
5. Run `aso auth` and complete Apple ID + password + 2FA in terminal

Example App Store URL:

```text
https://apps.apple.com/us/app/example-app/id123456789
```

App ID is `123456789` in this example.

## Quick Start

```bash
# Authenticate once
aso auth

# Fetch keyword metrics
aso keywords "meditation,sleep sounds,white noise"

# Open dashboard
aso
```

## Command Reference

| Command | What it does |
| --- | --- |
| `aso` | Starts the local dashboard (default command) |
| `aso keywords "k1,k2,k3"` | Fetches keyword popularity/difficulty and prints JSON |
| `aso keywords "k1,k2" --stdout` | Machine-safe non-interactive mode for automation/agents |
| `aso auth` | Reauthenticates Apple Search Ads session |
| `aso reset-credentials` | Clears saved credentials/cookies |
| `aso --primary-app-id <id>` | Sets primary App ID used for popularity requests |

### Supported flags

- `--country <code>`: currently `US` only
- `--primary-app-id <id>`: saved locally for future runs

## Output Example (`aso keywords`)

```json
[
  {
    "keyword": "meditation",
    "popularity": 45,
    "difficultyScore": 62,
    "minDifficultyScore": 38
  }
]
```

## MCP

This package also installs `aso-mcp` with tool: `aso_suggest`.

Example MCP config:

```json
{
  "mcpServers": {
    "aso": {
      "command": "aso-mcp"
    }
  }
}
```

## Help

```bash
aso --help
```

## Current Scope

- Storefront support: `US`
- Multi-storefront support is planned

## Project Docs

- Contribution guide: [CONTRIBUTING.md](CONTRIBUTING.md)
