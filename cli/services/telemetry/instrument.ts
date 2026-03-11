import { version } from "../../../package.json";
import { initializeBugsnag } from "./bugsnag-shared";

const isDevelopment = process.env.NODE_ENV == "development";
initializeBugsnag({
  isDevelopment,
  appVersion: version,
});
