const MIN_NODE_VERSION: [number, number, number] = [18, 14, 1];

function parseNodeVersion(version: string): [number, number, number] {
  const [major = "0", minor = "0", patch = "0"] = version
    .replace(/^v/, "")
    .split(".");
  return [
    Number.parseInt(major, 10) || 0,
    Number.parseInt(minor, 10) || 0,
    Number.parseInt(patch, 10) || 0,
  ];
}

function isAtLeast(
  actual: [number, number, number],
  minimum: [number, number, number]
): boolean {
  for (let i = 0; i < 3; i += 1) {
    if (actual[i] > minimum[i]) return true;
    if (actual[i] < minimum[i]) return false;
  }
  return true;
}

export function assertSupportedNodeVersion(version = process.version): void {
  const parsed = parseNodeVersion(version);
  if (isAtLeast(parsed, MIN_NODE_VERSION)) {
    return;
  }

  throw new Error(
    `aso-cli requires Node.js >= ${MIN_NODE_VERSION.join(
      "."
    )}. Current runtime: ${version}.`
  );
}
