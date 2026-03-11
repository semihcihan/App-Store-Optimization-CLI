# ASO Authentication Model vs Fastlane

## Purpose
Document the current auth architecture used by `aso` and why it follows a Fastlane-style cookie model.

## Current Architecture
- Entry point: `cli/services/auth/aso-auth-service.ts` (`AsoAuthService`, `AsoAuthEngine`).
- Auth is HTTP-based against Apple IDMS endpoints (no browser automation).
- Result is a cookie jar used for Search Ads popularity requests.
- Cookies persist at `~/.aso/aso-cookies.json`.
- Optional credential persistence uses macOS Keychain via `AsoKeychainService`.

## Login Strategy
- Mode: `ASO_AUTH_MODE=auto|sirp|legacy`.
- Default `auto`: try SIRP first, fallback to a single legacy attempt only for unknown/non-auth SIRP failures.
- Widget key is resolved dynamically from App Store Connect config with fallback.
- Hashcash is handled when Apple requires it.

## 2FA Strategy
- Challenge trigger: Apple returns `409` during sign-in completion.
- Supported verification methods: trusted-device code and SMS.
- Verification-code retry logic is message/payload-based (not tied to one numeric code).
- Non-retryable failures fail immediately.
- Trust is finalized through `/2sv/trust`.

## Alignment With Fastlane
- Same core pattern: Apple HTTP auth + cookie jar + 2FA handling.
- Same practical behavior for retrying invalid verification codes.

## Deliberate Differences
- Narrow scope: only what ASO popularity needs.
- SMS-focused phone verification (no voice-mode support).
- Different local session persistence format/path.
- Different final session target after login (App Ads handoff vs Olympus session fetch).

## Legacy Parity Notes
- Legacy signin request mirrors Fastlane header shape:
  - `Content-Type`, `X-Requested-With`, `X-Apple-Widget-Key`, `Accept`, optional `X-Apple-HC`.
  - Does not include SIRP/authorize-context-only headers on the legacy signin call.
- Cookie handling includes Fastlane-style quoting for `DES...` cookie values on both SIRP and legacy signin requests.
- Legacy post-login error mapping mirrors Fastlane signals:
  - Treat payloads containing `invalid="true"` as invalid credentials.
  - Treat `412` + known auth types (`sa`, `hsa`, `non-sa`, `hsa2`) as upgrade/privacy acknowledgement required.
  - Treat responses setting `itctx` cookies as account-not-enabled-for-ASC style failures.
- Legacy retry guard: do not retry deterministic failures (`invalid="true"`, `412` + known auth type, `itctx` cookie); retry only transient statuses.

## Why This Design
- Browser automation is brittle.
- API/cookie auth is deterministic and scriptable.
- Keeping auth in CLI keeps dashboard and keyword flows consistent.
