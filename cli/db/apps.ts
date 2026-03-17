import type { StoredApp } from "./types";
import {
  getOwnedAppById,
  upsertOwnedApps,
  listOwnedApps,
} from "./owned-apps";
import { isResearchAppId } from "../shared/aso-research";

export function listApps(): StoredApp[] {
  return listOwnedApps().map((app) => ({ id: app.id, name: app.name }));
}

export function upsertApps(apps: Array<{ id: string; name: string }>): void {
  if (apps.length === 0) return;
  upsertOwnedApps(
    apps.map((app) => ({
      id: app.id,
      name: app.name,
      kind: isResearchAppId(app.id) ? "research" : "owned",
    }))
  );
}

export function getAppById(id: string): StoredApp | null {
  const app = getOwnedAppById(id);
  if (!app) return null;
  return {
    id: app.id,
    name: app.name,
  };
}
