import { getDb } from "./store";

type MetadataRow = {
  value: string;
};

export function getMetadataValue(key: string): string | null {
  const db = getDb();
  const row = db
    .prepare("SELECT value FROM metadata WHERE key = ?")
    .get(key) as MetadataRow | undefined;
  return row?.value ?? null;
}

export function setMetadataValue(key: string, value: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO metadata (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at`
  ).run(key, value, new Date().toISOString());
}
