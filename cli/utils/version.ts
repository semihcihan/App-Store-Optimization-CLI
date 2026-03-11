export const CLI_VERSION_HEADER = "X-CLI-Version";

export function compareVersions(current: string, latest: string): number {
  const currentParts = current.split(".").map(Number);
  const latestParts = latest.split(".").map(Number);

  for (let i = 0; i < Math.max(currentParts.length, latestParts.length); i++) {
    const currentPart = currentParts[i] || 0;
    const latestPart = latestParts[i] || 0;

    if (currentPart < latestPart) return -1;
    if (currentPart > latestPart) return 1;
  }

  return 0;
}
