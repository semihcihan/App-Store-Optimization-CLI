# Scripts

This folder contains utility scripts for local debugging, telemetry inspection, and experiments.

## Bugsnag Export

Use [`bugsnag-export-events.sh`](./bugsnag-export-events.sh) to export hosted Bugsnag events (full reports) and generate a quick noise summary.

### Prerequisites

- `curl`
- `jq`
- A Bugsnag Personal Auth Token (PAT)

### Setup

```bash
export BUGSNAG_TOKEN="your_personal_auth_token"
```

Optional:

```bash
export BUGSNAG_BASE_URL="https://api.bugsnag.com"
# Use https://api.bugsnag.smartbear.com if your org is hosted there

export PER_PAGE="100"
export BASE_ISO="2026-03-01T00:00:00Z"
export OUTPUT_DIR=".artifacts/bugsnag-events"
```

### Commands

```bash
# 1) List organizations visible to your PAT
./scripts/bugsnag-export-events.sh orgs

# 2) List projects under an organization
./scripts/bugsnag-export-events.sh projects <organization_id>

# 3) Export events for one project
./scripts/bugsnag-export-events.sh events <project_id>
```

### Output

Exports are written to `OUTPUT_DIR` (default: `.artifacts/bugsnag-events/`):

- `bugsnag-project-<project_id>-<timestamp>.ndjson`: raw events (one JSON object per line)
- `bugsnag-project-<project_id>-<timestamp>-summary.txt`: grouped counts for:
  - `telemetryClassification`
  - `telemetryDecisionReason`
  - `source`
  - `operation`

## Node Sourcemap

Use [`upload-node-sourcemaps.js`](./upload-node-sourcemaps.js) to upload the CLI Node sourcemap.

### Setup

```bash
export BUGSNAG_API_KEY="your_bugsnag_api_key"
```

### Command

```bash
npm run upload-sourcemap
```

## GitHub Release Integration

Release workflow (`.github/workflows/release.yml`) uploads sourcemaps automatically when configured:

- Required secret: `BUGSNAG_API_KEY`
