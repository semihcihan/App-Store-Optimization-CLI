import { computeAppExpiryIsoForApp } from "./aso-keyword-utils";
import type { AsoCacheRepository, AsoAppDoc } from "./aso-types";
import { asoAppleGet } from "./aso-apple-client";

type AppStoreProductVersionHistoryItem = {
  releaseDate?: string;
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
  const subtitle =
    typeof product.subtitle === "string" && product.subtitle.trim() !== ""
      ? product.subtitle
      : undefined;

  return {
    appId,
    country,
    name: typeof product.name === "string" ? product.name : "",
    subtitle,
    averageUserRating: readNumber(userRating?.value),
    userRatingCount: readNumber(userRating?.ratingCount),
    releaseDate: typeof product.releaseDate === "string" ? product.releaseDate : null,
    currentVersionReleaseDate,
    iconArtwork:
      typeof artwork?.url === "string"
        ? { url: artwork.url }
        : typeof iconArtwork?.url === "string"
          ? { url: iconArtwork.url }
          : undefined,
  };
}

async function fetchAppDocById(country: string, appId: string): Promise<AsoAppDoc | null> {
  const response = await asoAppleGet(
    "https://apps.apple.com/app/id" + encodeURIComponent(appId),
    {
      operation: "appstore.app-lookup",
      headers: {
        "X-Apple-Store-Front": getStoreFrontHeader(country),
        Host: "apps.apple.com",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1.1 Safari/605.1.15",
        Accept: "application/json,text/plain,*/*",
      },
      timeout: 30000,
    }
  );

  const payload = parseAppStorePayload(response.data);
  if (!payload) return null;
  return parseAppDocFromPayload(payload, appId, country.toUpperCase());
}

function normalizeCountryOnAppDocs(country: string, docs: AsoAppDoc[]): AsoAppDoc[] {
  const normalizedCountry = country.toUpperCase();
  return docs.map((doc) => ({
    ...doc,
    country: normalizedCountry,
  }));
}

export async function fetchAppStoreLookupAppDocs(params: {
  country: string;
  appIds: string[];
}): Promise<AsoAppDoc[]> {
  const country = params.country.toUpperCase();
  if (params.appIds.length === 0) return [];
  const uniqueIds = Array.from(new Set(params.appIds.map((id) => id.trim()).filter(Boolean)));
  const docs = await Promise.all(uniqueIds.map((appId) => fetchAppDocById(country, appId)));
  const byId = new Map(docs.filter((doc): doc is AsoAppDoc => doc != null).map((doc) => [doc.appId, doc]));
  return normalizeCountryOnAppDocs(
    country,
    uniqueIds
    .map((id) => byId.get(id))
    .filter((doc): doc is AsoAppDoc => doc != null)
  );
}

export async function getAsoAppDocs(params: {
  country: string;
  appIds: string[];
  repository: AsoCacheRepository;
}): Promise<AsoAppDoc[]> {
  const country = params.country.toUpperCase();
  if (country !== "US") {
    throw new Error("Only US is supported for now");
  }

  const appIds = Array.from(
    new Set(params.appIds.map((id) => id.trim()).filter(Boolean))
  );
  if (appIds.length === 0) return [];

  if (!params.repository.getAppDocs) {
    return [];
  }

  const cached = normalizeCountryOnAppDocs(
    country,
    await params.repository.getAppDocs({ country, appIds })
  );
  const resultById = new Map(cached.map((doc) => [doc.appId, doc]));
  const missingIds = appIds.filter((id) => !resultById.has(id));

  if (missingIds.length > 0) {
    const fetchedRaw = await fetchAppStoreLookupAppDocs({
      country,
      appIds: missingIds,
    });
    const fetched = normalizeCountryOnAppDocs(country, fetchedRaw).map((doc) => ({
      ...doc,
      expiresAt: doc.expiresAt ?? computeAppExpiryIsoForApp(),
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
