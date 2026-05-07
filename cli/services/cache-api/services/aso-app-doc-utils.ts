import type { AsoAppDoc } from "./aso-types";

export function normalizeCountryOnAppDocs(
  country: string,
  docs: AsoAppDoc[]
): AsoAppDoc[] {
  const normalizedCountry = country.toUpperCase();
  return docs.map((doc) => ({
    ...doc,
    country: normalizedCountry,
  }));
}
