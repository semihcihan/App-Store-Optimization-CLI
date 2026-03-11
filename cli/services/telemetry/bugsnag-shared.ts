import Bugsnag from "@bugsnag/js";

const BUGSNAG_API_KEY = "ed1a4165d4f8fd836bf16f3ca1915a67";
let started = false;
let isDevelopmentMode = false;
type StartOptions = NonNullable<Parameters<typeof Bugsnag.start>[0]>;
type BugsnagConfigOptions = Exclude<StartOptions, string>;
const DEFAULT_BREADCRUMB_TYPES: NonNullable<
  BugsnagConfigOptions["enabledBreadcrumbTypes"]
> = ["error", "manual"];

export function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === "string") return new Error(error);
  try {
    return new Error(JSON.stringify(error));
  } catch {
    return new Error(String(error));
  }
}

export function initializeBugsnag(options: {
  isDevelopment: boolean;
  appVersion?: string;
  enabledBreadcrumbTypes?: BugsnagConfigOptions["enabledBreadcrumbTypes"];
}): void {
  if (started) return;

  isDevelopmentMode = options.isDevelopment;
  if (isDevelopmentMode) {
    return;
  }

  Bugsnag.start({
    apiKey: BUGSNAG_API_KEY,
    autoTrackSessions: false,
    appVersion: options.appVersion,
    logger: null,
    enabledBreadcrumbTypes:
      options.enabledBreadcrumbTypes ?? DEFAULT_BREADCRUMB_TYPES,
  });
  started = true;
}

export function notifyBugsnagError(
  error: unknown,
  metadata: Record<string, unknown> = {},
  mutateEvent?: (event: any) => void
): void {
  if (!started || isDevelopmentMode) return;

  Bugsnag.notify(toError(error), (event) => {
    event.addMetadata("metadata", metadata);
    if (mutateEvent) {
      mutateEvent(event);
    }
  });
}
