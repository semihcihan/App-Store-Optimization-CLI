export const DEFAULT_ASO_COUNTRY = "US" as const;

export function normalizeKeyword(keyword: string): string {
  return keyword.trim().toLowerCase();
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

export function normalizeCountry(input: string | undefined | null): string {
  return (input ?? DEFAULT_ASO_COUNTRY).toUpperCase();
}

export function assertSupportedCountry(country: string): void {
  if (normalizeCountry(country) !== DEFAULT_ASO_COUNTRY) {
    throw new Error("Only US is supported for now");
  }
}
