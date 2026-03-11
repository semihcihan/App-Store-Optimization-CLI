# ASO Dashboard Architecture

## Scope
Local-first dashboard architecture for `aso` (without `--keywords`).

## Core Decisions
- Source of truth is local SQLite at `~/.aso/aso-db.sqlite`.
- Storefront is `US` only.
- `aso` resolves Primary App ID before dashboard or keyword flows.
- Dashboard server orchestrates runtime; CLI/backend services own ASO fetch and enrichment logic.

## Runtime Components
- Command entry: `cli/commands/aso.ts`.
- Local persistence: `cli/db/*`.
- Dashboard API/server: `cli/dashboard-server/server.ts`.
- Startup refresh worker: `cli/dashboard-server/startup-refresh-manager.ts`.

## Local Data Model
- `apps`: owned and manually added app rows.
- `aso_keywords`: keyword metrics/order/expiry.
- `aso_apps`: app docs in `owned` and `competitor` buckets.
- `app_keywords`: app-keyword associations with `previous_position` and `added_at`.
- `metadata`: operational values (for example stale-refresh and Primary App ID metadata).

## Write Rules
- Apps are written by `POST /api/apps`.
- Keywords are written in two stages: popularity-first then enrichment.
- New app-keyword associations are created only for net-new keywords.
- Before keyword overwrite, previous rank for existing associations is copied into `previous_position`.

## Dashboard Server Responsibilities
- Serve SPA assets/runtime config.
- Expose local APIs for apps, keywords, top apps, app docs, auth state, and startup refresh state.
- Hydrate missing/expired app docs through backend `/aso/app-docs`.
- Map internal errors to stable user-facing error codes.

## Startup Background Refresh
1. Run once per dashboard launch.
2. Re-enrich keywords associated with non-research apps when popularity exists.
3. Process keyword refresh in batches (default `25`, max `100`) and pause during foreground mutations.
4. Publish state via `GET /api/aso/refresh-status`.

## Operational Constraints
- Non-US requests are rejected.
- App-doc backend hydration is chunked to max `50` app IDs per request.
- Add-keyword endpoint disables interactive auth recovery and surfaces explicit auth-required states for UI-managed reauthentication.
- Dashboard binding targets `127.0.0.1:3456`; when occupied, startup retries with an available local port automatically.
