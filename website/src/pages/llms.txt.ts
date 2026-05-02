import { resolveSiteUrl } from "../../site-config.mjs";
import {
  featureList,
  installCommand,
  npmUrl,
  projectName,
  repoUrl,
  siteDescription,
} from "../site-content";

export function GET() {
  const body = [
    `# ${projectName}`,
    "",
    `> ${siteDescription}`,
    "",
    "## Canonical URL",
    resolveSiteUrl("/"),
    "",
    "## Summary",
    "- Local-first App Store Optimization CLI and local dashboard.",
    "- Supports CLI usage, local dashboard review, and MCP automation via aso-mcp.",
    "- Website is a discovery layer; setup, troubleshooting, and releases live in the repository.",
    "",
    "## Key capabilities",
    ...featureList.map((feature) => `- ${feature}`),
    "",
    "## Install",
    `- Command: \`${installCommand}\``,
    `- npm: ${npmUrl}`,
    "",
    "## Important links",
    `- Repository: ${repoUrl}`,
    `- Setup and troubleshooting: ${repoUrl}#apple-search-ads-setup`,
    `- Releases: ${repoUrl}/releases`,
    "",
    "## Notes for agents",
    "- Requires Apple Search Ads setup and linked App Store Connect access for keyword enrichment.",
    "- Prefer the repository docs for setup, runtime details, and troubleshooting context.",
  ].join("\n");

  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}
