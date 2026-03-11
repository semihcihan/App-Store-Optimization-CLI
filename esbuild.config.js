const esbuild = require("esbuild");
const { execSync, spawn } = require("child_process");

const rootDir = __dirname;

const cliBuildConfig = {
  entryPoints: ["cli/cli.ts"],
  bundle: true,
  platform: "node",
  target: "node18",
  outfile: "cli/dist/cli.js",
  format: "cjs",
  external: [
    "axios",
    "better-sqlite3",
    "dotenv",
    "yargs",
    "zod",
    "zod-validation-error",
  ],
  packages: "bundle",
  sourcemap: true,
  minify: true,
};

const mcpBuildConfig = {
  entryPoints: ["cli/mcp/index.ts"],
  bundle: true,
  platform: "node",
  target: "node18",
  outfile: "cli/dist/mcp.js",
  format: "cjs",
  external: ["better-sqlite3", "bindings", "node-gyp-build"],
  banner: {
    js: "#!/usr/bin/env node",
  },
  packages: "bundle",
  sourcemap: true,
  minify: true,
};

const cliWatchConfig = { ...cliBuildConfig };
const mcpWatchConfig = { ...mcpBuildConfig };

function buildDashboardUi() {
  execSync("npm run dashboard:build --silent", {
    cwd: rootDir,
    stdio: "inherit",
  });
}

function startDashboardWatch() {
  const child = spawn("npm", ["run", "dashboard:watch"], {
    cwd: rootDir,
    stdio: "inherit",
    shell: true,
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      console.error(`dashboard:watch exited with signal ${signal}`);
      process.exit(1);
      return;
    }

    if (typeof code === "number" && code !== 0) {
      console.error(`dashboard:watch exited with code ${code}`);
      process.exit(code);
    }
  });

  return child;
}

async function build() {
  try {
    buildDashboardUi();
    console.log("Dashboard UI build completed successfully!");

    console.log("Building CLI with esbuild...");
    await esbuild.build(cliBuildConfig);
    console.log("CLI build completed successfully!");

    console.log("Building MCP server with esbuild...");
    await esbuild.build(mcpBuildConfig);
    console.log("MCP server build completed successfully!");
  } catch (error) {
    console.error("Build failed:", error);
    process.exit(1);
  }
}

async function watch() {
  let dashboardWatchProcess;
  let cliContext;
  let mcpContext;

  const cleanup = async () => {
    if (dashboardWatchProcess && !dashboardWatchProcess.killed) {
      dashboardWatchProcess.kill("SIGTERM");
    }
    await Promise.all([
      cliContext ? cliContext.dispose() : Promise.resolve(),
      mcpContext ? mcpContext.dispose() : Promise.resolve(),
    ]);
  };

  process.once("SIGINT", async () => {
    await cleanup();
    process.exit(0);
  });

  process.once("SIGTERM", async () => {
    await cleanup();
    process.exit(0);
  });

  try {
    console.log("Watching dashboard UI files for changes...");
    dashboardWatchProcess = startDashboardWatch();

    console.log("Watching CLI files for changes...");
    cliContext = await esbuild.context(cliWatchConfig);
    await cliContext.watch();

    console.log("Watching MCP files for changes...");
    mcpContext = await esbuild.context(mcpWatchConfig);
    await mcpContext.watch();

    console.log("Watching for dashboard, CLI, and MCP changes...");
  } catch (error) {
    await cleanup();
    console.error("Watch failed:", error);
    process.exit(1);
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes("--watch")) {
    watch();
  } else {
    build();
  }
}

module.exports = { build, watch };
