import { getStore } from "@netlify/blobs";
import { FETCHERS } from "../lib/sources.mjs";
import { MAX_QUERY_CHARS, searchSource } from "../lib/search.mjs";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });

// GET /api/search?source=himalayas&q=react+developer  (the browser calls this once per source to show progress)
export default async (req) => {
  const url = new URL(req.url);
  const source = url.searchParams.get("source") || "";
  const q = (url.searchParams.get("q") || "").trim();
  if (!Object.hasOwn(FETCHERS, source)) return json({ error: "unknown source" }, 400);
  if (!q || q.length > MAX_QUERY_CHARS) return json({ error: `q must be 1-${MAX_QUERY_CHARS} characters` }, 400);
  return json(await searchSource(getStore("jobs-cache"), source, q));
};

export const config = { path: "/api/search" };
