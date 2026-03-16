import * as cheerio from "cheerio";
import { asoAppleGet } from "./aso-apple-client";
import { reportAppleContractChange } from "../../keywords/apple-http-trace";

const APP_STORE_BASE = "https://apps.apple.com";
const DEFAULT_LANGUAGE = "en-us";

function getRequestCountry(language: string, defaultCountry: string): string {
  if (language && language.toLowerCase().startsWith("zh-")) {
    const part = language.split("-")[1];
    return part ? part.toLowerCase() : defaultCountry.toLowerCase();
  }
  return defaultCountry.toLowerCase();
}

function cleanText(text: string | null | undefined): string {
  if (!text) return "";
  const cleaned = text.replace(/[^\x20-\x7E]/g, "").replace(/\s+/g, " ").trim();
  return cleaned;
}

function parseTitleAndSubtitle(html: string): { title: string; subtitle: string } {
  const $ = cheerio.load(html);
  const titleEl = $("h1.product-header__title").first();
  titleEl.find("span.badge").remove();
  const title = cleanText(titleEl.text());
  const subtitleEl = $("h2.product-header__subtitle").first();
  const subtitle = cleanText(subtitleEl.text());
  return { title, subtitle };
}

export async function fetchAppStoreTitleAndSubtitle(
  appId: string,
  country: string,
  language: string = DEFAULT_LANGUAGE
): Promise<{ title: string; subtitle: string } | null> {
  const requestCountry = getRequestCountry(language, country);
  const url = `${APP_STORE_BASE}/${requestCountry}/app/id${appId}${language ? `?l=${language}` : ""}`;
  const response = await asoAppleGet<string>(url, {
    operation: "appstore.title-subtitle-page",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2.1 Safari/605.1.15",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      Host: "apps.apple.com",
      "Accept-Language": "en-US,en;q=0.9",
    },
    timeout: 30000,
    validateStatus: (status) => status === 200 || status === 404,
  });

  if (response.status === 404 && requestCountry !== country.toLowerCase()) {
    return null;
  }
  if (response.status !== 200) {
    return null;
  }
  if (typeof response.data !== "string") {
    reportAppleContractChange({
      provider: "apple-appstore",
      operation: "appstore.title-subtitle-page",
      endpoint: "https://apps.apple.com/{country}/app/id{appId}",
      statusCode: response.status,
      expectedContract: "Title/subtitle page returns HTML text",
      actualSignal: `response_data_type=${typeof response.data}`,
      context: {
        appId,
        country: requestCountry.toUpperCase(),
        language,
      },
      isTerminal: false,
      dedupeKey: "appstore-title-subtitle-non-html-response",
    });
    return null;
  }

  const { title, subtitle } = parseTitleAndSubtitle(response.data);
  if (!title && !subtitle) {
    reportAppleContractChange({
      provider: "apple-appstore",
      operation: "appstore.title-subtitle-page",
      endpoint: "https://apps.apple.com/{country}/app/id{appId}",
      statusCode: response.status,
      expectedContract:
        "Page includes title/subtitle selectors (.product-header__title or .product-header__subtitle)",
      actualSignal: "title_and_subtitle_missing",
      context: {
        appId,
        country: requestCountry.toUpperCase(),
        language,
      },
      isTerminal: false,
      dedupeKey: "appstore-title-subtitle-selectors-missing",
    });
    return null;
  }
  return { title, subtitle };
}
