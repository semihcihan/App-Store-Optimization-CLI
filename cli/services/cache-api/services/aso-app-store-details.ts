import { asoAppleGet } from "./aso-apple-client";
import { reportAppleContractChange } from "../../keywords/apple-http-trace";

const APP_STORE_BASE = "https://apps.apple.com";
const DEFAULT_LANGUAGE = "en-us";

type LocalizedAppPageData = {
  title: string;
  subtitle?: string;
  ratingAverage: number | null;
  totalNumberOfRatings: number | null;
  icon?: Record<string, unknown>;
};

type SerializedServerData = {
  data?: Array<{
    data?: {
      lockup?: {
        title?: string;
        subtitle?: string;
        icon?: Record<string, unknown>;
      };
      shelfMapping?: {
        productRatings?: {
          items?: Array<{
            ratingAverage?: number;
            totalNumberOfRatings?: number;
          }>;
        };
      };
    };
  }>;
};

function getRequestCountry(language: string, defaultCountry: string): string {
  if (language && language.toLowerCase().startsWith("zh-")) {
    const part = language.split("-")[1];
    return part ? part.toLowerCase() : defaultCountry.toLowerCase();
  }
  return defaultCountry.toLowerCase();
}

function cleanText(text: unknown): string {
  if (typeof text !== "string") return "";
  return text.replace(/\s+/g, " ").trim();
}

function readFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return null;
  }
  return value;
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function parseSerializedData(raw: unknown): SerializedServerData | null {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as SerializedServerData;
  }

  if (typeof raw !== "string") return null;

  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as SerializedServerData;
    }
  } catch {}

  const serializedDataMatch = trimmed.match(
    /<script[^>]*id=["']serialized-server-data["'][^>]*>([\s\S]*?)<\/script>/i
  );
  if (!serializedDataMatch?.[1]) return null;

  try {
    return JSON.parse(serializedDataMatch[1]) as SerializedServerData;
  } catch {
    return null;
  }
}

function mapLocalizedData(payload: SerializedServerData): LocalizedAppPageData | null {
  const root = payload.data?.[0]?.data;
  const title = cleanText(root?.lockup?.title);
  const subtitle = cleanText(root?.lockup?.subtitle);
  const icon = readObject(root?.lockup?.icon);
  const ratingItem = root?.shelfMapping?.productRatings?.items?.[0];
  const ratingAverage = readFiniteNumber(ratingItem?.ratingAverage);
  const totalNumberOfRatings = readFiniteNumber(ratingItem?.totalNumberOfRatings);

  if (!title && !subtitle && !icon && ratingAverage == null && totalNumberOfRatings == null) {
    return null;
  }

  return {
    title,
    subtitle: subtitle || undefined,
    ratingAverage,
    totalNumberOfRatings,
    ...(icon ? { icon } : {}),
  };
}

export async function fetchAppStoreLocalizedAppData(
  appId: string,
  country: string,
  language: string = DEFAULT_LANGUAGE
): Promise<LocalizedAppPageData | null> {
  const requestCountry = getRequestCountry(language, country);
  const url = `${APP_STORE_BASE}/${requestCountry}/app/id${appId}${language ? `?l=${language}` : ""}`;
  const response = await asoAppleGet<string>(url, {
    operation: "appstore.localized-app-page",
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

  const serialized = parseSerializedData(response.data);
  if (!serialized) {
    reportAppleContractChange({
      provider: "apple-appstore",
      operation: "appstore.localized-app-page",
      endpoint: "https://apps.apple.com/{country}/app/id{appId}?l={language}",
      statusCode: response.status,
      expectedContract:
        "Localized app page response contains serialized-server-data JSON payload",
      actualSignal: `payload_parse_failed rawType=${typeof response.data}`,
      context: {
        appId,
        country: requestCountry.toUpperCase(),
        language,
      },
      isTerminal: false,
      dedupeKey: "appstore-localized-page-payload-parse",
    });
    return null;
  }

  const mapped = mapLocalizedData(serialized);
  if (!mapped) {
    reportAppleContractChange({
      provider: "apple-appstore",
      operation: "appstore.localized-app-page",
      endpoint: "https://apps.apple.com/{country}/app/id{appId}?l={language}",
      statusCode: response.status,
      expectedContract:
        "serialized-server-data includes lockup.title/subtitle and productRatings.items[0]",
      actualSignal: "localized_mapping_missing",
      context: {
        appId,
        country: requestCountry.toUpperCase(),
        language,
      },
      isTerminal: false,
      dedupeKey: "appstore-localized-page-shape-missing",
    });
    return null;
  }

  return mapped;
}
