import {
  normalizeKeyword as normalizeKeywordFromDomain,
  sanitizeKeywords as sanitizeKeywordsFromDomain,
} from "../domain/keywords/policy";
import { ASO_ENV } from "./aso-env";

export function normalizeKeyword(keyword: string): string {
  return normalizeKeywordFromDomain(keyword);
}

export function normalizeTextForKeywordMatch(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\p{M}\s]/gu, " ")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

export function sanitizeKeywords(input: string[]): string[] {
  return sanitizeKeywordsFromDomain(input);
}

export function getOrderTtlHours(): number {
  return ASO_ENV.keywordOrderTtlHours;
}

export function computeOrderExpiryIso(now: Date = new Date()): string {
  const ttlHours = getOrderTtlHours();
  return new Date(now.getTime() + ttlHours * 60 * 60 * 1000).toISOString();
}

export function getPopularityTtlHours(): number {
  return ASO_ENV.popularityCacheTtlHours;
}

export function computePopularityExpiryIso(now: Date = new Date()): string {
  const ttlHours = getPopularityTtlHours();
  return new Date(now.getTime() + ttlHours * 60 * 60 * 1000).toISOString();
}

export function getAppTtlHours(): number {
  return ASO_ENV.appCacheTtlHours;
}

export function computeAppExpiryIsoForApp(now: Date = new Date()): string {
  const ttlHours = getAppTtlHours();
  if (ttlHours === 0) return new Date(0).toISOString();
  return new Date(
    now.getTime() + ttlHours * 60 * 60 * 1000
  ).toISOString();
}
