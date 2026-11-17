import { resolveSiteUrl } from "../../site-config.mjs";
import {
  installCommand,
  mcpToolName,
  npmUrl,
  projectName,
  repoUrl,
  setupUrl,
  siteDescription,
} from "../site-content";

export function GET() {
  const body = [
    `# ${projectName}`,
    "",
    `> ${siteDescription}`,
    "",
    `Install with \`${installCommand}\`. Requires Node.js 18.14.1 or later, Apple Search Ads linked to App Store Connect, and the App ID of a published app you can access. Run \`aso auth\` in a terminal before evaluating keywords.`,
    "",
    `The npm package installs \`aso\` (CLI and local dashboard) and \`aso-mcp\` (local stdio server). Call \`${mcpToolName}\` with a \`keywords\` array to evaluate candidates for the US storefront. The tool returns accepted terms with popularity, estimated difficulty, and brand classification, and can associate them with a local app.`,
    "",
    "## Get started",
    `- [Product overview](${resolveSiteUrl("/")}): CLI example and dashboard.`,
    `- [MCP setup and tool example](${resolveSiteUrl("/mcp/")}): Local server configuration, example inputs, output fields, and auth recovery.`,
    `- [Apple Search Ads setup](${setupUrl}): Account linking and published app requirements.`,
    `- [npm package](${npmUrl}): Installation and published versions.`,
    "",
    "## Reference",
    `- [Command reference](${repoUrl}#command-reference): CLI flags, JSON output, and association behavior.`,
    `- [Source and documentation](${repoUrl}): Implementation and troubleshooting.`,
    `- [Releases](${repoUrl}/releases): Release notes.`,
    "",
  ].join("\n");

  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}
