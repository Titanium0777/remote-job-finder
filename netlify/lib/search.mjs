/*
 * search.mjs - searches one source for a keyword.
 * - Himalayas has a keyword search, so it is queried live (each keyword cached for 15 minutes).
 * - Remotive, Remote OK and Jobicy only publish a full feed and limit how often it may be fetched, so their
 *   cached feed (see cache.mjs) is searched instead.
 */
import { getSourceRecord } from "./cache.mjs";
import { SOURCE_INFO, mergeJobs, searchHimalayas } from "./sources.mjs";

const QUERY_TTL_MS = 15 * 60e3;
export const MAX_QUERY_CHARS = 80;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Words must all match; "quoted phrases" match as one term. Same rules as the browser's search. */
export function queryTerms(q) {
  const out = [];
  for (const m of q.toLowerCase().matchAll(/"([^"]+)"|(\S+)/g)) {
    const t = (m[1] || m[2]).trim();
    if (t) out.push(new RegExp(`(^|[^a-z0-9])${escapeRe(t)}($|[^a-z0-9])`));
  }
  return out;
}

export function filterJobs(jobs, q) {
  const rx = queryTerms(q);
  return jobs.filter((j) => {
    const hay = [j.title, j.company, j.location, (j.tags || []).join(" "), j.snippet].join(" ").toLowerCase();
    return rx.every((r) => r.test(hay));
  });
}

const iso = (ms) => (ms ? new Date(ms).toISOString().slice(0, 16) + "Z" : null);

export async function searchSource(store, key, q, now = Date.now()) {
  const info = SOURCE_INFO[key];
  const base = { source: key, name: info.name, url: info.url };

  if (key !== "himalayas") {
    const { rec, error } = await getSourceRecord(store, key, now);
    const jobs = mergeJobs([filterJobs(rec?.jobs ?? [], q)], new Date(now));
    return { ...base, ok: !error, ...(error ? { error } : {}), fetched: iso(rec?.fetchedAt), live: false, jobs };
  }

  const cacheKey = `q-himalayas-${encodeURIComponent(q.toLowerCase().replace(/\s+/g, " ").trim())}`;
  let rec = null;
  try { rec = await store.get(cacheKey, { type: "json" }); } catch { /* empty cache */ }
  if (!rec || now - rec.fetchedAt >= QUERY_TTL_MS) {
    try {
      // Himalayas matches loosely and doesn't know our quote syntax, so it gets the plain words and we keep
      // only jobs whose full text has every term.
      const rx = queryTerms(q);
      const jobs = (await searchHimalayas(q.replaceAll('"', " ").trim(), (text) => rx.every((r) => r.test(text)))).filter(Boolean);
      rec = { fetchedAt: now, jobs };
      try { await store.setJSON(cacheKey, rec); } catch { /* still serve the data */ }
    } catch (e) {
      return { ...base, ok: false, error: String(e.message || e).slice(0, 120), fetched: null, live: true, jobs: [] };
    }
  }
  return { ...base, ok: true, fetched: iso(rec.fetchedAt), live: true, jobs: mergeJobs([rec.jobs], new Date(now)) };
}
