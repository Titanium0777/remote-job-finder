#!/usr/bin/env python3
"""
local_server.py - runs the whole job finder on your own computer.

    .venv/bin/python local_server.py        then open http://localhost:8765  (PORT=1234 to change)

Serves site/ and the same two endpoints the Netlify version has:
  /api/jobs                       all listings
  /api/search?source=KEY&q=WORDS  one source's results for a keyword (the page calls this once per source
                                  and shows a progress bar as they finish)
plus /api/sources (the list of sources). It only listens on this computer (127.0.0.1).

Each source is fetched live, but never more often than its rules allow (see TTL below). Fetched feeds are
saved in .cache/ so restarting doesn't fetch Remotive again (it allows 4 fetches a day).
"""

import json
import os
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import fetch_jobs as fj
from boards import fetch_boards

ROOT = Path(__file__).resolve().parent
SITE = ROOT / "site"
CACHE_FILE = ROOT / ".cache" / "feeds.json"
HOST, PORT = "127.0.0.1", int(os.environ.get("PORT", 8765))
MAX_QUERY_CHARS = 80
QUERY_TTL = 15 * 60

# source key -> (fetch function, seconds a fetched copy is reused, searched by feed or live?)
SOURCES = {
    "himalayas": (fj.fetch_himalayas, 15 * 60, "live"),     # has keyword search: queried per keyword
    "boards":    (fetch_boards,       30 * 60, "feed"),     # many small APIs: fetched together, then searched
    "remoteok":  (fj.fetch_remoteok,  15 * 60, "feed"),
    "jobicy":    (fj.fetch_jobicy,    60 * 60, "feed"),     # their limit: one sync an hour
    "remotive":  (fj.fetch_remotive,  6 * 3600, "feed"),    # their limit: 4 fetches a day
}
FAIL_RETRY = 5 * 60

_feeds = {}                                   # key -> {"fetched": ts, "tried": ts, "jobs": [...], "error": str}
_locks = {k: threading.Lock() for k in SOURCES}
_queries = {}                                 # (source, q) -> (ts, jobs)

# ---------- cache ----------

def _jsonable(jobs):
    return [{k: (v.isoformat() if isinstance(v, datetime) else v) for k, v in j.items()} for j in jobs]

def _revive(jobs):
    for j in jobs:
        for k in ("_posted_dt", "_expires"):
            j[k] = fj.to_dt(j.get(k))
    return jobs

def load_cache():
    try:
        for k, rec in json.loads(CACHE_FILE.read_text(encoding="utf-8")).items():
            if k in SOURCES:
                rec["jobs"] = _revive(rec["jobs"])
                _feeds[k] = rec
    except (FileNotFoundError, json.JSONDecodeError, KeyError):
        pass

def save_cache():
    CACHE_FILE.parent.mkdir(exist_ok=True)
    data = {k: dict(rec, jobs=_jsonable(rec["jobs"])) for k, rec in _feeds.items()}
    tmp = CACHE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(data), encoding="utf-8")
    tmp.replace(CACHE_FILE)

def feed(key):
    """Cached jobs for a source, fetching live first if the copy is older than the source allows."""
    fetch, ttl, _ = SOURCES[key]
    with _locks[key]:
        rec, now = _feeds.get(key), time.time()
        if rec and now - rec["fetched"] < ttl:
            return rec
        if rec and rec.get("error") and now - rec["tried"] < FAIL_RETRY:
            return rec
        try:
            print(f"fetching {key} …", flush=True)
            jobs = [j for j in fetch() if j]
            if not jobs:
                raise ValueError("no jobs returned")
            rec = {"fetched": now, "tried": now, "jobs": jobs}
        except Exception as e:
            print(f"  {key} failed: {e}", file=sys.stderr, flush=True)
            rec = {"fetched": rec["fetched"] if rec else 0, "tried": now,
                   "jobs": rec["jobs"] if rec else [], "error": str(e)[:120]}
        _feeds[key] = rec
        save_cache()
        return rec

# ---------- searching ----------

def query_terms(q):
    """Words must all match; "quoted phrases" match as one term. Same rules as the page's search."""
    terms = [(a or b).strip() for a, b in re.findall(r'"([^"]+)"|(\S+)', q.lower())]
    return [re.compile(rf"(^|[^a-z0-9]){re.escape(t)}($|[^a-z0-9])") for t in terms if t]

def filter_jobs(jobs, q):
    rx = query_terms(q)
    def hay(j):
        return " ".join([j["title"], j["company"], j["location"], " ".join(j["tags"]), j["snippet"]]).lower()
    return [j for j in jobs if all(r.search(hay(j)) for r in rx)]

def iso(ts):
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%MZ") if ts else None

def search_source(key, q):
    _, _, mode = SOURCES[key]
    name, url = fj.SOURCE_INFO[key]
    base = {"source": key, "name": name, "url": url, "live": mode == "live"}
    now = datetime.now(timezone.utc)
    if mode == "feed":
        rec = feed(key)
        return {**base, "ok": not rec.get("error"), **({"error": rec["error"]} if rec.get("error") else {}),
                "fetched": iso(rec["fetched"]), "jobs": fj.finalize(filter_jobs(rec["jobs"], q), now)}
    ck = (key, " ".join(q.lower().split()))
    hit = _queries.get(ck)
    if not hit or time.time() - hit[0] >= QUERY_TTL:
        try:
            rx = query_terms(q)
            jobs = fj.fetch_himalayas(q.replace('"', " ").strip(), 2, lambda text: all(r.search(text) for r in rx))
        except Exception as e:
            return {**base, "ok": False, "error": str(e)[:120], "fetched": None, "jobs": []}
        hit = _queries[ck] = (time.time(), [j for j in jobs if j])
    return {**base, "ok": True, "fetched": iso(hit[0]), "jobs": fj.finalize(hit[1], now)}

def all_jobs():
    now = datetime.now(timezone.utc)
    with ThreadPoolExecutor(max_workers=len(SOURCES)) as pool:
        recs = dict(zip(SOURCES, pool.map(feed, SOURCES)))
    sources = {k: {"name": fj.SOURCE_INFO[k][0], "url": fj.SOURCE_INFO[k][1], "ok": not r.get("error"),
                   "count": len(r["jobs"]), "fetched": iso(r["fetched"])} for k, r in recs.items()}
    jobs = fj.finalize([j for r in recs.values() for j in r["jobs"]], now)
    newest = max((r["fetched"] for r in recs.values()), default=0)
    return {"updated": iso(newest) or "", "count": len(jobs), "sources": sources, "jobs": jobs}

# ---------- HTTP ----------

TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
         ".json": "application/json", ".txt": "text/plain; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png"}

class Handler(BaseHTTPRequestHandler):
    def reply(self, body, status=200, ctype="application/json; charset=utf-8"):
        if not isinstance(body, bytes):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlparse(self.path)
        qs = {k: v[0] for k, v in parse_qs(url.query).items()}
        try:
            if url.path == "/api/sources":
                return self.reply([{"key": k, "name": fj.SOURCE_INFO[k][0], "url": fj.SOURCE_INFO[k][1]} for k in SOURCES])
            if url.path == "/api/jobs":
                return self.reply(all_jobs())
            if url.path == "/api/search":
                key, q = qs.get("source", ""), qs.get("q", "").strip()
                if key not in SOURCES:
                    return self.reply({"error": "unknown source"}, 400)
                if not q or len(q) > MAX_QUERY_CHARS:
                    return self.reply({"error": f"q must be 1-{MAX_QUERY_CHARS} characters"}, 400)
                return self.reply(search_source(key, q))
        except Exception as e:
            print("error:", e, file=sys.stderr)
            return self.reply({"error": "server error"}, 500)
        # static files from site/ (resolved so ../ can't escape the folder)
        rel = "index.html" if url.path == "/" else url.path.lstrip("/")
        f = (SITE / rel).resolve()
        if SITE.resolve() not in f.parents or not f.is_file():
            return self.reply(b"Not found", 404, "text/plain")
        self.reply(f.read_bytes(), 200, TYPES.get(f.suffix, "application/octet-stream"))

    def log_message(self, fmt, *args):
        if "/api/" in (args[0] if args else ""):
            print(" ", fmt % args, flush=True)

if __name__ == "__main__":
    load_cache()
    print(f"Remote Job Finder running at http://localhost:{PORT}  (Ctrl+C to stop)")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
