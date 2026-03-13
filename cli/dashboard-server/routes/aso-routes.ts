import { createAppDocHandlers, fetchAsoAppDocsFromApi } from "./app-doc-handlers";
import { createKeywordHandlers } from "./keyword-handlers";
import type { AsoRouteDeps } from "./aso-route-types";

export { fetchAsoAppDocsFromApi };

export function createAsoRouteHandlers(deps: AsoRouteDeps) {
  const keywordHandlers = createKeywordHandlers(deps);
  const appDocHandlers = createAppDocHandlers(deps);

  return {
    ...keywordHandlers,
    ...appDocHandlers,
  };
}
