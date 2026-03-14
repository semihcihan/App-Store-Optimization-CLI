<h1 align="center">App Store Optimization CLI</h1>

<p align="center">
  <img src="./assets/app-icon/aso-icon-readme.png" alt="ASO icon" width="132" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/aso-cli"><img src="https://img.shields.io/npm/v/aso-cli" alt="npm version" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="License: MIT" /></a>
  <a href="https://www.npmjs.com/package/aso-cli"><img src="https://img.shields.io/node/v/aso-cli" alt="Node.js" /></a>
  <a href="https://github.com/semihcihan/App-Store-Optimization-CLI/actions/workflows/ci.yml"><img src="https://github.com/semihcihan/App-Store-Optimization-CLI/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI" /></a>
</p>

Research ASO keywords, inspect competition, and manage results from one local-first CLI.

## What Is It?

- Fast, free keyword research and visibility tracking
- Keyword scoring with popularity + difficulty in one command
- Local ASO dashboard for reviewing keyword/app data
- MCP tool (`aso_evaluate_keywords`) for agent workflows and automated keyword research

<h3 align="center">ASO Dashboard</h3>

<p align="center">
  <img src="./cli/dashboard-ui/public/dashboard.jpg" alt="ASO dashboard" title="ASO Dashboard" width="900" />
</p>

<h3 align="center">MCP</h3>

The dashboard keywords shown above were discovered and added automatically by an agent using the MCP tool.

<p align="center">
  <img src="./cli/dashboard-ui/public/mcp.jpg" alt="ASO MCP workflow" width="900" />
</p>

## Install

```bash
npm install -g aso-cli
```

Note: requires Node.js `>=20.18.1`.

## Apple Search Ads Setup

ASO commands require Apple Search Ads setup.

### Prerequisites

- App Store Connect account
- App ID of a published app you can access
- No campaign creation required
- No billing information required

### Setup

1. Create/sign in: https://searchads.apple.com
   - If your country is not available during signup, select `United States`.
2. Open Apple Search Ads Advanced: https://searchads.apple.com/advanced
3. Click your account name in the top-left corner.
4. Under Campaign Groups, click Settings.
5. Click Link Accounts.
6. Select your App Store Connect account and save.
   - If this is your first time using Apple Search Ads, you will usually have only one campaign group.
7. Copy an App ID from your App Store URL (number after `id`)
   Example App Store URL:
   ```text
   https://apps.apple.com/us/app/example-app/id123456789
   ```
   App ID is `123456789` in this example.
8. Run `aso auth` and complete Apple ID + password + 2FA in terminal

Notes:

- You may see a missing billing information warning; this can be safely ignored.
- Ensure all campaign groups are linked to a valid App Store Connect account.
- [Troubleshoot App Store Connect account linking](https://ads.apple.com/app-store/help/get-started/0012-link-app-store-connect-accounts)

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

| Command                         | What it does                                            |
| ------------------------------- | ------------------------------------------------------- |
| `aso`                           | Starts the local dashboard (default command)            |
| `aso keywords "k1,k2,k3"`       | Fetches keyword popularity/difficulty and prints JSON   |
| `aso keywords "k1,k2" --stdout` | Machine-safe non-interactive mode for automation/agents |
| `aso auth`                      | Reauthenticates Apple Search Ads session                |
| `aso reset-credentials`         | Clears saved credentials/cookies                        |
| `aso --primary-app-id <id>`     | Sets primary App ID used for popularity requests        |

### Supported flags

- `--country <code>`: currently `US` only
- `--primary-app-id <id>`: saved locally for future runs

## Output Example (`aso keywords "meditation"`)

````json
{
  "items": [
    {
      "keyword": "meditation",
      "popularity": 45,
      "difficultyScore": 62,
      "minDifficultyScore": 38
    }
  ],
  "failedKeywords": []
}
````

## MCP

This package also installs `aso-mcp` with tool: `aso_evaluate_keywords`.

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

## Current Scope

- Storefront support: `US`
- Multi-storefront support is planned

## Project Docs

- Contribution guide: [CONTRIBUTING.md](CONTRIBUTING.md)
