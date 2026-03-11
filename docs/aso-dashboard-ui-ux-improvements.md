# ASO Dashboard Interaction Model

## Purpose
Capture stable interaction behavior that affects architecture and flow. This file intentionally excludes styling, component internals, and historical change logs.

## Interaction Principles
- App-scoped workflow: keyword operations run against one selected app context.
- Local-first rendering: data is shown from local DB and updated as async work completes.
- Explicit async states: loading, error, auth, and startup-refresh states are surfaced to users.

## Current Interaction Contracts
- App list includes owned apps plus research apps; manual add and refresh are supported.
- Default research app is always present in app list responses, even after adding manual research apps.
- Selected app is persisted in local storage and restored on load.
- Keyword add uses a two-stage flow (popularity first, enrichment later).
- Keyword delete removes app-keyword associations for the selected app only.
- Pending enrichment is represented by `difficultyScore = null` and polled until complete.
- Rank and rank-delta are shown from current position vs stored `previousPosition`.
- Research apps (no real app ID rank context) hide `Rank`, `Change`, and `Updated` columns.
- Top-app detail is fetched per keyword from local API and hydrated on demand.
- Research app rows show only app name (no app ID subtitle row).

## Auth Recovery Contract
- Add-keyword auth failures return machine-readable codes.
- UI starts reauth via `POST /api/aso/auth/start` and polls `GET /api/aso/auth/status`.
- On reauth success, UI auto-retries the pending add-keyword operation.
- If no interactive terminal exists, UI keeps user in a terminal-required state.

## Startup Refresh Contract
- UI polls `GET /api/aso/refresh-status`.
- Refresh is non-blocking for primary dashboard usage.
- Successful startup app-list refresh triggers app-list reload in UI.

## First-Open App Load Contract
- First-open app load is stale-while-refresh:
  - Step 1: load local app list from DB and render immediately.
  - Step 2: start owned-app-doc refresh in background.
  - Step 3: load selected app keywords without waiting for app-doc refresh.
- UI state model:
  - `isInitialLoad`: true until first local snapshot and initial keyword load complete.
  - `hasCachedData`: true after first successful local app-list read.
  - `isRefreshingApps`: true only during explicit `Refresh apps` action.
  - `isColdStart`: derived as `isInitialLoad && !hasCachedData`.
- Interaction gating:
  - Do not lock the full UI during app refresh.
  - Disable only action-local controls while their own mutation is in-flight (for example, refresh button while refresh is running).

## Out of Scope
- Visual design and CSS specifics.
- Component-level implementation notes.
- Backlog/prioritization discussions.
