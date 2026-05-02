import { resolveSiteUrl } from "../../site-config.mjs";

const pages = [
  {
    url: resolveSiteUrl("/"),
    changefreq: "weekly",
    priority: "1.0",
  },
];

export function GET() {
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages
    .map(
      ({ url, changefreq, priority }) => `  <url>\n    <loc>${url}</loc>\n    <changefreq>${changefreq}</changefreq>\n    <priority>${priority}</priority>\n  </url>`
    )
    .join("\n")}\n</urlset>\n`;

  return new Response(body, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
    },
  });
}
