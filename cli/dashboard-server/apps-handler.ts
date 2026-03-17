import * as http from "http";
import {
  getOwnedAppById,
  upsertOwnedApps,
  upsertOwnedAppSnapshots,
} from "../db/owned-apps";
import {
  DEFAULT_RESEARCH_APP_ID,
  DEFAULT_RESEARCH_APP_NAME,
} from "../shared/aso-research";
import type { OwnedAppSnapshot } from "./owned-app-details";

type ManualAppAddRequest =
  | {
      type: "app";
      appId?: string;
    }
  | {
      type: "research";
      name?: string;
    };

type CreateAppsHandlersDeps = {
  parseJsonBody: <T>(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ) => Promise<T | null>;
  sendJson: (res: http.ServerResponse, status: number, data: unknown) => void;
  sendApiError: (
    res: http.ServerResponse,
    status: number,
    errorCode: string,
    message: string
  ) => void;
  reportDashboardError: (
    error: unknown,
    metadata: Record<string, unknown>
  ) => void;
  fetchOwnedAppSnapshotsFromApi: (
    country: string,
    appIds: string[]
  ) => Promise<OwnedAppSnapshot[]>;
  hydrationCountry: string;
};

function normalizeAppId(input: string | undefined): string {
  return (input ?? "").trim();
}

function isNumericAppId(appId: string): boolean {
  return /^\d+$/.test(appId);
}

function slugifyResearchName(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
  return base || "research";
}

function nextResearchAppId(slug: string): string {
  const baseId = `research:${slug}`;
  if (!getOwnedAppById(baseId)) {
    return baseId;
  }
  let suffix = 2;
  while (true) {
    const candidate = `${baseId}-${suffix}`;
    if (!getOwnedAppById(candidate)) {
      return candidate;
    }
    suffix += 1;
  }
}

export function ensureDefaultResearchAppExists(): void {
  if (getOwnedAppById(DEFAULT_RESEARCH_APP_ID)) {
    return;
  }
  upsertOwnedApps([
    {
      id: DEFAULT_RESEARCH_APP_ID,
      kind: "research",
      name: DEFAULT_RESEARCH_APP_NAME,
    },
  ]);
}

export function createAppsHandlers(deps: CreateAppsHandlersDeps) {
  async function handleApiAppsPost(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const body = await deps.parseJsonBody<ManualAppAddRequest>(req, res);
    if (!body) {
      return;
    }

    if (!body || (body.type !== "app" && body.type !== "research")) {
      deps.sendApiError(
        res,
        400,
        "INVALID_REQUEST",
        "Invalid request. type must be 'app' or 'research'."
      );
      return;
    }

    if (body.type === "app") {
      const appId = normalizeAppId(body.appId);
      if (!appId || !isNumericAppId(appId)) {
        deps.sendApiError(res, 400, "INVALID_REQUEST", "App ID must be numeric.");
        return;
      }

      const country = deps.hydrationCountry;
      upsertOwnedApps([{ id: appId, kind: "owned", name: appId }]);
      let hydratedName = appId;
      try {
        const snapshots = await deps.fetchOwnedAppSnapshotsFromApi(country, [appId]);
        if (snapshots.length > 0) {
          upsertOwnedAppSnapshots(snapshots);
          const first = snapshots[0];
          if (first?.name?.trim()) {
            hydratedName = first.name.trim();
          }
        }
      } catch (error) {
        deps.reportDashboardError(error, {
          method: "POST",
          path: "/api/apps",
          phase: "manual-app-hydration",
          appId,
          country,
        });
      }

      deps.sendJson(res, 201, {
        success: true,
        data: {
          id: appId,
          name: hydratedName,
        },
      });
      return;
    }

    const name = (body.name ?? "").trim();
    if (!name) {
      deps.sendApiError(res, 400, "INVALID_REQUEST", "Research name is required.");
      return;
    }

    const slug = slugifyResearchName(name);
    ensureDefaultResearchAppExists();
    const id = nextResearchAppId(slug);
    upsertOwnedApps([{ id, kind: "research", name }]);
    deps.sendJson(res, 201, {
      success: true,
      data: {
        id,
        name,
      },
    });
  }

  return {
    handleApiAppsPost,
  };
}
