import {
  lookupAsoCache,
  enrichAsoKeywords,
  getAsoAppDocs,
} from "../cache-api";
import type { AsoAppDocItem, AsoCacheLookupResponse, AsoKeywordItem } from "./aso-types";

export async function lookupAsoCacheLocal(
  country: string,
  keywords: string[]
): Promise<AsoCacheLookupResponse> {
  return lookupAsoCache({ country, keywords }) as Promise<AsoCacheLookupResponse>;
}

export async function enrichAsoKeywordsLocal(
  country: string,
  items: Array<{ keyword: string; popularity: number }>
): Promise<AsoKeywordItem[]> {
  return enrichAsoKeywords({ country, items }) as Promise<AsoKeywordItem[]>;
}

export async function getAsoAppDocsLocal(
  country: string,
  appIds: string[]
): Promise<AsoAppDocItem[]> {
  return getAsoAppDocs({ country, appIds }) as Promise<AsoAppDocItem[]>;
}
