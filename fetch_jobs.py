#!/usr/bin/env python3
"""
fetch_jobs.py - downloads remote job listings from public job APIs and writes
site/data/jobs.json for the website. Runs every 6 hours in GitHub Actions.

Each source's rules are followed:
- Remotive: one request per run, at most 4 runs a day; link back and name Remotive.
- Remote OK: link back to the job's Remote OK page (followable link) and name Remote OK.
- Jobicy: apply links point to the Jobicy job page; credit Jobicy; at most hourly syncs.
- Himalayas: applicationLink used unchanged; visible link to Himalayas; expired jobs removed.
- None of the sources allow passing their jobs to Google Jobs or other job boards,
  so the site must NOT add JobPosting structured data.

Arbeitnow and We Work Remotely are included but switched OFF until you confirm
their terms allow showing their jobs on a public site (see ENABLED below).
"""

import html
import json
import re
import sys
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests
from bs4 import BeautifulSoup
from dateutil import parser as dtparser

# ============================== CONFIG ==============================

ENABLED = ["remotive", "remoteok", "jobicy", "himalayas"]   # add "arbeitnow", "wwr" once cleared
MAX_AGE_DAYS = 45            # drop listings older than this
HIMALAYAS_PAGES = 5          # pages per Himalayas search (India + worldwide)
SNIPPET_CHARS = 260
TIMEOUT = 30
HEADERS = {"User-Agent": "RemoteJobFinder/1.0 (job listings site; respects source terms)"}

ROOT = Path(__file__).resolve().parent
OUT_FILE = ROOT / "site" / "data" / "jobs.json"

SOURCE_INFO = {
    "remotive": ("Remotive", "https://remotive.com"),
    "remoteok": ("Remote OK", "https://remoteok.com"),
    "jobicy": ("Jobicy", "https://jobicy.com"),
    "himalayas": ("Himalayas", "https://himalayas.app"),
    "arbeitnow": ("Arbeitnow", "https://www.arbeitnow.com"),
    "wwr": ("We Work Remotely", "https://weworkremotely.com"),
    "boards": ("Company career pages", ""),
}

# Ordered: the first matching category wins (title is checked before source tags).
CATEGORY_RULES = [
    ("Data & AI", ["data scientist", "data analyst", "data engineer", "machine learning", "ml engineer",
                   "ai engineer", "analytics", "business intelligence", "bi developer", "llm", "data science"]),
    ("Design", ["designer", "ux", "ui", "graphic", "illustrator", "motion", "figma", "creative director"]),
    ("Marketing & SEO", ["seo", "marketing", "marketer", "growth", "ppc", "sem", "social media", "brand",
                         "campaign", "community manager", "public relations", "media buyer", "aeo"]),
    ("Content & Writing", ["writer", "copywriter", "editor", "content", "journalist", "translator",
                           "proofreader", "writing"]),
    ("Sales & Business", ["sales", "account executive", "business development", "bdr", "sdr",
                          "account manager", "partnerships", "lead generation"]),
    ("Customer Support", ["support", "customer success", "customer service", "customer experience",
                          "helpdesk", "help desk"]),
    ("Product & Project", ["product manager", "product owner", "project manager", "program manager",
                           "scrum master", "delivery manager", "product"]),
    ("Software & IT", ["engineer", "developer", "devops", "sre", "software", "programmer", "frontend",
                       "front-end", "backend", "back-end", "full stack", "fullstack", "qa", "tester",
                       "sysadmin", "cloud", "security", "mobile", "ios", "android", "web"]),
    ("Finance & Legal", ["accountant", "accounting", "finance", "financial", "bookkeeper", "legal",
                         "lawyer", "paralegal", "compliance", "tax", "payroll", "auditor"]),
    ("HR & Recruiting", ["recruiter", "recruiting", "talent", "hr", "human resources", "people operations"]),
    ("Operations & Admin", ["operations", "virtual assistant", "admin", "administrative",
                            "executive assistant", "coordinator", "data entry", "logistics", "assistant"]),
    ("Education", ["teacher", "tutor", "instructor", "curriculum", "education", "trainer", "teaching"]),
]

SENIOR_WORDS = ["senior", "sr", "lead", "principal", "staff", "head", "director", "vp",
                "vice president", "chief", "architect"]
ENTRY_WORDS = ["junior", "jr", "entry level", "entry-level", "graduate", "trainee", "fresher", "associate"]
INTERN_WORDS = ["intern", "internship", "praktikum", "apprentice", "apprenticeship"]

RESTRICTED_LOC = ["us", "usa", "united states", "u.s.", "canada", "europe", "eu", "emea", "uk",
                  "united kingdom", "latam", "latin america", "germany", "australia", "philippines",
                  "mexico", "brazil", "spain", "france", "netherlands", "poland", "americas",
                  "north america", "south america", "africa", "new zealand", "ireland", "portugal",
                  "italy", "sweden", "switzerland", "japan", "singapore", "colombia", "argentina"]
DESC_BLOCK = [
    r"authori[sz]ed to work in the (us|united states|uk|eu)",
    r"(us|u\.s\.|uk|eu) (residents|citizens) only",
    r"must (be|reside|live) (based )?in the (us|united states|uk|europe|eu)",
    r"(security|government) clearance",
]

# ============================== HELPERS ==============================

SESSION = requests.Session()
SESSION.headers.update(HEADERS)

def get(url, params=None, as_json=True, retries=3):
    for attempt in range(retries):
        try:
            r = SESSION.get(url, params=params, timeout=TIMEOUT)
            if r.status_code == 429:
                time.sleep(int(r.headers.get("Retry-After", 10)))
                continue
            r.raise_for_status()
            if not r.text.strip():
                raise ValueError("empty response")
            return r.json() if as_json else r.text
        except (requests.RequestException, ValueError):
            if attempt == retries - 1:
                raise
            time.sleep(3 * (attempt + 1))

def has(text, words):
    return any(re.search(rf"(?<![a-z0-9]){re.escape(w)}(?![a-z0-9])", text) for w in words)

def text_of(raw):
    return BeautifulSoup(raw or "", "html.parser").get_text(" ", strip=True) if raw else ""

def to_dt(value):
    if value in (None, "", 0):
        return None
    try:
        if isinstance(value, (int, float)) or (isinstance(value, str) and value.isdigit()):
            v = int(value)
            if v > 10**12:   # milliseconds
                v //= 1000
            return datetime.fromtimestamp(v, tz=timezone.utc)
        dt = dtparser.parse(str(value))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except (ValueError, OverflowError, TypeError):
        return None

def min_years(text):
    nums = []
    for m in re.finditer(r"(?<!\d)(\d{1,2})\s*(?:\+|plus)?\s*(?:(?:-|–|to)\s*\d{1,2})?\s*\+?\s*years?", text):
        window = text[max(0, m.start() - 60): m.end() + 60]
        n = int(m.group(1))
        if "experience" in window and 0 < n <= 20:
            nums.append(n)
    return min(nums) if nums else None

def eligibility(location, desc):
    loc = (location or "").lower()
    if any(re.search(p, desc) for p in DESC_BLOCK):
        return "restricted"
    if has(loc, ["india"]):
        return "india"
    if has(loc, ["worldwide", "anywhere", "global", "remote anywhere"]):
        return "worldwide"
    if has(loc, ["apac", "asia", "asia pacific"]):
        return "apac"
    if not loc.strip() or loc.strip() == "remote":
        return "unknown"
    if has(loc, RESTRICTED_LOC):
        return "restricted"
    return "unknown"

def category(title, extra):
    t = f" {title.lower()} "
    for name, words in CATEGORY_RULES:
        if has(t, words):
            return name
    e = f" {extra.lower()} "
    for name, words in CATEGORY_RULES:
        if has(e, words):
            return name
    return "Other"

def job_type(raw, title):
    t = (raw or "").lower().replace("_", "-")
    if has(title.lower(), INTERN_WORDS) or "intern" in t:
        return "internship"
    if "part" in t:
        return "part-time"
    if "freelance" in t:
        return "freelance"
    if any(w in t for w in ("contract", "temporary", "temp")):
        return "contract"
    if "full" in t:
        return "full-time"
    return ""

def level(title, raw_level, jtype):
    t, lv = title.lower(), (raw_level or "").lower()
    if jtype == "internship":
        return "intern"
    if has(t, SENIOR_WORDS) or (has(lv, ["senior", "manager", "director", "executive"])
                                and not has(lv, ["entry", "mid", "midweight", "any"])):
        return "senior"
    if has(t, ENTRY_WORDS) or has(lv, ["entry", "entry-level", "junior"]):
        return "entry"
    if has(lv, ["mid", "mid-level", "midweight"]):
        return "mid"
    return ""

def money(lo, hi, currency="USD", period=""):
    try:
        lo, hi = float(lo or 0), float(hi or 0)
    except (TypeError, ValueError):
        return ""
    if lo <= 0 and hi <= 0:
        return ""
    sym = {"USD": "$", "EUR": "€", "GBP": "£", "INR": "₹"}.get((currency or "USD").upper(), (currency or "") + " ")
    fmt = lambda v: f"{sym}{v:,.0f}"
    rng = f"{fmt(lo)}–{fmt(hi)}" if lo and hi and lo != hi else fmt(lo or hi)
    per = {"year": "/yr", "yearly": "/yr", "annual": "/yr", "month": "/mo", "monthly": "/mo",
           "hour": "/hr", "hourly": "/hr"}.get((period or "").lower(), "")
    return rng + per

def build(src, title, company, location, apply_url, source_url, posted, desc_html,
          jtype_raw="", level_raw="", salary="", tags=None, cat_hint="", expires=None):
    title = html.unescape(title or "").strip()
    if not title or not apply_url:
        return None
    desc = text_of(desc_html)
    dl = desc.lower()
    tags = [html.unescape(t).strip() for t in (tags or []) if t and len(t) < 30][:6]
    jt = job_type(jtype_raw, title)
    return {
        "title": title,
        "company": html.unescape(company or "").strip(),
        "location": html.unescape(location or "").strip() or "Not stated",
        "eligibility": eligibility(location, dl),
        "category": category(title, " ".join(tags) + " " + (cat_hint or "")),
        "type": jt,
        "level": level(title, level_raw, jt),
        "salary": salary or "",
        "min_years": min_years(dl),
        "posted": None if posted is None else posted.strftime("%Y-%m-%dT%H:%MZ"),
        "_posted_dt": posted,
        "_expires": expires,
        "source": src,
        "source_name": SOURCE_INFO[src][0],
        "source_url": source_url or apply_url,
        "apply_url": apply_url,
        "tags": tags,
        "snippet": (desc[:SNIPPET_CHARS].rsplit(" ", 1)[0] + "…") if len(desc) > SNIPPET_CHARS else desc,
    }

# ============================== SOURCES ==============================

def fetch_remotive():
    data = get("https://remotive.com/api/remote-jobs")   # single request: all categories
    out = []
    for j in data.get("jobs", []):
        out.append(build("remotive", j.get("title"), j.get("company_name"),
                         j.get("candidate_required_location"), j.get("url"), j.get("url"),
                         to_dt(j.get("publication_date")), j.get("description"),
                         jtype_raw=j.get("job_type", ""), salary=(j.get("salary") or "").strip(),
                         tags=j.get("tags"), cat_hint=j.get("category", "")))
    return out

def fetch_remoteok():
    data = get("https://remoteok.com/api")
    out = []
    for j in data:
        if not isinstance(j, dict) or "position" not in j:
            continue
        url = j.get("url")   # Remote OK page: their terms require linking back to it
        out.append(build("remoteok", j.get("position"), j.get("company"), j.get("location"),
                         url, url, to_dt(j.get("epoch") or j.get("date")), j.get("description"),
                         salary=money(j.get("salary_min"), j.get("salary_max"), "USD", "year"),
                         tags=j.get("tags"), cat_hint=" ".join(j.get("tags") or [])))
    return out

def fetch_jobicy():
    data = get("https://jobicy.com/api/v2/remote-jobs", {"count": 200})
    out = []
    for j in data.get("jobs", []):
        ind = j.get("jobIndustry")
        ind = " ".join(ind) if isinstance(ind, list) else str(ind or "")
        jt = j.get("jobType")
        jt = " ".join(jt) if isinstance(jt, list) else str(jt or "")
        url = j.get("url")   # Jobicy job page (required by their free API terms)
        out.append(build("jobicy", j.get("jobTitle"), j.get("companyName"), j.get("jobGeo"),
                         url, url, to_dt(j.get("pubDate")), j.get("jobDescription") or j.get("jobExcerpt"),
                         jtype_raw=jt, level_raw=j.get("jobLevel", ""),
                         salary=money(j.get("salaryMin"), j.get("salaryMax"), j.get("salaryCurrency"),
                                      j.get("salaryPeriod")),
                         tags=[ind] if ind else [], cat_hint=ind))
    return out

def fetch_himalayas(q="", pages=HIMALAYAS_PAGES, keep=None):
    """India + worldwide jobs. `q` is Himalayas' own (loose) keyword search; `keep(text)` gets each job's
    full lowercased text and can drop weak matches."""
    out = []
    for scope in ({"country": "India"}, {"worldwide": "true"}):
        for page in range(1, pages + 1):
            data = get("https://himalayas.app/jobs/api/search",
                       {"sort": "recent", "page": page, **({"q": q} if q else {}), **scope})
            jobs = data.get("jobs", [])
            for j in jobs:
                loc = ", ".join(j.get("locationRestrictions") or []) or "Worldwide"
                cats = (j.get("categories") or []) + (j.get("parentCategories") or [])
                if keep and not keep(f"{j.get('title')} {j.get('companyName')} {' '.join(cats)} "
                                     f"{text_of(j.get('description') or j.get('excerpt'))}".lower()):
                    continue
                out.append(build("himalayas", j.get("title"), j.get("companyName"), loc,
                                 j.get("applicationLink"), "https://himalayas.app",
                                 to_dt(j.get("pubDate")), j.get("description") or j.get("excerpt"),
                                 jtype_raw=j.get("employmentType") or "",
                                 level_raw=" ".join(j.get("seniority") or []),
                                 salary=money(j.get("minSalary"), j.get("maxSalary"), j.get("currency"),
                                              j.get("salaryPeriod")),
                                 tags=cats[:4], cat_hint=" ".join(cats),
                                 expires=to_dt(j.get("expiryDate"))))
            if len(jobs) < 20:   # search returns 20 per page; fewer means the last page
                break
            time.sleep(1.5)
    return out

def fetch_arbeitnow():
    data = get("https://www.arbeitnow.com/api/job-board-api")
    return [build("arbeitnow", j.get("title"), j.get("company_name"), j.get("location"),
                  j.get("url"), j.get("url"), to_dt(j.get("created_at")), j.get("description"),
                  jtype_raw=" ".join(j.get("job_types") or []), tags=j.get("tags"),
                  cat_hint=" ".join(j.get("tags") or []))
            for j in data.get("data", []) if j.get("remote")]

def fetch_wwr():
    xml = get("https://weworkremotely.com/categories/remote-sales-and-marketing-jobs.rss", as_json=False)
    out = []
    for item in ET.fromstring(xml.encode("utf-8")).iter("item"):
        raw = item.findtext("title", "")
        company, _, title = raw.partition(": ")
        if not title:
            company, title = "", raw
        link = item.findtext("link", "")
        out.append(build("wwr", title, company, item.findtext("region", "") or "Remote", link, link,
                         to_dt(item.findtext("pubDate", "")), item.findtext("description", ""),
                         cat_hint=item.findtext("category", "")))
    return out

FETCHERS = {"remotive": fetch_remotive, "remoteok": fetch_remoteok, "jobicy": fetch_jobicy,
            "himalayas": fetch_himalayas, "arbeitnow": fetch_arbeitnow, "wwr": fetch_wwr}

# ============================== MAIN ==============================

def finalize(jobs, now, max_age_days=MAX_AGE_DAYS):
    """Drop old/expired jobs, remove duplicates, add ids and strip internal fields. Newest first."""
    cutoff = now - timedelta(days=max_age_days)
    seen, final = set(), []
    for j in sorted(jobs, key=lambda x: x["_posted_dt"] or cutoff, reverse=True):
        if j["_posted_dt"] and j["_posted_dt"] < cutoff:
            continue
        if j.get("_expires") and j["_expires"] < now:
            continue
        key = (re.sub(r"\W+", " ", j["title"].lower()).strip(), re.sub(r"\W+", " ", j["company"].lower()).strip())
        if key in seen:
            continue
        seen.add(key)
        j = {k: v for k, v in j.items() if k not in ("_posted_dt", "_expires")}
        j["id"] = re.sub(r"[^a-z0-9]+", "-", f"{j['source']}-{j['company']}-{j['title']}".lower())[:90].strip("-")
        final.append(j)
    return final

def load_previous():
    try:
        return json.loads(OUT_FILE.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {"jobs": [], "sources": {}}

def main():
    now = datetime.now(timezone.utc)
    previous = load_previous()
    jobs, sources = [], {}

    for key in ENABLED:
        name, home = SOURCE_INFO[key]
        try:
            got = [j for j in FETCHERS[key]() if j]
            sources[key] = {"name": name, "url": home, "ok": True, "count": len(got)}
            jobs.extend(got)
            print(f"  {name:<18} {len(got):>5}")
        except Exception as e:
            # Keep this source's jobs from the last successful run instead of losing them.
            kept = [j for j in previous.get("jobs", []) if j.get("source") == key]
            for j in kept:
                j["_posted_dt"] = to_dt(j.get("posted"))
                j["_expires"] = None
            jobs.extend(kept)
            sources[key] = {"name": name, "url": home, "ok": False, "count": len(kept),
                            "error": str(e)[:120]}
            print(f"  {name:<18} FAILED ({e}); kept {len(kept)} from last run", file=sys.stderr)
        time.sleep(2)

    final = finalize(jobs, now)

    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    payload = {"updated": now.strftime("%Y-%m-%dT%H:%MZ"), "count": len(final),
               "sources": sources, "jobs": final}
    # Write to a temp file, then swap it in, so visitors never download a half-written file.
    tmp = OUT_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    tmp.replace(OUT_FILE)
    print(f"\nWrote {len(final)} jobs to {OUT_FILE.relative_to(ROOT)} "
          f"({OUT_FILE.stat().st_size / 1024:.0f} KB)")
    if not any(s["ok"] for s in sources.values()):
        sys.exit(1)   # every source failed: make the GitHub Action show a red X

if __name__ == "__main__":
    main()
