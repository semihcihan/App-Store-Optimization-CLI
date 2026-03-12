export function normalizeKeyword(keyword: string): string {
  return keyword.trim().toLowerCase();
}

export function normalizeTextForKeywordMatch(text: string): string {
  return text
    .replace(/[^\w\s]/g, " ")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

export function sanitizeKeywords(input: string[]): string[] {
  const unique = new Set<string>();
  for (const keyword of input) {
    const normalized = normalizeKeyword(keyword);
    if (normalized) {
      unique.add(normalized);
    }
  }
  return Array.from(unique);
}

export function getOrderTtlHours(): number {
  const parsed = Number.parseInt(
    process.env.ASO_KEYWORD_ORDER_TTL_HOURS || "24",
    10
  );
  if (Number.isNaN(parsed) || parsed <= 0) return 24;
  return parsed;
}

export function computeOrderExpiryIso(now: Date = new Date()): string {
  const ttlHours = getOrderTtlHours();
  return new Date(now.getTime() + ttlHours * 60 * 60 * 1000).toISOString();
}

export function getPopularityTtlHours(): number {
  const parsed = Number.parseInt(
    process.env.ASO_POPULARITY_CACHE_TTL_HOURS ?? "720",
    10
  );
  if (Number.isNaN(parsed) || parsed <= 0) return 720;
  return parsed;
}

export function computePopularityExpiryIso(now: Date = new Date()): string {
  const ttlHours = getPopularityTtlHours();
  return new Date(now.getTime() + ttlHours * 60 * 60 * 1000).toISOString();
}

export function getAppTtlHours(): number {
  const parsed = Number.parseInt(
    process.env.ASO_APP_CACHE_TTL_HOURS ?? "168",
    10
  );
  if (Number.isNaN(parsed) || parsed < 0) return 168;
  return parsed;
}

export function computeAppExpiryIsoForApp(now: Date = new Date()): string {
  const ttlHours = getAppTtlHours();
  if (ttlHours === 0) return new Date(0).toISOString();
  return new Date(
    now.getTime() + ttlHours * 60 * 60 * 1000
  ).toISOString();
}
