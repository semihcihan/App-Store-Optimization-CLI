import type {
  FailedKeyword,
  FailedKeywordStage,
} from "../../shared/aso-keyword-types";

export interface AsoAppDocItem {
  appId: string;
  country: string;
  name: string;
  subtitle?: string;
  averageUserRating: number;
  userRatingCount: number;
  releaseDate?: string | null;
  currentVersionReleaseDate?: string | null;
  icon?: Record<string, unknown>;
  iconArtwork?: { url?: string; [key: string]: unknown };
  expiresAt?: string;
}

export interface AsoKeywordItem {
  keyword: string;
  popularity: number;
  difficultyScore: number;
  minDifficultyScore: number;
  appCount: number;
  keywordIncluded: number;
  orderedAppIds: string[];
  createdAt?: string;
  updatedAt?: string;
  orderExpiresAt: string;
  popularityExpiresAt: string;
  normalizedKeyword?: string;
  country?: string;
  appDocs?: AsoAppDocItem[];
}

export type { FailedKeyword, FailedKeywordStage };

export interface KeywordFetchResult {
  items: AsoKeywordItem[];
  failedKeywords: FailedKeyword[];
}

export interface AsoCacheLookupResponse {
  hits: AsoKeywordItem[];
  misses: string[];
}
