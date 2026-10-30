# Remote Job Finder

A free, fast job site: remote jobs and internships in every field, filtered for people based in India.
Listings refresh automatically every 6 hours. No server, no database, and no cost on the free tiers of GitHub and Netlify.

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
GitHub Action (every 6 h) ──> fetch_jobs.py ──> site/data/jobs.json ──> commit ──> Netlify redeploys
                                                         │
                         visitor's browser loads it and searches it locally (site/app.js)
```

## Put it online (one-time setup)

1. **Create a GitHub repository** and push this folder to it.
2. **Run the first data update.** In the repo, open **Actions → Update jobs → Run workflow**. After about a minute, `site/data/jobs.json` fills with jobs.
   - If the commit step fails with a permission error, go to **Settings → Actions → General → Workflow permissions**, choose **Read and write permissions**, then run it again.
3. **Deploy on Netlify.** Choose **Add new site → Import an existing project → GitHub**, then pick the repo. Netlify reads `netlify.toml` automatically (publish folder: `site`, no build command). Click **Deploy**.
4. **Add your domain (optional).** In Netlify, go to **Domain management → Add a domain**, then update your DNS as Netlify shows.
5. **Done.** Every 6 hours the Action commits fresh data and Netlify redeploys on its own.

Check Netlify's current free-plan limits for deploys. Four small deploys a day is light. The `site` folder also works on Cloudflare Pages or GitHub Pages if you prefer.

## Run it on your computer

```
pip install -r requirements.txt
python fetch_jobs.py                  # downloads jobs into site/data/jobs.json
python -m http.server 8000 -d site    # open http://localhost:8000
```

Don't run `fetch_jobs.py` more than about 4 times a day. Remotive allows at most 4 fetches a day, and the GitHub Action already uses those.

## Sources and their rules (keep these, or you can lose access)

| Source | Status | Rules |
|---|---|---|
| Remotive | On | Link back and name Remotive. At most 4 fetches a day. Don't send jobs to Google Jobs or other job boards. Don't use listings to collect signups or emails. |
| Remote OK | On | Link to the job's Remote OK page with a normal (followable, not nofollow) link, and name "Remote OK". Don't use their logo without permission. |
| Jobicy | On | Apply links go to the Jobicy job page. Credit Jobicy. At most one sync an hour. |
| Himalayas | On | Use `applicationLink` unchanged. Show a visible link to Himalayas. Remove expired jobs. Don't pass jobs to Google Jobs or other boards. |
| Arbeitnow | **Off** | No published terms. Email them before turning it on. |
| We Work Remotely | **Off** | Confirm that their terms allow republishing their RSS before turning it on. |

To switch a source on or off, edit `ENABLED` at the top of `fetch_jobs.py`.

**Never add JobPosting structured data (schema) to this site.** Remotive and Himalayas forbid passing their jobs to Google Jobs. If you plan to make money from the site (ads or paid features), ask the sources first. Remotive and Arbeitnow sell paid access for commercial use.

## Customise

- **Site name and text:** `site/index.html` and `site/about.html`.
- **Categories:** `CATEGORY_RULES` in `fetch_jobs.py`. The first match wins.
- **How long jobs stay listed:** `MAX_AGE_DAYS` in `fetch_jobs.py` (default 45).
- **Colours:** the variables at the top of `site/style.css`.

Built with AI-assisted development (Claude Code).
