import {
  lookupAsoCache,
  enrichAsoKeywords,
  getAsoAppDocs,
  refreshKeywordOrder,
} from "../cache-api";
import type {
  AsoAppDocItem,
  AsoCacheLookupResponse,
  AsoKeywordItem,
  FailedKeyword,
} from "./aso-types";

export async function lookupAsoCacheLocal(
  country: string,
  keywords: string[]
): Promise<AsoCacheLookupResponse> {
  return lookupAsoCache({ country, keywords }) as Promise<AsoCacheLookupResponse>;
}

export async function enrichAsoKeywordsLocal(
  country: string,
  items: Array<{ keyword: string; popularity: number }>
): Promise<{ items: AsoKeywordItem[]; failedKeywords: FailedKeyword[] }> {
  return enrichAsoKeywords({ country, items }) as Promise<{
    items: AsoKeywordItem[];
    failedKeywords: FailedKeyword[];
  }>;
}

export async function getAsoAppDocsLocal(
  country: string,
  appIds: string[],
  options?: { forceLookup?: boolean }
): Promise<AsoAppDocItem[]> {
  const params: { country: string; appIds: string[]; forceLookup?: boolean } = {
    country,
    appIds,
  };
  if (options?.forceLookup === true) {
    params.forceLookup = true;
  }
  return getAsoAppDocs(params) as Promise<AsoAppDocItem[]>;
}

export async function refreshAsoKeywordOrderLocal(
  country: string,
  keyword: string
): Promise<{
  keyword: string;
  normalizedKeyword: string;
  appCount: number;
  orderedAppIds: string[];
  appDocs?: AsoAppDocItem[];
}> {
  return refreshKeywordOrder({ country, keyword });
}
