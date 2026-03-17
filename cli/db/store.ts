import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import Database from "better-sqlite3";

const DB_DIR = path.join(os.homedir(), ".aso");
const DEFAULT_DB_FILE = path.join(DB_DIR, "aso-db.sqlite");
let db: Database.Database | null = null;

function resolveDbPath(): string {
  const fromEnv = process.env.ASO_DB_PATH;
  if (fromEnv && fromEnv.trim() !== "") {
    return path.resolve(fromEnv);
  }
  return DEFAULT_DB_FILE;
}

function initializeDatabase(database: Database.Database): void {
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.exec(`
    CREATE TABLE IF NOT EXISTS owned_apps (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('owned', 'research')),
      name TEXT NOT NULL,
      average_user_rating REAL,
      user_rating_count INTEGER,
      previous_average_user_rating REAL,
      previous_user_rating_count INTEGER,
      icon_json TEXT,
      expires_at TEXT,
      last_fetched_at TEXT,
      previous_fetched_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_owned_apps_kind
      ON owned_apps(kind);

    CREATE TABLE IF NOT EXISTS aso_keywords (
      country TEXT NOT NULL,
      normalized_keyword TEXT NOT NULL,
      keyword TEXT NOT NULL,
      popularity REAL NOT NULL,
      difficulty_score REAL,
      min_difficulty_score REAL,
      app_count INTEGER,
      keyword_included INTEGER,
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
      icon_json TEXT,
      icon_artwork_json TEXT,
      expires_at TEXT,
      PRIMARY KEY (country, app_id)
    );

    CREATE TABLE IF NOT EXISTS app_keywords (
      app_id TEXT NOT NULL,
      keyword TEXT NOT NULL,
      country TEXT NOT NULL,
      previous_position INTEGER,
      added_at TEXT,
      PRIMARY KEY (app_id, keyword, country)
    );
    CREATE INDEX IF NOT EXISTS idx_app_keywords_country_app
      ON app_keywords(country, app_id);
    CREATE INDEX IF NOT EXISTS idx_app_keywords_country_keyword
      ON app_keywords(country, keyword);

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
}

export function getDbPath(): string {
  return resolveDbPath();
}

export function getDb(): Database.Database {
  if (db) {
    return db;
  }
  const dbPath = resolveDbPath();
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
