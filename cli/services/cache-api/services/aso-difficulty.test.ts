import {
  calculateAppDifficultyBreakdown,
  calculateKeywordDifficultyBreakdown,
  keywordMatchToScore,
} from "./aso-difficulty";

describe("aso-difficulty", () => {
  it("calculates per-app competitive score from explicit inputs", () => {
    const breakdown = calculateAppDifficultyBreakdown({
      averageUserRating: 4.5,
      userRatingCount: 1000,
      daysSinceLastRelease: 30,
      daysSinceFirstRelease: 400,
      keywordMatch: "titleAllWords",
    });

    expect(breakdown.normalizedRatingCount).toBeCloseTo(0.1, 5);
    expect(breakdown.normalizedAvgRating).toBeCloseTo(0.75, 5);
    expect(breakdown.normalizedAge).toBeCloseTo(0.9178, 4);
    expect(breakdown.normalizedRatingPerDay).toBeCloseTo(0.26136, 5);
    expect(breakdown.score).toBeCloseTo(0.52405, 4);
    expect(breakdown.score100).toBeCloseTo(52.405, 2);
  });

  it("maps keyword match type to score centrally", () => {
    expect(keywordMatchToScore("titleExactPhrase")).toBe(1);
    expect(keywordMatchToScore("titleAllWords")).toBe(0.7);
    expect(keywordMatchToScore("subtitleExactPhrase")).toBe(0.7);
    expect(keywordMatchToScore("combinedPhrase")).toBe(0.5);
    expect(keywordMatchToScore("subtitleAllWords")).toBe(0.4);
    expect(keywordMatchToScore("none")).toBe(0);
  });

  it("returns fallback difficulty when top-five gate is not satisfied", () => {
    const difficulty = calculateKeywordDifficultyBreakdown({
      competitiveScores: [0.7, 0.6, 0.5],
      appCount: 200,
      enforceTopFiveGate: true,
    });

    expect(difficulty.isFallback).toBe(true);
    expect(difficulty.difficultyScore).toBe(1);
    expect(difficulty.minDifficultyScore).toBe(1);
  });

  it("calculates keyword difficulty using average, minimum, and app-count weights", () => {
    const difficulty = calculateKeywordDifficultyBreakdown({
      competitiveScores: [0.8, 0.7, 0.6, 0.5, 0.4],
      appCount: 120,
      enforceTopFiveGate: false,
    });

    expect(difficulty.isFallback).toBe(false);
    expect(difficulty.avgCompetitive).toBeCloseTo(0.6, 5);
    expect(difficulty.minCompetitive).toBeCloseTo(0.4, 5);
    expect(difficulty.normalizedAppCount).toBeCloseTo(0.57895, 5);
    expect(difficulty.rawDifficulty).toBeCloseTo(0.48271, 5);
    expect(difficulty.difficultyScore).toBeCloseTo(48.2707, 4);
    expect(difficulty.minDifficultyScore).toBeCloseTo(40, 5);
  });
});
