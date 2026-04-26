export const COMPARE_MIN_APPS = 2;
export const COMPARE_MAX_APPS = 10;
export const COMPARE_MIN_KEYWORDS = 1;
export const COMPARE_MAX_KEYWORDS = 100;

export type CompareApp = {
  appId: string;
  name: string;
};

export type CompareUniverseKeyword = {
  keyword: string;
  normalizedKeyword: string;
  trackedByAppIds: string[];
  trackedCount: number;
  popularity: number | null;
  difficulty: number | null;
  isResearched: boolean;
};

export type CompareKeywordsResponse = {
  country: string;
  apps: CompareApp[];
  keywords: CompareUniverseKeyword[];
};

export type CompareMatrixRequest = {
  appIds: string[];
  keywords: string[];
  country?: string;
};

export type CompareMatrixCell = {
  appId: string;
  currentPosition: number | null;
  previousPosition: number | null;
  change: number | null;
  isTracked: boolean;
};

export type CompareMatrixRow = {
  keyword: string;
  normalizedKeyword: string;
  popularity: number | null;
  difficulty: number | null;
  status: "researched" | "not_researched";
  cells: CompareMatrixCell[];
};

export type CompareMatrixResponse = {
  country: string;
  generatedAt: string;
  apps: CompareApp[];
  rows: CompareMatrixRow[];
};
