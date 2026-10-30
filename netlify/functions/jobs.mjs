import { getStore } from "@netlify/blobs";
import { loadJobs } from "../lib/cache.mjs";

export default async () => {
  const payload = await loadJobs(getStore("jobs-cache"));
  const everySourceFailed = Object.values(payload.sources).every((s) => !s.ok) && payload.count === 0;
  return new Response(JSON.stringify(payload), {
    status: everySourceFailed ? 502 : 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=0, must-revalidate",
      // Netlify's CDN reuses one response for a minute and refreshes in the background for 5 more.
      "Netlify-CDN-Cache-Control": everySourceFailed ? "no-store" : "public, max-age=60, stale-while-revalidate=300",
    },
  });
};

export const config = { path: "/api/jobs" };
