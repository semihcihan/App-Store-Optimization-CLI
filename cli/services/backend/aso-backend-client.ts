import fs from "fs";
import os from "os";
import path from "path";
import axios from "axios";
import { version as cliVersion } from "../../../package.json";
import { asoBackendApiKeyService } from "./aso-backend-api-key-service";
import type {
  DifficultyScorePayload,
  DifficultyScoreResult,
  AsoBackendContext,
  AsoBackendEntitlements,
  AsoBackendErrorCode,
  AsoBackendFeature,
} from "./aso-backend-types";

const DEFAULT_CONTEXT_TTL_SECONDS = 86400;
const DEFAULT_ASO_BACKEND_BASE_URL =
  "https://aso-difficulty-api.umitsemihcihan.workers.dev";

type CachedContextEnvelope = {
  context: AsoBackendContext;
  cachedAt: string;
};

type ContextResponse = {
  upgradeUrl?: unknown;
  entitlements?: unknown;
};

type DifficultyScoreResponse = {
  difficultyScore?: unknown;
};

export class AsoBackendApiError extends Error {
  readonly code: AsoBackendErrorCode;
  readonly statusCode: number;
  readonly feature: AsoBackendFeature;
  readonly upgradeUrl: string | null;

  constructor(params: {
    code: AsoBackendErrorCode;
    feature: AsoBackendFeature;
    statusCode?: number;
    message: string;
    upgradeUrl?: string | null;
  }) {
    super(params.message);
    this.name = "AsoBackendApiError";
    this.code = params.code;
    this.feature = params.feature;
    this.statusCode = params.statusCode ?? 403;
    this.upgradeUrl = params.upgradeUrl ?? null;
  }
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function resolveContextCachePath(): string {
  const configuredHome = process.env.ASO_HOME_DIR;
  const homeDir =
    typeof configuredHome === "string" && configuredHome.trim() !== ""
      ? configuredHome.trim()
      : os.homedir();
  return path.join(homeDir, ".aso", "backend-context-cache.json");
}

function nowIso(): string {
  return new Date().toISOString();
}

function toBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  return fallback;
}

function normalizeUpgradeUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

function toNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseEntitlements(raw: ContextResponse): AsoBackendEntitlements {
  const entitlementsRecord =
    raw.entitlements && typeof raw.entitlements === "object"
      ? (raw.entitlements as Record<string, unknown>)
      : {};

  return {
    difficultyView: toBoolean(entitlementsRecord.difficultyView),
    topApps: toBoolean(entitlementsRecord.topApps),
  };
}

function parseContext(raw: unknown): AsoBackendContext {
  const payload =
    raw && typeof raw === "object" ? (raw as ContextResponse) : ({} as ContextResponse);
  const entitlements = parseEntitlements(payload);
  return {
    upgradeUrl: normalizeUpgradeUrl(payload.upgradeUrl),
    entitlements,
    fetchedAt: nowIso(),
  };
}

function parseDifficultyResponse(raw: unknown): {
  difficultyScore: number | null;
} {
  const payload =
    raw && typeof raw === "object"
      ? (raw as DifficultyScoreResponse)
      : ({} as DifficultyScoreResponse);

  return {
    difficultyScore: toNumberOrNull(payload.difficultyScore),
  };
}

function buildDefaultContext(): AsoBackendContext {
  return {
    upgradeUrl: null,
    entitlements: {
      difficultyView: true,
      topApps: true,
    },
    fetchedAt: nowIso(),
  };
}

export class AsoBackendClient {
  private memoryCache: CachedContextEnvelope | null = null;

  private buildBackendHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "user-agent": `aso-cli/${cliVersion}`,
    };

    const resolvedKey = asoBackendApiKeyService.resolveApiKey();
    if (resolvedKey.apiKey) {
      headers["x-aso-cli-api-key"] = resolvedKey.apiKey;
    }

    const resolvedClientId = asoBackendApiKeyService.resolveClientId();
    if (resolvedClientId.clientId) {
      headers["x-aso-client-id"] = resolvedClientId.clientId;
    }

    return headers;
  }

  private get baseUrl(): string {
    const raw = process.env.ASO_BACKEND_BASE_URL;
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    const resolved =
      trimmed === "" ? DEFAULT_ASO_BACKEND_BASE_URL : trimmed;
    return resolved.replace(/\/+$/, "");
  }

  private get cacheTtlSeconds(): number {
    return parsePositiveInt(
      process.env.ASO_BACKEND_CONTEXT_TTL_SECONDS,
      DEFAULT_CONTEXT_TTL_SECONDS
    );
  }

  private readContextCacheFromDisk(): CachedContextEnvelope | null {
    const cachePath = resolveContextCachePath();
    try {
      if (!fs.existsSync(cachePath)) return null;
      const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8")) as CachedContextEnvelope;
      if (!parsed || typeof parsed !== "object") return null;
      if (!parsed.context || typeof parsed.context !== "object") return null;
      if (typeof parsed.cachedAt !== "string") return null;
      return {
        context: parseContext(parsed.context),
        cachedAt: parsed.cachedAt,
      };
    } catch {
      return null;
    }
  }

  private persistContextCache(context: AsoBackendContext): void {
    const cachePath = resolveContextCachePath();
    const cacheDir = path.dirname(cachePath);
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    }
    const payload: CachedContextEnvelope = {
      context,
      cachedAt: nowIso(),
    };
    const tempPath = `${cachePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(tempPath, cachePath);
    this.memoryCache = payload;
  }

  private isFreshCache(cache: CachedContextEnvelope | null): boolean {
    if (!cache) return false;
    const cachedAtMs = Date.parse(cache.cachedAt);
    if (!Number.isFinite(cachedAtMs)) return false;
    const ageMs = Date.now() - cachedAtMs;
    return ageMs <= this.cacheTtlSeconds * 1000;
  }

  private async fetchContextFromBackend(): Promise<AsoBackendContext> {
    const response = await axios.get(`${this.baseUrl}/v1/client/context`, {
      headers: this.buildBackendHeaders(),
      timeout: 15000,
      validateStatus: () => true,
    });
    if (response.status >= 200 && response.status < 300) {
      return parseContext(response.data);
    }
    throw new Error(
      `Failed to load backend context (status=${response.status}).`
    );
  }

  invalidateContextCache(): void {
    this.memoryCache = null;
    try {
      const cachePath = resolveContextCachePath();
      if (fs.existsSync(cachePath)) {
        fs.unlinkSync(cachePath);
      }
    } catch {
      return;
    }
  }

  async getContext(options?: { forceRefresh?: boolean }): Promise<AsoBackendContext> {
    if (!options?.forceRefresh) {
      if (this.isFreshCache(this.memoryCache)) {
        return this.memoryCache!.context;
      }
      const diskCache = this.readContextCacheFromDisk();
      if (this.isFreshCache(diskCache)) {
        this.memoryCache = diskCache;
        return diskCache!.context;
      }
    }

    try {
      const context = await this.fetchContextFromBackend();
      this.persistContextCache(context);
      return context;
    } catch {
      const diskCache = this.readContextCacheFromDisk();
      if (diskCache) {
        this.memoryCache = diskCache;
        return diskCache.context;
      }
      return buildDefaultContext();
    }
  }

  async isDifficultyEntitled(): Promise<boolean> {
    const context = await this.getContext();
    return context.entitlements.difficultyView;
  }

  async isTopAppsEntitled(): Promise<{
    allowed: boolean;
    code?: AsoBackendErrorCode;
    feature?: AsoBackendFeature;
    message?: string;
    upgradeUrl?: string | null;
  }> {
    const context = await this.getContext();
    if (context.entitlements.topApps) {
      return { allowed: true };
    }
    return {
      allowed: false,
      code: "PLAN_REQUIRED",
      feature: "top_apps",
      message: "Top apps requires an active plan.",
      upgradeUrl: context.upgradeUrl,
    };
  }

  private buildPaywalledDifficultyResult(params: {
    code: AsoBackendErrorCode;
    message: string;
    upgradeUrl?: string | null;
  }): DifficultyScoreResult {
    return {
      difficultyScore: null,
      difficultyState: "paywalled",
      code: params.code,
      message: params.message,
      feature: "difficulty",
      upgradeUrl: params.upgradeUrl ?? null,
    };
  }

  private parseBackendError(error: unknown): DifficultyScoreResult | null {
    const isAxiosError =
      axios.isAxiosError(error) ||
      (typeof error === "object" &&
        error !== null &&
        (error as { isAxiosError?: unknown }).isAxiosError === true);
    if (!isAxiosError) return null;
    const axiosError = error as {
      response?: { status?: number; data?: unknown };
    };
    const payload =
      axiosError.response?.data && typeof axiosError.response.data === "object"
        ? (axiosError.response.data as Record<string, unknown>)
        : {};
    const errorCode = typeof payload.errorCode === "string" ? payload.errorCode : null;
    const errorMessage =
      typeof payload.error === "string"
        ? payload.error
        : typeof payload.message === "string"
          ? payload.message
          : "Difficulty scoring is not available for this plan.";
    const upgradeUrl =
      typeof payload.upgradeUrl === "string" ? payload.upgradeUrl : null;

    if (errorCode === "PLAN_REQUIRED") {
      return this.buildPaywalledDifficultyResult({
        code: "PLAN_REQUIRED",
        message: errorMessage,
        upgradeUrl,
      });
    }
    if (errorCode === "ENTITLEMENT_UNAVAILABLE") {
      return this.buildPaywalledDifficultyResult({
        code: "ENTITLEMENT_UNAVAILABLE",
        message: errorMessage,
        upgradeUrl,
      });
    }
    return null;
  }

  async scoreDifficulty(payload: DifficultyScorePayload): Promise<DifficultyScoreResult> {
    try {
      const response = await axios.post(
        `${this.baseUrl}/v1/aso/difficulty/score`,
        payload,
        {
          headers: this.buildBackendHeaders(),
          timeout: 20000,
        }
      );
      const parsed = parseDifficultyResponse(response.data);
      if (parsed.difficultyScore == null) {
        return this.buildPaywalledDifficultyResult({
          code: "ENTITLEMENT_UNAVAILABLE",
          message: "Difficulty score response was missing score field.",
        });
      }
      return {
        difficultyScore: parsed.difficultyScore,
        difficultyState: "ready",
      };
    } catch (error) {
      const paywalled = this.parseBackendError(error);
      if (paywalled) return paywalled;
      throw error;
    }
  }
}

export const asoBackendClient = new AsoBackendClient();
