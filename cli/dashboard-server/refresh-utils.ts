export function chunkArray<T>(items: T[], size: number): T[][] {
  if (items.length === 0) return [];
  const chunkSize = Math.max(1, Math.floor(size));
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    result.push(items.slice(i, i + chunkSize));
  }
  return result;
}

export function isFreshAsoAppDoc(
  doc: {
    expiresAt?: string;
    releaseDate?: string | null;
    currentVersionReleaseDate?: string | null;
  },
  nowMs: number = Date.now()
): boolean {
  const ts = Date.parse(doc.expiresAt ?? "0");
  if (!Number.isFinite(ts) || ts <= nowMs) return false;
  return Boolean(doc.releaseDate && doc.currentVersionReleaseDate);
}

export function getMissingOrExpiredAppIds(
  orderedIds: string[],
  docs: Array<{
    appId: string;
    expiresAt?: string;
    releaseDate?: string | null;
    currentVersionReleaseDate?: string | null;
  }>,
  nowMs: number = Date.now()
): string[] {
  if (orderedIds.length === 0) return [];
  const byId = new Map(docs.map((doc) => [doc.appId, doc]));
  return orderedIds.filter((appId) => {
    const cached = byId.get(appId);
    return !cached || !isFreshAsoAppDoc(cached, nowMs);
  });
}
