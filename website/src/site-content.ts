export const projectName = "ASO CLI";
export const repoUrl = "https://github.com/semihcihan/App-Store-Optimization-CLI";
export const npmUrl = "https://www.npmjs.com/package/aso-cli";
export const installCommand = "npm install -g aso-cli";
export const setupUrl = `${repoUrl}#apple-search-ads-setup`;
export const siteTitle = "App Store Keyword Research Tool | ASO CLI";
export const siteDescription =
  "Research US App Store keywords with ASO CLI. Check popularity, ranking difficulty, and brand terms in a local dashboard or through MCP.";

export const mcpTitle = "App Store Optimization MCP Server | ASO CLI";
export const mcpDescription =
  "Set up ASO MCP to evaluate US App Store keyword candidates from an agent. Get the local server config, tool inputs, and example call.";
export const mcpToolName = "aso_evaluate_keywords";
export const mcpConfig = { mcpServers: { aso: { command: "aso-mcp" } } };
export const mcpExample = {
  keywords: ["meditation", "sleep sounds", "white noise"],
  minPopularity: 6,
  maxDifficulty: 70,
};

export const featureList = [
  "App Store keyword research from the command line",
  "Local dashboard for reviewing ASO results",
  "MCP server for agent-driven automation",
  "CLI output modes for custom scripts and workflows",
];

export const faqEntries = [
  {
    question: "Which App Store storefronts does ASO CLI support?",
    answer: "Keyword research currently supports the US App Store storefront.",
  },
  {
    question: "What do I need to get started?",
    answer:
      "Install Node.js 18.14.1 or later. Set up Apple Search Ads, link your App Store Connect account, and have the App ID of a published app you can access. You can get started without creating an ad campaign.",
  },
  {
    question: "Is ASO CLI free and open source?",
    answer: "Yes. ASO CLI is free and open source under the MIT License.",
  },
  {
    question: "Can I automate workflows beyond MCP?",
    answer:
      "Run aso keywords with --stdout to get JSON for your own scripts. Use aso-mcp to evaluate candidate keywords from an MCP client.",
  },
];
