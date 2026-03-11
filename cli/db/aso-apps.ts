import type { StoredAsoApp } from "./types";
import { getDb } from "./store";

type AppDocInput = {
  appId: string;
  name: string;
  subtitle?: string;
  averageUserRating: number;
  userRatingCount: number;
  previousAverageUserRating?: number | null;
  previousUserRatingCount?: number | null;
  releaseDate?: string | null;
  currentVersionReleaseDate?: string | null;
  icon?: Record<string, unknown>;
  iconArtwork?: { url?: string; [key: string]: unknown };
  expiresAt?: string;
  lastFetchedAt?: string | null;
  previousFetchedAt?: string | null;
};

type AppBucket = "owned" | "competitor";

type AsoAppRow = {
  app_id: string;
  name: string;
  subtitle: string | null;
  average_user_rating: number;
  user_rating_count: number;
  previous_average_user_rating: number | null;
  previous_user_rating_count: number | null;
  release_date: string | null;
  current_version_release_date: string | null;
  icon_json: string | null;
  icon_artwork_json: string | null;
  expires_at: string | null;
  last_fetched_at: string | null;
  previous_fetched_at: string | null;
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
    previousAverageUserRating: row.previous_average_user_rating,
    previousUserRatingCount: row.previous_user_rating_count,
    releaseDate: row.release_date,
    currentVersionReleaseDate: row.current_version_release_date,
    icon,
    iconArtwork,
    expiresAt: row.expires_at ?? undefined,
    lastFetchedAt: row.last_fetched_at,
    previousFetchedAt: row.previous_fetched_at,
    country: row.country,
  };
}

function getDocsFromBucket(
  bucket: AppBucket,
  country: string,
  appIds: string[]
): StoredAsoApp[] {
  if (appIds.length === 0) return [];
  const db = getDb();
  const placeholders = appIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT app_id, name, subtitle, average_user_rating, user_rating_count,
              previous_average_user_rating, previous_user_rating_count, release_date,
              current_version_release_date, icon_json, icon_artwork_json,
              expires_at, last_fetched_at, previous_fetched_at, country
       FROM aso_apps
       WHERE bucket = ? AND country = ? AND app_id IN (${placeholders})`
    )
    .all(bucket, country, ...appIds) as AsoAppRow[];
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

function upsertDocsToBucket(
  bucket: AppBucket,
  country: string,
  docs: AppDocInput[]
): void {
  if (docs.length === 0) return;
  const db = getDb();
  const upsertStmt =
    bucket === "owned"
      ? db.prepare(`
          INSERT INTO aso_apps (
            bucket, country, app_id, name, subtitle, average_user_rating,
            user_rating_count, previous_average_user_rating, previous_user_rating_count,
            release_date, current_version_release_date, icon_json, icon_artwork_json, expires_at,
            last_fetched_at, previous_fetched_at
          )
          VALUES (
            @bucket, @country, @appId, @name, @subtitle, @averageUserRating,
            @userRatingCount, @previousAverageUserRating, @previousUserRatingCount,
            @releaseDate, @currentVersionReleaseDate, @iconJson, @iconArtworkJson, @expiresAt,
            @lastFetchedAt, @previousFetchedAt
          )
          ON CONFLICT(bucket, country, app_id) DO UPDATE SET
            name = excluded.name,
            subtitle = excluded.subtitle,
            previous_average_user_rating = aso_apps.average_user_rating,
            previous_user_rating_count = aso_apps.user_rating_count,
            average_user_rating = excluded.average_user_rating,
            user_rating_count = excluded.user_rating_count,
            release_date = excluded.release_date,
            current_version_release_date = excluded.current_version_release_date,
            icon_json = excluded.icon_json,
            icon_artwork_json = excluded.icon_artwork_json,
            expires_at = excluded.expires_at,
            previous_fetched_at = COALESCE(aso_apps.last_fetched_at, aso_apps.previous_fetched_at),
            last_fetched_at = excluded.last_fetched_at
        `)
      : db.prepare(`
          INSERT INTO aso_apps (
            bucket, country, app_id, name, subtitle, average_user_rating,
            user_rating_count, previous_average_user_rating, previous_user_rating_count,
            release_date, current_version_release_date, icon_json, icon_artwork_json, expires_at,
            last_fetched_at, previous_fetched_at
          )
          VALUES (
            @bucket, @country, @appId, @name, @subtitle, @averageUserRating,
            @userRatingCount, @previousAverageUserRating, @previousUserRatingCount,
            @releaseDate, @currentVersionReleaseDate, @iconJson, @iconArtworkJson, @expiresAt,
            @lastFetchedAt, @previousFetchedAt
          )
          ON CONFLICT(bucket, country, app_id) DO UPDATE SET
            name = excluded.name,
            subtitle = excluded.subtitle,
            average_user_rating = excluded.average_user_rating,
            user_rating_count = excluded.user_rating_count,
            previous_average_user_rating = excluded.previous_average_user_rating,
            previous_user_rating_count = excluded.previous_user_rating_count,
            release_date = excluded.release_date,
            current_version_release_date = excluded.current_version_release_date,
            icon_json = excluded.icon_json,
            icon_artwork_json = excluded.icon_artwork_json,
            expires_at = excluded.expires_at,
            last_fetched_at = excluded.last_fetched_at,
            previous_fetched_at = excluded.previous_fetched_at
        `);
  const fetchedAt = new Date().toISOString();
  const tx = db.transaction(() => {
    for (const doc of docs) {
      upsertStmt.run({
        bucket,
        country,
        appId: doc.appId,
        name: doc.name,
        subtitle: doc.subtitle ?? null,
        averageUserRating: doc.averageUserRating,
        userRatingCount: doc.userRatingCount,
        previousAverageUserRating: doc.previousAverageUserRating ?? null,
        previousUserRatingCount: doc.previousUserRatingCount ?? null,
        releaseDate: doc.releaseDate ?? null,
        currentVersionReleaseDate: doc.currentVersionReleaseDate ?? null,
        iconJson: doc.icon ? JSON.stringify(doc.icon) : null,
        iconArtworkJson: doc.iconArtwork ? JSON.stringify(doc.iconArtwork) : null,
        expiresAt: doc.expiresAt ?? null,
        lastFetchedAt: doc.lastFetchedAt ?? fetchedAt,
        previousFetchedAt: doc.previousFetchedAt ?? null,
      });
    }
  });
  tx();
}

export function getOwnedAppDocs(country: string, appIds: string[]): StoredAsoApp[] {
  return getDocsFromBucket("owned", country, appIds);
}

export function upsertOwnedAppDocs(country: string, docs: AppDocInput[]): void {
  upsertDocsToBucket("owned", country, docs);
}

export function getCompetitorAppDocs(country: string, appIds: string[]): StoredAsoApp[] {
  return getDocsFromBucket("competitor", country, appIds);
}

export function upsertCompetitorAppDocs(country: string, docs: AppDocInput[]): void {
  upsertDocsToBucket("competitor", country, docs);
}
