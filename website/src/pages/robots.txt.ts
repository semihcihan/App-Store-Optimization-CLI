import { resolveSiteUrl } from "../../site-config.mjs";

export function GET() {
  const body = [
    "User-agent: *",
    "Allow: /",
    "",
    `Sitemap: ${resolveSiteUrl("/sitemap.xml")}`,
    `LLM: ${resolveSiteUrl("/llms.txt")}`,
  ].join("\n");

  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}
