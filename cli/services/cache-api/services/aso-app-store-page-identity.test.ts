import { inspectAppStorePageIdentity } from "./aso-app-store-page-identity";

describe("App Store page identity", () => {
  const searchUrl = "https://apps.apple.com/us/iphone/search?term=reader";
  const appUrl = "https://apps.apple.com/us/app/id123?l=zh-Hans";

  it("detects the historical CN Today response even without a redirect", () => {
    const data = `<html lang="zh-Hans-CN"><title>‎iPhone 版“Today” - App Store</title>
      <link href="https://apps.apple.com/cn/iphone/today" rel="canonical"></html>`;
    expect(inspectAppStorePageIdentity({ data }, searchUrl)).toEqual({
      requestedUrl: searchUrl,
      finalUrl: null,
      canonicalUrl: "https://apps.apple.com/cn/iphone/today",
      mismatchSource: "canonical_url",
      payloadSummary: {
        bodyType: "string",
        bodyLength: data.length,
        title: "‎iPhone 版“Today” - App Store",
        htmlLanguage: "zh-Hans-CN",
        hasSerializedServerData: false,
      },
    });
  });

  it.each([
    "https://apps.apple.com/cn/app/example/id123",
    "https://apps.apple.com/us/app/example/id456",
    "https://example.com/us/app/id123",
    "https://apps.apple.com/cn/iphone/today",
  ])("rejects wrong final app identity %s before parsing", (finalUrl) => {
    expect(
      inspectAppStorePageIdentity(
        {
          data: `<link rel="canonical" href="${appUrl}">`,
          request: { res: { responseUrl: finalUrl } },
        },
        appUrl
      )?.mismatchSource
    ).toBe("final_url");
  });

  it("allows app slug redirects and Chinese localization in the requested country", () => {
    const finalUrl = "https://apps.apple.com/us/app/example/id123";
    expect(
      inspectAppStorePageIdentity(
        {
          data: `<html lang='zh-Hans-CN'><link REL='canonical' href='/us/app/example/id123'></html>`,
          request: { res: { responseUrl: finalUrl } },
        },
        appUrl
      )
    ).toBeNull();
  });

  it("checks storefront redirects for the country-less lookup endpoint", () => {
    expect(
      inspectAppStorePageIdentity(
        {
          data: {},
          request: {
            res: { responseUrl: "https://apps.apple.com/cn/app/example/id123" },
          },
        },
        "https://apps.apple.com/app/id123",
        "US"
      )
    ).not.toBeNull();
  });

  it("allows matching search canonical URLs with omitted query parameters", () => {
    expect(
      inspectAppStorePageIdentity(
        { data: '<link rel="canonical" href="/us/iphone/search">' },
        searchUrl
      )
    ).toBeNull();
  });

  it("detects a different search term and decodes canonical HTML entities", () => {
    expect(
      inspectAppStorePageIdentity(
        {
          data: '<link rel="canonical" href="/us/iphone/search?term=other&amp;foo=bar">',
        },
        searchUrl
      )
    ).toMatchObject({
      canonicalUrl:
        "https://apps.apple.com/us/iphone/search?term=other&foo=bar",
      mismatchSource: "canonical_url",
    });
  });

  it("leaves absent identity evidence to the normal payload parser", () => {
    expect(
      inspectAppStorePageIdentity(
        { data: "<html>malformed payload</html>" },
        searchUrl
      )
    ).toBeNull();
  });

  it("reports malformed identity URLs without throwing", () => {
    expect(
      inspectAppStorePageIdentity(
        { data: '<link rel="canonical" href="http://[">' },
        searchUrl
      )
    ).toMatchObject({ mismatchSource: "canonical_url" });
  });
});
