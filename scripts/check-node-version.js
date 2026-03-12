const MIN_NODE_VERSION = [20, 19, 0];
const version = process.version;

function parseVersion(input) {
  const [major = "0", minor = "0", patch = "0"] = input
    .replace(/^v/, "")
    .split(".");
  return [
    Number.parseInt(major, 10) || 0,
    Number.parseInt(minor, 10) || 0,
    Number.parseInt(patch, 10) || 0,
  ];
}

function isAtLeast(actual, minimum) {
  for (let i = 0; i < 3; i += 1) {
    if (actual[i] > minimum[i]) return true;
    if (actual[i] < minimum[i]) return false;
  }
  return true;
}

const parsed = parseVersion(version);
if (!isAtLeast(parsed, MIN_NODE_VERSION)) {
  console.error(
    `Local development/build requires Node.js >= ${MIN_NODE_VERSION.join(
      "."
    )}. Current runtime: ${version}. Run "nvm use 20".`
  );
  process.exit(1);
}
