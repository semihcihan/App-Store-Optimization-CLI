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
  expires_at: string | null;
  country: string;
};

function toStoredApp(row: AsoAppRow): StoredAsoApp {
  let icon: Record<string, unknown> | undefined;
  let iconArtwork: { url?: string; [key: string]: unknown } | undefined;
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
              icon_json, icon_artwork_json, expires_at, country
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
  const upsertStmt = db.prepare(`
    INSERT INTO aso_apps (
      country, app_id, name, subtitle, average_user_rating,
      user_rating_count, release_date, current_version_release_date,
      icon_json, icon_artwork_json, expires_at
    )
    VALUES (
      @country, @appId, @name, @subtitle, @averageUserRating,
      @userRatingCount, @releaseDate, @currentVersionReleaseDate,
      @iconJson, @iconArtworkJson, @expiresAt
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
      expires_at = excluded.expires_at
  `);

  const tx = db.transaction(() => {
    for (const doc of docs) {
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
        expiresAt: doc.expiresAt ?? null,
      });
    }
  });
  tx();
}
