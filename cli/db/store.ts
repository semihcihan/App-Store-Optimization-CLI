import * as fs from "fs";
import * as path from "path";
import Database from "better-sqlite3";
import { ASO_ENV } from "../shared/aso-env";
let db: Database.Database | null = null;

function ensureAppKeywordFavoriteColumn(database: Database.Database): void {
  const columns = database
    .prepare(`PRAGMA table_info(app_keywords)`)
    .all() as Array<{ name?: string }>;
  const hasFavoriteColumn = columns.some((column) => column.name === "is_favorite");
  if (!hasFavoriteColumn) {
    database.exec(
      `ALTER TABLE app_keywords
       ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0`
    );
  }
}

function ensureAppKeywordNotesColumn(database: Database.Database): void {
  const columns = database
    .prepare(`PRAGMA table_info(app_keywords)`)
    .all() as Array<{ name?: string }>;
  if (!columns.some((column) => column.name === "notes")) {
    database.exec(`ALTER TABLE app_keywords ADD COLUMN notes TEXT NOT NULL DEFAULT ''`);
  }
}

function initializeDatabase(database: Database.Database): void {
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.exec(`
    CREATE TABLE IF NOT EXISTS owned_apps (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('owned', 'research')),
      name TEXT NOT NULL,
      icon_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_owned_apps_kind
      ON owned_apps(kind);

    CREATE TABLE IF NOT EXISTS owned_app_country_ratings (
      app_id TEXT NOT NULL,
      country TEXT NOT NULL,
      average_user_rating REAL,
      user_rating_count INTEGER,
      previous_average_user_rating REAL,
      previous_user_rating_count INTEGER,
      expires_at TEXT,
      last_fetched_at TEXT,
      PRIMARY KEY (app_id, country),
      FOREIGN KEY (app_id) REFERENCES owned_apps(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_owned_app_country_ratings_country
      ON owned_app_country_ratings(country);
    CREATE INDEX IF NOT EXISTS idx_owned_app_country_ratings_app
      ON owned_app_country_ratings(app_id);

    CREATE TABLE IF NOT EXISTS aso_keywords (
      country TEXT NOT NULL,
      normalized_keyword TEXT NOT NULL,
      keyword TEXT NOT NULL,
      popularity REAL NOT NULL,
      difficulty_score REAL,
      min_difficulty_score REAL,
      is_brand_keyword INTEGER,
      app_count INTEGER,
      keyword_match TEXT CHECK (keyword_match IN (
        'none',
        'titleExactPhrase',
        'titleAllWords',
        'subtitleExactPhrase',
        'combinedPhrase',
        'subtitleAllWords'
      )),
      ordered_app_ids TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      order_expires_at TEXT NOT NULL,
      popularity_expires_at TEXT NOT NULL,
      PRIMARY KEY (country, normalized_keyword)
    );
    CREATE INDEX IF NOT EXISTS idx_aso_keywords_country_order_expires
      ON aso_keywords(country, order_expires_at);

    CREATE TABLE IF NOT EXISTS aso_apps (
      country TEXT NOT NULL,
      app_id TEXT NOT NULL,
      name TEXT NOT NULL,
      subtitle TEXT,
      average_user_rating REAL NOT NULL,
      user_rating_count INTEGER NOT NULL,
      release_date TEXT,
      current_version_release_date TEXT,
      publisher_name TEXT,
      icon_json TEXT,
      icon_artwork_json TEXT,
      additional_localizations_json TEXT,
      expires_at TEXT,
      PRIMARY KEY (country, app_id)
    );

    CREATE TABLE IF NOT EXISTS sensor_tower_app_metrics (
      app_id TEXT PRIMARY KEY,
      last_month_downloads TEXT NOT NULL,
      last_month_revenue TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_keywords (
      app_id TEXT NOT NULL,
      keyword TEXT NOT NULL,
      country TEXT NOT NULL,
      is_favorite INTEGER NOT NULL DEFAULT 0,
      notes TEXT NOT NULL DEFAULT '',
      previous_position INTEGER,
      added_at TEXT,
      PRIMARY KEY (app_id, keyword, country)
    );
    CREATE INDEX IF NOT EXISTS idx_app_keywords_country_app
      ON app_keywords(country, app_id);
    CREATE INDEX IF NOT EXISTS idx_app_keywords_country_keyword
      ON app_keywords(country, keyword);
    CREATE TABLE IF NOT EXISTS app_keyword_position_history (
      app_id TEXT NOT NULL,
      keyword TEXT NOT NULL,
      country TEXT NOT NULL,
      position INTEGER,
      captured_at TEXT NOT NULL,
      PRIMARY KEY (app_id, keyword, country, captured_at)
    );
    CREATE INDEX IF NOT EXISTS idx_app_keyword_position_history_lookup
      ON app_keyword_position_history(country, app_id, keyword, captured_at);

    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS aso_keyword_failures (
      country TEXT NOT NULL,
      normalized_keyword TEXT NOT NULL,
      keyword TEXT NOT NULL,
      status TEXT NOT NULL,
      stage TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      message TEXT NOT NULL,
      status_code INTEGER,
      retryable INTEGER NOT NULL,
      attempts INTEGER NOT NULL,
      request_id TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (country, normalized_keyword)
    );
    CREATE INDEX IF NOT EXISTS idx_aso_keyword_failures_country_stage
      ON aso_keyword_failures(country, stage);
  `);
  ensureAppKeywordFavoriteColumn(database);
  ensureAppKeywordNotesColumn(database);
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_app_keywords_country_app_favorite
      ON app_keywords(country, app_id, is_favorite);
  `);
}

export function getDbPath(): string {
  return ASO_ENV.dbPath;
}

export function getDb(): Database.Database {
  if (db) {
    return db;
  }
  const dbPath = ASO_ENV.dbPath;
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
  db = new Database(dbPath);
  initializeDatabase(db);
  return db;
}

export function closeDbForTests(): void {
  if (!db) return;
  db.close();
  db = null;
}
