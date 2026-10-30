# Remote Job Finder

A free, fast job site: remote jobs and internships in every field, filtered for people based in India.
Listings are fetched live from the job sources by a Netlify Function, so there is no stored job file to go stale. No server to run, and no cost on Netlify's free tier.

**Features**
- Search with live results. Words must all match; put "quoted phrases" in quotes.
- Category chips with counts: Software & IT, Marketing & SEO, Design, Data & AI, Support, Sales and more.
- Filters: who can apply (open to India / India-based / worldwide / all), job type (full-time, part-time, contract, internship, freelance), level, posted date, salary shown, and sort.
- Save jobs and mark them as applied. This is stored in the visitor's own browser, with no login. Applications can be downloaded as a CSV file.
- A NEW badge shows jobs posted since the visitor's last visit.
- Shareable search links: every search and filter is kept in the URL.
- "Also search on" links to LinkedIn, Internshala, Naukri and Indeed.
- Dark mode, works on mobile, and keyboard shortcut `/` to jump to search.

## How it works

```
visitor's browser ──> /api/jobs (Netlify Function) ──> per-source cache (Netlify Blobs) ──> live source APIs
        │                                                  only re-fetches when a source's limit allows
        └─ search, filters and sorting run locally in the browser on the returned listings
```

The function (`netlify/functions/jobs.mjs`) fetches Remotive, Remote OK, Jobicy and Himalayas, normalises them, removes duplicates and returns one JSON list. Each source has its own cache time in `netlify/lib/sources.mjs` (`ttlMs`), chosen to stay inside that source's rules:

| Source | Re-fetched at most every |
|---|---|
| Remotive | 6 hours (their limit is 4 fetches a day) |
| Jobicy | 1 hour (their limit is one sync an hour) |
| Remote OK, Himalayas | 15 minutes |

If a source fails, the last good copy is served and that source is retried after a cool-down. The browser re-checks every 5 minutes while the page is open.

This is why searches do not call the sources directly: Remotive and Jobicy would block a site that called them on every search.

## Searching

Press **Search** and the page shows a progress bar (one step per source) while `/api/search` asks each source for your keyword, then lists the merged results.

- **Himalayas** is searched live for your keyword. Each keyword is cached for 15 minutes.
- **Remotive, Remote OK and Jobicy** only publish a full feed and limit how often it can be fetched, so their cached feeds (see the table above) are searched instead of calling them on every search.
- Typing without pressing Search filters the already-loaded listings instantly.

## Put it online (one-time setup)

1. **Push this folder to a GitHub repository.**
2. **Deploy on Netlify.** Choose **Add new site → Import an existing project → GitHub**, then pick the repo. Netlify reads `netlify.toml` (publish folder `site`, functions in `netlify/functions`) and installs the dependency in `package.json`. Click **Deploy**.
3. **Add your domain (optional).** In Netlify, go to **Domain management → Add a domain**.
4. **Done.** Open the site; the first visit after a cache expires takes a few seconds while the sources are fetched.

## Run it on your computer

```
./start.sh                 # first run sets up .venv; then open http://localhost:8765
```

This runs the same site with a Python server (`local_server.py`) instead of Netlify. It listens only on your computer. Press **Search** and it asks every source live, with the same progress bar. Fetched feeds are saved in `.cache/`, so restarting doesn't fetch Remotive again (4 a day).

On top of the four sources it also reads **company career pages** straight from the public job-board APIs of Greenhouse, Lever and Ashby (about 30 companies, remote and India-friendly roles only). These are official APIs meant for this, not page scraping. Add companies in `companies.json`, using the name in their careers URL (`boards.greenhouse.io/<name>`, `jobs.lever.co/<name>`, `jobs.ashbyhq.com/<name>`). The first search takes about 20 seconds while they load; after that they're cached for 30 minutes.

LinkedIn, Naukri, Indeed and Internshala are not scraped: they forbid it and block automated requests. The page links out to them under the results ("Also search on").

To use a different port: `PORT=9000 ./start.sh`.

## Sources and their rules (keep these, or you can lose access)

| Source | Status | Rules |
|---|---|---|
| Remotive | On | Link back and name Remotive. At most 4 fetches a day. Don't send jobs to Google Jobs or other job boards. Don't use listings to collect signups or emails. |
| Remote OK | On | Link to the job's Remote OK page with a normal (followable, not nofollow) link, and name "Remote OK". Don't use their logo without permission. |
| Jobicy | On | Apply links go to the Jobicy job page. Credit Jobicy. At most one sync an hour. |
| Himalayas | On | Use `applicationLink` unchanged. Show a visible link to Himalayas. Remove expired jobs. Don't pass jobs to Google Jobs or other boards. |
| Arbeitnow | **Off** | No published terms. Email them before turning it on. |
| We Work Remotely | **Off** | Confirm that their terms allow republishing their RSS before turning it on. |

To switch a source on or off, edit `FETCHERS` at the bottom of `netlify/lib/sources.mjs` (and `ENABLED` in `fetch_jobs.py` for the local fallback).

**Never add JobPosting structured data (schema) to this site.** Remotive and Himalayas forbid passing their jobs to Google Jobs. If you plan to make money from the site (ads or paid features), ask the sources first. Remotive and Arbeitnow sell paid access for commercial use.

## Customise

- **Site name and text:** `site/index.html` and `site/about.html`.
- **Categories:** `CATEGORY_RULES` in `netlify/lib/sources.mjs` (and `fetch_jobs.py`). The first match wins.
- **How long jobs stay listed:** `MAX_AGE_DAYS` in `netlify/lib/sources.mjs` (and `fetch_jobs.py`) (default 45).
- **Colours:** the variables at the top of `site/style.css`.

Built with AI-assisted development (Claude Code).
