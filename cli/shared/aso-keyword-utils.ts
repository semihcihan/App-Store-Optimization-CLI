import {
  normalizeKeyword as normalizeKeywordFromDomain,
  sanitizeKeywords as sanitizeKeywordsFromDomain,
} from "../domain/keywords/policy";
import { readAsoEnv } from "./aso-env";

export function normalizeKeyword(keyword: string): string {
  return normalizeKeywordFromDomain(keyword);
}

export function normalizeTextForKeywordMatch(text: string): string {
  return text
    .replace(/[^\w\s]/g, " ")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

export function sanitizeKeywords(input: string[]): string[] {
  return sanitizeKeywordsFromDomain(input);
}

export function getOrderTtlHours(): number {
  return readAsoEnv().keywordOrderTtlHours;
}

export function computeOrderExpiryIso(now: Date = new Date()): string {
  const ttlHours = getOrderTtlHours();
  return new Date(now.getTime() + ttlHours * 60 * 60 * 1000).toISOString();
}

export function getPopularityTtlHours(): number {
  return readAsoEnv().popularityCacheTtlHours;
}

export function computePopularityExpiryIso(now: Date = new Date()): string {
  const ttlHours = getPopularityTtlHours();
  return new Date(now.getTime() + ttlHours * 60 * 60 * 1000).toISOString();
}

export function getAppTtlHours(): number {
  return readAsoEnv().appCacheTtlHours;
}

export function computeAppExpiryIsoForApp(now: Date = new Date()): string {
  const ttlHours = getAppTtlHours();
  if (ttlHours === 0) return new Date(0).toISOString();
  return new Date(
    now.getTime() + ttlHours * 60 * 60 * 1000
  ).toISOString();
}
