/* Remote Job Finder - front end. Loads live listings from /api/jobs and does all searching in the browser. */
(function () {
  "use strict";

  const PAGE = 30;
  const REFRESH_MS = 5 * 60 * 1000;   // re-check for new listings while the page is open
  const DEFAULTS = { q: "", cat: "", type: "", elig: "india", level: "", days: "", salary: "", sort: "newest", tab: "all" };
  const TYPE_LABEL = { "full-time": "Full-time", "part-time": "Part-time", contract: "Contract", internship: "Internship", freelance: "Freelance" };
  const LEVEL_LABEL = { intern: "Intern", entry: "Entry level", mid: "Mid level", senior: "Senior" };
  const ELIG_LABEL = { india: "India ✓", worldwide: "Worldwide", apac: "APAC" };

  const $ = (id) => document.getElementById(id);
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  };

  let JOBS = [], META = {}, shown = PAGE;
  let LIVE = null;        // {q, jobs, failed, at} once a live search has finished
  let searching = null;   // {q, total, done, sources:[{name, status, count}]} while one is running
  let searchRun = 0;      // bumped on every search so a slow, older one can't overwrite a newer one
  let saved = store.get("rjf_saved", {});      // id -> job snapshot (kept even after the job leaves the feed)
  let applied = store.get("rjf_applied", {});  // id -> {job, at}
  const lastVisit = store.get("rjf_last_visit", null);
  const state = Object.assign({}, DEFAULTS);

  // ---------- URL state (shareable searches) ----------
  function readUrl() {
    const p = new URLSearchParams(location.search);
    Object.keys(DEFAULTS).forEach((k) => { if (p.has(k)) state[k] = p.get(k); });
  }
  function writeUrl() {
    const p = new URLSearchParams();
    Object.keys(DEFAULTS).forEach((k) => { if (state[k] && state[k] !== DEFAULTS[k]) p.set(k, state[k]); });
    const qs = p.toString();
    history.replaceState(null, "", qs ? "?" + qs : location.pathname);
  }

  // ---------- helpers ----------
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  function terms(q) {
    const out = [];
    (q || "").toLowerCase().replace(/"([^"]+)"|(\S+)/g, (_, a, b) => { const t = (a || b).trim(); if (t) out.push(t); });
    return out.map((t) => new RegExp("(^|[^a-z0-9])" + esc(t) + "($|[^a-z0-9])"));
  }
  function ageDays(job) {
    if (!job.posted) return null;
    return Math.max(0, Math.floor((Date.now() - Date.parse(job.posted)) / 86400000));
  }
  function ago(iso) {
    const h = Math.floor((Date.now() - Date.parse(iso)) / 3600000);
    if (h < 1) return "just now";
    if (h < 24) return h + "h ago";
    return Math.floor(h / 24) + "d ago";
  }
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  // ---------- filtering ----------
  function passes(job, skipCat) {
    if (!skipCat && state.cat && job.category !== state.cat) return false;
    if (state.type && job.type !== state.type) return false;
    if (state.level === "entry" && !(job.level === "intern" || job.level === "entry")) return false;
    if (state.level && state.level !== "entry" && job.level !== state.level) return false;
    if (state.salary && !job.salary) return false;
    if (state.days) { const a = ageDays(job); if (a === null || a > +state.days) return false; }
    const e = job.eligibility;
    if (state.elig === "india" && !(e === "india" || e === "worldwide" || e === "apac" || e === "unknown")) return false;
    if (state.elig === "india_only" && e !== "india") return false;
    if (state.elig === "worldwide" && e !== "worldwide") return false;
    return true;
  }
  function score(job, rx) {
    let s = 0;
    rx.forEach((r) => { if (r.test(job._title)) s += 10; else s += 2; });
    const a = ageDays(job);
    if (a !== null) s += Math.max(0, 10 - a / 3);
    return s;
  }
  function results() {
    const rx = terms(state.q);
    // After a live search the sources have already matched the words, so don't re-filter with our stricter rules.
    const useLive = !!LIVE && LIVE.q === state.q.trim() && state.tab === "all";
    const base = useLive ? LIVE.jobs : JOBS;
    let pool;
    if (state.tab === "saved") pool = Object.values(saved);
    else if (state.tab === "applied") pool = Object.values(applied).map((x) => x.job);
    else pool = base;
    const match = (j) => useLive || rx.every((r) => r.test(j._hay));
    const list = pool.filter((j) => match(j) && (state.tab !== "all" || passes(j)));
    if (state.sort === "best" && rx.length) list.sort((a, b) => score(b, rx) - score(a, rx));
    else list.sort((a, b) => (b.posted || "").localeCompare(a.posted || ""));
    // category counts for the chips (all filters except category)
    const counts = {};
    if (state.tab === "all") base.forEach((j) => { if (match(j) && passes(j, true)) counts[j.category] = (counts[j.category] || 0) + 1; });
    return { list, counts };
  }

  // ---------- rendering ----------
  function renderCats(counts) {
    const box = $("cats");
    box.innerHTML = "";
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const mk = (name, label, n) => {
      const b = el("button", "cat" + (state.cat === name ? " on" : ""), label);
      b.type = "button";
      if (n !== undefined) b.appendChild(el("span", null, String(n)));
      b.onclick = () => { state.cat = state.cat === name ? "" : name; update(true); };
      box.appendChild(b);
    };
    if (state.tab !== "all") { box.hidden = true; return; }
    box.hidden = false;
    mk("", "All", total);
    Object.entries(counts).sort((a, b) => b[1] - a[1]).forEach(([c, n]) => mk(c, c, n));
  }

  function card(job) {
    const a = el("article", "job");
    const main = el("div");
    main.appendChild(el("h3", null, job.title));
    main.appendChild(el("p", "co", (job.company || "Company not listed") + " · " + job.location));

    const chips = el("div", "chips");
    const add = (text, cls) => chips.appendChild(el("span", "chip" + (cls ? " " + cls : ""), text));
    if (lastVisit && job.posted && Date.parse(job.posted) > lastVisit && state.tab === "all") add("NEW", "new");
    if (ELIG_LABEL[job.eligibility]) add(ELIG_LABEL[job.eligibility], job.eligibility === "india" ? "good" : "");
    else if (job.eligibility === "unknown") add("Check location", "warn");
    else if (job.eligibility === "restricted") add("Location restricted", "warn");
    add(job.category);
    if (job.type) add(TYPE_LABEL[job.type] || job.type);
    if (job.level) add(LEVEL_LABEL[job.level] || job.level);
    if (job.salary) add(job.salary, "money");
    if (job.min_years) add("Asks " + job.min_years + "+ yrs", job.min_years > 3 ? "warn" : "");
    const d = ageDays(job);
    if (d !== null) add(d === 0 ? "Today" : d + "d ago");
    if (applied[job.id]) add("Applied " + new Date(applied[job.id].at).toLocaleDateString(), "good");
    main.appendChild(chips);

    if (job.snippet || (job.tags && job.tags.length)) {
      const det = el("details");
      det.appendChild(el("summary", null, "Details"));
      if (job.snippet) det.appendChild(el("p", null, job.snippet));
      if (job.tags && job.tags.length) det.appendChild(el("p", null, "Tags: " + job.tags.join(", ")));
      main.appendChild(det);
    }

    const act = el("div", "actions");
    const apply = el("a", "btn apply", "Apply ↗");
    apply.href = job.apply_url; apply.target = "_blank"; apply.rel = "noopener";
    const sv = el("button", "btn" + (saved[job.id] ? " saved" : ""), saved[job.id] ? "★ Saved" : "☆ Save");
    sv.type = "button";
    sv.onclick = () => {
      if (saved[job.id]) delete saved[job.id]; else saved[job.id] = job;
      store.set("rjf_saved", saved); update(false);
    };
    const ap = el("button", "btn" + (applied[job.id] ? " done" : ""), applied[job.id] ? "✓ Applied" : "Mark applied");
    ap.type = "button";
    ap.onclick = () => {
      if (applied[job.id]) delete applied[job.id]; else applied[job.id] = { job, at: Date.now() };
      store.set("rjf_applied", applied); update(false);
    };
    const via = el("div", "via");
    via.append("via ");
    const src = el("a", null, job.source_name);
    src.href = job.source_url; src.target = "_blank"; src.rel = "noopener";   // followable link back, as sources require
    via.appendChild(src);
    act.append(apply, sv, ap, via);

    a.append(main, act);
    return a;
  }

  function render() {
    const { list, counts } = results();
    renderCats(counts);
    $("n-saved").textContent = Object.keys(saved).length;
    $("n-applied").textContent = Object.keys(applied).length;
    document.querySelectorAll(".tab[data-tab]").forEach((t) => t.classList.toggle("on", t.dataset.tab === state.tab));
    document.querySelector(".filters").hidden = state.tab !== "all";

    const meta = $("meta");
    meta.innerHTML = "";
    const left = el("div");
    left.appendChild(el("b", null, list.length.toLocaleString() + (list.length === 1 ? " job" : " jobs")));
    if (state.tab === "all" && LIVE && LIVE.q === state.q.trim()) {
      left.append(" · searched live " + ago(new Date(LIVE.at).toISOString()));
      if (LIVE.failed.length) left.append(" · couldn't reach " + LIVE.failed.join(", "));
    } else if (state.tab === "all" && META.updated) left.append(" · updated " + ago(META.updated));
    meta.appendChild(left);
    if (state.tab === "applied" && list.length) {
      const ex = el("button", "export", "Download as CSV");
      ex.type = "button"; ex.onclick = exportCsv;
      meta.appendChild(ex);
    }

    const box = $("list");
    box.innerHTML = "";
    if (searching && state.tab === "all") {
      $("meta").innerHTML = "";
      $("cats").hidden = true;
      box.appendChild(progressEl());
      $("more").hidden = true;
      $("also").innerHTML = "";
      return;
    }
    if (!list.length) {
      const msg = state.tab === "all" && !JOBS.length ? "Jobs are being collected for the first time. Please check back in a few minutes."
        : state.tab === "saved" ? "No saved jobs yet. Tap ☆ Save on any job to keep it here."
        : state.tab === "applied" ? "Nothing marked as applied yet. Use “Mark applied” to track your applications."
        : "No jobs match. Try fewer words, “All locations”, or a longer time range.";
      box.appendChild(el("p", "empty", msg));
    }
    list.slice(0, shown).forEach((j) => box.appendChild(card(j)));
    $("more").hidden = list.length <= shown;
    $("more").textContent = "Show more (" + (list.length - shown) + " left)";

    // same search on other sites
    const also = $("also");
    also.innerHTML = "";
    const q = state.q.replace(/"/g, "").trim();
    if (q && state.tab === "all") {
      also.append("Also search “" + q + "” on: ");
      const slug = q.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      [["LinkedIn", "https://www.linkedin.com/jobs/search/?keywords=" + encodeURIComponent(q) + "&f_WT=2"],
       ["Internshala", "https://internshala.com/internships/keywords-" + encodeURIComponent(q) + "/"],
       ["Naukri", "https://www.naukri.com/" + slug + "-jobs"],
       ["Indeed India", "https://in.indeed.com/jobs?q=" + encodeURIComponent(q) + "&l=Remote"]]
        .forEach(([n, u]) => { const a = el("a", null, n); a.href = u; a.target = "_blank"; a.rel = "noopener nofollow"; also.appendChild(a); });
    }
  }

  function exportCsv() {
    const rows = [["Applied on", "Title", "Company", "Location", "Type", "Source", "Link"]];
    Object.values(applied).sort((a, b) => b.at - a.at).forEach(({ job, at }) =>
      rows.push([new Date(at).toISOString().slice(0, 10), job.title, job.company, job.location, job.type, job.source_name, job.apply_url]));
    const cell = (c) => { let v = String(c || ""); if (/^[=+\-@]/.test(v)) v = "'" + v; return '"' + v.replace(/"/g, '""') + '"'; };
    const csv = rows.map((r) => r.map(cell).join(",")).join("\n");
    const a = el("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = "my-job-applications.csv";
    document.body.appendChild(a); a.click(); a.remove();
  }

  // ---------- live search ----------
  // Asks each source for the keyword (one request per source) so the bar can show real progress.
  const SOURCE_KEYS = ["himalayas", "remoteok", "jobicy", "remotive"];
  const SOURCE_NAMES = { himalayas: "Himalayas", remoteok: "Remote OK", jobicy: "Jobicy", remotive: "Remotive" };

  function progressEl() {
    const pct = Math.round((searching.done / searching.total) * 100);
    const box = el("div", "progress");
    box.setAttribute("role", "status");
    box.appendChild(el("p", "progress-title", "Searching for “" + searching.q + "”… " + pct + "%"));
    const bar = el("div", "bar");
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-valuemin", "0"); bar.setAttribute("aria-valuemax", "100"); bar.setAttribute("aria-valuenow", String(pct));
    const fill = el("span"); fill.style.width = pct + "%";
    bar.appendChild(fill);
    box.appendChild(bar);
    const ul = el("ul", "progress-list");
    searching.sources.forEach((s) => {
      const text = s.status === "wait" ? "searching…" : s.status === "ok" ? s.count + (s.count === 1 ? " job" : " jobs") : "unavailable";
      ul.appendChild(el("li", s.status, (s.status === "ok" ? "✓ " : s.status === "fail" ? "✗ " : "• ") + s.name + " — " + text));
    });
    box.appendChild(ul);
    return box;
  }

  function liveSearch(q) {
    const run = ++searchRun;
    LIVE = null;
    if (!q) { searching = null; render(); return; }
    searching = { q, total: SOURCE_KEYS.length, done: 0,
      sources: SOURCE_KEYS.map((k) => ({ name: SOURCE_NAMES[k], status: "wait", count: 0 })) };
    render();
    const jobs = [], failed = [];
    let reachable = 0;
    const tasks = SOURCE_KEYS.map((k, i) =>
      fetch("/api/search?source=" + k + "&q=" + encodeURIComponent(q))
        .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
        .then((d) => {
          if (run !== searchRun) return;
          reachable++;
          if (d.ok) { jobs.push(...d.jobs); searching.sources[i].status = "ok"; searching.sources[i].count = d.jobs.length; }
          else { failed.push(SOURCE_NAMES[k]); searching.sources[i].status = "fail"; }
        })
        .catch(() => { if (run === searchRun) { failed.push(SOURCE_NAMES[k]); searching.sources[i].status = "fail"; } })
        .then(() => { if (run === searchRun) { searching.done++; render(); } }));
    Promise.all(tasks).then(() => {
      if (run !== searchRun) return;
      searching = null;
      if (!reachable) {
        // No /api/search (e.g. running the site without Netlify): fall back to searching the loaded listings.
        render();
        return;
      }
      // The same job can come from two sources; keep the first copy.
      const seen = new Set();
      const merged = jobs.filter((j) => {
        const key = (j.title + "|" + j.company).toLowerCase().replace(/\W+/g, " ").trim();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).map(prep);
      LIVE = { q, jobs: merged, failed, at: Date.now() };
      shown = PAGE;
      render();
    });
  }

  // ---------- wiring ----------
  const FIELDS = ["elig", "type", "level", "days", "sort"];
  function syncInputs() {
    $("q").value = state.q;
    FIELDS.forEach((f) => { $(f).value = state[f]; });
    $("salary").checked = !!state.salary;
  }
  function update(resetPaging) {
    if (resetPaging) shown = PAGE;
    writeUrl();
    render();
  }

  let timer;
  $("q").addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => { state.q = $("q").value; update(true); }, 250); });
  $("search-form").addEventListener("submit", (e) => {
    e.preventDefault();
    state.q = $("q").value;
    state.tab = "all";
    update(true);
    liveSearch(state.q.trim());
  });
  FIELDS.forEach((f) => $(f).addEventListener("change", () => { state[f] = $(f).value; update(true); }));
  $("salary").addEventListener("change", () => { state.salary = $("salary").checked ? "1" : ""; update(true); });
  $("reset").addEventListener("click", () => { Object.assign(state, DEFAULTS, { tab: state.tab }); syncInputs(); update(true); });
  $("more").addEventListener("click", () => { shown += PAGE; render(); });
  document.querySelectorAll(".tab[data-tab]").forEach((t) => t.addEventListener("click", () => { state.tab = t.dataset.tab; update(true); }));
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && document.activeElement !== $("q")) { e.preventDefault(); $("q").focus(); }
  });

  readUrl();
  syncInputs();
  $("list").appendChild(el("p", "empty", "Loading jobs…"));
  // Live listings come from the /api/jobs Netlify Function; data/jobs.json is only a fallback
  // for running the site locally without Netlify.
  const loadData = () =>
    fetch("/api/jobs", { cache: "no-cache" })
      .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .catch(() => fetch("data/jobs.json", { cache: "no-cache" })
        .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }));

  const prep = (j) => Object.assign(j, {
    _title: (j.title || "").toLowerCase(),
    _hay: [j.title, j.company, j.location, (j.tags || []).join(" "), j.snippet].join(" ").toLowerCase(),
  });

  function apply(data, first) {
    META = data;
    JOBS = data.jobs.map(prep);
    // saved/applied snapshots need search fields too
    Object.values(saved).concat(Object.values(applied).map((x) => x.job)).forEach(prep);
    const srcs = Object.values(data.sources || {});
    if (srcs.length) {
      const c = $("credits");
      c.textContent = "Listings from ";
      srcs.forEach((s, i) => {
        const a = el("a", null, s.name); a.href = s.url; a.target = "_blank"; a.rel = "noopener";
        c.appendChild(a);
        c.append(i < srcs.length - 2 ? ", " : i === srcs.length - 2 ? " and " : ".");
      });
    }
    if (first) store.set("rjf_last_visit", Date.now());
    render();
  }

  // A shared link with ?q= starts its live search straight away instead of waiting for the browse list.
  if (state.q.trim() && state.tab === "all") liveSearch(state.q.trim());

  loadData()
    .then((data) => {
      apply(data, true);
      // Pick up new listings while the page stays open.
      setInterval(() => {
        if (document.hidden) return;
        loadData().then((d) => apply(d, false)).catch(() => {});
      }, REFRESH_MS);
    })
    .catch((err) => {
      $("list").innerHTML = "";
      $("list").appendChild(el("p", "empty", "Couldn't load jobs (" + err.message + "). Please refresh the page."));
    });
})();
