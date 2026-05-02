const DEFAULT_SITE_ORIGIN = "https://asocli.com";
const DEFAULT_SITE_BASE_PATH = "/";

function normalizeOrigin(value) {
  return value.trim().replace(/\/+$/, "");
}

function normalizeBasePath(value) {
  const trimmed = value.trim();

  if (!trimmed || trimmed === "/") {
    return "/";
  }

  return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

export const siteOrigin = normalizeOrigin(
  process.env.PUBLIC_SITE_ORIGIN ?? DEFAULT_SITE_ORIGIN
);

export const siteBasePath = normalizeBasePath(
  process.env.PUBLIC_SITE_BASE_PATH ?? DEFAULT_SITE_BASE_PATH
);

const baseDirectory = siteBasePath === "/" ? "" : `${siteBasePath.slice(1)}/`;

export const siteRootUrl = new URL(baseDirectory, `${siteOrigin}/`).toString();

export function resolveSiteUrl(pathname = "/") {
  const normalizedPath = pathname === "/" ? "" : pathname.replace(/^\/+/, "");
  return new URL(normalizedPath, siteRootUrl).toString();
}
