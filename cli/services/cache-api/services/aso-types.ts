export interface AsoAppDocIcon {
  template?: string;
  width?: number;
  height?: number;
  backgroundColor?: { red: number; green: number; blue: number };
  [key: string]: unknown;
}

export interface AsoAppDocIconArtwork {
  url?: string;
  width?: number;
  height?: number;
  [key: string]: unknown;
}

export type AsoAppLocalization = {
  title: string;
  subtitle?: string;
};

export interface AsoAppDoc {
  appId: string;
  country: string;
  name: string;
  subtitle?: string;
  averageUserRating: number;
  userRatingCount: number;
  releaseDate?: string | null;
  currentVersionReleaseDate?: string | null;
  icon?: AsoAppDocIcon;
  iconArtwork?: AsoAppDocIconArtwork;
  additionalLocalizations?: Record<string, AsoAppLocalization>;
  expiresAt?: string;
}

export interface AsoKeywordRecord {
  keyword: string;
  normalizedKeyword: string;
  country: string;
  popularity: number;
  difficultyScore: number;
  minDifficultyScore: number;
  appCount: number;
  keywordIncluded: number;
  orderedAppIds: string[];
  createdAt: string;
  updatedAt: string;
  orderExpiresAt: string;
  popularityExpiresAt: string;
  sourceVersion?: string;
}

export interface AsoCacheRepository {
  getByKeywords(params: {
    country: string;
    keywords: string[];
  }): Promise<{ hits: AsoKeywordRecord[]; misses: string[] }>;
  upsertMany(params: {
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
  }): Promise<AsoKeywordRecord[]>;
  getAppDocs?(params: {
    country: string;
    appIds: string[];
  }): Promise<AsoAppDoc[]>;
}
