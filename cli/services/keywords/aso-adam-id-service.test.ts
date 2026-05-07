import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import inquirer from "inquirer";
import {
  getSavedAsoAdamId,
  getConfiguredAsoAdamId,
  resetAsoAdamIdRuntimeOverrideForTests,
  resolveAsoAdamId,
  saveAsoAdamId,
} from "./aso-adam-id-service";
import { getMetadataValue, setMetadataValue } from "../../db/metadata";

jest.mock("inquirer");

jest.mock("../../db/metadata", () => ({
  getMetadataValue: jest.fn(),
  setMetadataValue: jest.fn(),
}));

describe("aso-adam-id-service", () => {
  const mockInquirer = jest.mocked(inquirer);
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    resetAsoAdamIdRuntimeOverrideForTests();
    process.env = { ...originalEnv };
    delete process.env.ASO_PRIMARY_APP_ID;
    jest.mocked(getMetadataValue).mockReturnValue(null);
    mockInquirer.prompt.mockResolvedValue({ adamId: "1234567890" } as any);
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("returns saved adam id when valid", () => {
    jest.mocked(getMetadataValue).mockReturnValue("555666777");
    expect(getSavedAsoAdamId()).toBe("555666777");
  });

  it("returns null when saved value is invalid", () => {
    jest.mocked(getMetadataValue).mockReturnValue("abc");
    expect(getSavedAsoAdamId()).toBeNull();
  });

  it("saves valid adam id", () => {
    expect(saveAsoAdamId(" 123456 ")).toBe("123456");
    expect(setMetadataValue).toHaveBeenCalledWith(
      "aso-popularity-adam-id",
      "123456"
    );
  });

  it("throws when saving invalid adam id", () => {
    expect(() => saveAsoAdamId("not-a-number")).toThrow(
      "Invalid Primary App ID."
    );
  });

  it("prioritizes adam id argument and saves it", async () => {
    const result = await resolveAsoAdamId({ adamId: "900100200" });
    expect(result).toBe("900100200");
    expect(mockInquirer.prompt).not.toHaveBeenCalled();
    expect(setMetadataValue).toHaveBeenCalledWith(
      "aso-popularity-adam-id",
      "900100200"
    );
  });

  it("falls back to saved adam id when argument is missing", async () => {
    jest.mocked(getMetadataValue).mockReturnValue("101010101");
    const result = await resolveAsoAdamId();
    expect(result).toBe("101010101");
    expect(mockInquirer.prompt).not.toHaveBeenCalled();
  });

  it("uses env adam id when argument is missing", async () => {
    process.env.ASO_PRIMARY_APP_ID = "121212121";
    jest.mocked(getMetadataValue).mockReturnValue("101010101");

    const result = await resolveAsoAdamId();

    expect(result).toBe("121212121");
    expect(mockInquirer.prompt).not.toHaveBeenCalled();
  });

  it("activates saved adam id immediately in the current process", () => {
    process.env.ASO_PRIMARY_APP_ID = "121212121";

    saveAsoAdamId("900100200");

    expect(getConfiguredAsoAdamId()).toBe("900100200");
  });

  it("ignores invalid env adam id and uses saved adam id", async () => {
    process.env.ASO_PRIMARY_APP_ID = "not-numeric";
    jest.mocked(getMetadataValue).mockReturnValue("101010101");

    const result = await resolveAsoAdamId();

    expect(result).toBe("101010101");
    expect(mockInquirer.prompt).not.toHaveBeenCalled();
  });

  it("prioritizes explicit adam id over env adam id", async () => {
    process.env.ASO_PRIMARY_APP_ID = "121212121";

    const result = await resolveAsoAdamId({ adamId: "900100200" });

    expect(result).toBe("900100200");
    expect(setMetadataValue).toHaveBeenCalledWith(
      "aso-popularity-adam-id",
      "900100200"
    );
  });

  it("prompts and saves when no argument and no saved value", async () => {
    const result = await resolveAsoAdamId();
    expect(result).toBe("1234567890");
    expect(mockInquirer.prompt).toHaveBeenCalledTimes(1);
    expect(setMetadataValue).toHaveBeenCalledWith(
      "aso-popularity-adam-id",
      "1234567890"
    );
  });

  it("fails instead of prompting when allowPrompt is false and id is missing", async () => {
    await expect(resolveAsoAdamId({ allowPrompt: false })).rejects.toThrow(
      "Primary App ID is missing."
    );
    expect(mockInquirer.prompt).not.toHaveBeenCalled();
  });

  it("forces re-entry when an id is already configured", async () => {
    jest.mocked(getMetadataValue).mockReturnValue("101010101");

    const result = await resolveAsoAdamId({ forcePrompt: true });

    expect(result).toBe("1234567890");
    expect(mockInquirer.prompt).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          name: "adamId",
          default: "101010101",
        }),
      ])
    );
  });
});
