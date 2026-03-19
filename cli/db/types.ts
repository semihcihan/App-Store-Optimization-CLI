export interface StoredApp {
  id: string;
  name: string;
}

export type OwnedAppKind = "owned" | "research";

export interface StoredOwnedApp {
  id: string;
  kind: OwnedAppKind;
  name: string;
  averageUserRating: number | null;
  userRatingCount: number | null;
  previousAverageUserRating: number | null;
  previousUserRatingCount: number | null;
  icon?: Record<string, unknown>;
  expiresAt: string | null;
  lastFetchedAt: string | null;
  previousFetchedAt: string | null;
}

export interface StoredAsoKeyword {
  keyword: string;
  normalizedKeyword: string;
  country: string;
  popularity: number;
  difficultyScore: number | null;
  minDifficultyScore: number | null;
  appCount: number | null;
  keywordIncluded: number | null;
  orderedAppIds: string[];
  createdAt: string;
  updatedAt: string;
  orderExpiresAt: string;
  popularityExpiresAt: string;
}

export interface StoredAsoKeywordFailure {
  country: string;
  normalizedKeyword: string;
  keyword: string;
  status: "failed";
  stage: "popularity" | "enrichment";
  reasonCode: string;
  message: string;
  statusCode: number | null;
  retryable: boolean;
  attempts: number;
  requestId: string | null;
  updatedAt: string;
}

export interface StoredAsoApp {
  appId: string;
  name: string;
  subtitle?: string;
  averageUserRating: number;
  userRatingCount: number;
  releaseDate?: string | null;
  currentVersionReleaseDate?: string | null;
  icon?: Record<string, unknown>;
  iconArtwork?: { url?: string; [key: string]: unknown };
  additionalLocalizations?: Record<string, { title: string; subtitle?: string }>;
  expiresAt?: string;
  country: string;
}

export interface StoredAppKeyword {
  appId: string;
  keyword: string;
  country: string;
  previousPosition: number | null;
  addedAt?: string;
}

export interface AsoDbSchema {
  ownedApps: StoredOwnedApp[];
  asoKeywords: Record<string, StoredAsoKeyword>;
  asoApps: Record<string, StoredAsoApp>;
  appKeywords: StoredAppKeyword[];
}
