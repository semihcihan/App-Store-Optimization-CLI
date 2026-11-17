# Website Architecture

## Scope
- Static marketing/discovery site for `aso-cli` with a product homepage and a dedicated MCP setup guide.
- Purpose: SEO and discoverability, not product runtime.

## Stack
- Astro static site under `website/`.
- Node.js `20.x` runtime for website build/development.

## Content Contract
- Website messaging reflects existing CLI/runtime contracts:
  - local-first CLI + local dashboard
  - `aso keywords ...` command usage
  - MCP surface (`aso-mcp`, `aso_evaluate_keywords`)
- Website links out to canonical repository docs for setup, troubleshooting, and releases.

## SEO Contract
- Production URL is configured centrally in `website/site-config.mjs`.
- Default deployment target is Netlify on apex domain:
  - origin: `https://asocli.com`
  - base path: `/`
- Override with environment variables when deployment changes:
  - `PUBLIC_SITE_ORIGIN`
  - `PUBLIC_SITE_BASE_PATH`
- Generated SEO artifacts:
  - per-page canonical URL and social metadata from the shared `SiteHead` component
  - `robots.txt` allows public crawling and advertises the sitemap
  - `sitemap.xml` lists the homepage and MCP guide
  - `llms.txt` links to setup and reference sources. Both pages advertise it with `rel="describedby"`.
  - homepage JSON-LD connects the site, landing page, creator, and software application

## Analytics Contract
- Firebase Analytics is enabled for both pages to capture default GA4 web events, including page views.
- Initialization is client-side only from the shared page head via `website/src/firebase-analytics.ts`.
- No custom click/CTA event tracking is implemented; behavior is intentionally limited to default analytics signals.

## Deploy Contract
- Netlify is the deployment platform for `website/`.
- Root `netlify.toml` defines:
  - build base: `website`
  - build command: `npm run build`
  - publish directory: `dist`
  - Node runtime: `20`
  - production + preview environment values for `PUBLIC_SITE_ORIGIN` and `PUBLIC_SITE_BASE_PATH`
- Continuous deployment behavior:
  - production deploy on push to `main`
  - deploy previews for pull requests

## Shared Asset Policy
- Website imports images directly from existing repo sources:
  - `assets/app-icon/aso-icon-readme.png`
  - `cli/dashboard-ui/public/dashboard.jpg`
  - `cli/dashboard-ui/public/mcp.jpg`
- Astro generates responsive WebP screenshots for the pages. Social metadata uses the original JPEGs.
- No duplicate tracked copies under `website/`; README and website stay visually in sync.

## Typography Policy
- Website uses the same typeface as dashboard UI: `JetBrains Mono`.
