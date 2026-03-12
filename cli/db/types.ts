export interface StoredApp {
  id: string;
  name: string;
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
  previousAverageUserRating?: number | null;
  previousUserRatingCount?: number | null;
  releaseDate?: string | null;
  currentVersionReleaseDate?: string | null;
  icon?: Record<string, unknown>;
  iconArtwork?: { url?: string; [key: string]: unknown };
  expiresAt?: string;
  lastFetchedAt?: string | null;
  previousFetchedAt?: string | null;
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
  apps: StoredApp[];
  asoKeywords: Record<string, StoredAsoKeyword>;
  ownedAsoApps: Record<string, StoredAsoApp>;
  competitorAsoApps: Record<string, StoredAsoApp>;
  appKeywords: StoredAppKeyword[];
}
