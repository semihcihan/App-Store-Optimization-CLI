import { jest } from "@jest/globals";
import { asoAppleGet } from "./aso-apple-client";
import { fetchAppStoreTitleAndSubtitle } from "./aso-app-store-details";
import { reportAppleContractChange } from "../../keywords/apple-http-trace";

jest.mock("./aso-apple-client", () => ({
  asoAppleGet: jest.fn(),
}));

jest.mock("../../keywords/apple-http-trace", () => ({
  reportAppleContractChange: jest.fn(),
}));

const mockedAsoAppleGet = jest.mocked(asoAppleGet);
const mockedReportAppleContractChange = jest.mocked(reportAppleContractChange);

describe("aso-app-store-details", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("fetches and parses title/subtitle from app page html", async () => {
    mockedAsoAppleGet.mockResolvedValue({
      status: 200,
      data: `<html><body>
        <h1 class=\"product-header__title\">My App <span class=\"badge\">GET</span></h1>
        <h2 class=\"product-header__subtitle\">Super\n fun\u00a0app</h2>
      </body></html>`,
    } as never);

    const result = await fetchAppStoreTitleAndSubtitle("123", "US");

    expect(result).toEqual({
      title: "My App",
      subtitle: "Super funapp",
    });
    expect(mockedAsoAppleGet).toHaveBeenCalledWith(
      "https://apps.apple.com/us/app/id123?l=en-us",
      expect.objectContaining({ operation: "appstore.title-subtitle-page" })
    );
  });

  it("uses zh language region in request path", async () => {
    mockedAsoAppleGet.mockResolvedValue({
      status: 200,
      data: `<h1 class=\"product-header__title\">Title</h1><h2 class=\"product-header__subtitle\">Sub</h2>`,
    } as never);

    await fetchAppStoreTitleAndSubtitle("999", "US", "zh-HK");

    expect(mockedAsoAppleGet).toHaveBeenCalledWith(
      "https://apps.apple.com/hk/app/id999?l=zh-HK",
      expect.any(Object)
    );
  });

  it("returns null on non-200 responses", async () => {
    mockedAsoAppleGet.mockResolvedValue({ status: 500, data: "" } as never);

    await expect(fetchAppStoreTitleAndSubtitle("123", "US")).resolves.toBeNull();
  });

  it("reports contract drift when 200 response is missing title/subtitle selectors", async () => {
    mockedAsoAppleGet.mockResolvedValue({
      status: 200,
      data: "<html><body><div>No expected selectors</div></body></html>",
    } as never);

    await expect(fetchAppStoreTitleAndSubtitle("123", "US")).resolves.toBeNull();

    expect(mockedReportAppleContractChange).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "apple-appstore",
        operation: "appstore.title-subtitle-page",
      })
    );
  });
});
