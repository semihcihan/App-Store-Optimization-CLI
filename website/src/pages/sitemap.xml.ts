import { resolveSiteUrl } from "../../site-config.mjs";

export function GET() {
  const url = resolveSiteUrl("/").replaceAll("&", "&amp;").replaceAll("<", "&lt;");
  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    `  <url><loc>${url}</loc></url>`,
    "</urlset>",
    "",
  ].join("\n");

  return new Response(body, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
    },
  });
}
