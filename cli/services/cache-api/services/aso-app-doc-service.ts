import { computeAppExpiryIsoForApp } from "./aso-keyword-utils";
import type { AsoCacheRepository, AsoAppDoc } from "./aso-types";
import { normalizeCountryOnAppDocs } from "./aso-app-doc-utils";
import { asoAppleGet } from "./aso-apple-client";
import { logger } from "../../../utils/logger";
import { reportAppleContractChange } from "../../keywords/apple-http-trace";
import { ASO_APPLE_WEB_USER_AGENT } from "../../../shared/aso-apple-http";
import {
  assertSupportedCountry,
  normalizeCountry,
} from "../../../domain/keywords/policy";

type AppStoreProductVersionHistoryItem = {
  releaseDate?: string;
};

type ItunesLookupResult = {
  trackId?: number;
  trackName?: string;
  sellerName?: string;
  averageUserRating?: number;
  userRatingCount?: number;
  releaseDate?: string;
  currentVersionReleaseDate?: string;
  artworkUrl512?: string;
  artworkUrl100?: string;
  artworkUrl60?: string;
  kind?: string;
  wrapperType?: string;
};

type ItunesLookupResponse = {
  resultCount?: number;
  results?: ItunesLookupResult[];
};

type AppStoreProductLookupPayload = {
  storePlatformData?: {
    "product-dv"?: {
      results?: Record<string, Record<string, unknown>>;
    };
  };
  pageData?: {
    versionHistory?: AppStoreProductVersionHistoryItem[];
  };
};

const APP_STORE_FRONT_ID_BY_COUNTRY: Record<string, string> = {
  US: "143441",
};

function getStoreFrontHeader(country: string): string {
  const id = APP_STORE_FRONT_ID_BY_COUNTRY[country.toUpperCase()] ?? APP_STORE_FRONT_ID_BY_COUNTRY.US;
  return `${id}-1,29`;
}

function parseAppStorePayload(raw: unknown): AppStoreProductLookupPayload | null {
  if (raw && typeof raw === "object") return raw as AppStoreProductLookupPayload;
  if (typeof raw !== "string") return null;

  try {
    return JSON.parse(raw) as AppStoreProductLookupPayload;
  } catch {
    const serializedDataMatch = raw.match(
      /<script[^>]*id="serialized-server-data"[^>]*>([\s\S]*?)<\/script>/i
    );
    if (!serializedDataMatch?.[1]) return null;
    try {
      return JSON.parse(serializedDataMatch[1]) as AppStoreProductLookupPayload;
    } catch {
      return null;
    }
  }
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseAppDocFromPayload(
  payload: AppStoreProductLookupPayload,
  fallbackAppId: string,
  country: string
): AsoAppDoc | null {
  const results = payload.storePlatformData?.["product-dv"]?.results;
  if (!results || typeof results !== "object") return null;
  const product =
    results[fallbackAppId] ??
    (Object.values(results).find((value) => value && typeof value === "object") as
      | Record<string, unknown>
      | undefined);
  if (!product) return null;

  const appId =
    (typeof product.id === "string" && product.id.trim()) ||
    (typeof product.id === "number" ? String(product.id) : fallbackAppId);
  if (!appId) return null;

  const userRating =
    product.userRating && typeof product.userRating === "object"
      ? (product.userRating as Record<string, unknown>)
      : undefined;
  const artwork =
    product.artwork && typeof product.artwork === "object"
      ? (product.artwork as Record<string, unknown>)
      : undefined;
  const iconArtwork =
    product.iconArtwork && typeof product.iconArtwork === "object"
      ? (product.iconArtwork as Record<string, unknown>)
      : undefined;

  const versionHistory = payload.pageData?.versionHistory;
  const currentVersionReleaseDate =
    Array.isArray(versionHistory) && versionHistory.length > 0
      ? versionHistory[0]?.releaseDate ?? null
      : null;
  const releaseDate =
    typeof product.releaseDate === "string" ? product.releaseDate : null;
  const subtitle =
    typeof product.subtitle === "string" && product.subtitle.trim() !== ""
      ? product.subtitle
      : undefined;
  const publisherName = [
    product.artistName,
    product.sellerName,
    product.developerName,
  ].find((value) => typeof value === "string" && value.trim() !== "") as
    | string
    | undefined;

  if (!releaseDate || !currentVersionReleaseDate) {
    logger.debug("[aso-app-lookup] missing app date fields", {
      appId,
      country,
      hasReleaseDate: Boolean(releaseDate),
      hasCurrentVersionReleaseDate: Boolean(currentVersionReleaseDate),
      versionHistoryCount: Array.isArray(versionHistory) ? versionHistory.length : 0,
      productHasReleaseDateField: Object.prototype.hasOwnProperty.call(
        product,
        "releaseDate"
      ),
    });
  }

  return {
    appId,
    country,
    name: typeof product.name === "string" ? product.name : "",
    subtitle,
    ...(publisherName ? { publisherName } : {}),
    averageUserRating: readNumber(userRating?.value),
    userRatingCount: readNumber(userRating?.ratingCount),
    releaseDate,
    currentVersionReleaseDate,
    iconArtwork:
      typeof artwork?.url === "string"
        ? { url: artwork.url }
        : typeof iconArtwork?.url === "string"
          ? { url: iconArtwork.url }
          : undefined,
  };
}

function splitIntoChunks<T>(items: T[], size: number): T[][] {
  const chunkSize = Math.max(1, Math.floor(size));
  const chunks: T[][] = [];
  for (let idx = 0; idx < items.length; idx += chunkSize) {
    chunks.push(items.slice(idx, idx + chunkSize));
  }
  return chunks;
}

function parseItunesLookupResult(
  result: ItunesLookupResult,
  country: string
): AsoAppDoc | null {
  const kind = readString(result.kind)?.toLowerCase();
  const wrapperType = readString(result.wrapperType)?.toLowerCase();
  if (kind !== "software" && wrapperType !== "software") {
    return null;
  }

  const trackId =
    typeof result.trackId === "number" ? String(result.trackId) : null;
  if (!trackId) return null;
  const name = readString(result.trackName) ?? "";
  const publisherName = readString(result.sellerName) ?? undefined;
  const releaseDate = readString(result.releaseDate);
  const currentVersionReleaseDate = readString(result.currentVersionReleaseDate);
  const iconUrl =
    readString(result.artworkUrl512) ??
    readString(result.artworkUrl100) ??
    readString(result.artworkUrl60);

  return {
    appId: trackId,
    country,
    name,
    ...(publisherName ? { publisherName } : {}),
    averageUserRating: readNumber(result.averageUserRating),
    userRatingCount: readNumber(result.userRatingCount),
    releaseDate,
    currentVersionReleaseDate,
    ...(iconUrl ? { iconArtwork: { url: iconUrl } } : {}),
  };
}

async function fetchItunesLookupAppDocs(params: {
  country: string;
  appIds: string[];
}): Promise<Map<string, AsoAppDoc>> {
  const byId = new Map<string, AsoAppDoc>();
  if (params.appIds.length === 0) return byId;

  const country = params.country.toUpperCase();
  const chunks = splitIntoChunks(params.appIds, 50);
  for (const chunk of chunks) {
    let response;
    try {
      response = await asoAppleGet<ItunesLookupResponse>(
        "https://itunes.apple.com/lookup",
        {
          operation: "itunes.lookup",
          params: {
            id: chunk.join(","),
            country: country.toLowerCase(),
            entity: "software",
          },
          headers: {
            "User-Agent": ASO_APPLE_WEB_USER_AGENT,
            Accept: "application/json,text/plain,*/*",
          },
          timeout: 30000,
        }
      );
    } catch (error) {
      logger.debug("[aso-app-lookup] itunes lookup request failed", {
        country,
        requestedCount: chunk.length,
        appIds: chunk,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    if (!response || !response.data || typeof response.data !== "object") {
      continue;
    }
    const results = Array.isArray(response.data.results) ? response.data.results : [];
    for (const result of results) {
      const doc = parseItunesLookupResult(result, country);
      if (!doc) continue;
      byId.set(doc.appId, doc);
    }
  }

  return byId;
}

function mergeFallbackDoc(
  existing: AsoAppDoc | undefined,
  fallback: AsoAppDoc
): AsoAppDoc {
  if (!existing) return fallback;
  return {
    ...existing,
    ...(existing.name.trim() === "" ? { name: fallback.name } : {}),
    ...(existing.publisherName ? {} : { publisherName: fallback.publisherName }),
    ...(existing.releaseDate ? {} : { releaseDate: fallback.releaseDate }),
    ...(existing.currentVersionReleaseDate
      ? {}
      : { currentVersionReleaseDate: fallback.currentVersionReleaseDate }),
    ...(existing.iconArtwork ? {} : { iconArtwork: fallback.iconArtwork }),
    averageUserRating:
      existing.averageUserRating > 0
        ? existing.averageUserRating
        : fallback.averageUserRating,
    userRatingCount:
      existing.userRatingCount > 0 ? existing.userRatingCount : fallback.userRatingCount,
  };
}

async function fetchAppDocById(country: string, appId: string): Promise<AsoAppDoc | null> {
  let response;
  try {
    response = await asoAppleGet(
      "https://apps.apple.com/app/id" + encodeURIComponent(appId),
      {
        operation: "appstore.app-lookup",
        headers: {
          "X-Apple-Store-Front": getStoreFrontHeader(country),
          Host: "apps.apple.com",
          "User-Agent": ASO_APPLE_WEB_USER_AGENT,
          Accept: "application/json,text/plain,*/*",
        },
        timeout: 30000,
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.debug("[aso-app-lookup] request failed after retries", {
      appId,
      country: country.toUpperCase(),
      message,
    });
    throw error;
  }

  const payload = parseAppStorePayload(response.data);
  if (!payload) {
    reportAppleContractChange({
      provider: "apple-appstore",
      operation: "appstore.app-lookup",
      endpoint: "https://apps.apple.com/app/id{appId}",
      statusCode: response.status,
      expectedContract:
        "App lookup response is JSON/object or HTML with serialized-server-data JSON",
      actualSignal: `payload_parse_failed rawType=${typeof response.data}`,
      context: {
        appId,
        country: country.toUpperCase(),
      },
      isTerminal: false,
      dedupeKey: "appstore-app-lookup-payload-parse",
    });
    logger.debug("[aso-app-lookup] unparseable payload", {
      appId,
      country: country.toUpperCase(),
    });
    return null;
  }

  const parsedDoc = parseAppDocFromPayload(payload, appId, country.toUpperCase());
  if (!parsedDoc) {
    reportAppleContractChange({
      provider: "apple-appstore",
      operation: "appstore.app-lookup",
      endpoint: "https://apps.apple.com/app/id{appId}",
      statusCode: response.status,
      expectedContract:
        "App lookup payload has storePlatformData.product-dv.results with a product entry",
      actualSignal: "missing_product_payload",
      context: {
        appId,
        country: country.toUpperCase(),
      },
      isTerminal: false,
      dedupeKey: "appstore-app-lookup-missing-product",
    });
    return null;
  }

  return parsedDoc;
}

export async function fetchAppStoreLookupAppDocs(params: {
  country: string;
  appIds: string[];
}): Promise<AsoAppDoc[]> {
  const country = normalizeCountry(params.country);
  assertSupportedCountry(country);
  if (params.appIds.length === 0) return [];
  const uniqueIds = Array.from(new Set(params.appIds.map((id) => id.trim()).filter(Boolean)));
  const docs = await Promise.all(uniqueIds.map((appId) => fetchAppDocById(country, appId)));
  const byId = new Map(
    docs.filter((doc): doc is AsoAppDoc => doc != null).map((doc) => [doc.appId, doc])
  );
  const unresolvedIds = uniqueIds.filter((id) => {
    const doc = byId.get(id);
    if (!doc) return true;
    return !doc.releaseDate || !doc.currentVersionReleaseDate;
  });
  const fallbackById = await fetchItunesLookupAppDocs({
    country,
    appIds: unresolvedIds,
  });
  for (const id of unresolvedIds) {
    const fallback = fallbackById.get(id);
    if (!fallback) continue;
    const merged = mergeFallbackDoc(byId.get(id), fallback);
    byId.set(id, merged);
  }
  const parsedDocs = uniqueIds.map((id) => byId.get(id)).filter((doc): doc is AsoAppDoc => doc != null);
  logger.debug("[aso-app-lookup] lookup batch summary", {
    country: country.toUpperCase(),
    requestedCount: uniqueIds.length,
    parsedCount: parsedDocs.length,
    skippedCount: uniqueIds.length - parsedDocs.length,
    unresolvedCount: unresolvedIds.length,
    fallbackResolvedCount: unresolvedIds.filter((id) => {
      const doc = byId.get(id);
      return Boolean(doc?.releaseDate && doc?.currentVersionReleaseDate);
    }).length,
  });
  return normalizeCountryOnAppDocs(
    country,
    parsedDocs
  );
}

export async function getAsoAppDocs(params: {
  country: string;
  appIds: string[];
  forceLookup?: boolean;
  repository: AsoCacheRepository;
}): Promise<AsoAppDoc[]> {
  const country = normalizeCountry(params.country);
  assertSupportedCountry(country);

  const appIds = Array.from(
    new Set(params.appIds.map((id) => id.trim()).filter(Boolean))
  );
  if (appIds.length === 0) return [];

  if (!params.repository.getAppDocs) {
    return [];
  }

  const forceLookup = params.forceLookup === true;
  const cached = forceLookup
    ? []
    : normalizeCountryOnAppDocs(
        country,
        await params.repository.getAppDocs({ country, appIds })
      );
  const resultById = new Map(cached.map((doc) => [doc.appId, doc]));
  const missingIds = forceLookup
    ? appIds
    : appIds.filter((id) => !resultById.has(id));

  if (missingIds.length > 0) {
    const fetchedRaw = await fetchAppStoreLookupAppDocs({
      country,
      appIds: missingIds,
    });
    const fetched = normalizeCountryOnAppDocs(country, fetchedRaw).map((doc) => ({
      ...doc,
      expiresAt:
        doc.releaseDate && doc.currentVersionReleaseDate
          ? doc.expiresAt ?? computeAppExpiryIsoForApp()
          : undefined,
    }));
    for (const doc of fetched) {
      resultById.set(doc.appId, doc);
    }
    if (fetched.length > 0) {
      await params.repository.upsertMany({
        country,
        items: [],
        appDocs: fetched,
      });
    }
  }
  return appIds
    .map((id) => resultById.get(id))
    .filter((doc): doc is AsoAppDoc => doc != null);
}
