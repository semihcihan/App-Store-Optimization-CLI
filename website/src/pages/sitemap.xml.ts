import { resolveSiteUrl } from "../../site-config.mjs";

const pages = ["/", "/mcp/"];

export function GET() {
  const entries = pages.map((path) => {
    const url = resolveSiteUrl(path).replaceAll("&", "&amp;").replaceAll("<", "&lt;");
    return `  <url><loc>${url}</loc></url>`;
  });
  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...entries,
    "</urlset>",
    "",
  ].join("\n");

  return new Response(body, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
    },
  });
}
