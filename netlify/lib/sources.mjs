/*
 * sources.mjs - fetches remote job listings live from public job APIs and
 * normalises them into one shape. Used by the /api/jobs Netlify Function.
 * This is a port of fetch_jobs.py; keep the two in step if you change rules.
 *
 * Each source's rules are followed (see README "Sources and their rules"):
 * - Remotive: at most 4 fetches a day (the function caches it for 6 hours); link back and name Remotive.
 * - Remote OK: link to the job's Remote OK page (followable) and name Remote OK.
 * - Jobicy: apply links go to the Jobicy job page; credit Jobicy; at most one sync an hour.
 * - Himalayas: applicationLink used unchanged; visible link to Himalayas; expired jobs removed.
 * - None of them allow passing jobs to Google Jobs, so never add JobPosting structured data.
 */

export const MAX_AGE_DAYS = 45;
const HIMALAYAS_PAGES = 3;      // pages per Himalayas search (India + worldwide), kept small to fit the function time limit
const SNIPPET_CHARS = 260;
const TIMEOUT_MS = 8000;
const HEADERS = { "User-Agent": "RemoteJobFinder/1.0 (job listings site; respects source terms)" };

export const SOURCE_INFO = {
  remotive: { name: "Remotive", url: "https://remotive.com", ttlMs: 6 * 3600e3 },   // limit: 4 fetches a day
  remoteok: { name: "Remote OK", url: "https://remoteok.com", ttlMs: 15 * 60e3 },
  jobicy: { name: "Jobicy", url: "https://jobicy.com", ttlMs: 60 * 60e3 },          // limit: one sync an hour
  himalayas: { name: "Himalayas", url: "https://himalayas.app", ttlMs: 15 * 60e3 },
};

// Ordered: the first matching category wins (title is checked before source tags).
const CATEGORY_RULES = [
  ["Data & AI", ["data scientist", "data analyst", "data engineer", "machine learning", "ml engineer",
    "ai engineer", "analytics", "business intelligence", "bi developer", "llm", "data science"]],
  ["Design", ["designer", "ux", "ui", "graphic", "illustrator", "motion", "figma", "creative director"]],
  ["Marketing & SEO", ["seo", "marketing", "marketer", "growth", "ppc", "sem", "social media", "brand",
    "campaign", "community manager", "public relations", "media buyer", "aeo"]],
  ["Content & Writing", ["writer", "copywriter", "editor", "content", "journalist", "translator",
    "proofreader", "writing"]],
  ["Sales & Business", ["sales", "account executive", "business development", "bdr", "sdr",
    "account manager", "partnerships", "lead generation"]],
  ["Customer Support", ["support", "customer success", "customer service", "customer experience",
    "helpdesk", "help desk"]],
  ["Product & Project", ["product manager", "product owner", "project manager", "program manager",
    "scrum master", "delivery manager", "product"]],
  ["Software & IT", ["engineer", "developer", "devops", "sre", "software", "programmer", "frontend",
    "front-end", "backend", "back-end", "full stack", "fullstack", "qa", "tester",
    "sysadmin", "cloud", "security", "mobile", "ios", "android", "web"]],
  ["Finance & Legal", ["accountant", "accounting", "finance", "financial", "bookkeeper", "legal",
    "lawyer", "paralegal", "compliance", "tax", "payroll", "auditor"]],
  ["HR & Recruiting", ["recruiter", "recruiting", "talent", "hr", "human resources", "people operations"]],
  ["Operations & Admin", ["operations", "virtual assistant", "admin", "administrative",
    "executive assistant", "coordinator", "data entry", "logistics", "assistant"]],
  ["Education", ["teacher", "tutor", "instructor", "curriculum", "education", "trainer", "teaching"]],
];

const SENIOR_WORDS = ["senior", "sr", "lead", "principal", "staff", "head", "director", "vp",
  "vice president", "chief", "architect"];
const ENTRY_WORDS = ["junior", "jr", "entry level", "entry-level", "graduate", "trainee", "fresher", "associate"];
const INTERN_WORDS = ["intern", "internship", "praktikum", "apprentice", "apprenticeship"];

const RESTRICTED_LOC = ["us", "usa", "united states", "u.s.", "canada", "europe", "eu", "emea", "uk",
  "united kingdom", "latam", "latin america", "germany", "australia", "philippines",
  "mexico", "brazil", "spain", "france", "netherlands", "poland", "americas",
  "north america", "south america", "africa", "new zealand", "ireland", "portugal",
  "italy", "sweden", "switzerland", "japan", "singapore", "colombia", "argentina"];
const DESC_BLOCK = [
  /authori[sz]ed to work in the (us|united states|uk|eu)/,
  /(us|u\.s\.|uk|eu) (residents|citizens) only/,
  /must (be|reside|live) (based )?in the (us|united states|uk|europe|eu)/,
  /(security|government) clearance/,
];

// ============================== HELPERS ==============================

async function getJson(url, params) {
  const u = new URL(url);
  Object.entries(params || {}).forEach(([k, v]) => u.searchParams.set(k, v));
  const r = await fetch(u, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const text = await r.text();
  if (!text.trim()) throw new Error("empty response");
  return JSON.parse(text);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const has = (text, words) =>
  words.some((w) => new RegExp(`(?<![a-z0-9])${escapeRe(w)}(?![a-z0-9])`).test(text));

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘" };
function unescapeHtml(s) {
  return String(s ?? "").replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
const textOf = (raw) =>
  raw ? unescapeHtml(String(raw).replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ").trim() : "";

function toDate(value) {
  if (value === null || value === undefined || value === "" || value === 0) return null;
  let d;
  if (typeof value === "number" || /^\d+$/.test(String(value))) {
    let v = Number(value);
    if (v > 1e12) v = Math.floor(v / 1000);   // milliseconds
    d = new Date(v * 1000);
  } else {
    d = new Date(String(value));
  }
  return Number.isNaN(d.getTime()) ? null : d;
}

function minYears(text) {
  const nums = [];
  const re = /(?<!\d)(\d{1,2})\s*(?:\+|plus)?\s*(?:(?:-|–|to)\s*\d{1,2})?\s*\+?\s*years?/g;
  for (const m of text.matchAll(re)) {
    const window = text.slice(Math.max(0, m.index - 60), m.index + m[0].length + 60);
    const n = parseInt(m[1], 10);
    if (window.includes("experience") && n > 0 && n <= 20) nums.push(n);
  }
  return nums.length ? Math.min(...nums) : null;
}

function eligibility(location, desc) {
  const loc = (location || "").toLowerCase();
  if (DESC_BLOCK.some((re) => re.test(desc))) return "restricted";
  if (has(loc, ["india"])) return "india";
  if (has(loc, ["worldwide", "anywhere", "global", "remote anywhere"])) return "worldwide";
  if (has(loc, ["apac", "asia", "asia pacific"])) return "apac";
  if (!loc.trim() || loc.trim() === "remote") return "unknown";
  if (has(loc, RESTRICTED_LOC)) return "restricted";
  return "unknown";
}

function category(title, extra) {
  const t = ` ${title.toLowerCase()} `;
  for (const [name, words] of CATEGORY_RULES) if (has(t, words)) return name;
  const e = ` ${extra.toLowerCase()} `;
  for (const [name, words] of CATEGORY_RULES) if (has(e, words)) return name;
  return "Other";
}

function jobType(raw, title) {
  const t = (raw || "").toLowerCase().replaceAll("_", "-");
  if (has(title.toLowerCase(), INTERN_WORDS) || t.includes("intern")) return "internship";
  if (t.includes("part")) return "part-time";
  if (t.includes("freelance")) return "freelance";
  if (["contract", "temporary", "temp"].some((w) => t.includes(w))) return "contract";
  if (t.includes("full")) return "full-time";
  return "";
}

function level(title, rawLevel, jtype) {
  const t = title.toLowerCase(), lv = (rawLevel || "").toLowerCase();
  if (jtype === "internship") return "intern";
  if (has(t, SENIOR_WORDS) ||
      (has(lv, ["senior", "manager", "director", "executive"]) && !has(lv, ["entry", "mid", "midweight", "any"]))) return "senior";
  if (has(t, ENTRY_WORDS) || has(lv, ["entry", "entry-level", "junior"])) return "entry";
  if (has(lv, ["mid", "mid-level", "midweight"])) return "mid";
  return "";
}

function money(lo, hi, currency = "USD", period = "") {
  lo = Number(lo) || 0; hi = Number(hi) || 0;
  if (lo <= 0 && hi <= 0) return "";
  const cur = (currency || "USD").toUpperCase();
  const sym = { USD: "$", EUR: "€", GBP: "£", INR: "₹" }[cur] ?? `${currency || ""} `;
  const fmt = (v) => `${sym}${Math.round(v).toLocaleString("en-US")}`;
  const rng = lo && hi && lo !== hi ? `${fmt(lo)}–${fmt(hi)}` : fmt(lo || hi);
  const per = { year: "/yr", yearly: "/yr", annual: "/yr", month: "/mo", monthly: "/mo", hour: "/hr", hourly: "/hr" }[(period || "").toLowerCase()] ?? "";
  return rng + per;
}

function build(src, { title, company, location, applyUrl, sourceUrl, posted, descHtml,
  jtypeRaw = "", levelRaw = "", salary = "", tags = [], catHint = "", expires = null }) {
  title = unescapeHtml(title).trim();
  if (!title || !applyUrl) return null;
  const desc = textOf(descHtml);
  const dl = desc.toLowerCase();
  tags = (tags || []).filter((t) => t && t.length < 30).map((t) => unescapeHtml(t).trim()).slice(0, 6);
  const jt = jobType(jtypeRaw, title);
  return {
    title,
    company: unescapeHtml(company).trim(),
    location: unescapeHtml(location).trim() || "Not stated",
    eligibility: eligibility(location, dl),
    category: category(title, `${tags.join(" ")} ${catHint || ""}`),
    type: jt,
    level: level(title, levelRaw, jt),
    salary: salary || "",
    min_years: minYears(dl),
    posted: posted ? posted.toISOString().slice(0, 16) + "Z" : null,
    expires: expires ? expires.toISOString() : null,
    source: src,
    source_name: SOURCE_INFO[src].name,
    source_url: sourceUrl || applyUrl,
    apply_url: applyUrl,
    tags,
    snippet: desc.length > SNIPPET_CHARS ? desc.slice(0, SNIPPET_CHARS).replace(/\s+\S*$/, "") + "…" : desc,
  };
}

// ============================== SOURCES ==============================

async function fetchRemotive() {
  const data = await getJson("https://remotive.com/api/remote-jobs");   // single request: all categories
  return (data.jobs || []).map((j) => build("remotive", {
    title: j.title, company: j.company_name, location: j.candidate_required_location,
    applyUrl: j.url, sourceUrl: j.url, posted: toDate(j.publication_date), descHtml: j.description,
    jtypeRaw: j.job_type || "", salary: (j.salary || "").trim(), tags: j.tags, catHint: j.category || "",
  }));
}

async function fetchRemoteOk() {
  const data = await getJson("https://remoteok.com/api");
  return data.filter((j) => j && typeof j === "object" && "position" in j).map((j) => build("remoteok", {
    title: j.position, company: j.company, location: j.location,
    applyUrl: j.url, sourceUrl: j.url,   // Remote OK page: their terms require linking back to it
    posted: toDate(j.epoch || j.date), descHtml: j.description,
    salary: money(j.salary_min, j.salary_max, "USD", "year"),
    tags: j.tags, catHint: (j.tags || []).join(" "),
  }));
}

async function fetchJobicy() {
  const data = await getJson("https://jobicy.com/api/v2/remote-jobs", { count: 200 });
  const joined = (v) => (Array.isArray(v) ? v.join(" ") : String(v ?? ""));
  return (data.jobs || []).map((j) => {
    const ind = joined(j.jobIndustry);
    return build("jobicy", {
      title: j.jobTitle, company: j.companyName, location: j.jobGeo,
      applyUrl: j.url, sourceUrl: j.url,   // Jobicy job page (required by their free API terms)
      posted: toDate(j.pubDate), descHtml: j.jobDescription || j.jobExcerpt,
      jtypeRaw: joined(j.jobType), levelRaw: j.jobLevel || "",
      salary: money(j.salaryMin, j.salaryMax, j.salaryCurrency, j.salaryPeriod),
      tags: ind ? [ind] : [], catHint: ind,
    });
  });
}

/**
 * Himalayas jobs for India and worldwide. `q` (optional) is a keyword search done by Himalayas itself; its
 * matching is loose, so `keep(text)` (optional) gets each job's full text, lowercased, and can drop weak matches.
 */
async function fetchHimalayas(q = "", pages = HIMALAYAS_PAGES, keep = null) {
  const scopeJobs = async (scope) => {
    const out = [];
    for (let page = 1; page <= pages; page++) {
      const data = await getJson("https://himalayas.app/jobs/api/search",
        { sort: "recent", page, ...(q ? { q } : {}), ...scope });
      const jobs = data.jobs || [];
      for (const j of jobs) {
        const cats = [...(j.categories || []), ...(j.parentCategories || [])];
        if (keep && !keep(`${j.title} ${j.companyName} ${cats.join(" ")} ${textOf(j.description || j.excerpt)}`.toLowerCase())) continue;
        out.push(build("himalayas", {
          title: j.title, company: j.companyName,
          location: (j.locationRestrictions || []).join(", ") || "Worldwide",
          applyUrl: j.applicationLink, sourceUrl: "https://himalayas.app",
          posted: toDate(j.pubDate), descHtml: j.description || j.excerpt,
          jtypeRaw: j.employmentType || "", levelRaw: (j.seniority || []).join(" "),
          salary: money(j.minSalary, j.maxSalary, j.currency, j.salaryPeriod),
          tags: cats.slice(0, 4), catHint: cats.join(" "), expires: toDate(j.expiryDate),
        }));
      }
      if (jobs.length < 20) break;   // Himalayas search returns 20 per page; fewer means the last page
    }
    return out;
  };
  const [india, worldwide] = await Promise.all([scopeJobs({ country: "India" }), scopeJobs({ worldwide: "true" })]);
  return [...india, ...worldwide];
}

export const searchHimalayas = (q, keep) => fetchHimalayas(q, 2, keep);

export const FETCHERS = { remotive: fetchRemotive, remoteok: fetchRemoteOk, jobicy: fetchJobicy, himalayas: () => fetchHimalayas() };

// ============================== MERGE ==============================

/** Merge per-source job lists: drop old/expired jobs, de-duplicate, add ids, newest first. */
export function mergeJobs(lists, now = new Date()) {
  const cutoff = new Date(now.getTime() - MAX_AGE_DAYS * 864e5);
  const norm = (s) => s.toLowerCase().replace(/\W+/g, " ").trim();
  const seen = new Set();
  const out = [];
  const all = lists.flat().filter(Boolean)
    .sort((a, b) => new Date(b.posted || cutoff) - new Date(a.posted || cutoff));
  for (const j of all) {
    if (j.posted && new Date(j.posted) < cutoff) continue;
    if (j.expires && new Date(j.expires) < now) continue;
    const key = `${norm(j.title)}|${norm(j.company)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const { expires, ...job } = j;
    job.id = `${j.source}-${j.company}-${j.title}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 90).replace(/^-|-$/g, "");
    out.push(job);
  }
  return out;
}
