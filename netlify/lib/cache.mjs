/*
 * cache.mjs - returns the merged job list, fetching each source live only when its
 * cached copy is older than that source's limit (SOURCE_INFO[...].ttlMs). The cache
 * keeps us inside each source's rate limit however many visitors search.
 */
import { FETCHERS, SOURCE_INFO, mergeJobs } from "./sources.mjs";

const MIN_RETRY_MS = 5 * 60e3;

/** `store` needs get(key, {type:"json"}) and setJSON(key, value), like a Netlify Blobs store. */
export async function loadJobs(store, now = Date.now()) {
  const results = await Promise.all(Object.keys(FETCHERS).map(async (key) => {
    const info = SOURCE_INFO[key];
    let rec = null;
    try { rec = await store.get(key, { type: "json" }); } catch { /* treat as empty cache */ }

    const fresh = rec && now - rec.fetchedAt < info.ttlMs;
    // After a failed attempt, wait before trying the source again so we never hammer it.
    const retryMs = Math.max(MIN_RETRY_MS, info.ttlMs / 2);
    const coolingDown = rec && rec.attemptedAt && now - rec.attemptedAt < retryMs;
    if (fresh || coolingDown) return { key, rec, error: rec?.error };

    try {
      const jobs = (await FETCHERS[key]()).filter(Boolean);
      if (!jobs.length) throw new Error("no jobs returned");
      rec = { fetchedAt: now, attemptedAt: now, jobs };
    } catch (e) {
      rec = { fetchedAt: rec?.fetchedAt ?? 0, attemptedAt: now, jobs: rec?.jobs ?? [], error: String(e.message || e).slice(0, 120) };
    }
    try { await store.setJSON(key, rec); } catch { /* cache write failed; still serve the data */ }
    return { key, rec, error: rec.error };
  }));

  const sources = {};
  results.forEach(({ key, rec, error }) => {
    const info = SOURCE_INFO[key];
    sources[key] = { name: info.name, url: info.url, ok: !error, count: rec?.jobs.length ?? 0,
      fetched: rec?.fetchedAt ? new Date(rec.fetchedAt).toISOString().slice(0, 16) + "Z" : null,
      ...(error ? { error } : {}) };
  });
  const jobs = mergeJobs(results.map(({ rec }) => rec?.jobs ?? []), new Date(now));
  const newest = Math.max(0, ...results.map(({ rec }) => rec?.fetchedAt ?? 0));
  return {
    updated: newest ? new Date(newest).toISOString().slice(0, 16) + "Z" : "",
    count: jobs.length, sources, jobs,
  };
}
