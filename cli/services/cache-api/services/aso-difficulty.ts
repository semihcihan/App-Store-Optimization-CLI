export const MAX_COMPETING_APPS = 200;
export const MAX_RATINGS = 10000;
export const AGE_NORMALIZATION_DAYS = 365;
export const RATING_PER_DAY_MAX = 100;
export const RATING_PER_DAY_MAP_THRESHOLD = 0.25;
export const RATING_PER_DAY_THRESHOLD = 1;
export const LOW_RATING_COUNT_THRESHOLD = 20;
export const MIN_RATING_FOR_POSITIVE_SCORE = 3;
export const DIFFICULTY_DETAIL_LIMIT = 5;
export const DIFFICULTY_AVG_WEIGHT = 1;
export const DIFFICULTY_MIN_WEIGHT = 2;
export const DIFFICULTY_APP_COUNT_WEIGHT = 0.5;

export type KeywordMatchType =
  | "none"
  | "titleExactPhrase"
  | "titleAllWords"
  | "subtitleExactPhrase"
  | "combinedPhrase"
  | "subtitleAllWords";

export type AppDifficultyInputs = {
  averageUserRating: number;
  userRatingCount: number;
  daysSinceLastRelease: number;
  daysSinceFirstRelease: number;
  keywordMatch: KeywordMatchType;
};

export type AppDifficultyBreakdown = {
  normalizedRatingCount: number;
  normalizedAvgRating: number;
  normalizedAge: number;
  normalizedRatingPerDay: number;
  keywordMatch: KeywordMatchType;
  keywordScore: number;
  score: number;
  score100: number;
  ratingPerDay: number;
};

export type KeywordDifficultyInputs = {
  competitiveScores: number[];
  appCount: number;
  enforceTopFiveGate?: boolean;
};

export type KeywordDifficultyBreakdown = {
  isFallback: boolean;
  scoreCount: number;
  appCount: number;
  avgCompetitive: number;
  minCompetitive: number;
  normalizedAppCount: number;
  rawDifficulty: number;
  difficultyScore: number;
  minDifficultyScore: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function normalizeDays(days: number): number {
  return Math.max(1, finiteOr(days, AGE_NORMALIZATION_DAYS));
}

function normalizeNonNegative(value: number): number {
  return Math.max(0, finiteOr(value, 0));
}

export function normalizeRatingCountPerDay(ratingPerDay: number): number {
  if (ratingPerDay <= 0) return 0;
  if (ratingPerDay <= RATING_PER_DAY_THRESHOLD) {
    return ratingPerDay * RATING_PER_DAY_MAP_THRESHOLD;
  }
  if (ratingPerDay < RATING_PER_DAY_MAX) {
    const t =
      (ratingPerDay - RATING_PER_DAY_THRESHOLD) /
      (RATING_PER_DAY_MAX - RATING_PER_DAY_THRESHOLD);
    return (
      RATING_PER_DAY_MAP_THRESHOLD + (1 - RATING_PER_DAY_MAP_THRESHOLD) * t
    );
  }
  return 1;
}

export function normalizeAvgRating(
  avgRating: number,
  ratingCount: number
): number {
  if (avgRating <= MIN_RATING_FOR_POSITIVE_SCORE) return 0;

  let normalized =
    (avgRating - MIN_RATING_FOR_POSITIVE_SCORE) /
    (5 - MIN_RATING_FOR_POSITIVE_SCORE);
  normalized = clamp(normalized, 0, 1);

  return (
    (normalized * Math.min(ratingCount, LOW_RATING_COUNT_THRESHOLD)) /
    LOW_RATING_COUNT_THRESHOLD
  );
}

export function keywordMatchToScore(match: KeywordMatchType): number {
  switch (match) {
    case "titleExactPhrase":
      return 1;
    case "titleAllWords":
      return 0.7;
    case "subtitleExactPhrase":
      return 0.7;
    case "combinedPhrase":
      return 0.5;
    case "subtitleAllWords":
      return 0.4;
    case "none":
    default:
      return 0;
  }
}

export function calculateAppDifficultyBreakdown(
  input: AppDifficultyInputs
): AppDifficultyBreakdown {
  const userRatingCount = normalizeNonNegative(input.userRatingCount);
  const averageUserRating = normalizeNonNegative(input.averageUserRating);
  const daysSinceLastRelease = normalizeDays(input.daysSinceLastRelease);
  const daysSinceFirstRelease = normalizeDays(input.daysSinceFirstRelease);
  const keywordMatch = input.keywordMatch;
  const keywordScore = keywordMatchToScore(keywordMatch);

  const normalizedAge =
    1 - clamp(daysSinceLastRelease / AGE_NORMALIZATION_DAYS, 0, 1);
  const ratingPerDay = userRatingCount / daysSinceFirstRelease;
  const normalizedRatingPerDay = normalizeRatingCountPerDay(ratingPerDay);
  const normalizedRatingCount = clamp(userRatingCount / MAX_RATINGS, 0, 1);
  const normalizedAvgRatingValue = normalizeAvgRating(
    averageUserRating,
    userRatingCount
  );

  const score = Math.max(
    0,
    0.2 * normalizedRatingCount +
      0.2 * normalizedAvgRatingValue +
      0.1 * normalizedAge +
      0.3 * keywordScore +
      0.2 * normalizedRatingPerDay
  );

  return {
    normalizedRatingCount,
    normalizedAvgRating: normalizedAvgRatingValue,
    normalizedAge,
    normalizedRatingPerDay,
    keywordMatch,
    keywordScore,
    ratingPerDay,
    score,
    score100: score * 100,
  };
}

export function hasDifficultyDetails(params: {
  scoreCount: number;
  appCount: number;
}): boolean {
  return (
    params.scoreCount >= DIFFICULTY_DETAIL_LIMIT &&
    params.appCount >= DIFFICULTY_DETAIL_LIMIT
  );
}

function normalizedAppCountScore(appCount: number): number {
  if (appCount <= 10) return 0;
  if (appCount >= MAX_COMPETING_APPS) return 1;
  let score = (appCount - 10) / (MAX_COMPETING_APPS - 10);
  return clamp(score, 0, 1);
}

export function calculateKeywordDifficultyBreakdown(
  input: KeywordDifficultyInputs
): KeywordDifficultyBreakdown {
  const scores = input.competitiveScores.filter((value) =>
    Number.isFinite(value)
  );
  const appCount = normalizeNonNegative(input.appCount);
  const enforceTopFiveGate = input.enforceTopFiveGate !== false;
  const scoreCount = scores.length;

  if (scoreCount === 0) {
    return {
      isFallback: true,
      scoreCount,
      appCount,
      avgCompetitive: 0,
      minCompetitive: 0,
      normalizedAppCount: 0,
      rawDifficulty: 0,
      difficultyScore: 1,
      minDifficultyScore: 1,
    };
  }

  if (enforceTopFiveGate && !hasDifficultyDetails({ scoreCount, appCount })) {
    return {
      isFallback: true,
      scoreCount,
      appCount,
      avgCompetitive: 0,
      minCompetitive: 0,
      normalizedAppCount: 0,
      rawDifficulty: 0,
      difficultyScore: 1,
      minDifficultyScore: 1,
    };
  }

  const avgCompetitive =
    scores.reduce((sum, value) => sum + value, 0) / scoreCount;
  const minCompetitive = Math.min(...scores);
  const normalizedAppCount = normalizedAppCountScore(appCount);
  const weightSum =
    DIFFICULTY_AVG_WEIGHT + DIFFICULTY_MIN_WEIGHT + DIFFICULTY_APP_COUNT_WEIGHT;
  const rawDifficulty =
    (DIFFICULTY_APP_COUNT_WEIGHT * normalizedAppCount +
      DIFFICULTY_AVG_WEIGHT * avgCompetitive +
      DIFFICULTY_MIN_WEIGHT * minCompetitive) /
    weightSum;

  return {
    isFallback: false,
    scoreCount,
    appCount,
    avgCompetitive,
    minCompetitive,
    normalizedAppCount,
    rawDifficulty,
    difficultyScore: clamp(rawDifficulty * 100, 1, 100),
    minDifficultyScore: minCompetitive * 100,
  };
}
