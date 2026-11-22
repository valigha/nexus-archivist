#!/usr/bin/env node
/**
 * HentaiNexus CBZ archivist.
 * Search and /view/{id} pages give the metadata. The images come from the
 * site's own /zip/{id} download, using the login saved from the dashboard.
 * The zip is turned into a CBZ by adding ComicInfo.xml. Nothing from the
 * reader pages is decoded.
 */
import { createServer } from "node:http";
import net from "node:net";
import dns from "node:dns";
import { timingSafeEqual } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, rename, rm, stat, writeFile, appendFile } from "node:fs/promises";
import { readFileSync, createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ORIGIN = process.env.HN_ORIGIN || "https://hentainexus.com";

// Node gives each address only 250 ms to connect before trying the next one,
// and fails with ETIMEDOUT when all of them are slow once. Allow longer, and
// try IPv4 first because Docker bridge networks usually have no IPv6.
net.setDefaultAutoSelectFamilyAttemptTimeout(Math.max(250, Number(process.env.CONNECT_TIMEOUT_MS) || 5000));
dns.setDefaultResultOrder("ipv4first");
const VERSION = "1.5.3";
const UNSAFE = /\b(lolicon|loli|shotacon|shota|toddlercon|toddler|preteen|underage|pedo|pedophilia)\b/i;
const HERE = dirname(fileURLToPath(import.meta.url));

loadDotenv(process.env.ENV_FILE || "/app/config/.env");

const cfg = {
  library: process.env.LIBRARY_PATH || "/app/library/",
  split: Math.max(0, Number(process.env.LIBRARY_SPLIT) || 0),
  downloadme: process.env.DOWNLOADME_FILEPATH || "/app/config/downloadme.txt",
  dont: process.env.DONTDOWNLOADME_FILEPATH || "/app/config/dontdownloadme.txt",
  sleep: Math.max(0, Number(process.env.SLEEP_INTERVAL) || 3600),
  delay: Math.max(200, Number(process.env.REQUEST_DELAY_MS) || 1500),
  streakCap: Math.max(0, Number(process.env.CATCH_UP_STREAK) || 40),
  maxPerCycle: Math.max(0, Number(process.env.MAX_PER_CYCLE) || 10),
  // File names start with this prefix so a library shared with another tool
  // (whose names start with a bare number) never mixes up the two sites' ids.
  prefix: String(process.env.FILE_PREFIX ?? "HN").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 8),
  zipTimeout: Math.max(60, Number(process.env.ZIP_TIMEOUT_SEC) || 900),
  cooldown: Math.max(1, Number(process.env.ZIP_COOLDOWN_SEC) || 120),
  stall: Math.max(2, Number(process.env.ZIP_STALL_SEC) || 30),
  importKey: process.env.LIBRARY_IMPORT_KEY || "",
  ua: process.env.USER_AGENT
    || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  dry: flag(process.env.DRY_RUN),
  once: flag(process.env.RUN_ONCE),
  cleanup: process.env.CLEANUP_TEMPORARY_FILES == null ? true : flag(process.env.CLEANUP_TEMPORARY_FILES),
  port: Math.max(0, Number(process.env.STATUS_PORT) || 8100),
};

const logBuffer = [];
const status = {
  version: VERSION,
  state: "starting",
  paused: false,
  cycle: 0,
  libraryCount: 0, // books this tool wrote (names with the prefix)
  libraryTotal: 0, // every .cbz in the library, including other tools' books
  libraryScanning: false,
  libraryScannedAt: null,
  addedThisCycle: 0,
  skippedThisCycle: 0,
  failedThisCycle: 0,
  blockedThisCycle: 0,
  searchPage: 0,
  searchPages: 0,
  downloadDone: 0,
  downloadTotal: 0,
  currentId: null,
  currentTitle: "",
  message: "",
  running: false,
  nextDownloadAt: null,
  downloadDelaySec: 180,
  login: { loggedIn: false, expired: false, user: "", since: null },
  tagsInput: "",
  tags: "",
  chips: [],
  chipProblems: [],
  pageLimit: 10,
  searchLimit: 0,
  wantBatch: { total: 0, done: 0 },
  wantRecent: [],
  cycleStartedAt: null,
  sleepUntil: null,
  wantQueue: [],
  recent: [],
  startedAt: new Date().toISOString(),
};

// Search query chips. Prefixes are the ones the site's search understands.
const CHIP_TYPES = ["tag", "artist", "author", "circle", "event", "magazine", "parody", "publisher", "title", "description"];
const SUGGEST_TYPES = ["tag", "artist", "author", "circle", "event", "magazine", "parody", "publisher"];

function chipTerm(c) {
  const v = /^[A-Za-z0-9_-]+$/.test(c.value) ? c.value : `"${c.value}"`;
  return `${c.not ? "-" : ""}${c.type}:${v}`;
}

function chipsToQuery(chips) {
  return chips.map(chipTerm).join(" ");
}

// Turns an old free-text query (or HN_TAGS) into chips. Bare words are tags.
// Also accepts a bracketed, comma-separated list such as
// [language:"english", -tag:"unbirth"]. Filters the site cannot search (for
// example language:) are left out and their names are added to `skipped`.
function parseQueryToChips(text, skipped = []) {
  const out = [];
  const cleaned = String(text || "").replace(/("[^"]*")|[\[\],]/g, (m, quoted) => quoted || " ");
  for (const m of cleaned.matchAll(/(-?)(?:([a-z]+):)?("([^"]*)"|[^\s"]+)/gi)) {
    const type = (m[2] || "tag").toLowerCase();
    const value = (m[4] ?? m[3] ?? "").trim();
    if (!value || !/[\p{L}\p{N}]/u.test(value)) continue;
    if (!CHIP_TYPES.includes(type)) { skipped.push(`${type}:${value}`); continue; }
    out.push({ type, value, not: m[1] === "-" });
  }
  return cleanChips(out) || [];
}

// Returns a clean list, or null when the input is not acceptable.
function cleanChips(list) {
  if (!Array.isArray(list) || list.length > 60) return null;
  const seen = new Map();
  for (const c of list) {
    if (!c || typeof c !== "object") return null;
    const type = String(c.type || "").toLowerCase();
    const value = String(c.value ?? "").replace(/\s+/g, " ").trim();
    if (!CHIP_TYPES.includes(type)) return null;
    if (!value || value.length > 100 || /["\u0000-\u001f]/.test(value)) return null;
    seen.set(`${type}:${value.toLowerCase()}`, { type, value, not: c.not === true });
  }
  return [...seen.values()];
}

const skippedFilters = [];
let liveChips = parseQueryToChips(process.env.HN_TAGS || "", skippedFilters);
let liveTags = chipsToQuery(liveChips);
// Search only the newest N pages each cycle; 0 means every page the site has.
const envPages = process.env.MAX_SEARCH_PAGES;
let pageLimit = envPages !== undefined && envPages !== "" ? Math.max(0, Math.floor(Number(envPages)) || 0) : 10;
let wantBatch = { total: 0, done: 0 };
let wantRecent = [];
// Nothing runs until the user presses Start in the dashboard.
let paused = true;
let queueArmed = false;
let stopCtl = new AbortController(); // aborted by Stop so a running download ends at once
let stopEpoch = 0; // bumped by Stop so waits for the delay can be cancelled
let downloadDelaySec = 180;
let lastDownloadEnd = 0;
let loginBusy = false;
let runNow = false;
let shuttingDown = false;
let wantQueue = [];
let wantBusy = false;
let authFailed = false;
let sleepTimer = null;
let sleepResolve = null;
let lastHtmlAt = 0;

const livePath = join(dirname(cfg.downloadme), "nexus.json");

function flag(v) {
  return /^(1|true|yes|on)$/i.test(String(v || ""));
}

function loadDotenv(path) {
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#") || !t.includes("=")) continue;
      const i = t.indexOf("=");
      const key = t.slice(0, i).trim();
      let val = t.slice(i + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      if (process.env[key] == null || process.env[key] === "") process.env[key] = val;
    }
  } catch { /* no file */ }
}

function decode(s) {
  return String(s || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0*39;|&#x27;|&apos;/gi, "'")
    .replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

function xml(s) {
  return String(s ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const NET_HINTS = {
  ENOTFOUND: "DNS could not resolve the host. Check Pi-hole/AdGuard/router blocking, or give the container a DNS server (Extra Parameters: --dns 1.1.1.1).",
  EAI_AGAIN: "DNS lookup timed out. Check the container DNS (Extra Parameters: --dns 1.1.1.1).",
  ENETUNREACH: "Network unreachable, often broken IPv6. Try variable NODE_OPTIONS=--dns-result-order=ipv4first.",
  EHOSTUNREACH: "Host unreachable. Check routing, VPN and firewall.",
  ECONNREFUSED: "Connection refused. Something is blocking the connection (firewall, VPN, ISP).",
  ECONNRESET: "Connection was reset. The site or a firewall closed it; this can be bot protection.",
  ETIMEDOUT: "Connection timed out. Check firewall, VPN and IPv6 routing.",
  UND_ERR_CONNECT_TIMEOUT: "Connection timed out. Check firewall, VPN and IPv6 routing.",
  CERT_HAS_EXPIRED: "TLS certificate problem. Check the Unraid clock and any HTTPS-intercepting proxy.",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "TLS certificate problem. Check for an HTTPS-intercepting proxy or filter.",
};

/** Turn Node's opaque "fetch failed" into the real reason plus a hint. */
function describeError(err) {
  if (!(err instanceof Error)) return String(err);
  if (err.detail) return err.detail;
  const cause = err.cause;
  if (!cause) return err.name === "TimeoutError" ? "request timed out" : err.message;
  const first = Array.isArray(cause.errors) ? cause.errors[0] : null;
  const code = cause.code || first?.code || "";
  const detail = cause.message || first?.message || "";
  const hint = NET_HINTS[code];
  return `${err.message}: ${[code, detail].filter(Boolean).join(" ")}${hint ? ` - ${hint}` : ""}`;
}

function isTransient(err) {
  const code = err?.cause?.code || "";
  return err?.name === "TimeoutError" || ["ECONNRESET", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "EAI_AGAIN"].includes(code);
}

function sleep(ms) {
  return new Promise((resolve) => {
    sleepResolve = resolve;
    sleepTimer = setTimeout(() => { sleepTimer = null; sleepResolve = null; resolve(); }, ms);
  });
}

function wake() {
  if (!sleepResolve) return;
  clearTimeout(sleepTimer);
  const r = sleepResolve;
  sleepTimer = null;
  sleepResolve = null;
  r();
}

function withSafety(query) {
  const q = String(query || "").trim();
  const plain = q.toLowerCase().replace(/"/g, "");
  const extras = ["lolicon", "shotacon", "loli", "shota", "toddlercon"]
    .filter((t) => !new RegExp(`-tag:${t}(\\s|$)`).test(plain))
    .map((t) => `-tag:${t}`);
  return [q, ...extras].filter(Boolean).join(" ");
}

function log(level, msg) {
  const line = `[${new Date().toISOString()}] ${level.toUpperCase().padEnd(5)} ${msg}`;
  console.log(line);
  logBuffer.push(line);
  if (logBuffer.length > 400) logBuffer.splice(0, logBuffer.length - 400);
  appendFile("/app/log/archivist.log", line + "\n").catch(() => {});
}

function pushEvent(type, data) {
  status.recent.unshift({ type, at: new Date().toISOString(), ...data });
  if (status.recent.length > 30) status.recent.length = 30;
}

function fmtDuration(ms) {
  const sec = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

function sync() {
  status.paused = paused;
  status.running = !paused;
  status.downloadDelaySec = downloadDelaySec;
  status.login = { loggedIn: session.loggedIn, expired: session.expired, user: session.user, since: session.at };
  status.tagsInput = liveTags;
  status.tags = liveTags ? withSafety(liveTags) : "";
  status.chips = liveChips;
  status.chipProblems = chipProblems();
  status.pageLimit = pageLimit;
  status.wantBatch = wantBatch;
  status.wantRecent = wantRecent;
  status.wantQueue = [...wantQueue];
}

async function saveLive() {
  sync();
  try {
    await mkdir(dirname(livePath), { recursive: true });
    await writeFile(livePath, JSON.stringify({ chips: liveChips, pageLimit, wantQueue, downloadDelaySec }, null, 2) + "\n");
  } catch (err) {
    log("warn", `could not save nexus.json: ${err instanceof Error ? err.message : err}`);
  }
}

function loadLive() {
  try {
    const j = JSON.parse(readFileSync(livePath, "utf8"));
    if (Array.isArray(j.chips)) {
      liveChips = cleanChips(j.chips) || [];
    } else if (typeof j.tags === "string") {
      liveChips = parseQueryToChips(j.tags, skippedFilters); // saved by an older version as text
    }
    liveTags = chipsToQuery(liveChips);
    if (Number.isInteger(j.pageLimit) && j.pageLimit >= 0 && j.pageLimit <= 5000) pageLimit = j.pageLimit;
    if (typeof j.downloadDelaySec === "number" && j.downloadDelaySec >= 0 && j.downloadDelaySec <= 86400) downloadDelaySec = Math.round(j.downloadDelaySec);
    if (Array.isArray(j.wantQueue)) wantQueue = j.wantQueue.map(Number).filter((n) => Number.isInteger(n) && n > 0);
  } catch { /* first boot */ }
  sync();
}

function libraryDir(id) {
  if (!cfg.split) return cfg.library;
  const start = Math.floor(id / cfg.split) * cfg.split;
  return join(cfg.library, `${start}~${start + cfg.split - 1}`);
}

function safeName(id, title) {
  const cleaned = String(title).replace(/[\\/:*?"<>|\t\n]/g, "").replace(/\s+/g, " ").trim();
  const overhead = `${cfg.prefix}${id} .cbz`.length;
  let out = "";
  let bytes = 0;
  for (const ch of cleaned) {
    const size = Buffer.byteLength(ch);
    if (overhead + bytes + size > 240) break;
    out += ch;
    bytes += size;
  }
  return `${cfg.prefix}${id}${out ? ` ${out}` : ""}.cbz`;
}

async function throttleHtml() {
  const waitFor = lastHtmlAt + cfg.delay - Date.now();
  if (waitFor > 0) await wait(waitFor);
  lastHtmlAt = Date.now();
}

// ---- Login session. Stored in the config folder; the password is never stored.
const sessionPath = join(dirname(cfg.downloadme), "session.json");
const session = { loggedIn: false, expired: false, user: "", at: null, cookies: {} };
let sessionSaveTimer = null;

const LOGIN_HELP = "Log in again from the Login box on the dashboard.";

function loadSession() {
  try {
    const j = JSON.parse(readFileSync(sessionPath, "utf8"));
    if (j && j.cookies && typeof j.cookies === "object") {
      session.cookies = Object.fromEntries(Object.entries(j.cookies).filter(([, v]) => typeof v === "string"));
      session.user = typeof j.user === "string" ? j.user : "";
      session.at = typeof j.at === "string" ? j.at : null;
      session.loggedIn = j.loggedIn === true && Object.keys(session.cookies).length > 0;
      session.expired = j.expired === true && !session.loggedIn;
    }
  } catch { /* no session saved yet */ }
}

async function saveSession() {
  try {
    await mkdir(dirname(sessionPath), { recursive: true });
    await writeFile(sessionPath, JSON.stringify(session, null, 2) + "\n", { mode: 0o600 });
    await chmod(sessionPath, 0o600).catch(() => {});
  } catch (err) {
    log("warn", `could not save session.json: ${err instanceof Error ? err.message : err}`);
  }
}

function jarHeader(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
}

function absorbInto(jar, res) {
  const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  let changed = false;
  for (const sc of list) {
    const first = sc.split(";")[0];
    const i = first.indexOf("=");
    if (i < 1) continue;
    const name = first.slice(0, i).trim();
    const val = first.slice(i + 1).trim();
    const gone = val === "" || /;\s*max-age=0\b/i.test(sc) || /;\s*expires=[^;]*1970/i.test(sc);
    if (gone) {
      if (name in jar) { delete jar[name]; changed = true; }
    } else if (jar[name] !== val) {
      jar[name] = val;
      changed = true;
    }
  }
  return changed;
}

// Keep the saved session fresh when the site rotates its cookies.
function absorbSession(res) {
  if (!session.loggedIn) return;
  if (absorbInto(session.cookies, res)) {
    clearTimeout(sessionSaveTimer);
    sessionSaveTimer = setTimeout(() => { saveSession(); }, 1000);
  }
}

function expireSession(reason) {
  if (!session.loggedIn) return;
  session.loggedIn = false;
  session.expired = true;
  log("warn", `Session expired (${reason}). Log in again from the dashboard.`);
  saveSession();
}

const LOGIN_PATHS = ["/login", "/account/login", "/user/login", "/users/login", "/signin", "/sign-in", "/auth/login"];
const CAPTCHA_IN_FORM = /g-recaptcha|h-captcha|cf-turnstile|data-sitekey|recaptcha|hcaptcha|turnstile/i;
const CAPTCHA_WIDGET = /class="[^"]*(?:g-recaptcha|h-captcha|cf-turnstile)/i;

function unescapeAttr(v) {
  return String(v).replace(/&quot;/g, '"').replace(/&#0*39;|&#x27;|&apos;/gi, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function parseAttrs(str) {
  const out = {};
  for (const m of str.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    out[m[1].toLowerCase()] = unescapeAttr(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

function parseForms(html) {
  const forms = [];
  for (const m of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    forms.push({
      attrs: parseAttrs(m[1]),
      inputs: [...m[2].matchAll(/<input\b([^>]*)>/gi)].map((x) => parseAttrs(x[1])),
      html: m[0],
    });
  }
  return forms;
}

const hasPassword = (form) => form.inputs.some((i) => (i.type || "").toLowerCase() === "password");

function loginError(html) {
  const m = html.match(/<(?:div|p|span|li|article)\b[^>]*class="[^"]*(?:error|danger|alert|invalid|notification|flash)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|p|span|li|article)>/i);
  return m ? decode(m[1]).slice(0, 160) : "";
}

// GET/POST with a cookie jar, following redirects by hand, same site only.
async function jarFetch(jar, url, { method = "GET", body, referer } = {}) {
  const site = new URL(ORIGIN).origin;
  let cur = url;
  let ref = referer || `${ORIGIN}/`;
  for (let hop = 0; hop < 7; hop++) {
    if (new URL(cur).origin !== site) throw new Error(`the site redirected to another address (${new URL(cur).host}); not following it`);
    const headers = { "User-Agent": cfg.ua, Accept: "text/html,application/xhtml+xml", Referer: ref };
    const ck = jarHeader(jar);
    if (ck) headers.Cookie = ck;
    if (body) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      headers.Origin = site;
    }
    await throttleHtml();
    let res;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await fetch(cur, { method, headers, body, redirect: "manual", signal: AbortSignal.timeout(30_000) });
        break;
      } catch (err) {
        // A reset before any response is safe to retry; the login form was not processed.
        const safe = true;
        if (attempt < 3 && safe && isTransient(err)) {
          const pause = 2000 * 2 ** attempt;
          log("warn", `${describeError(err)} (${cur}) - retrying in ${pause / 1000}s`);
          await wait(pause);
          continue;
        }
        throw new Error(`${describeError(err)} (${cur})`);
      }
    }
    absorbInto(jar, res);
    const loc = res.headers.get("location");
    if ([301, 302, 303, 307, 308].includes(res.status) && loc) {
      await res.body?.cancel().catch(() => {});
      ref = cur;
      cur = new URL(loc, cur).toString();
      if (res.status !== 307 && res.status !== 308) { method = "GET"; body = undefined; }
      continue;
    }
    return { status: res.status, text: await res.text(), url: cur };
  }
  throw new Error("too many redirects");
}

async function siteLogin(username, password) {
  const jar = {};
  const tried = [];
  let found = null;

  const home = await jarFetch(jar, `${ORIGIN}/`);
  const inline = parseForms(home.text).find(hasPassword);
  if (inline) found = { page: home, form: inline };
  if (!found) {
    const candidates = [];
    for (const m of home.text.matchAll(/href="([^"#]*(?:log-?in|sign-?in)[^"#]*)"/gi)) {
      try { candidates.push(new URL(unescapeAttr(m[1]), ORIGIN).toString()); } catch { /* skip */ }
    }
    for (const path of LOGIN_PATHS) candidates.push(`${ORIGIN}${path}`);
    for (const u of [...new Set(candidates)].slice(0, 8)) {
      const where = new URL(u).pathname;
      try {
        const r = await jarFetch(jar, u);
        tried.push(`${where} ${r.status}`);
        const form = r.status < 400 ? parseForms(r.text).find(hasPassword) : null;
        if (form) { found = { page: r, form }; break; }
      } catch (err) {
        tried.push(`${where} ${describeError(err).slice(0, 60)}`);
      }
    }
  }
  if (!found) throw new Error(`LOGIN FAILED: could not find the site's login form (tried ${tried.join(", ") || "nothing"}).`);

  const form = found.form;
  if (CAPTCHA_IN_FORM.test(form.html) || CAPTCHA_WIDGET.test(found.page.text)) {
    throw new Error("LOGIN BLOCKED: the site's login form has a CAPTCHA, which the archivist cannot complete.");
  }
  const method = (form.attrs.method || "GET").toUpperCase();
  if (method !== "POST") throw new Error("LOGIN BLOCKED: the login form does not use POST, so it was not used (the password would end up in the address).");
  const action = new URL(form.attrs.action || found.page.url, found.page.url);
  if (action.origin !== new URL(ORIGIN).origin) {
    throw new Error(`LOGIN BLOCKED: the login form sends the password to another site (${action.host}), so it was not used.`);
  }

  const textInputs = form.inputs.filter((i) => i.name && ["text", "email"].includes((i.type || "text").toLowerCase()));
  const userField = (textInputs.find((i) => /user|e-?mail|login|account|name|id/i.test(i.name)) || textInputs[0])?.name;
  if (!userField) throw new Error("LOGIN FAILED: could not find the username field on the login form.");
  const fields = [];
  let passDone = false;
  let submitDone = false;
  for (const inp of form.inputs) {
    if (!inp.name) continue;
    const type = (inp.type || "text").toLowerCase();
    if (type === "password") {
      if (!passDone) { fields.push([inp.name, password]); passDone = true; }
    } else if (inp.name === userField && ["text", "email"].includes(type)) {
      fields.push([inp.name, username]);
    } else if (type === "hidden") {
      fields.push([inp.name, inp.value ?? ""]);
    } else if (type === "checkbox") {
      if (/remember|stay|keep|persist/i.test(inp.name)) fields.push([inp.name, inp.value || "on"]);
    } else if (type === "submit" && !submitDone) {
      fields.push([inp.name, inp.value ?? ""]);
      submitDone = true;
    }
  }

  const r = await jarFetch(jar, action.toString(), { method: "POST", body: new URLSearchParams(fields).toString(), referer: found.page.url });
  if (r.status === 403 || r.status === 429) throw new Error(`LOGIN FAILED: the site answered ${r.status} to the login. It may be blocking automated logins.`);
  if (r.status >= 400) throw new Error(`LOGIN FAILED: HTTP ${r.status} from the login page.`);
  if (parseForms(r.text).some(hasPassword)) {
    const why = loginError(r.text);
    throw new Error(`LOGIN FAILED: the site showed the login form again${why ? ` ("${why}")` : ""}. Check the username and password.`);
  }

  session.cookies = jar;
  session.user = username;
  session.at = new Date().toISOString();
  session.loggedIn = true;
  session.expired = false;
  await saveSession();
  log("info", `Logged in as ${username} (cookies: ${Object.keys(jar).join(", ") || "none"})`);
}

async function http(url, { referer } = {}) {
  const headers = {
    "User-Agent": cfg.ua,
    Accept: "text/html",
    Referer: referer || `${ORIGIN}/`,
  };
  if (session.loggedIn) {
    const ck = jarHeader(session.cookies);
    if (ck) headers.Cookie = ck;
  }
  let last = "no response";
  for (let i = 0; i < 5; i++) {
    await throttleHtml();
    let res;
    try {
      res = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(60_000) });
    } catch (err) {
      last = describeError(err);
      if (isTransient(err) && i < 4) {
        const pause = Math.min(60_000, 3000 * 2 ** i);
        log("warn", `${last} (${url}) - retrying in ${Math.round(pause / 1000)}s`);
        await wait(pause);
        continue;
      }
      throw new Error(`${last} (${url})`);
    }
    absorbSession(res);
    if (res.status === 429 || res.status === 503 || res.status === 502) {
      const pause = Math.min(120_000, 4000 * 2 ** i);
      log("warn", `${res.status} ${url} — waiting ${Math.round(pause / 1000)}s`);
      await wait(pause);
      last = String(res.status);
      continue;
    }
    if (res.status === 403) throw new Error(`403 from ${url}. The site is refusing requests from this server (bot protection or a block).`);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    const text = await res.text();
    if (/Just a moment|cf-browser-verification|challenge-platform/i.test(text)) {
      throw new Error("Cloudflare is showing a challenge page to this server, which the archivist cannot pass.");
    }
    return text;
  }
  throw new Error(`gave up ${url} (${last})`);
}

function searchUrl(query, page) {
  const q = encodeURIComponent(query);
  if (page <= 1) return `${ORIGIN}/?q=${q}`;
  return `${ORIGIN}/page/${page}?q=${q}`;
}

function parseSearch(html) {
  const ids = [];
  const seen = new Set();
  for (const m of html.matchAll(/href="(?:https?:\/\/(?:www\.)?hentainexus\.com)?\/view\/(\d+)(?:[?#][^"]*)?"/g)) {
    const id = Number(m[1]);
    if (!seen.has(id)) { seen.add(id); ids.push(id); }
  }
  let last = 1;
  for (const m of html.matchAll(/href="(?:https?:\/\/(?:www\.)?hentainexus\.com)?\/page\/(\d+)\?/g)) last = Math.max(last, Number(m[1]));
  return { ids, last };
}

function cellValues(inner) {
  const links = [...inner.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)]
    .map((m) => decode(m[1]).replace(/\s*\([\d,]+\)\s*$/, "").trim())
    .filter(Boolean);
  if (links.length) return links;
  const text = decode(inner);
  return text ? [text] : [];
}

function parseGallery(html, id) {
  const title = decode((html.match(/<h1 class="title">([\s\S]*?)<\/h1>/) || [])[1] || String(id));
  const fields = {};
  for (const m of html.matchAll(/<td class="viewcolumn">([^<]+)<\/td>\s*<td>([\s\S]*?)<\/td>/g)) {
    fields[decode(m[1]).toLowerCase()] = cellValues(m[2]);
  }
  const pages = Number((fields.pages || ["0"])[0]) || 0;
  const linked = [...html.matchAll(new RegExp(`/read/${id}/(\\d+)`, "g"))].map((m) => Number(m[1]));
  const pageNums = linked.length
    ? [...new Set(linked)].sort((a, b) => a - b)
    : Array.from({ length: pages }, (_, i) => i + 1);
  const tags = fields.tags || [];
  const blob = [title, ...Object.values(fields).flat()].join(" ");
  return {
    id, title, tags, pageNums,
    artist: (fields.artist || []).join(", "),
    magazine: (fields.magazine || []).join(", "),
    parody: (fields.parody || []).join(", "),
    publisher: (fields.publisher || []).join(", "),
    published: (fields.published || [""])[0],
    pages: pageNums.length || pages,
    unsafe: UNSAFE.test(blob),
  };
}

function comicInfo(g) {
  const d = new Date(g.published);
  const ok = !Number.isNaN(d.getTime());
  const tag = (name, val) => (val ? `  <${name}>${xml(val)}</${name}>\n` : "");
  return `<?xml version="1.0" encoding="utf-8"?>\n<ComicInfo>\n` +
    `  <Title>${xml(`${g.id} ${g.title}`)}</Title>\n` +
    (ok ? `  <Year>${d.getUTCFullYear()}</Year>\n  <Month>${d.getUTCMonth() + 1}</Month>\n  <Day>${d.getUTCDate()}</Day>\n` : "") +
    tag("Writer", g.artist) +
    tag("Publisher", g.publisher) +
    tag("Series", g.parody && g.parody !== "Original Work" ? g.parody : "") +
    tag("Tags", g.tags.join(", ")) +
    tag("Notes", g.magazine) +
    `  <Web>${ORIGIN}/view/${g.id}</Web>\n` +
    `  <PageCount>${g.pages}</PageCount>\n` +
    `  <Manga>YesAndRightToLeft</Manga>\n</ComicInfo>\n`;
}

const idPattern = new RegExp(`^${cfg.prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\d+)\\b`);

async function indexLibrary(root) {
  const ids = new Set();
  let other = 0; // .cbz files that are not ours (for example folio's), counted but left alone
  async function scan(dir, depth) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory() && depth < 2 && !entry.name.startsWith(".tmp-")) await scan(full, depth + 1);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".cbz")) {
        const m = entry.name.match(idPattern);
        if (m) ids.add(Number(m[1]));
        else other += 1;
      }
    }
  }
  await scan(root, 0);
  ids.other = other;
  return ids;
}

function setLibraryCounts(have) {
  status.libraryCount = have.size;
  status.libraryTotal = have.size + (have.other || 0);
}

let scanBusy = false;
// Counts the whole library in the background. Large libraries can take a few minutes.
async function rescanLibrary(why) {
  if (scanBusy) return;
  scanBusy = true;
  status.libraryScanning = true;
  const t0 = Date.now();
  if (why !== "periodic") log("info", `Scanning library ${cfg.library} ...`);
  try {
    const have = await indexLibrary(cfg.library);
    setLibraryCounts(have);
    status.libraryScannedAt = new Date().toISOString();
    if (why !== "periodic") {
      log("info", `Library: ${status.libraryTotal} .cbz in total, ${have.size} ${cfg.prefix ? cfg.prefix + " " : ""}from this tool, ${have.other} from other tools (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      if (!status.libraryTotal) log("warn", `Nothing found in ${cfg.library}. If your books are elsewhere, change the Library path in the container settings.`);
    }
  } catch (err) {
    log("warn", `Library scan failed: ${describeError(err)}`);
  } finally {
    scanBusy = false;
    status.libraryScanning = false;
  }
}

async function readIds(path) {
  try {
    const text = await readFile(path, "utf8");
    const ids = [];
    const seen = new Set();
    const add = (n) => {
      const id = Number(n);
      if (Number.isInteger(id) && id > 0 && !seen.has(id)) { seen.add(id); ids.push(id); }
    };
    for (const m of text.matchAll(/hentainexus\.com\/(?:view|read)\/(\d+)/gi)) add(m[1]);
    for (const line of text.split(/[\s,;]+/)) if (/^\d+$/.test(line)) add(line);
    return ids;
  } catch { return []; }
}

async function blacklist(id) {
  await mkdir(dirname(cfg.dont), { recursive: true });
  const have = new Set(await readIds(cfg.dont));
  if (have.has(id)) return;
  await writeFile(cfg.dont, `${[...have, id].join("\n")}\n`);
}

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

// The zip link redirects to a download host (for example downloads.<site>). Follow
// it by hand so the login cookie goes to the site's own subdomains, as a browser
// would, and never to any other site. Fail fast if a host does not answer.
const HEADER_WAIT_MS = 60_000;
async function fetchFollow(url, baseHeaders, cookie, stopSignal) {
  const siteHost = new URL(ORIGIN).hostname;
  let cur = url;
  for (let hop = 0; hop < 6; hop++) {
    const u = new URL(cur);
    const headers = { ...baseHeaders };
    delete headers.Cookie;
    if (cookie && (u.hostname === siteHost || u.hostname.endsWith(`.${siteHost}`))) headers.Cookie = cookie;
    const ctl = new AbortController();
    let slow = false;
    const timer = setTimeout(() => { slow = true; ctl.abort(); }, HEADER_WAIT_MS);
    let res;
    try {
      res = await fetch(cur, { headers, redirect: "manual", signal: AbortSignal.any([ctl.signal, stopSignal, AbortSignal.timeout(cfg.zipTimeout * 1000)]) });
    } catch (err) {
      if (slow) {
        const e = new Error("no response");
        e.name = "TimeoutError";
        e.detail = `${u.host} did not answer within ${HEADER_WAIT_MS / 1000}s`;
        throw e;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
    const loc = res.headers.get("location");
    if ([301, 302, 303, 307, 308].includes(res.status) && loc) {
      await res.body?.cancel().catch(() => {});
      const next = new URL(loc, cur);
      if (next.protocol !== u.protocol && next.protocol !== "https:") throw new Error(`refusing a redirect to ${next.protocol}//${next.host}`);
      if (next.host !== u.host) log("info", `Download is served from ${next.host}`);
      cur = next.toString();
      continue;
    }
    return res;
  }
  throw new Error("too many redirects");
}

async function httpFile(url, dest, { referer } = {}) {
  const baseHeaders = {
    "User-Agent": cfg.ua,
    Accept: "application/zip,application/octet-stream,*/*;q=0.8",
    Referer: referer || `${ORIGIN}/`,
  };
  const cookie = session.loggedIn ? jarHeader(session.cookies) : "";
  const myStop = stopEpoch;
  const stopSignal = stopCtl.signal;
  const stopped = () => stopEpoch !== myStop || shuttingDown;
  // Sleep that Stop can cut short.
  const nap = async (ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (stopped()) throw new Cancelled("cancelled");
      await wait(Math.min(500, end - Date.now()));
    }
  };
  // The host throttles for a while after a stalled or unanswered attempt, so a
  // quick retry just stalls again. Wait progressively longer in that case.
  let quietCount = 0;
  const QUIET_PAUSES = [1, 2.5, 5].map((k) => k * cfg.cooldown * 1000);
  const quietPause = () => QUIET_PAUSES[Math.min(quietCount++, QUIET_PAUSES.length - 1)];
  const MB = (n) => `${(n / 1048576).toFixed(1)} MB`;
  let last = "no response";
  let fails = 0; // attempts that made no progress; resuming attempts do not count
  let validator = ""; // ETag / Last-Modified of the file being resumed
  let got = 0; // bytes already on disk
  let interruptions = 0;
  let rangeState = "unknown"; // does the server honour Range? learned from its answer
  await rm(dest, { force: true });
  status.downloadDone = 0;
  status.downloadTotal = 0;

  const fail = (message) => {
    fails++;
    last = message;
    return fails >= 5;
  };

  for (;;) {
    if (stopped()) throw new Cancelled("cancelled");
    await throttleHtml();
    const headers = { ...baseHeaders };
    if (got > 0) {
      headers.Range = `bytes=${got}-`;
      if (validator) headers["If-Range"] = validator;
    }
    let res;
    try {
      res = await fetchFollow(url, headers, cookie, stopSignal);
    } catch (err) {
      if (stopped()) throw new Cancelled("cancelled");
      last = describeError(err);
      if (isTransient(err) && fails < 4) {
        fails++;
        const silent = err.name === "TimeoutError";
        const pause = silent ? quietPause() : Math.min(60_000, 3000 * 2 ** (fails - 1));
        log("warn", `${last} (${url}) - trying again in ${fmtDuration(pause)}${silent ? " (the site throttles right after a failed attempt, so this waits longer)" : ""}`);
        await nap(pause);
        continue;
      }
      throw new Error(`${last} (${url})`);
    }
    absorbSession(res);
    if (res.status === 429 || res.status === 503 || res.status === 502) {
      await res.body?.cancel().catch(() => {});
      if (fail(String(res.status))) throw new Error(`gave up ${url} (${last})`);
      const pause = Math.min(120_000, 4000 * 2 ** (fails - 1));
      log("warn", `${res.status} ${url} - waiting ${Math.round(pause / 1000)}s`);
      await nap(pause);
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`LOGIN REQUIRED: ${res.status} from ${url}. Your login may have expired, or the site is blocking this server. ${LOGIN_HELP}`);
    }
    if (res.status === 416 && got > 0) {
      // Our partial file no longer matches what the server has: start over.
      await res.body?.cancel().catch(() => {});
      await rm(dest, { force: true });
      got = 0;
      validator = "";
      status.downloadDone = 0;
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    const type = (res.headers.get("content-type") || "").toLowerCase();
    if (type.includes("text/html") || type.includes("json")) {
      const body = (await res.text()).slice(0, 4000);
      if (/Just a moment|cf-browser-verification|challenge-platform/i.test(body)) {
        throw new Error("Cloudflare is showing a challenge page for the zip download, which the archivist cannot pass.");
      }
      throw new Error(`LOGIN REQUIRED: the site returned a web page instead of a zip, so your login has expired. ${LOGIN_HELP}`);
    }

    let resuming = false;
    if (res.status === 206) {
      const cr = /^bytes (\d+)-\d+\/(\d+|\*)$/i.exec(res.headers.get("content-range") || "");
      if (got > 0 && cr && Number(cr[1]) === got) {
        resuming = true;
        rangeState = "yes";
        status.downloadTotal = cr[2] !== "*" ? Number(cr[2]) : 0;
      } else {
        await res.body?.cancel().catch(() => {});
        await rm(dest, { force: true });
        got = 0;
        validator = "";
        if (fail("the server sent a different part of the file than requested")) throw new Error(`gave up ${url} (${last})`);
        continue;
      }
    } else {
      // A full response: anything saved before is replaced.
      if (got > 0) rangeState = "no"; // we asked for a range and got the whole file
      got = 0;
      status.downloadTotal = Number(res.headers.get("content-length")) || 0;
    }
    validator = res.headers.get("etag") || res.headers.get("last-modified") || validator;
    if (!resuming) {
      status.downloadDone = 0;
      log("info", `Downloading #${status.currentId ?? ""}: ${status.downloadTotal ? MB(status.downloadTotal) : "size unknown"}, resume ${rangeState === "yes" || res.headers.get("accept-ranges") === "bytes" ? "supported" : "will be tried if it drops"}`);
    } else {
      log("info", `Resuming at ${MB(got)} of ${status.downloadTotal ? MB(status.downloadTotal) : "?"}`);
    }

    // Abort a transfer that goes quiet instead of waiting for the OS to give up.
    const body = Readable.fromWeb(res.body);
    let quiet = null;
    const arm = () => {
      clearTimeout(quiet);
      quiet = setTimeout(() => body.destroy(new Error(`download stalled: no data for ${cfg.stall}s`)), cfg.stall * 1000);
    };
    arm();
    let received = 0;
    body.on("data", (chunk) => {
      received += chunk.length;
      status.downloadDone += chunk.length;
      arm();
    });
    try {
      await pipeline(body, createWriteStream(dest, { flags: resuming ? "a" : "w" }));
      clearTimeout(quiet);
    } catch (err) {
      clearTimeout(quiet);
      const size = await stat(dest).then((st) => st.size).catch(() => 0);
      if (stopped()) {
        await rm(dest, { force: true });
        throw new Cancelled("cancelled");
      }
      const reason = describeError(err);
      const silent = /^download stalled/.test(reason);
      // The site does not advertise Range, so try it after the first drop and learn from the answer.
      const canResume = rangeState !== "no";
      interruptions++;
      // Progress that can be resumed is not a failed attempt; restarting from zero is.
      if (received > 0 && canResume && interruptions < 40) fails = 0;
      if (fail(reason)) {
        await rm(dest, { force: true });
        throw new Error(`${reason} (${url})`);
      }
      got = canResume ? size : 0;
      if (!got) await rm(dest, { force: true });
      status.downloadDone = got;
      const pause = silent ? quietPause() : Math.min(60_000, 3000 * 2 ** Math.max(0, fails - 1));
      log("warn", `download interrupted at ${MB(size)}${status.downloadTotal ? ` of ${MB(status.downloadTotal)}` : ""} (${reason}) - ${got ? "resuming" : "restarting"} in ${fmtDuration(pause)}${silent ? " (the site throttles right after a failed attempt, so this waits longer)" : ""}`);
      await nap(pause);
      continue;
    }

    const size = (await stat(dest)).size;
    if (status.downloadTotal && size !== status.downloadTotal) {
      await rm(dest, { force: true });
      got = 0;
      if (fail(`the file is ${size} bytes but ${status.downloadTotal} were expected`)) throw new Error(`${last} (${url})`);
      continue;
    }
    const fh = await open(dest, "r");
    try {
      const head = Buffer.alloc(4);
      await fh.read(head, 0, 4, 0);
      if (head.readUInt16LE(0) !== 0x4b50) throw new Error(`the download from ${url} is not a zip file`);
    } finally {
      await fh.close();
    }
    return;
  }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  if (typeof zlib.crc32 === "function") return zlib.crc32(buf);
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const IMAGE_NAME = /\.(jpe?g|png|webp|avif|gif|bmp)$/i;

/**
 * Add ComicInfo.xml to an existing zip in place, without unpacking it.
 * The new entry is written over the old central directory, which is then
 * rewritten after it. makeXml(imageCount) returns the XML text.
 * Returns the number of images in the zip.
 */
async function addComicInfo(path, makeXml) {
  const fh = await open(path, "r+");
  try {
    const { size } = await fh.stat();
    const tailLen = Math.min(size, 65557);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let e = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { e = i; break; }
    }
    if (e < 0) throw new Error("the downloaded file is not a valid zip (no end record)");
    const entries = tail.readUInt16LE(e + 10);
    const cdSize = tail.readUInt32LE(e + 12);
    const cdOffset = tail.readUInt32LE(e + 16);
    if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new Error("zip64 archives are not supported");
    if (entries >= 0xfffe) throw new Error("too many files in the zip");
    if (cdOffset + cdSize > size) throw new Error("the zip directory is corrupt");
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);

    let images = 0;
    let hasInfo = false;
    let p = 0;
    for (let n = 0; n < entries; n++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw new Error("the zip directory is corrupt");
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const name = cd.toString("utf8", p + 46, p + 46 + nameLen);
      if (IMAGE_NAME.test(name)) images += 1;
      if (name.toLowerCase() === "comicinfo.xml") hasInfo = true;
      p += 46 + nameLen + extraLen + commentLen;
    }
    if (!images) throw new Error("the zip contains no images");
    if (hasInfo) return images;

    const xml = Buffer.from(makeXml(images), "utf8");
    const name = Buffer.from("ComicInfo.xml");
    const crc = crc32(xml);
    const d = new Date();
    const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const dosDate = (Math.max(0, d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(xml.length, 18);
    local.writeUInt32LE(xml.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(xml.length, 20);
    central.writeUInt32LE(xml.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(cdOffset, 42);
    name.copy(central, 46);

    const newCdOffset = cdOffset + local.length + xml.length;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries + 1, 8);
    eocd.writeUInt16LE(entries + 1, 10);
    eocd.writeUInt32LE(cdSize + central.length, 12);
    eocd.writeUInt32LE(newCdOffset, 16);

    const out = Buffer.concat([local, xml, cd, central, eocd]);
    await fh.write(out, 0, out.length, cdOffset);
    await fh.truncate(cdOffset + out.length);
    return images;
  } finally {
    await fh.close();
  }
}

class Cancelled extends Error {}

// Wait until the gap since the last download has passed. The gap is read again
// every half second, so changing it in the dashboard applies immediately.
async function waitForDelay(cancelled) {
  try {
    for (;;) {
      const due = lastDownloadEnd + downloadDelaySec * 1000;
      const left = due - Date.now();
      if (left <= 0) return;
      if (shuttingDown || cancelled()) throw new Cancelled("cancelled");
      status.state = "waiting";
      status.nextDownloadAt = new Date(due).toISOString();
      status.message = `Next download in ${fmtDuration(left)}`;
      await wait(Math.min(500, left));
    }
  } finally {
    status.nextDownloadAt = null;
  }
}

async function downloadGallery(id, have, opts = {}) {
  status.state = cfg.dry ? "dry-run" : "downloading";
  status.currentId = id;
  status.currentTitle = "";
  status.downloadDone = 0;
  status.downloadTotal = 0;
  status.message = `Gallery ${id}`;
  if (!cfg.dry && !session.loggedIn) {
    throw new Error(`LOGIN REQUIRED: ${session.expired ? "the login has expired" : "you are not logged in"}. ${LOGIN_HELP}`);
  }
  const view = await http(`${ORIGIN}/view/${id}`);
  const g = parseGallery(view, id);
  status.currentTitle = g.title;
  if (g.unsafe) {
    log("warn", `#${id} blocked tag`);
    await blacklist(id);
    status.blockedThisCycle += 1;
    status.skippedThisCycle += 1;
    pushEvent("blocked", { id, title: g.title });
    return "blocked";
  }
  const filename = safeName(id, g.title);
  const destDir = libraryDir(id);
  await mkdir(destDir, { recursive: true });
  const dest = join(destDir, filename);
  if (have.has(id) || await exists(dest)) {
    have.add(id);
    status.skippedThisCycle += 1;
    return "have";
  }
  if (cfg.dry) {
    log("info", `DRY_RUN ${dest} (${g.pages} pages)`);
    status.addedThisCycle += 1;
    pushEvent("dry", { id, title: filename });
    return "wrote";
  }

  const tmp = join(cfg.library, `.tmp-hn-${id}`);
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  try {
    const zipPath = join(tmp, `${id}.zip`);
    const epoch = stopEpoch;
    await waitForDelay(() => stopEpoch !== epoch || (!opts.queued && paused && !runNow));
    status.state = "downloading";
    status.message = `Downloading zip for #${id}`;
    try {
      await httpFile(`${ORIGIN}/zip/${id}`, zipPath, { referer: `${ORIGIN}/view/${id}` });
    } finally {
      lastDownloadEnd = Date.now();
    }
    const pages = await addComicInfo(zipPath, (count) => comicInfo({ ...g, pages: count }));
    await rename(zipPath, dest);
    have.add(id);
    status.libraryCount = have.size;
    status.libraryTotal += 1;
    status.addedThisCycle += 1;
    log("info", `Wrote ${dest} (${pages} pages)`);
    pushEvent("wrote", { id, title: filename, pages });
    return "wrote";
  } finally {
    if (cfg.cleanup) await rm(tmp, { recursive: true, force: true });
  }
}

async function takeOne(id, have, skip, opts = {}) {
  try {
    if (skip.has(id)) return "blacklisted";
    if (have.has(id)) return "have";
    return await downloadGallery(id, have, opts);
  } catch (err) {
    if (err instanceof Cancelled) {
      status.message = "Stopped";
      return "cancelled";
    }
    status.failedThisCycle += 1;
    const title = describeError(err);
    if (/^LOGIN REQUIRED/.test(title)) {
      authFailed = true;
      expireSession("the site did not accept the saved login");
    }
    log("error", `#${id} ${title}`);
    pushEvent("error", { id, title });
    return "failed";
  }
}

async function drainWant(have, skip) {
  if (wantBusy || !wantQueue.length) return;
  wantBusy = true;
  try {
    while (wantQueue.length && !shuttingDown) {
      const id = wantQueue[0];
      log("info", `One-off #${id}`);
      const outcome = await takeOne(id, have, skip, { queued: true });
      if (outcome === "cancelled") {
        log("info", `Stopped before #${id}; it stays queued. Press Start to resume.`);
        break;
      }
      wantQueue.shift();
      wantBatch.done += 1;
      wantRecent.unshift({ id, result: outcome, title: status.currentTitle || "", at: new Date().toISOString() });
      if (wantRecent.length > 20) wantRecent.length = 20;
      if (authFailed && wantQueue.length) {
        log("warn", `Login required: dropped ${wantQueue.length} more queued book(s). Log in again from the dashboard and queue them again.`);
        wantQueue.length = 0;
      }
      status.wantQueue = [...wantQueue];
      await saveLive();
    }
  } finally {
    wantBusy = false;
  }
}

async function searchCycle(have, skip) {
  const query = withSafety(liveTags);
  log("info", `Search ${query}`);
  let page = 1;
  let last = 1;
  let streak = 0;
  let added = 0;
  let prevFirst = null;
  const limit = pageLimit;
  status.searchLimit = limit;
  while (page <= last && !shuttingDown) {
    if (paused && !runNow) { log("info", "Paused"); return; }
    if (limit && page > limit) {
      log("info", `Page limit reached: searched the newest ${limit} of ${last} pages`);
      status.message = `Searched the newest ${limit} of ${last} pages`;
      return;
    }
    const html = await http(searchUrl(query, page));
    const parsed = parseSearch(html);
    last = Math.max(last, parsed.last);
    status.searchPage = page;
    status.searchPages = last;
    status.state = "searching";
    status.message = limit && limit < last ? `Search page ${page} / ${limit} (${last} available)` : `Search page ${page} / ${last}`;
    if (!parsed.ids.length) {
      const title = decode((html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || "");
      const views = (html.match(/\/view\/\d+/g) || []).length;
      const text = decode(html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")).slice(0, 240);
      log("warn", `Search page ${page} had no galleries I could read. Page title "${title}", ${html.length} bytes, ${views} "/view/" links. Page text: ${text}`);
      const why = chipProblems().map((pr) => pr.message).join(" ");
      if (why) log("warn", `Likely cause: ${why}`);
      status.message = why ? `The search found no galleries. ${chipProblems()[0].message}` : "The search found no galleries (see the Log)";
      return;
    }
    if (parsed.ids[0] === prevFirst) return;
    prevFirst = parsed.ids[0];
    log("info", `Search page ${page}/${last} — ${parsed.ids.length} galleries`);
    for (const id of parsed.ids) {
      if (shuttingDown) return;
      if (wantQueue.length) await drainWant(have, skip);
      if (skip.has(id) || have.has(id)) {
        streak += 1;
        status.skippedThisCycle += 1;
        if (cfg.streakCap && streak >= cfg.streakCap) {
          log("info", `Caught up after ${streak} already handled`);
          status.message = `Caught up after ${streak} already in library`;
          return;
        }
        continue;
      }
      streak = 0;
      if (cfg.maxPerCycle && added >= cfg.maxPerCycle) {
        log("info", `MAX_PER_CYCLE=${cfg.maxPerCycle}`);
        return;
      }
      const result = await takeOne(id, have, skip);
      if (authFailed) { log("warn", "Stopping this cycle: login required."); return; }
      if (result === "wrote") added += 1;
      if (paused && !runNow) return;
    }
    page += 1;
  }
}

async function runCycle() {
  authFailed = false;
  status.cycle += 1;
  status.addedThisCycle = 0;
  status.skippedThisCycle = 0;
  status.failedThisCycle = 0;
  status.blockedThisCycle = 0;
  status.sleepUntil = null;
  status.cycleStartedAt = new Date().toISOString();
  status.state = "searching";
  const have = await indexLibrary(cfg.library);
  const skip = new Set(await readIds(cfg.dont));
  setLibraryCounts(have);
  log("info", `Library ${have.size} cbz, ${skip.size} blacklisted`);
  if (wantQueue.length) await drainWant(have, skip);
  const listed = await readIds(cfg.downloadme);
  if (listed.length) {
    log("info", `${listed.length} ids in downloadme.txt`);
    for (const id of listed) {
      if (shuttingDown || authFailed || (paused && !runNow)) break;
      if (cfg.maxPerCycle && status.addedThisCycle >= cfg.maxPerCycle) break;
      await takeOne(id, have, skip);
    }
  }
  if (liveTags && !shuttingDown && !(paused && !runNow)) {
    await checkChips();
    for (const pr of chipProblems()) log("warn", `Filter check: ${pr.message}`);
    await searchCycle(have, skip);
  }
  if (!liveTags && !listed.length && !wantQueue.length) {
    status.state = "stopped";
    status.message = "No search query yet. Set one, then press Start.";
    paused = true;
  }
  status.currentId = null;
  status.downloadDone = 0;
  status.downloadTotal = 0;
  await saveLive();
}

function snapshot() {
  sync();
  return { ...status, log: logBuffer.slice(-120), now: new Date().toISOString() };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > 20_000) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error("invalid json")); }
    });
    req.on("error", reject);
  });
}

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function authorized(header) {
  if (!cfg.importKey || typeof header !== "string") return false;
  const a = Buffer.from(header);
  const b = Buffer.from(cfg.importKey);
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseWant(text) {
  const ids = [];
  const seen = new Set();
  const add = (n) => {
    const id = Number(n);
    if (Number.isInteger(id) && id > 0 && !seen.has(id)) { seen.add(id); ids.push(id); }
  };
  const raw = String(text || "");
  for (const m of raw.matchAll(/hentainexus\.com\/(?:view|read)\/(\d+)/gi)) add(m[1]);
  for (const line of raw.split(/[\s,;]+/)) if (/^\d+$/.test(line)) add(line);
  return ids;
}

// An include chip whose name is not in the site's list for that type finds
// nothing (for example "fakku" is a publisher, not a tag). Uses the cached lists.
function chipProblems() {
  const out = [];
  const has = (items, v) => items.some((it) => it.name.toLowerCase() === v.toLowerCase());
  liveChips.forEach((c, index) => {
    if (c.not || !SUGGEST_TYPES.includes(c.type)) return;
    const own = categoryCache.get(c.type);
    if (!own || own.items.length < 5 || has(own.items, c.value)) return;
    const elsewhere = SUGGEST_TYPES.filter((t) => t !== c.type && categoryCache.get(t) && has(categoryCache.get(t).items, c.value));
    out.push({
      index,
      elsewhere,
      message: `“${c.value}” is not in the site's ${c.type} list` + (elsewhere.length ? `, but it is a ${elsewhere.join(" and a ")}. Use ${elsewhere[0]}:${c.value} instead.` : ", so this filter will probably find nothing."),
    });
  });
  return out;
}

let checkBusy = false;
// Loads the lists needed to check the include chips (and the rest, if one looks wrong).
async function checkChips() {
  if (checkBusy) return;
  checkBusy = true;
  try {
    const types = [...new Set(liveChips.filter((c) => !c.not && SUGGEST_TYPES.includes(c.type)).map((c) => c.type))];
    for (const t of types) await loadCategory(t).catch(() => {});
    if (chipProblems().length) for (const t of SUGGEST_TYPES) await loadCategory(t).catch(() => {});
  } finally {
    checkBusy = false;
  }
}

// Tag / artist / ... suggestions come from the site's own category pages.
const categoryCache = new Map();
const categoryLoading = new Map();
let suggestBusy = false;

function parseCategory(html) {
  const items = [];
  const seen = new Set();
  for (const m of html.matchAll(/<a\b[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    let q;
    try { q = new URL(unescapeAttr(m[1]), ORIGIN).searchParams.get("q"); } catch { continue; }
    const mm = q && /^([a-z]+):(.+)$/i.exec(q.trim());
    if (!mm) continue;
    const type = mm[1].toLowerCase();
    if (!CHIP_TYPES.includes(type)) continue;
    const name = mm[2].trim().replace(/^"(.*)"$/, "$1").trim();
    if (!name || name.length > 100 || seen.has(`${type}:${name.toLowerCase()}`)) continue;
    seen.add(`${type}:${name.toLowerCase()}`);
    const cm = /\(used ([\d,]+) times?\)/i.exec(decode(m[2]));
    items.push({ type, name, count: cm ? Number(cm[1].replace(/,/g, "")) : 0 });
  }
  return items;
}

const categoryFresh = (type) => {
  const hit = categoryCache.get(type);
  return !!hit && Date.now() - hit.at < 6 * 3600_000;
};

async function loadCategory(type) {
  if (categoryFresh(type)) return categoryCache.get(type).items;
  if (categoryLoading.has(type)) return categoryLoading.get(type);
  const p = (async () => {
    try {
      const items = parseCategory(await http(`${ORIGIN}/explore/categories/${type}`));
      categoryCache.set(type, { at: Date.now(), items });
      log("info", `Loaded ${items.length} ${type} suggestions`);
      return items;
    } finally {
      categoryLoading.delete(type);
    }
  })();
  categoryLoading.set(type, p);
  return p;
}

async function suggest(q, typeParam) {
  const wanted = SUGGEST_TYPES.includes(typeParam) ? [typeParam] : SUGGEST_TYPES;
  const missing = wanted.filter((t) => !categoryFresh(t));
  let error = "";
  let loading = false;
  if (missing.length) {
    if (wanted.length === 1) {
      try {
        await Promise.race([loadCategory(missing[0]), wait(20_000).then(() => { throw new Error("the site is slow to answer"); })]);
      } catch (err) {
        error = describeError(err);
      }
      loading = !categoryFresh(missing[0]) && !error;
    } else {
      loading = true;
      if (!suggestBusy) {
        suggestBusy = true;
        (async () => {
          for (const t of missing) await loadCategory(t).catch((err) => log("warn", `suggestions for ${t}: ${describeError(err)}`));
        })().finally(() => { suggestBusy = false; });
      }
    }
  }
  const needle = q.toLowerCase();
  const rows = [];
  if (needle) {
    for (const t of wanted) for (const it of categoryCache.get(t)?.items || []) {
      const name = it.name.toLowerCase();
      if (name.includes(needle)) rows.push({ ...it, rank: name.startsWith(needle) ? 0 : 1 });
    }
  }
  rows.sort((a, b) => a.rank - b.rank || b.count - a.count || a.name.localeCompare(b.name));
  return { result: rows.slice(0, 20).map(({ rank, ...r }) => r), loading, error };
}

function startServer(port) {
  let page = "<p>dashboard.html missing</p>";
  for (const p of [join(HERE, "dashboard.html"), "/app/dashboard.html"]) {
    try { page = readFileSync(p, "utf8"); break; } catch { /* next */ }
  }
  createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/health") return json(res, 200, { ok: true, state: status.state });
    if (url.pathname === "/api/status") return json(res, 200, snapshot());
    if (url.pathname === "/api/control" && req.method === "POST") {
      readBody(req).then(async (body) => {
        const action = String(body.action || "");
        if (action === "stop" || action === "pause") {
          paused = true;
          runNow = false;
          queueArmed = false;
          stopEpoch++;
          stopCtl.abort();
          stopCtl = new AbortController();
          status.sleepUntil = null;
          log("info", "Stop requested");
          wake();
        } else if (action === "start" || action === "run") {
          if (!session.loggedIn && !cfg.dry) return json(res, 400, { error: "Log in first, then press Start." });
          paused = false;
          runNow = true;
          queueArmed = true;
          log("info", action === "start" ? "Start" : "Run now");
          wake();
        } else return json(res, 400, { error: "action must be start or stop" });
        await saveLive();
        json(res, 200, snapshot());
      }).catch((err) => json(res, 400, { error: err.message }));
      return;
    }
    if (url.pathname === "/api/rescan" && req.method === "POST") {
      req.resume();
      if (!scanBusy) rescanLibrary("button");
      status.libraryScanning = true;
      return json(res, 200, snapshot());
    }
    if (url.pathname === "/api/tags") {
      const q = (url.searchParams.get("q") || "").trim().slice(0, 100);
      suggest(q, url.searchParams.get("type") || "all")
        .then((out) => json(res, 200, out))
        .catch((err) => json(res, 200, { result: [], loading: false, error: describeError(err) }));
      return;
    }
    if (url.pathname === "/api/config" && req.method === "POST") {
      readBody(req).then(async (body) => {
        if (body.chips !== undefined || body.tags !== undefined) {
          const chips = body.chips !== undefined ? cleanChips(body.chips) : parseQueryToChips(String(body.tags ?? "").slice(0, 500));
          if (!chips) return json(res, 400, { error: "Those filters are not valid (up to 60, values up to 100 characters, no quote marks)." });
          liveChips = chips;
          liveTags = chipsToQuery(chips);
          log("info", `Query saved: ${liveTags || "(empty)"}`);
          checkChips().catch(() => {});
        }
        if (body.pageLimit !== undefined) {
          const n = Number(body.pageLimit);
          if (!Number.isInteger(n) || n < 0 || n > 5000) return json(res, 400, { error: "Enter a whole number of pages, 0 or more (0 = all pages)." });
          pageLimit = n;
          log("info", `Page limit set to ${n || "all pages"}`);
        }
        await saveLive();
        json(res, 200, snapshot());
      }).catch((err) => json(res, 400, { error: err.message }));
      return;
    }
    if (url.pathname === "/api/login" && req.method === "POST") {
      readBody(req).then(async (body) => {
        const username = String(body.username ?? "").trim();
        const password = String(body.password ?? "");
        if (!username || !password) return json(res, 400, { error: "Enter your username and password." });
        if (username.length > 200 || password.length > 500) return json(res, 400, { error: "Username or password is too long." });
        if (loginBusy) return json(res, 409, { error: "A login is already in progress." });
        loginBusy = true;
        try {
          log("info", `Logging in as ${username}`);
          await siteLogin(username, password);
          authFailed = false;
          json(res, 200, snapshot());
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log("error", message);
          json(res, 400, { error: message });
        } finally {
          loginBusy = false;
        }
      }).catch((err) => json(res, 400, { error: err.message }));
      return;
    }
    if (url.pathname === "/api/logout" && req.method === "POST") {
      req.resume();
      paused = true;
      runNow = false;
      queueArmed = false;
      stopEpoch++;
      stopCtl.abort();
      stopCtl = new AbortController();
      status.sleepUntil = null;
      session.loggedIn = false;
      session.expired = false;
      session.user = "";
      session.at = null;
      session.cookies = {};
      saveSession().then(() => {
        log("info", "Logged out");
        wake();
        json(res, 200, snapshot());
      });
      return;
    }
    if (url.pathname === "/api/settings" && req.method === "POST") {
      readBody(req).then(async (body) => {
        const minutes = Number(body.delayMinutes);
        if (!Number.isFinite(minutes) || minutes < 0 || minutes > 1440) return json(res, 400, { error: "Enter a delay between 0 and 1440 minutes." });
        downloadDelaySec = Math.round(minutes * 60);
        log("info", `Delay between downloads set to ${fmtDuration(downloadDelaySec * 1000)}`);
        await saveLive();
        json(res, 200, snapshot());
      }).catch((err) => json(res, 400, { error: err.message }));
      return;
    }
    if (url.pathname === "/api/want" && req.method === "POST") {
      readBody(req).then(async (body) => {
        if (!session.loggedIn && !cfg.dry) return json(res, 400, { error: "Log in first." });
        const ids = parseWant(body.text);
        if (!ids.length) return json(res, 400, { error: "Paste a hentainexus.com/view/… link or an id" });
        const wasEmpty = wantQueue.length === 0;
        let fresh = 0;
        for (const id of ids) if (!wantQueue.includes(id) && wantQueue.length < 500) { wantQueue.push(id); fresh++; }
        if (wasEmpty) wantBatch = { total: fresh, done: 0 };
        else wantBatch = { total: wantBatch.total + fresh, done: wantBatch.done };
        log("info", `Queued ${ids.join(", ")}`);
        queueArmed = true;
        await saveLive();
        wake();
        json(res, 200, snapshot());
      }).catch((err) => json(res, 400, { error: err.message }));
      return;
    }
    if (url.pathname === "/api/import" && req.method === "POST") {
      if (!authorized(req.headers["x-api-key"])) { req.resume(); return json(res, 401, { ok: false, error: "unauthorized" }); }
      readBody(req).then(async (body) => {
        if (!session.loggedIn && !cfg.dry) return json(res, 409, { ok: false, error: "not logged in" });
        const ids = parseWant(body.url || body.id || "");
        if (ids.length !== 1) return json(res, 400, { ok: false, error: "bad request" });
        if (!wantQueue.includes(ids[0])) wantQueue.push(ids[0]);
        queueArmed = true;
        await saveLive();
        wake();
        json(res, 202, { ok: true, status: "queued", id: String(ids[0]) });
      }).catch(() => json(res, 400, { ok: false, error: "bad request" }));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(page);
  }).listen(port, "0.0.0.0", () => log("info", `Dashboard on port ${port}`));
}

// Download queued one-off books without starting a full search cycle.
async function drainOnly() {
  authFailed = false;
  const have = await indexLibrary(cfg.library);
  const skip = new Set(await readIds(cfg.dont));
  await drainWant(have, skip);
  status.currentId = null;
  status.currentTitle = "";
  status.downloadDone = 0;
  status.downloadTotal = 0;
  setLibraryCounts(have);
  await saveLive();
}

// Sleep until the next cycle is due, but handle queued books as soon as they
// arrive, and return straight away when "Run now" is pressed.
async function sleepUntilDue() {
  while (!shuttingDown && !runNow && !paused) {
    const left = status.sleepUntil ? Date.parse(status.sleepUntil) - Date.now() : 0;
    if (left <= 500) break;
    status.state = "sleeping";
    status.message = `Sleeping until ${status.sleepUntil}`;
    await sleep(left);
    if (wantQueue.length && !shuttingDown) {
      try { await drainOnly(); } catch (err) { log("error", describeError(err)); }
    }
  }
}

async function main() {
  await mkdir(cfg.library, { recursive: true });
  await mkdir("/app/log", { recursive: true }).catch(() => {});
  await mkdir(dirname(cfg.downloadme), { recursive: true }).catch(() => {});
  loadLive();
  loadSession();
  if (cfg.port) startServer(cfg.port);
  log("info", `Nexus archivist ${VERSION}. library=${cfg.library} delay=${cfg.delay}ms query=${status.tags || "(none)"}`);
  log("info", `Files are named ${cfg.prefix}<id> <title>.cbz${cfg.prefix ? "" : " (no prefix: do not share this folder with another site's tool)"}`);
  log("info", `login=${session.loggedIn ? `saved session for ${session.user}` : session.expired ? "expired" : "not logged in"} download-delay=${fmtDuration(downloadDelaySec * 1000)} user-agent=${process.env.USER_AGENT ? "custom" : "default"}`);
  rescanLibrary("boot");
  // Pick up books other tools add, now and then, without a restart.
  setInterval(() => { if (!shuttingDown) rescanLibrary("periodic"); }, 60 * 60_000).unref();
  if (skippedFilters.length) log("warn", `Ignored filters the site cannot search: ${[...new Set(skippedFilters)].join(", ")}`);
  log("info", "Stopped. Log in, set a search query, then press Start.");
  status.message = "Stopped. Log in, set a search query, then press Start.";
  for (;;) {
    if (shuttingDown) break;
    if (paused && !runNow) {
      // Stopped: only books the user queued by hand are downloaded.
      if (wantQueue.length && queueArmed) {
        try {
          await drainOnly();
        } catch (err) {
          log("error", describeError(err));
          wantQueue.length = 0;
          await saveLive();
        }
        if (paused) { status.state = "stopped"; status.message = "Stopped."; }
        continue;
      }
      if (status.state !== "stopped") {
        status.state = "stopped";
        status.message = "Stopped. Press Start to begin.";
      }
      await wait(300);
      continue;
    }
    if (!runNow && status.sleepUntil && Date.parse(status.sleepUntil) - Date.now() > 500) {
      await sleepUntilDue();
      continue;
    }
    runNow = false;
    try { await runCycle(); } catch (err) { log("error", describeError(err)); }
    if (cfg.once || shuttingDown) break;
    if (authFailed) {
      paused = true;
      queueArmed = false;
      status.state = "stopped";
      status.message = "Stopped: not logged in or the login expired. Log in, then press Start.";
      log("warn", status.message);
      continue;
    }
    if (paused || runNow) continue;
    if (!liveTags && !wantQueue.length) continue;
    const until = new Date(Date.now() + cfg.sleep * 1000);
    status.sleepUntil = until.toISOString();
    status.state = "sleeping";
    status.message = `Sleeping until ${until.toISOString()}`;
    log("info", status.message);
    await sleepUntilDue();
  }
  status.state = "stopped";
}

process.on("SIGTERM", () => { shuttingDown = true; wake(); });
process.on("SIGINT", () => { shuttingDown = true; wake(); });
await main();