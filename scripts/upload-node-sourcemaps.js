const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { version } = require("../package.json");

const rootDir = path.resolve(__dirname, "..");
const bundlePath = path.join(rootDir, "cli", "dist", "cli.js");
const sourceMapPath = path.join(rootDir, "cli", "dist", "cli.js.map");
const apiKey = process.env.BUGSNAG_API_KEY;

function assertInputs() {
  if (!apiKey) {
    throw new Error("BUGSNAG_API_KEY is required to upload Node sourcemaps.");
  }
  if (!fs.existsSync(bundlePath)) {
    throw new Error(`Bundle not found: ${bundlePath}. Run 'npm run build' first.`);
  }
  if (!fs.existsSync(sourceMapPath)) {
    throw new Error(`Source map not found: ${sourceMapPath}. Run 'npm run build' first.`);
  }
}

function main() {
  assertInputs();
  const args = [
    "bugsnag-source-maps",
    "upload-node",
    "--api-key",
    apiKey,
    "--overwrite",
    "--app-version",
    version,
    "--bundle",
    bundlePath,
    "--source-map",
    sourceMapPath,
  ];

  const result = spawnSync("npx", args, {
    cwd: rootDir,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error("Node sourcemap upload failed.");
  }
}

try {
  main();
  console.log(`Node sourcemap upload complete for version ${version}.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
