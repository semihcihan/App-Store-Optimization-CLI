import type { StoredAsoApp } from "./types";
import { getDb } from "./store";

type AppDocInput = {
  appId: string;
  name: string;
  subtitle?: string;
  averageUserRating: number;
  userRatingCount: number;
  releaseDate?: string | null;
  currentVersionReleaseDate?: string | null;
  icon?: Record<string, unknown>;
  iconArtwork?: { url?: string; [key: string]: unknown };
  additionalLocalizations?: Record<string, { title: string; subtitle?: string }>;
  expiresAt?: string;
};

type AsoAppRow = {
  app_id: string;
  name: string;
  subtitle: string | null;
  average_user_rating: number;
  user_rating_count: number;
  release_date: string | null;
  current_version_release_date: string | null;
  icon_json: string | null;
  icon_artwork_json: string | null;
  additional_localizations_json: string | null;
  expires_at: string | null;
  country: string;
};

function parseAdditionalLocalizations(
  raw: string | null
): Record<string, { title: string; subtitle?: string }> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }

    const result: Record<string, { title: string; subtitle?: string }> = {};
    for (const [language, value] of Object.entries(parsed)) {
      if (!language || !value || typeof value !== "object" || Array.isArray(value)) {
        continue;
      }
      const title = typeof value.title === "string" ? value.title.trim() : "";
      const subtitle =
        typeof value.subtitle === "string" && value.subtitle.trim()
          ? value.subtitle.trim()
          : undefined;
      if (!title && !subtitle) continue;
      result[language] = {
        title,
        ...(subtitle ? { subtitle } : {}),
      };
    }

    return Object.keys(result).length > 0 ? result : undefined;
  } catch {
    return undefined;
  }
}

function toStoredApp(row: AsoAppRow): StoredAsoApp {
  let icon: Record<string, unknown> | undefined;
  let iconArtwork: { url?: string; [key: string]: unknown } | undefined;
  const additionalLocalizations = parseAdditionalLocalizations(
    row.additional_localizations_json
  );
  if (row.icon_json) {
    try {
      icon = JSON.parse(row.icon_json) as Record<string, unknown>;
    } catch {
      icon = undefined;
    }
  }
  if (row.icon_artwork_json) {
    try {
      iconArtwork = JSON.parse(row.icon_artwork_json) as {
        url?: string;
        [key: string]: unknown;
      };
    } catch {
      iconArtwork = undefined;
    }
  }
  return {
    appId: row.app_id,
    name: row.name,
    subtitle: row.subtitle ?? undefined,
    averageUserRating: row.average_user_rating,
    userRatingCount: row.user_rating_count,
    releaseDate: row.release_date,
    currentVersionReleaseDate: row.current_version_release_date,
    icon,
    iconArtwork,
    additionalLocalizations,
    expiresAt: row.expires_at ?? undefined,
    country: row.country,
  };
}

export function getCompetitorAppDocs(
  country: string,
  appIds: string[]
): StoredAsoApp[] {
  if (appIds.length === 0) return [];
  const db = getDb();
  const placeholders = appIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT app_id, name, subtitle, average_user_rating, user_rating_count,
              release_date, current_version_release_date,
              icon_json, icon_artwork_json, additional_localizations_json,
              expires_at, country
       FROM aso_apps
       WHERE country = ? AND app_id IN (${placeholders})`
    )
    .all(country, ...appIds) as AsoAppRow[];
  const byId = new Map(rows.map((row) => [row.app_id, toStoredApp(row)]));
  const ordered: StoredAsoApp[] = [];
  for (const appId of appIds) {
    const doc = byId.get(appId);
    if (doc) {
      ordered.push(doc);
    }
  }
  return ordered;
}

export function upsertCompetitorAppDocs(
  country: string,
  docs: AppDocInput[]
): void {
  if (docs.length === 0) return;
  const db = getDb();
  const appIds = Array.from(
    new Set(docs.map((doc) => doc.appId.trim()).filter(Boolean))
  );
  const existingByAppId = new Map<
    string,
    Record<string, { title: string; subtitle?: string }> | undefined
  >();
  if (appIds.length > 0) {
    const placeholders = appIds.map(() => "?").join(",");
    const existingRows = db
      .prepare(
        `SELECT app_id, additional_localizations_json
         FROM aso_apps
         WHERE country = ? AND app_id IN (${placeholders})`
      )
      .all(country, ...appIds) as Array<{
      app_id: string;
      additional_localizations_json: string | null;
    }>;
    for (const row of existingRows) {
      existingByAppId.set(
        row.app_id,
        parseAdditionalLocalizations(row.additional_localizations_json)
      );
    }
  }

  const upsertStmt = db.prepare(`
    INSERT INTO aso_apps (
      country, app_id, name, subtitle, average_user_rating,
      user_rating_count, release_date, current_version_release_date,
      icon_json, icon_artwork_json, additional_localizations_json, expires_at
    )
    VALUES (
      @country, @appId, @name, @subtitle, @averageUserRating,
      @userRatingCount, @releaseDate, @currentVersionReleaseDate,
      @iconJson, @iconArtworkJson, @additionalLocalizationsJson, @expiresAt
    )
    ON CONFLICT(country, app_id) DO UPDATE SET
      name = excluded.name,
      subtitle = excluded.subtitle,
      average_user_rating = excluded.average_user_rating,
      user_rating_count = excluded.user_rating_count,
      release_date = excluded.release_date,
      current_version_release_date = excluded.current_version_release_date,
      icon_json = excluded.icon_json,
      icon_artwork_json = excluded.icon_artwork_json,
      additional_localizations_json = excluded.additional_localizations_json,
      expires_at = excluded.expires_at
  `);

  const tx = db.transaction(() => {
    for (const doc of docs) {
      const additionalLocalizations =
        doc.additionalLocalizations ?? existingByAppId.get(doc.appId);
      const additionalLocalizationsJson =
        additionalLocalizations && Object.keys(additionalLocalizations).length > 0
          ? JSON.stringify(additionalLocalizations)
          : null;
      upsertStmt.run({
        country,
        appId: doc.appId,
        name: doc.name,
        subtitle: doc.subtitle ?? null,
        averageUserRating: doc.averageUserRating,
        userRatingCount: doc.userRatingCount,
        releaseDate: doc.releaseDate ?? null,
        currentVersionReleaseDate: doc.currentVersionReleaseDate ?? null,
        iconJson: doc.icon ? JSON.stringify(doc.icon) : null,
        iconArtworkJson: doc.iconArtwork ? JSON.stringify(doc.iconArtwork) : null,
        additionalLocalizationsJson,
        expiresAt: doc.expiresAt ?? null,
      });
    }
  });
  tx();
}
