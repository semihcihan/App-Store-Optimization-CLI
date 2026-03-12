import { version } from "../../../package.json";
import { initializeBugsnag } from "../../shared/telemetry/bugsnag-shared";

const isDevelopment = process.env.NODE_ENV == "development";
initializeBugsnag({
  isDevelopment,
  appVersion: version,
});
