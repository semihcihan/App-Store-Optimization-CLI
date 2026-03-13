import type { StoredAppKeyword } from "./types";
import { getDb } from "./store";
import {
  DEFAULT_ASO_COUNTRY,
  normalizeKeyword,
} from "../domain/keywords/policy";

const COUNTRY = DEFAULT_ASO_COUNTRY;

export function listByApp(appId: string, country: string = COUNTRY): StoredAppKeyword[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT app_id as appId, keyword, country, previous_position as previousPosition,
              added_at as addedAt
       FROM app_keywords
       WHERE app_id = ? AND country = ?
       ORDER BY keyword COLLATE NOCASE ASC`
    )
    .all(appId, country) as StoredAppKeyword[];
}

export function listAllAppKeywords(country: string = COUNTRY): StoredAppKeyword[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT app_id as appId, keyword, country, previous_position as previousPosition,
              added_at as addedAt
       FROM app_keywords
       WHERE country = ?`
    )
    .all(country) as StoredAppKeyword[];
}

export function createAppKeyword(
  appId: string,
  keyword: string,
  country: string = COUNTRY
): void {
  const norm = normalizeKeyword(keyword);
  if (!norm) return;
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO app_keywords (
      app_id, keyword, country, previous_position, added_at
    )
    VALUES (?, ?, ?, NULL, ?)`
  ).run(appId, norm, country, new Date().toISOString());
}

export function createAppKeywords(
  appId: string,
  keywords: string[],
  country: string = COUNTRY
): void {
  if (keywords.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO app_keywords (
      app_id, keyword, country, previous_position, added_at
    )
    VALUES (?, ?, ?, NULL, ?)`
  );
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    for (const kw of keywords) {
      const norm = normalizeKeyword(kw);
      if (!norm) continue;
      stmt.run(appId, norm, country, now);
    }
  });
  tx();
}

export function setPreviousPosition(
  keyword: string,
  country: string,
  appId: string,
  position: number
): void {
  const norm = normalizeKeyword(keyword);
  const db = getDb();
  db.prepare(
    `UPDATE app_keywords
     SET previous_position = ?
     WHERE app_id = ? AND keyword = ? AND country = ?`
  ).run(position, appId, norm, country);
}

export function getAssociationsForKeyword(
  keyword: string,
  country: string = COUNTRY
): StoredAppKeyword[] {
  const db = getDb();
  const norm = normalizeKeyword(keyword);
  return db
    .prepare(
      `SELECT app_id as appId, keyword, country, previous_position as previousPosition,
              added_at as addedAt
       FROM app_keywords
       WHERE keyword = ? AND country = ?`
    )
    .all(norm, country) as StoredAppKeyword[];
}

export function deleteAppKeywords(
  appId: string,
  keywords: string[],
  country: string = COUNTRY
): number {
  const norms = new Set(keywords.map((kw) => normalizeKeyword(kw)).filter(Boolean));
  if (norms.size === 0) return 0;
  const db = getDb();
  const values = Array.from(norms);
  const placeholders = values.map(() => "?").join(",");
  const result = db
    .prepare(
      `DELETE FROM app_keywords
       WHERE app_id = ? AND country = ? AND keyword IN (${placeholders})`
    )
    .run(appId, country, ...values);
  return result.changes;
}

export function getAppLastKeywordAddedAtMap(
  country: string = COUNTRY
): Map<string, string> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT app_id as appId, MAX(added_at) as addedAt
       FROM app_keywords
       WHERE country = ? AND added_at IS NOT NULL
       GROUP BY app_id`
    )
    .all(country) as Array<{ appId: string; addedAt: string | null }>;
  const out = new Map<string, string>();
  for (const row of rows) {
    if (row.addedAt) {
      out.set(row.appId, row.addedAt);
    }
  }
  return out;
}
