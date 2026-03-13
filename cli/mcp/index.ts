import "../load-env";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { version } from "../../package.json";
import {
  asoEvaluateKeywordsInputSchema,
  handleAsoEvaluateKeywords,
} from "./services/aso-evaluate-keywords";
import { assertSupportedNodeVersion } from "../services/runtime/node-version-guard";
import { reportBugsnagError } from "../services/telemetry/error-reporter";

assertSupportedNodeVersion();

const server = new McpServer(
  {
    name: "aso-mcp",
    title: "ASO MCP Server",
    version,
    description:
      "MCP server for ASO keyword evaluation and scoring through the standalone ASO CLI.",
    websiteUrl: "https://github.com/semihcihan/App-Store-Optimization-CLI",
  },
  {
    instructions:
      "Use `aso_evaluate_keywords` to evaluate explicit ASO keyword candidates. The tool returns only accepted keywords with compact scores.",
  }
);

server.registerTool(
  "aso_evaluate_keywords",
  {
    title: "Evaluate ASO keywords",
    description:
      "Evaluates explicit ASO search terms (single-word or multi-word long-tail phrases) and returns only accepted keywords with compact metrics: keyword, popularity, difficulty, minDifficultyScore.",
    inputSchema: asoEvaluateKeywordsInputSchema,
  },
  handleAsoEvaluateKeywords
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  reportBugsnagError(error, {
    surface: "aso-mcp",
    stage: "bootstrap",
    telemetryHint: {
      classification: "actionable_bug",
      surface: "aso-mcp",
      source: "mcp.index.main",
      stage: "bootstrap",
    },
  });
  console.error("MCP server error:", error);
  process.exitCode = 1;
});
