# ASO CLI Website

Single-page static website for SEO/discoverability.

## Requirements
- Node.js `20.x`

## SEO Contract
- `PUBLIC_SITE_ORIGIN` sets the production origin for canonical and social URLs.
- `PUBLIC_SITE_BASE_PATH` sets the deployment base path. Default is `/` for apex domain hosting.
- SEO assets are generated from the same config:
  - `/robots.txt`
  - `/sitemap.xml`
  - `/llms.txt`
- If the deployment URL changes, update the environment variables before building.

## Netlify CD
- Deployment config is stored in root `netlify.toml`.
- Production deploys are automatic on pushes to the Netlify production branch (`main` by default).
- Pull requests get Netlify Deploy Previews automatically when the repository is connected.

## Local Development
```bash
nvm use 20
npm install --prefix website --cache /private/tmp/aso-npm-cache
npm run --prefix website dev
```

## Build
```bash
nvm use 20
npm run --prefix website build
```
