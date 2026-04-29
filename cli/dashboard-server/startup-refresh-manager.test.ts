import {
  createStartupRefreshManager,
  selectKeywordRefreshCandidates,
  type KeywordRefreshItem,
} from "./startup-refresh-manager";
import type { StoredAppKeyword, StoredAsoKeyword } from "../db";

function buildKeyword(
  overrides: Partial<StoredAsoKeyword>
): StoredAsoKeyword {
  return {
    keyword: "term",
    normalizedKeyword: "term",
    country: "US",
    popularity: 10,
    difficultyScore: 20,
    minDifficultyScore: 5,
    isBrandKeyword: null,
    appCount: 10,
    keywordMatch: "titleExactPhrase",
    orderedAppIds: ["app-1"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    orderExpiresAt: "2099-01-01T00:00:00.000Z",
    popularityExpiresAt: "2099-01-30T00:00:00.000Z",
    ...overrides,
  };
}

function buildAssociation(
  overrides: Partial<StoredAppKeyword>
): StoredAppKeyword {
  return {
    appId: "app-1",
    keyword: "term",
    country: "US",
    isFavorite: false,
    previousPosition: null,
    addedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

async function waitForManagerToFinish(
  manager: ReturnType<typeof createStartupRefreshManager>
): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const state = manager.getState();
    if (state.status === "completed" || state.status === "failed") return;
    await Promise.resolve();
  }
}

describe("startup-refresh-manager", () => {
  it("does not select research-only keywords for order-stale refresh", () => {
    const now = Date.parse("2026-03-07T00:00:00.000Z");
    const selected = selectKeywordRefreshCandidates({
      keywords: [
        buildKeyword({
          keyword: "order-stale",
          normalizedKeyword: "order-stale",
          orderExpiresAt: "2026-03-06T00:00:00.000Z",
        }),
        buildKeyword({ keyword: "fresh", normalizedKeyword: "fresh" }),
        buildKeyword({
          keyword: "difficulty-missing",
          normalizedKeyword: "difficulty-missing",
          difficultyScore: null,
          minDifficultyScore: null,
          appCount: null,
          keywordMatch: null,
        }),
        buildKeyword({
          keyword: "popularity-stale",
          normalizedKeyword: "popularity-stale",
          popularityExpiresAt: "2026-03-06T00:00:00.000Z",
        }),
        buildKeyword({
          keyword: "research-order-stale",
          normalizedKeyword: "research-order-stale",
          popularity: 30,
          orderExpiresAt: "2026-03-06T00:00:00.000Z",
        }),
        buildKeyword({
          keyword: "research-popularity-stale",
          normalizedKeyword: "research-popularity-stale",
          popularity: 31,
          popularityExpiresAt: "2026-03-06T00:00:00.000Z",
        }),
        buildKeyword({
          keyword: "research-difficulty-missing",
          normalizedKeyword: "research-difficulty-missing",
          popularity: 32,
          difficultyScore: null,
          minDifficultyScore: null,
          appCount: null,
          keywordMatch: null,
        }),
        buildKeyword({
          keyword: "no-popularity",
          normalizedKeyword: "no-popularity",
          popularity: Number.NaN,
        }),
      ],
      appKeywords: [
        buildAssociation({ appId: "app-1", keyword: "order-stale" }),
        buildAssociation({ appId: "app-1", keyword: "fresh" }),
        buildAssociation({ appId: "app-1", keyword: "difficulty-missing" }),
        buildAssociation({ appId: "app-1", keyword: "popularity-stale" }),
        buildAssociation({
          appId: "research:ideas",
          keyword: "research-order-stale",
        }),
        buildAssociation({
          appId: "research:ideas",
          keyword: "research-popularity-stale",
        }),
        buildAssociation({
          appId: "research:ideas",
          keyword: "research-difficulty-missing",
        }),
        buildAssociation({ appId: "app-1", keyword: "no-popularity" }),
      ],
      associatedAppIds: new Set(["app-1", "research:ideas"]),
      orderRelevantAppIds: new Set(["app-1"]),
      nowMs: now,
    });

    expect(selected).toEqual<KeywordRefreshItem[]>([
      { keyword: "order-stale", popularity: 10 },
      { keyword: "difficulty-missing", popularity: 10 },
      { keyword: "popularity-stale", popularity: 10 },
      { keyword: "research-popularity-stale", popularity: 31 },
      { keyword: "research-difficulty-missing", popularity: 32 },
    ]);
  });

  it("retries failed batch once and records successful counters", async () => {
    let now = Date.parse("2026-03-07T00:00:00.000Z");
    const enrichCalls: KeywordRefreshItem[][] = [];
    const errors: unknown[] = [];

    const manager = createStartupRefreshManager({
      country: "US",
      listKeywords: () => [
        buildKeyword({
          keyword: "k1",
          normalizedKeyword: "k1",
          orderExpiresAt: "2026-03-06T00:00:00.000Z",
        }),
        buildKeyword({
          keyword: "k2",
          normalizedKeyword: "k2",
          orderExpiresAt: "2026-03-06T00:00:00.000Z",
        }),
        buildKeyword({
          keyword: "k3",
          normalizedKeyword: "k3",
          orderExpiresAt: "2026-03-06T00:00:00.000Z",
        }),
      ],
      listAppKeywords: () => [
        buildAssociation({ keyword: "k1", appId: "app-1" }),
        buildAssociation({ keyword: "k2", appId: "app-1" }),
        buildAssociation({ keyword: "k3", appId: "app-1" }),
      ],
      listAssociatedAppIds: () => new Set(["app-1"]),
      listOrderRelevantAppIds: () => new Set(["app-1"]),
      enrichKeywords: async (_country, items) => {
        enrichCalls.push(items);
        if (enrichCalls.length === 1) {
          throw new Error("first batch failed");
        }
      },
      isForegroundBusy: () => false,
      reportError: (error) => {
        errors.push(error);
      },
      nowMs: () => now,
      sleep: async () => {},
      keywordBatchSize: 2,
    });

    manager.start();
    now += 1000;
    await waitForManagerToFinish(manager);

    const state = manager.getState();
    expect(state.status).toBe("completed");
    expect(state.counters.eligibleKeywordCount).toBe(3);
    expect(state.counters.refreshedKeywordCount).toBe(3);
    expect(state.counters.failedKeywordCount).toBe(0);
    expect(state.requiresReauthentication).toBe(false);
    expect(enrichCalls).toHaveLength(3);
    expect(errors).toHaveLength(0);
  });

  it("marks batch failed when retry also fails", async () => {
    const errors: unknown[] = [];

    const manager = createStartupRefreshManager({
      country: "US",
      listKeywords: () => [
        buildKeyword({
          keyword: "k1",
          normalizedKeyword: "k1",
          orderExpiresAt: "2026-03-06T00:00:00.000Z",
        }),
      ],
      listAppKeywords: () => [buildAssociation({ keyword: "k1", appId: "app-1" })],
      listAssociatedAppIds: () => new Set(["app-1"]),
      listOrderRelevantAppIds: () => new Set(["app-1"]),
      enrichKeywords: async () => {
        throw new Error("always fails");
      },
      isForegroundBusy: () => false,
      reportError: (error) => {
        errors.push(error);
      },
      nowMs: () => Date.parse("2026-03-07T00:00:00.000Z"),
      sleep: async () => {},
      keywordBatchSize: 25,
    });

    manager.start();
    await waitForManagerToFinish(manager);

    const state = manager.getState();
    expect(state.status).toBe("failed");
    expect(state.counters.refreshedKeywordCount).toBe(0);
    expect(state.counters.failedKeywordCount).toBe(1);
    expect(state.requiresReauthentication).toBe(false);
    expect(errors).toHaveLength(1);
  });

  it("marks auth-required failures and allows restart after failure", async () => {
    let attempt = 0;

    const manager = createStartupRefreshManager({
      country: "US",
      listKeywords: () => [
        buildKeyword({
          keyword: "k1",
          normalizedKeyword: "k1",
          orderExpiresAt: "2026-03-06T00:00:00.000Z",
        }),
      ],
      listAppKeywords: () => [buildAssociation({ keyword: "k1", appId: "app-1" })],
      listAssociatedAppIds: () => new Set(["app-1"]),
      listOrderRelevantAppIds: () => new Set(["app-1"]),
      enrichKeywords: async () => {
        attempt += 1;
        if (attempt === 1) {
          throw new Error(
            "Apple Search Ads session expired. Reauthentication is required."
          );
        }
      },
      isForegroundBusy: () => false,
      isAuthReauthRequiredError: (error) =>
        error instanceof Error &&
        error.message.includes("Reauthentication is required"),
      nowMs: () => Date.parse("2026-03-07T00:00:00.000Z"),
      sleep: async () => {},
      keywordBatchSize: 25,
    });

    manager.start();
    await waitForManagerToFinish(manager);

    expect(manager.getState()).toEqual(
      expect.objectContaining({
        status: "failed",
        requiresReauthentication: true,
      })
    );

    await Promise.resolve();
    manager.start();
    await waitForManagerToFinish(manager);

    expect(manager.getState()).toEqual(
      expect.objectContaining({
        status: "completed",
        requiresReauthentication: false,
      })
    );
    expect(attempt).toBe(2);
  });
});
