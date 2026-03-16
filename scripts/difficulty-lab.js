#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const { buildSync } = require("esbuild");

const SCENARIO_PATH = path.resolve(__dirname, "difficulty-scenarios.example.json");

function n(v, d = 2) {
  return Number(v.toFixed(d));
}

function ensureFiniteNumber(value, field, index) {
  if (!Number.isFinite(value)) {
    throw new Error(`Scenario #${index + 1}: ${field} must be a finite number.`);
  }
}

function ensureKeywordMatch(value, index) {
  const allowed = new Set([
    "none",
    "titleExactPhrase",
    "titleAllWords",
    "subtitleExactPhrase",
    "combinedPhrase",
    "subtitleAllWords",
  ]);

  if (!allowed.has(value)) {
    throw new Error(
      `Scenario #${index + 1}: keywordMatch must be one of ${Array.from(allowed).join(", ")}.`
    );
  }
}

function keywordMatchCode(value) {
  switch (value) {
    case "titleExactPhrase":
      return "tExact";
    case "titleAllWords":
      return "tWords";
    case "subtitleExactPhrase":
      return "sExact";
    case "combinedPhrase":
      return "combo";
    case "subtitleAllWords":
      return "sWords";
    case "none":
    default:
      return "none";
  }
}

function loadDifficultyCalculator() {
  const entry = path.resolve(__dirname, "../cli/services/cache-api/services/aso-difficulty.ts");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aso-difficulty-lab-"));
  const out = path.join(tmpDir, "aso-difficulty.cjs");

  buildSync({
    entryPoints: [entry],
    outfile: out,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node18",
    sourcemap: false,
    minify: false,
  });

  const mod = require(out);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return mod;
}

function readScenarios() {
  const parsed = JSON.parse(fs.readFileSync(SCENARIO_PATH, "utf8"));

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("Scenario file must be a non-empty JSON array.");
  }

  return parsed.map((raw, index) => {
    if (!raw || typeof raw !== "object") {
      throw new Error(`Scenario #${index + 1} must be an object.`);
    }

    const item = {
      appCount: Number(raw.appCount),
      averageUserRating: Number(raw.averageUserRating),
      userRatingCount: Number(raw.userRatingCount),
      daysSinceLastRelease: Number(raw.daysSinceLastRelease),
      daysSinceFirstRelease: Number(raw.daysSinceFirstRelease),
      keywordMatch: raw.keywordMatch,
    };

    ensureFiniteNumber(item.appCount, "appCount", index);
    ensureFiniteNumber(item.averageUserRating, "averageUserRating", index);
    ensureFiniteNumber(item.userRatingCount, "userRatingCount", index);
    ensureFiniteNumber(item.daysSinceLastRelease, "daysSinceLastRelease", index);
    ensureFiniteNumber(item.daysSinceFirstRelease, "daysSinceFirstRelease", index);
    ensureKeywordMatch(item.keywordMatch, index);

    return item;
  });
}

function run() {
  if (process.argv.length > 2) {
    throw new Error("This script does not accept arguments. Edit scripts/difficulty-scenarios.example.json and rerun.");
  }

  const scenarios = readScenarios();
  const difficulty = loadDifficultyCalculator();
  const calculateAppDifficultyBreakdown = difficulty.calculateAppDifficultyBreakdown;
  const calculateKeywordDifficultyBreakdown = difficulty.calculateKeywordDifficultyBreakdown;

  const rows = scenarios.map((s, idx) => {
    const out = calculateAppDifficultyBreakdown({
      averageUserRating: s.averageUserRating,
      userRatingCount: s.userRatingCount,
      daysSinceLastRelease: s.daysSinceLastRelease,
      daysSinceFirstRelease: s.daysSinceFirstRelease,
      keywordMatch: s.keywordMatch,
    });
    return {
      i: idx + 1,
      rate: n(s.averageUserRating, 1),
      cnt: n(s.userRatingCount, 0),
      appCount: n(s.appCount, 0),
      dLast: n(s.daysSinceLastRelease, 0),
      dFirst: n(s.daysSinceFirstRelease, 0),
      kw: keywordMatchCode(s.keywordMatch),
      rpd: n(out.ratingPerDay, 2),
      appScore: n(out.score100, 2),
    };
  });

  const scores = rows.map((r) => r.appScore / 100);
  const appCount = scenarios[0].appCount;

  for (let i = 1; i < scenarios.length; i += 1) {
    if (scenarios[i].appCount !== appCount) {
      throw new Error("All rows must have the same appCount.");
    }
  }

  const runtime = calculateKeywordDifficultyBreakdown({
    competitiveScores: scores,
    appCount,
    enforceTopFiveGate: true,
  });
  const simulated = calculateKeywordDifficultyBreakdown({
    competitiveScores: scores,
    appCount,
    enforceTopFiveGate: false,
  });

  console.table(rows);
  console.table([
    {
      mode: "runtime",
      appCount,
      scores: scores.length,
      fallback: runtime.isFallback,
      difficulty: n(runtime.difficultyScore),
      minDifficulty: n(runtime.minDifficultyScore),
      avgCompetitive: n(runtime.avgCompetitive * 100),
    },
    {
      mode: "simulated",
      appCount,
      scores: scores.length,
      fallback: simulated.isFallback,
      difficulty: n(simulated.difficultyScore),
      minDifficulty: n(simulated.minDifficultyScore),
      avgCompetitive: n(simulated.avgCompetitive * 100),
    },
  ]);
}

try {
  run();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`difficulty-lab failed: ${message}`);
  process.exit(1);
}
