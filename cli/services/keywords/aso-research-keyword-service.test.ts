import { jest } from "@jest/globals";
import { createAppKeywords } from "../../db/app-keywords";
import { getAppById, upsertApps } from "../../db/apps";
import {
  DEFAULT_RESEARCH_APP_ID,
  DEFAULT_RESEARCH_APP_NAME,
} from "../../shared/aso-research";
import {
  saveKeywordsToDefaultResearchApp,
  saveKeywordsToResearchApp,
} from "./aso-research-keyword-service";

jest.mock("../../db/app-keywords", () => ({
  createAppKeywords: jest.fn(),
}));

jest.mock("../../db/apps", () => ({
  getAppById: jest.fn(),
  upsertApps: jest.fn(),
}));

describe("saveKeywordsToDefaultResearchApp", () => {
  const mockCreateAppKeywords = jest.mocked(createAppKeywords);
  const mockGetAppById = jest.mocked(getAppById);
  const mockUpsertApps = jest.mocked(upsertApps);

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAppById.mockReturnValue(null);
  });

  it("returns 0 for empty keyword input", () => {
    expect(saveKeywordsToDefaultResearchApp([], "US")).toBe(0);
    expect(mockCreateAppKeywords).not.toHaveBeenCalled();
    expect(mockUpsertApps).not.toHaveBeenCalled();
  });

  it("returns 0 when normalized keywords are empty", () => {
    expect(saveKeywordsToDefaultResearchApp(["  ", "\n"], "US")).toBe(0);
    expect(mockCreateAppKeywords).not.toHaveBeenCalled();
    expect(mockUpsertApps).not.toHaveBeenCalled();
  });

  it("normalizes/dedupes keywords and creates research app when missing", () => {
    const savedCount = saveKeywordsToDefaultResearchApp(
      ["  Sleep  ", "sleep", "MEDITATION", ""],
      "US"
    );

    expect(savedCount).toBe(2);
    expect(mockUpsertApps).toHaveBeenCalledWith([
      {
        id: DEFAULT_RESEARCH_APP_ID,
        name: DEFAULT_RESEARCH_APP_NAME,
      },
    ]);
    expect(mockCreateAppKeywords).toHaveBeenCalledWith(
      DEFAULT_RESEARCH_APP_ID,
      ["sleep", "meditation"],
      "US"
    );
  });

  it("does not create app row when research app already exists", () => {
    mockGetAppById.mockReturnValue({
      id: DEFAULT_RESEARCH_APP_ID,
      name: DEFAULT_RESEARCH_APP_NAME,
    } as any);

    const savedCount = saveKeywordsToDefaultResearchApp(["term"], "US");

    expect(savedCount).toBe(1);
    expect(mockUpsertApps).not.toHaveBeenCalled();
    expect(mockCreateAppKeywords).toHaveBeenCalledWith(
      DEFAULT_RESEARCH_APP_ID,
      ["term"],
      "US"
    );
  });

  it("saves keywords to a custom app id when provided", () => {
    const savedCount = saveKeywordsToResearchApp(["term"], "US", "123");

    expect(savedCount).toBe(1);
    expect(mockUpsertApps).toHaveBeenCalledWith([
      {
        id: "123",
        name: "123",
      },
    ]);
    expect(mockCreateAppKeywords).toHaveBeenCalledWith("123", ["term"], "US");
  });

  it("uses numeric app id when input is id-prefixed and numeric app exists", () => {
    mockGetAppById.mockImplementation((id: string) => {
      if (id === "123") {
        return { id: "123", name: "Owned App" } as any;
      }
      return null;
    });

    const savedCount = saveKeywordsToResearchApp(["term"], "US", "id123");

    expect(savedCount).toBe(1);
    expect(mockUpsertApps).not.toHaveBeenCalled();
    expect(mockCreateAppKeywords).toHaveBeenCalledWith("123", ["term"], "US");
  });

  it("falls back to id-prefixed app id when numeric app id does not exist", () => {
    mockGetAppById.mockImplementation((id: string) => {
      if (id === "id123") {
        return { id: "id123", name: "Prefixed App" } as any;
      }
      return null;
    });

    const savedCount = saveKeywordsToResearchApp(["term"], "US", "id123");

    expect(savedCount).toBe(1);
    expect(mockUpsertApps).not.toHaveBeenCalled();
    expect(mockCreateAppKeywords).toHaveBeenCalledWith("id123", ["term"], "US");
  });
});
