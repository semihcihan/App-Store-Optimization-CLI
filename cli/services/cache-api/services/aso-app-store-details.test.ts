import { jest } from "@jest/globals";
import { asoAppleGet } from "./aso-apple-client";
import { fetchAppStoreLocalizedAppData } from "./aso-app-store-details";
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

  it("fetches and parses localized app-page serialized JSON fields", async () => {
    const payload = {
      data: [
        {
          data: {
            lockup: {
              title: "My App",
              subtitle: "Super app",
              icon: {
                template: "https://example.com/icon/{w}x{h}.{f}",
                width: 1024,
                height: 1024,
              },
            },
            shelfMapping: {
              productRatings: {
                items: [
                  {
                    ratingAverage: 4.56,
                    totalNumberOfRatings: 12345,
                  },
                ],
              },
            },
          },
        },
      ],
    };

    mockedAsoAppleGet.mockResolvedValue({
      status: 200,
      data: `<html><body>
        <script type=\"application/json\" id=\"serialized-server-data\">${JSON.stringify(payload)}</script>
      </body></html>`,
    } as never);

    const result = await fetchAppStoreLocalizedAppData("123", "US");

    expect(result).toEqual({
      title: "My App",
      subtitle: "Super app",
      ratingAverage: 4.56,
      totalNumberOfRatings: 12345,
      icon: {
        template: "https://example.com/icon/{w}x{h}.{f}",
        width: 1024,
        height: 1024,
      },
    });
    expect(mockedAsoAppleGet).toHaveBeenCalledWith(
      "https://apps.apple.com/us/app/id123?l=en-us",
      expect.objectContaining({ operation: "appstore.localized-app-page" })
    );
  });

  it("uses zh language region in request path", async () => {
    mockedAsoAppleGet.mockResolvedValue({
      status: 200,
      data: `<script id=\"serialized-server-data\">${JSON.stringify({
        data: [{ data: { lockup: { title: "Title" } } }],
      })}</script>`,
    } as never);

    await fetchAppStoreLocalizedAppData("999", "US", "zh-HK");

    expect(mockedAsoAppleGet).toHaveBeenCalledWith(
      "https://apps.apple.com/hk/app/id999?l=zh-HK",
      expect.any(Object)
    );
  });

  it("returns null on non-200 responses", async () => {
    mockedAsoAppleGet.mockResolvedValue({ status: 500, data: "" } as never);

    await expect(fetchAppStoreLocalizedAppData("123", "US")).resolves.toBeNull();
  });

  it("reports contract drift when 200 response is missing serialized data mapping", async () => {
    mockedAsoAppleGet.mockResolvedValue({
      status: 200,
      data: "<html><body><div>No expected payload</div></body></html>",
    } as never);

    await expect(fetchAppStoreLocalizedAppData("123", "US")).resolves.toBeNull();

    expect(mockedReportAppleContractChange).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "apple-appstore",
        operation: "appstore.localized-app-page",
      })
    );
  });
});
