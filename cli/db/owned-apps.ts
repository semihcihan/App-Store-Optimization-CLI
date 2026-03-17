import type { OwnedAppKind, StoredOwnedApp } from "./types";
import { getDb } from "./store";

type OwnedAppRow = {
  id: string;
  kind: string;
  name: string;
  average_user_rating: number | null;
  user_rating_count: number | null;
  previous_average_user_rating: number | null;
  previous_user_rating_count: number | null;
  icon_json: string | null;
  expires_at: string | null;
  last_fetched_at: string | null;
  previous_fetched_at: string | null;
};

function parseJsonObject(
  value: string | null
): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {}
  return undefined;
}

function toOwnedAppKind(value: string): OwnedAppKind {
  return value === "research" ? "research" : "owned";
}

function toStoredOwnedApp(row: OwnedAppRow): StoredOwnedApp {
  return {
    id: row.id,
    kind: toOwnedAppKind(row.kind),
    name: row.name,
    averageUserRating: row.average_user_rating,
    userRatingCount: row.user_rating_count,
    previousAverageUserRating: row.previous_average_user_rating,
    previousUserRatingCount: row.previous_user_rating_count,
    icon: parseJsonObject(row.icon_json),
    expiresAt: row.expires_at,
    lastFetchedAt: row.last_fetched_at,
    previousFetchedAt: row.previous_fetched_at,
  };
}

export function listOwnedApps(): StoredOwnedApp[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, kind, name, average_user_rating, user_rating_count,
              previous_average_user_rating, previous_user_rating_count,
              icon_json,
              expires_at, last_fetched_at, previous_fetched_at
       FROM owned_apps
       ORDER BY name COLLATE NOCASE ASC`
    )
    .all() as OwnedAppRow[];
  return rows.map(toStoredOwnedApp);
}

export function listOwnedAppIdsByKind(kind: OwnedAppKind): string[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id
       FROM owned_apps
       WHERE kind = ?`
    )
    .all(kind) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

export function getOwnedAppById(id: string): StoredOwnedApp | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, kind, name, average_user_rating, user_rating_count,
              previous_average_user_rating, previous_user_rating_count,
              icon_json,
              expires_at, last_fetched_at, previous_fetched_at
       FROM owned_apps
       WHERE id = ?`
    )
    .get(id) as OwnedAppRow | undefined;
  return row ? toStoredOwnedApp(row) : null;
}

export function upsertOwnedApps(
  apps: Array<{ id: string; kind: OwnedAppKind; name: string }>
): void {
  if (apps.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO owned_apps (id, kind, name)
     VALUES (@id, @kind, @name)
     ON CONFLICT(id) DO UPDATE SET
       kind = excluded.kind,
       name = excluded.name`
  );

  const tx = db.transaction(() => {
    for (const app of apps) {
      stmt.run({
        id: app.id,
        kind: app.kind,
        name: app.name,
      });
    }
  });
  tx();
}

export function upsertOwnedAppSnapshots(
  apps: Array<{
    id: string;
    name?: string;
    averageUserRating?: number | null;
    userRatingCount?: number | null;
    icon?: Record<string, unknown>;
    expiresAt?: string | null;
    fetchedAt?: string;
  }>
): void {
  if (apps.length === 0) return;
  const db = getDb();
  const selectStmt = db.prepare(
    `SELECT id, kind, name, average_user_rating, user_rating_count,
            previous_average_user_rating, previous_user_rating_count,
            icon_json,
            expires_at, last_fetched_at, previous_fetched_at
     FROM owned_apps
     WHERE id = ?`
  );
  const upsertStmt = db.prepare(
    `INSERT INTO owned_apps (
      id, kind, name,
      average_user_rating, user_rating_count,
      previous_average_user_rating, previous_user_rating_count,
      icon_json,
      expires_at, last_fetched_at, previous_fetched_at
    )
    VALUES (
      @id, @kind, @name,
      @averageUserRating, @userRatingCount,
      @previousAverageUserRating, @previousUserRatingCount,
      @iconJson,
      @expiresAt, @lastFetchedAt, @previousFetchedAt
    )
    ON CONFLICT(id) DO UPDATE SET
      kind = excluded.kind,
      name = excluded.name,
      average_user_rating = excluded.average_user_rating,
      user_rating_count = excluded.user_rating_count,
      previous_average_user_rating = excluded.previous_average_user_rating,
      previous_user_rating_count = excluded.previous_user_rating_count,
      icon_json = excluded.icon_json,
      expires_at = excluded.expires_at,
      last_fetched_at = excluded.last_fetched_at,
      previous_fetched_at = excluded.previous_fetched_at`
  );

  const tx = db.transaction(() => {
    for (const app of apps) {
      const existing = selectStmt.get(app.id) as OwnedAppRow | undefined;
      const now = app.fetchedAt ?? new Date().toISOString();

      const nextAverage =
        app.averageUserRating != null
          ? app.averageUserRating
          : existing?.average_user_rating ?? null;
      const nextCount =
        app.userRatingCount != null
          ? app.userRatingCount
          : existing?.user_rating_count ?? null;

      const previousAverage =
        app.averageUserRating != null && existing?.average_user_rating != null
          ? existing.average_user_rating
          : existing?.previous_average_user_rating ?? null;
      const previousCount =
        app.userRatingCount != null && existing?.user_rating_count != null
          ? existing.user_rating_count
          : existing?.previous_user_rating_count ?? null;

      const kind = toOwnedAppKind(existing?.kind ?? "owned");
      const nextName =
        app.name?.trim() || existing?.name?.trim() || app.id;

      const icon =
        app.icon ?? parseJsonObject(existing?.icon_json ?? null) ?? undefined;

      const lastFetchedAt = now;
      const previousFetchedAt =
        existing?.last_fetched_at ?? existing?.previous_fetched_at ?? null;

      upsertStmt.run({
        id: app.id,
        kind,
        name: nextName,
        averageUserRating: nextAverage,
        userRatingCount: nextCount,
        previousAverageUserRating: previousAverage,
        previousUserRatingCount: previousCount,
        iconJson: icon ? JSON.stringify(icon) : null,
        expiresAt: app.expiresAt ?? existing?.expires_at ?? null,
        lastFetchedAt,
        previousFetchedAt,
      });
    }
  });

  tx();
}
