#!/usr/bin/env bash
set -euo pipefail

BUGSNAG_TOKEN="${BUGSNAG_TOKEN:-PASTE_YOUR_BUGSNAG_PAT_HERE}"
BUGSNAG_BASE_URL="${BUGSNAG_BASE_URL:-https://api.bugsnag.com}"
PER_PAGE="${PER_PAGE:-100}"
OUTPUT_DIR="${OUTPUT_DIR:-.artifacts/bugsnag-events}"
BASE_ISO="${BASE_ISO:-}"

usage() {
  cat <<'USAGE'
Usage:
  scripts/bugsnag-export-events.sh orgs
  scripts/bugsnag-export-events.sh projects <organization_id>
  scripts/bugsnag-export-events.sh events <project_id>

Environment variables:
  BUGSNAG_TOKEN     Personal auth token (required)
  BUGSNAG_BASE_URL  https://api.bugsnag.com (default)
                    Use https://api.bugsnag.smartbear.com for SmartBear-hosted orgs.
  PER_PAGE          Page size for events export (default: 100)
  OUTPUT_DIR        Output directory for exports (default: .artifacts/bugsnag-events)
  BASE_ISO          Optional ISO timestamp for "base" query parameter
                    Example: 2026-03-01T00:00:00Z

Examples:
  BUGSNAG_TOKEN=token_here scripts/bugsnag-export-events.sh orgs
  BUGSNAG_TOKEN=token_here scripts/bugsnag-export-events.sh projects 515fb9337c1074f6fd000001
  BUGSNAG_TOKEN=token_here scripts/bugsnag-export-events.sh events 515fb9337c1074f6fd000003
USAGE
}

require_tools() {
  local missing=0
  for tool in curl jq sed awk wc date; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      echo "Missing required tool: $tool" >&2
      missing=1
    fi
  done
  if [[ "$missing" -ne 0 ]]; then
    exit 1
  fi
}

require_token() {
  if [[ -z "${BUGSNAG_TOKEN}" || "${BUGSNAG_TOKEN}" == "PASTE_YOUR_BUGSNAG_PAT_HERE" ]]; then
    cat >&2 <<'EOF'
Set BUGSNAG_TOKEN first, or replace the placeholder in this script.
Example:
  export BUGSNAG_TOKEN="your_personal_auth_token"
EOF
    exit 1
  fi
}

api_get() {
  local url="$1"
  local body_file="$2"
  local headers_file="$3"

  curl -sS \
    -D "$headers_file" \
    -o "$body_file" \
    -H "Authorization: token ${BUGSNAG_TOKEN}" \
    -H "Accept: application/json" \
    "$url"
}

http_status_from_headers() {
  local headers_file="$1"
  awk '/^HTTP\// {code=$2} END {print code+0}' "$headers_file"
}

next_link_from_headers() {
  local headers_file="$1"
  tr -d '\r' < "$headers_file" \
    | sed -n 's/^[Ll][Ii][Nn][Kk]:[[:space:]]*//p' \
    | sed -n 's/.*<\([^>]*\)>;[[:space:]]*rel="next".*/\1/p'
}

print_api_error() {
  local status="$1"
  local body_file="$2"
  echo "Bugsnag API request failed (HTTP ${status})" >&2
  if [[ -s "$body_file" ]]; then
    echo "Response body:" >&2
    cat "$body_file" >&2
  fi
}

list_orgs() {
  local body headers status
  body="$(mktemp)"
  headers="$(mktemp)"
  trap 'rm -f "$body" "$headers"' RETURN

  api_get "${BUGSNAG_BASE_URL}/user/organizations" "$body" "$headers"
  status="$(http_status_from_headers "$headers")"
  if [[ "$status" -lt 200 || "$status" -ge 300 ]]; then
    print_api_error "$status" "$body"
    return 1
  fi

  jq -r '.[] | "\(.id)\t\(.name // "unknown")"' "$body"
}

list_projects() {
  local org_id="$1"
  local body headers status
  body="$(mktemp)"
  headers="$(mktemp)"
  trap 'rm -f "$body" "$headers"' RETURN

  api_get "${BUGSNAG_BASE_URL}/organizations/${org_id}/projects?per_page=100" "$body" "$headers"
  status="$(http_status_from_headers "$headers")"
  if [[ "$status" -lt 200 || "$status" -ge 300 ]]; then
    print_api_error "$status" "$body"
    return 1
  fi

  jq -r '.[] | "\(.id)\t\(.name // "unknown")"' "$body"
}

write_summary() {
  local events_file="$1"
  local summary_file="$2"

  {
    echo "events_file: $events_file"
    echo "generated_at_utc: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    echo "total_events: $(wc -l < "$events_file" | tr -d ' ')"
    echo
    echo "telemetryClassification:"
    jq -r '.metaData.metadata.telemetryClassification // "missing"' "$events_file" \
      | sort \
      | uniq -c \
      | sort -nr
    echo
    echo "telemetryDecisionReason:"
    jq -r '.metaData.metadata.telemetryDecisionReason // "missing"' "$events_file" \
      | sort \
      | uniq -c \
      | sort -nr
    echo
    echo "source:"
    jq -r '.metaData.metadata.source // "missing"' "$events_file" \
      | sort \
      | uniq -c \
      | sort -nr
    echo
    echo "operation:"
    jq -r '.metaData.metadata.operation // "missing"' "$events_file" \
      | sort \
      | uniq -c \
      | sort -nr
  } > "$summary_file"
}

export_events() {
  local project_id="$1"
  local timestamp events_file summary_file
  local page_url next_url page_count total_count
  local body headers status base_query page_items last_id prev_offset_last_id

  mkdir -p "$OUTPUT_DIR"
  timestamp="$(date -u +"%Y%m%d-%H%M%S")"
  events_file="${OUTPUT_DIR}/bugsnag-project-${project_id}-${timestamp}.ndjson"
  summary_file="${OUTPUT_DIR}/bugsnag-project-${project_id}-${timestamp}-summary.txt"

  base_query=""
  if [[ -n "$BASE_ISO" ]]; then
    base_query="&base=$(printf '%s' "$BASE_ISO" | jq -sRr @uri)"
  fi
  page_url="${BUGSNAG_BASE_URL}/projects/${project_id}/events?per_page=${PER_PAGE}&sort=timestamp&direction=desc&full_reports=true${base_query}"
  page_count=0
  total_count=0
  prev_offset_last_id=""

  : > "$events_file"

  while [[ -n "$page_url" ]]; do
    body="$(mktemp)"
    headers="$(mktemp)"
    trap 'rm -f "$body" "$headers"' RETURN

    api_get "$page_url" "$body" "$headers"
    status="$(http_status_from_headers "$headers")"
    if [[ "$status" -lt 200 || "$status" -ge 300 ]]; then
      print_api_error "$status" "$body"
      return 1
    fi

    if ! jq -e 'type == "array"' "$body" >/dev/null; then
      echo "Unexpected response shape. Expected JSON array." >&2
      cat "$body" >&2
      return 1
    fi

    page_items="$(jq 'length' "$body")"
    jq -c '.[]' "$body" >> "$events_file"
    page_count=$((page_count + 1))
    total_count=$((total_count + page_items))

    next_url="$(next_link_from_headers "$headers" || true)"
    if [[ -n "$next_url" ]]; then
      page_url="${next_url}"
    elif [[ "$page_items" -gt 0 ]]; then
      last_id="$(jq -r '.[-1].id // empty' "$body")"
      if [[ -n "$last_id" && "$last_id" != "$prev_offset_last_id" ]]; then
        page_url="${BUGSNAG_BASE_URL}/projects/${project_id}/events?per_page=${PER_PAGE}&sort=timestamp&direction=desc&full_reports=true${base_query}&offset=${last_id}"
        prev_offset_last_id="$last_id"
      else
        page_url=""
      fi
    else
      page_url=""
    fi

    rm -f "$body" "$headers"
    trap - RETURN
  done

  write_summary "$events_file" "$summary_file"

  echo "Export complete."
  echo "Pages: ${page_count}"
  echo "Events: ${total_count}"
  echo "NDJSON: ${events_file}"
  echo "Summary: ${summary_file}"
}

main() {
  require_tools
  require_token

  local cmd="${1:-}"
  case "$cmd" in
    orgs)
      list_orgs
      ;;
    projects)
      if [[ $# -lt 2 ]]; then
        usage
        exit 1
      fi
      list_projects "$2"
      ;;
    events)
      if [[ $# -lt 2 ]]; then
        usage
        exit 1
      fi
      export_events "$2"
      ;;
    *)
      usage
      exit 1
      ;;
  esac
}

main "$@"
