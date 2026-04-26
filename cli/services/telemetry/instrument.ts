import { version } from "../../../package.json";
import { initializeBugsnag } from "../../shared/telemetry/bugsnag-shared";
import { initializePostHog } from "../../shared/telemetry/posthog-shared";

const DEFAULT_POSTHOG_API_KEY = "phc_CjK5coJt6fxtXseg8XgkU8dMfXPur3JgabQh5454opmQ";

const isDevelopment = process.env.NODE_ENV == "development";
const bugsnagApiKey = process.env.BUGSNAG_API_KEY?.trim();
initializeBugsnag({
  isDevelopment,
  ...(bugsnagApiKey ? { apiKey: bugsnagApiKey } : {}),
  appVersion: version,
});

const posthogApiKey = process.env.ASO_POSTHOG_API_KEY?.trim() || DEFAULT_POSTHOG_API_KEY;
const posthogHost = process.env.ASO_POSTHOG_HOST?.trim();
initializePostHog({
  isDevelopment,
  apiKey: posthogApiKey,
  ...(posthogHost ? { host: posthogHost } : {}),
});
