"""
boards.py - remote jobs straight from companies' own career pages, using the public job-board APIs that
Greenhouse, Lever and Ashby offer for exactly this purpose (no scraping of web pages, no disguised browser).
Edit companies.json to add companies: use the name in their careers URL, e.g.
boards.greenhouse.io/<name>, jobs.lever.co/<name>, jobs.ashbyhq.com/<name>.
"""

import html
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fetch_jobs import build, get, to_dt

COMPANIES_FILE = Path(__file__).resolve().parent / "companies.json"

def _remote_ok(location, workplace=""):
    loc = (location or "").lower()
    return "remote" in (workplace or "").lower() or any(w in loc for w in ("remote", "anywhere", "india", "worldwide"))

def _greenhouse(token):
    out = []
    for j in get(f"https://boards-api.greenhouse.io/v1/boards/{token}/jobs", {"content": "true"}).get("jobs", []):
        loc = (j.get("location") or {}).get("name", "")
        if not _remote_ok(loc):
            continue
        depts = [d.get("name", "") for d in j.get("departments") or []]
        out.append(build("boards", j.get("title"), j.get("company_name") or token, loc,
                         j.get("absolute_url"), j.get("absolute_url"),
                         to_dt(j.get("first_published") or j.get("updated_at")),
                         html.unescape(j.get("content") or ""), tags=depts, cat_hint=" ".join(depts)))
    return out

def _lever(token):
    out = []
    for j in get(f"https://api.lever.co/v0/postings/{token}", {"mode": "json"}):
        cats = j.get("categories") or {}
        loc = cats.get("location", "")
        if not _remote_ok(loc, j.get("workplaceType")):
            continue
        out.append(build("boards", j.get("text"), token.title(), loc,
                         j.get("hostedUrl"), j.get("hostedUrl"), to_dt(j.get("createdAt")),
                         j.get("descriptionPlain") or j.get("description"),
                         jtype_raw=cats.get("commitment", ""), tags=[cats.get("team", "")],
                         cat_hint=f"{cats.get('team', '')} {cats.get('department', '')}"))
    return out

def _ashby(token):
    out = []
    for j in get(f"https://api.ashbyhq.com/posting-api/job-board/{token}").get("jobs", []):
        loc = j.get("location", "")
        if not j.get("isListed", True) or not _remote_ok(loc, "remote" if j.get("isRemote") else ""):
            continue
        out.append(build("boards", j.get("title"), token.title(), loc,
                         j.get("applyUrl") or j.get("jobUrl"), j.get("jobUrl"),
                         to_dt(j.get("publishedAt")), j.get("descriptionHtml") or j.get("descriptionPlain"),
                         jtype_raw=j.get("employmentType", ""), tags=[j.get("team", "")],
                         cat_hint=f"{j.get('department', '')} {j.get('team', '')}"))
    return out

FETCH = {"greenhouse": _greenhouse, "lever": _lever, "ashby": _ashby}

def fetch_boards():
    """All remote/India-friendly jobs from the companies in companies.json. A company that fails is skipped."""
    companies = json.loads(COMPANIES_FILE.read_text(encoding="utf-8"))
    tasks = [(kind, token) for kind, tokens in companies.items() if kind in FETCH for token in tokens]

    def one(task):
        kind, token = task
        try:
            return FETCH[kind](token)
        except Exception as e:   # one bad company name must not sink the rest
            print(f"  boards: {kind}/{token} skipped ({e})")
            return []
    with ThreadPoolExecutor(max_workers=6) as pool:
        return [j for jobs in pool.map(one, tasks) for j in jobs if j]
