import { version } from "../../../package.json";
import { initializeBugsnag } from "../../shared/telemetry/bugsnag-shared";

const isDevelopment = process.env.NODE_ENV == "development";
const bugsnagApiKey = process.env.BUGSNAG_API_KEY?.trim();
initializeBugsnag({
  isDevelopment,
  ...(bugsnagApiKey ? { apiKey: bugsnagApiKey } : {}),
  appVersion: version,
});
