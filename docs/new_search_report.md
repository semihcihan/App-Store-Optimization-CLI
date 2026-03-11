# App Store Search Data Source Decision Record

## Decision
Use App Store search page HTML (`serialized-server-data`) as the primary source for ordered search results in enrichment, with MZSearch fallback.

## Rationale
- In this runtime, reusing extracted AMP bearer tokens from backend Node calls proved unreliable (`401`).
- HTML parsing provides the ordered IDs and lockup data needed for ASO enrichment.
- MZSearch gives a stable fallback when HTML parsing fails.

## Current Implementation
- Primary path (`cli/services/cache-api/services/aso-enrichment-service.ts`): parse `https://apps.apple.com/us/iphone/search?term=...` and extract ordered IDs + lockups.
- Fallback path: use MZSearch ordering and build required app docs from App Store lookup + title/subtitle fetch.

## Consequences
- No backend dependency on browser-mimic token lifecycle.
- Enrichment remains deterministic and server-side.
- If Apple changes search-page structure, fallback preserves baseline behavior until parser updates.

## Guardrails
- Treat parser failure as recoverable.
- Keep this doc focused on decision/rationale, not reverse-engineering logs.
