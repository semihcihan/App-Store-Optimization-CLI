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
