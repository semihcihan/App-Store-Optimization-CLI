import type { StoredApp } from "./types";
import { getDb } from "./store";

export function listApps(): StoredApp[] {
  const db = getDb();
  return db
    .prepare("SELECT id, name FROM apps ORDER BY name COLLATE NOCASE ASC")
    .all() as StoredApp[];
}

export function upsertApps(apps: Array<{ id: string; name: string }>): void {
  if (apps.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO apps (id, name)
    VALUES (@id, @name)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name
  `);
  const tx = db.transaction((rows: Array<{ id: string; name: string }>) => {
    for (const app of rows) {
      stmt.run({ id: app.id, name: app.name });
    }
  });
  tx(apps);
}

export function getAppById(id: string): StoredApp | null {
  const db = getDb();
  const row = db
    .prepare("SELECT id, name FROM apps WHERE id = ?")
    .get(id) as StoredApp | undefined;
  return row ?? null;
}
