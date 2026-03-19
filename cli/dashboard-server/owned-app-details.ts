import { normalizeCountry } from "../domain/keywords/policy";
import { fetchAppStoreLocalizedAppData } from "../services/cache-api/services/aso-app-store-details";
import { computeAppExpiryIsoForApp } from "../services/cache-api/services/aso-keyword-utils";
import { getStorefrontDefaultLanguage } from "../shared/aso-storefront-localizations";

export type OwnedAppSnapshot = {
  id: string;
  name: string;
  averageUserRating: number | null;
  userRatingCount: number | null;
  icon?: Record<string, unknown>;
  expiresAt: string;
};

export async function fetchOwnedAppSnapshotsFromApi(
  country: string,
  appIds: string[],
  language?: string
): Promise<OwnedAppSnapshot[]> {
  const normalizedCountry = normalizeCountry(country);
  const resolvedLanguage =
    language == null ? getStorefrontDefaultLanguage(normalizedCountry) : language;
  const uniqueIds = Array.from(new Set(appIds.map((id) => id.trim()).filter(Boolean)));
  if (uniqueIds.length === 0) return [];

  const settled = await Promise.all(
    uniqueIds.map(async (appId) => {
      try {
        const localized = await fetchAppStoreLocalizedAppData(
          appId,
          normalizedCountry,
          resolvedLanguage
        );
        if (!localized) return null;
        return {
          id: appId,
          name: localized.title || appId,
          averageUserRating: localized.ratingAverage,
          userRatingCount: localized.totalNumberOfRatings,
          ...(localized.icon ? { icon: localized.icon } : {}),
          expiresAt: computeAppExpiryIsoForApp(),
        } satisfies OwnedAppSnapshot;
      } catch {
        return null;
      }
    })
  );

  return settled.filter((item): item is OwnedAppSnapshot => item != null);
}
