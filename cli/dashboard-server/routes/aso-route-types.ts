import * as http from "http";

export type AsoApiAppDoc = {
  appId: string;
  country: string;
  name: string;
  subtitle?: string;
  averageUserRating: number;
  userRatingCount: number;
  releaseDate?: string | null;
  currentVersionReleaseDate?: string | null;
  icon?: Record<string, unknown>;
  iconArtwork?: { url?: string; [key: string]: unknown };
  expiresAt?: string;
};

export type UserSafeError = {
  errorCode: string;
  message: string;
};

export type AsoRouteDeps = {
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
  toUserSafeError: (error: unknown, fallback: string) => UserSafeError;
  statusForDashboardErrorCode: (errorCode: string) => number;
  isDashboardAuthInProgress: () => boolean;
  isTruthyQueryParam: (value: string | undefined) => boolean;
};
