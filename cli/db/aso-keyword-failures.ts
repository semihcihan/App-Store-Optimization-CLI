import type { StoredAsoKeywordFailure } from "./types";
import { getDb } from "./store";

type KeywordFailureRow = {
  country: string;
  normalized_keyword: string;
  keyword: string;
  status: string;
  stage: string;
  reason_code: string;
  message: string;
  status_code: number | null;
  retryable: number;
  attempts: number;
  request_id: string | null;
  updated_at: string;
};

function normalizeKeyword(keyword: string): string {
  return keyword.trim().toLowerCase();
}

function toStoredKeywordFailure(row: KeywordFailureRow): StoredAsoKeywordFailure {
  return {
    country: row.country,
    normalizedKeyword: row.normalized_keyword,
    keyword: row.keyword,
    status: "failed",
    stage:
      row.stage === "popularity" || row.stage === "enrichment"
        ? row.stage
        : "enrichment",
    reasonCode: row.reason_code,
    message: row.message,
    statusCode: row.status_code,
    retryable: row.retryable === 1,
    attempts: row.attempts,
    requestId: row.request_id,
    updatedAt: row.updated_at,
  };
}

export function listKeywordFailures(country: string): StoredAsoKeywordFailure[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT country, normalized_keyword, keyword, status, stage, reason_code,
              message, status_code, retryable, attempts, request_id, updated_at
       FROM aso_keyword_failures
       WHERE country = ?
       ORDER BY keyword COLLATE NOCASE ASC`
    )
    .all(country) as KeywordFailureRow[];
  return rows.map(toStoredKeywordFailure);
}

export function getKeywordFailures(
  country: string,
  keywords: string[]
): StoredAsoKeywordFailure[] {
  const normalized = Array.from(
    new Set(keywords.map((keyword) => normalizeKeyword(keyword)).filter(Boolean))
  );
  if (normalized.length === 0) return [];
  const placeholders = normalized.map(() => "?").join(", ");
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT country, normalized_keyword, keyword, status, stage, reason_code,
              message, status_code, retryable, attempts, request_id, updated_at
       FROM aso_keyword_failures
       WHERE country = ? AND normalized_keyword IN (${placeholders})
       ORDER BY keyword COLLATE NOCASE ASC`
    )
    .all(country, ...normalized) as KeywordFailureRow[];
  return rows.map(toStoredKeywordFailure);
}

export function listKeywordFailuresForApp(
  appId: string,
  country: string
): StoredAsoKeywordFailure[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT f.country, f.normalized_keyword, f.keyword, f.status, f.stage, f.reason_code,
              f.message, f.status_code, f.retryable, f.attempts, f.request_id, f.updated_at
       FROM aso_keyword_failures f
       INNER JOIN app_keywords ak
         ON ak.country = f.country
        AND ak.keyword = f.normalized_keyword
       WHERE ak.app_id = ? AND f.country = ?
       ORDER BY f.keyword COLLATE NOCASE ASC`
    )
    .all(appId, country) as KeywordFailureRow[];
  return rows.map(toStoredKeywordFailure);
}

export function upsertKeywordFailures(
  country: string,
  failures: Array<{
    keyword: string;
    stage: "popularity" | "enrichment";
    reasonCode: string;
    message: string;
    statusCode?: number;
    retryable: boolean;
    attempts: number;
    requestId?: string;
  }>
): void {
  if (failures.length === 0) return;
  const db = getDb();
  const now = new Date().toISOString();
  const upsertStmt = db.prepare(
    `INSERT INTO aso_keyword_failures (
      country, normalized_keyword, keyword, status, stage, reason_code, message,
      status_code, retryable, attempts, request_id, updated_at
    ) VALUES (
      @country, @normalizedKeyword, @keyword, 'failed', @stage, @reasonCode, @message,
      @statusCode, @retryable, @attempts, @requestId, @updatedAt
    )
    ON CONFLICT(country, normalized_keyword) DO UPDATE SET
      keyword = excluded.keyword,
      status = 'failed',
      stage = excluded.stage,
      reason_code = excluded.reason_code,
      message = excluded.message,
      status_code = excluded.status_code,
      retryable = excluded.retryable,
      attempts = excluded.attempts,
      request_id = excluded.request_id,
      updated_at = excluded.updated_at`
  );
  const tx = db.transaction(() => {
    for (const failure of failures) {
      const normalizedKeyword = normalizeKeyword(failure.keyword);
      if (!normalizedKeyword) continue;
      upsertStmt.run({
        country,
        normalizedKeyword,
        keyword: normalizedKeyword,
        stage: failure.stage,
        reasonCode: failure.reasonCode,
        message: failure.message,
        statusCode:
          typeof failure.statusCode === "number" ? failure.statusCode : null,
        retryable: failure.retryable ? 1 : 0,
        attempts: Math.max(1, Math.floor(failure.attempts)),
        requestId: failure.requestId ?? null,
        updatedAt: now,
      });
    }
  });
  tx();
}

export function deleteKeywordFailures(
  country: string,
  keywords: string[]
): number {
  const normalized = Array.from(
    new Set(keywords.map((keyword) => normalizeKeyword(keyword)).filter(Boolean))
  );
  if (normalized.length === 0) return 0;
  const placeholders = normalized.map(() => "?").join(", ");
  const db = getDb();
  const result = db
    .prepare(
      `DELETE FROM aso_keyword_failures
       WHERE country = ? AND normalized_keyword IN (${placeholders})`
    )
    .run(country, ...normalized);
  return result.changes;
}
