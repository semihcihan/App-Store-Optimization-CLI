import type { AxiosResponse } from "axios";

export type AppStorePageMismatch = {
  requestedUrl: string;
  finalUrl: string | null;
  canonicalUrl: string | null;
  mismatchSource: "final_url" | "canonical_url";
  payloadSummary: {
    bodyType: string;
    bodyLength: number | null;
    title: string | null;
    htmlLanguage: string | null;
    hasSerializedServerData: boolean;
  };
};

function decodeHtml(value: string): string {
  return value.replace(
    /&(amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/gi,
    (match, entity: string) => {
      const named: Record<string, string> = {
        amp: "&",
        quot: '"',
        apos: "'",
        lt: "<",
        gt: ">",
      };
      const key = entity.toLowerCase();
      if (named[key]) return named[key];
      const code = key.startsWith("#x")
        ? parseInt(key.slice(2), 16)
        : Number(key.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
  );
}

function attributes(tag: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of tag.matchAll(
    /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g
  )) {
    result[match[1].toLowerCase()] = decodeHtml(
      match[2] ?? match[3] ?? match[4]
    );
  }
  return result;
}

function pageMatches(
  requested: URL,
  candidate: URL,
  country?: string
): boolean {
  if (candidate.origin !== requested.origin) return false;
  const requestedAppId = requested.pathname.match(/\/id(\d+)\/?$/)?.[1];
  if (requestedAppId) {
    const candidateAppId = candidate.pathname.match(
      /\/app\/(?:[^/]+\/)?id(\d+)\/?$/
    )?.[1];
    if (candidateAppId !== requestedAppId) return false;
    const expectedCountry =
      requested.pathname.match(/^\/([a-z]{2})\/app\//i)?.[1] ?? country;
    const candidateCountry =
      candidate.pathname.match(/^\/([a-z]{2})\/app\//i)?.[1];
    return (
      !candidateCountry ||
      !expectedCountry ||
      candidateCountry.toLowerCase() === expectedCountry.toLowerCase()
    );
  }
  const candidateTerm = candidate.searchParams.get("term");
  const requestedTerm = requested.searchParams.get("term");
  return (
    candidate.pathname.replace(/\/$/, "") ===
      requested.pathname.replace(/\/$/, "") &&
    (!candidateTerm || !requestedTerm || candidateTerm === requestedTerm)
  );
}

function parseUrl(value: string, base?: string): URL | null {
  try {
    return new URL(value, base);
  } catch {
    return null;
  }
}

export function inspectAppStorePageIdentity(
  response: Pick<AxiosResponse, "data" | "request">,
  requestedUrl: string,
  country?: string
): AppStorePageMismatch | null {
  const requested = new URL(requestedUrl);
  const finalUrl: string | null =
    response.request?.res?.responseUrl ?? response.request?.responseURL ?? null;
  const html = typeof response.data === "string" ? response.data : "";
  const canonicalTag = [...html.matchAll(/<link\b[^>]*>/gi)].find((match) =>
    attributes(match[0]).rel?.toLowerCase().split(/\s+/).includes("canonical")
  );
  const canonicalHref = canonicalTag
    ? attributes(canonicalTag[0]).href
    : undefined;
  const final = finalUrl ? parseUrl(finalUrl) : requested;
  const canonical = canonicalHref
    ? parseUrl(canonicalHref, finalUrl ?? requestedUrl)
    : null;
  const canonicalUrl = canonicalHref
    ? (canonical?.href ?? canonicalHref)
    : null;
  const mismatchSource =
    !final || !pageMatches(requested, final, country)
      ? "final_url"
      : canonicalHref &&
          (!canonical || !pageMatches(requested, canonical, country))
        ? "canonical_url"
        : null;
  if (!mismatchSource) return null;

  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const htmlTag = html.match(/<html\b[^>]*>/i)?.[0];
  return {
    requestedUrl,
    finalUrl,
    canonicalUrl,
    mismatchSource,
    payloadSummary: {
      bodyType: typeof response.data,
      bodyLength:
        typeof response.data === "string" ? response.data.length : null,
      title: title
        ? decodeHtml(title).replace(/\s+/g, " ").trim().slice(0, 160)
        : null,
      htmlLanguage: htmlTag
        ? (attributes(htmlTag).lang?.slice(0, 60) ?? null)
        : null,
      hasSerializedServerData:
        /<script\b[^>]*\bid=["']serialized-server-data["']/i.test(html),
    },
  };
}
