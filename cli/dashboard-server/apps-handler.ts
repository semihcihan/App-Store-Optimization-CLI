import * as http from "http";
import { getAppById, upsertApps } from "../db/apps";
import { upsertOwnedAppDocs } from "../db/aso-apps";
import {
  DEFAULT_RESEARCH_APP_ID,
  DEFAULT_RESEARCH_APP_NAME,
} from "../shared/aso-research";

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
  fetchAsoAppDocsFromApi: (country: string, appIds: string[]) => Promise<
    Array<{
      appId: string;
      name: string;
      subtitle?: string;
      averageUserRating: number;
      userRatingCount: number;
      releaseDate?: string | null;
      currentVersionReleaseDate?: string | null;
      icon?: Record<string, unknown>;
      iconArtwork?: { url?: string; [key: string]: unknown };
      expiresAt?: string;
    }>
  >;
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
  if (!getAppById(baseId)) {
    return baseId;
  }
  let suffix = 2;
  while (true) {
    const candidate = `${baseId}-${suffix}`;
    if (!getAppById(candidate)) {
      return candidate;
    }
    suffix += 1;
  }
}

export function ensureDefaultResearchAppExists(): void {
  if (getAppById(DEFAULT_RESEARCH_APP_ID)) {
    return;
  }
  upsertApps([
    {
      id: DEFAULT_RESEARCH_APP_ID,
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
      upsertApps([{ id: appId, name: appId }]);
      let hydratedName = appId;
      try {
        const docs = await deps.fetchAsoAppDocsFromApi(country, [appId]);
        if (docs.length > 0) {
          upsertOwnedAppDocs(country, docs);
          const first = docs[0];
          if (first?.name?.trim()) {
            hydratedName = first.name.trim();
            upsertApps([{ id: appId, name: hydratedName }]);
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
    upsertApps([{ id, name }]);
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
