import fs from "fs";
import os from "os";
import path from "path";
import {
  computeExpiryIso,
  computeAppExpiryIsoForApp,
  normalizeKeyword,
  sanitizeKeywords,
} from "./aso-keyword-utils";
import type {
  AsoCacheRepository,
  AsoKeywordRecord,
  AsoAppDoc,
} from "./aso-types";

type KeywordCacheMap = Record<string, AsoKeywordRecord>;

function buildAppDocKey(country: string, appId: string): string {
  return `aso#app#${appId}#country#${country}`;
}

interface LocalCacheFile {
  keywords: KeywordCacheMap;
  appDocs: Record<string, AsoAppDoc>;
}

function readCacheFile(filePath: string): LocalCacheFile {
  try {
    if (!fs.existsSync(filePath)) {
      return { keywords: {}, appDocs: {} };
    }
    const parsed = JSON.parse(
      fs.readFileSync(filePath, "utf8")
    ) as LocalCacheFile;
    return {
      keywords: parsed?.keywords || {},
      appDocs: parsed?.appDocs || {},
    };
  } catch {
    return { keywords: {}, appDocs: {} };
  }
}

function writeCacheFile(filePath: string, data: LocalCacheFile): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function buildKey(country: string, keyword: string): string {
  return `aso#keyword#${normalizeKeyword(keyword)}#country#${country}`;
}

export class LocalAsoCacheRepository implements AsoCacheRepository {
  private readonly filePath = path.join(
    os.homedir(),
    ".aso",
    "aso-cache.json"
  );

  async getByKeywords(params: {
    country: string;
    keywords: string[];
  }): Promise<{ hits: AsoKeywordRecord[]; misses: string[] }> {
    const country = params.country.toUpperCase();
    const keywords = sanitizeKeywords(params.keywords);
    const data = readCacheFile(this.filePath);
    const hits: AsoKeywordRecord[] = [];
    const misses: string[] = [];

    for (const keyword of keywords) {
      const key = buildKey(country, keyword);
      const item = data.keywords[key];
      if (!item) {
        misses.push(keyword);
        continue;
      }

      hits.push(item);
    }

    writeCacheFile(this.filePath, data);
    return { hits, misses };
  }

  async upsertMany(params: {
    country: string;
    items: Array<{
      keyword: string;
      popularity: number;
      difficultyScore: number;
      minDifficultyScore: number;
      appCount: number;
      keywordIncluded: number;
      orderedAppIds: string[];
    }>;
    appDocs?: AsoAppDoc[];
  }): Promise<AsoKeywordRecord[]> {
    const country = params.country.toUpperCase();
    const nowIso = new Date().toISOString();
    const expiresAt = computeExpiryIso();
    const data = readCacheFile(this.filePath);
    const records: AsoKeywordRecord[] = [];

    for (const item of params.items) {
      const normalizedKeyword = normalizeKeyword(item.keyword);
      const key = buildKey(country, item.keyword);
      const previous = data.keywords[key];
      const record: AsoKeywordRecord = {
        keyword: item.keyword,
        normalizedKeyword,
        country,
        popularity: item.popularity,
        difficultyScore: item.difficultyScore,
        minDifficultyScore: item.minDifficultyScore,
        appCount: item.appCount,
        keywordIncluded: item.keywordIncluded,
        orderedAppIds: item.orderedAppIds,
        createdAt: previous?.createdAt || nowIso,
        updatedAt: nowIso,
        expiresAt,
      };
      data.keywords[key] = record;
      records.push(record);
    }

    if (params.appDocs && params.appDocs.length > 0) {
      for (const app of params.appDocs) {
        const appKey = buildAppDocKey(country, app.appId);
        data.appDocs[appKey] = {
          ...app,
          country,
          expiresAt: app.expiresAt ?? computeAppExpiryIsoForApp(),
        };
      }
    }

    writeCacheFile(this.filePath, data);
    return records;
  }

  async getAppDocs(params: {
    country: string;
    appIds: string[];
  }): Promise<AsoAppDoc[]> {
    const country = params.country.toUpperCase();
    const data = readCacheFile(this.filePath);
    const now = Date.now();
    const result: AsoAppDoc[] = [];
    for (const appId of params.appIds) {
      const key = buildAppDocKey(country, appId);
      const doc = data.appDocs[key];
      if (
        doc &&
        doc.country === country &&
        Date.parse(doc.expiresAt ?? "0") > now
      ) {
        result.push(doc);
      }
    }
    return result;
  }
}

export const localAsoCacheRepository = new LocalAsoCacheRepository();
