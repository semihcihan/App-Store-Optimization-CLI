import "../load-env";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { version } from "../../package.json";
import {
  asoSuggestInputSchema,
  handleAsoSuggest,
} from "./services/aso-suggest";

const server = new McpServer(
  {
    name: "aso-mcp",
    title: "ASO MCP Server",
    version,
    description:
      "MCP server for ASO keyword suggestion and scoring through the standalone ASO CLI.",
    websiteUrl: "https://github.com/semihcihan/App-Store-Optimization-CLI",
  },
  {
    instructions:
      "Use `aso_suggest` to evaluate explicit ASO keyword candidates. The tool returns only accepted keywords with compact scores.",
  }
);

server.registerTool(
  "aso_suggest",
  {
    title: "Suggest and evaluate ASO keywords",
    description:
      "Evaluates explicit ASO search terms (single-word or multi-word long-tail phrases) and returns only accepted keywords with compact metrics: keyword, popularity, difficulty, minDifficultyScore.",
    inputSchema: asoSuggestInputSchema,
  },
  handleAsoSuggest
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("MCP server error:", error);
  process.exitCode = 1;
});
