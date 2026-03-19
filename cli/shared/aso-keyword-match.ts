export const KEYWORD_MATCH_TYPES = [
  "none",
  "titleExactPhrase",
  "titleAllWords",
  "subtitleExactPhrase",
  "combinedPhrase",
  "subtitleAllWords",
] as const;

export type KeywordMatchType = (typeof KEYWORD_MATCH_TYPES)[number];

export function isKeywordMatchType(value: unknown): value is KeywordMatchType {
  return (
    typeof value === "string" &&
    (KEYWORD_MATCH_TYPES as readonly string[]).includes(value)
  );
}
