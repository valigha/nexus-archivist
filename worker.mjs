#!/usr/bin/env node
/**
 * HentaiNexus CBZ archivist.
 * Search and /view/{id} pages give the metadata. The images come from the
 * site's own /zip/{id} download, using the logged-in session in COOKIE.
 * The zip is turned into a CBZ by adding ComicInfo.xml. Nothing from the
 * reader pages is decoded.
 */
import { createServer } from "node:http";
import net from "node:net";
import dns from "node:dns";
import { timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile, appendFile } from "node:fs/promises";
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
const VERSION = "1.1.0";
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
  maxPages: Math.max(0, Number(process.env.MAX_SEARCH_PAGES) || 0),
  cookie: (process.env.COOKIE || "").replace(/^\s*cookie:\s*/i, "").trim(),
  zipTimeout: Math.max(60, Number(process.env.ZIP_TIMEOUT_SEC) || 900),
  zipDelay: (process.env.ZIP_DELAY_MS ?? "") === "" ? 5000 : Math.max(0, Number(process.env.ZIP_DELAY_MS) || 0),
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
  libraryCount: 0,
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
  cookieSet: false,
  tagsInput: "",
  tags: "",
  sleepUntil: null,
  wantQueue: [],
  recent: [],
  startedAt: new Date().toISOString(),
};

let liveTags = (process.env.HN_TAGS || "").trim();
let paused = false;
let runNow = false;
let shuttingDown = false;
let wantQueue = [];
let wantBusy = false;
let authFailed = false;
let sleepTimer = null;
let sleepResolve = null;
let lastHtmlAt = 0;

status.cookieSet = !!cfg.cookie;
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
  return err?.name === "TimeoutError" || ["ECONNRESET", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "EAI_AGAIN"].includes(code);
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
  const extras = ["lolicon", "shotacon", "loli", "shota", "toddlercon"]
    .filter((t) => !q.toLowerCase().includes(`-tag:${t}`))
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

function sync() {
  status.paused = paused;
  status.tagsInput = liveTags;
  status.tags = liveTags ? withSafety(liveTags) : "";
  status.wantQueue = [...wantQueue];
}

async function saveLive() {
  sync();
  try {
    await mkdir(dirname(livePath), { recursive: true });
    await writeFile(livePath, JSON.stringify({ tags: liveTags, paused, wantQueue }, null, 2) + "\n");
  } catch (err) {
    log("warn", `could not save nexus.json: ${err instanceof Error ? err.message : err}`);
  }
}

function loadLive() {
  try {
    const j = JSON.parse(readFileSync(livePath, "utf8"));
    if (typeof j.tags === "string") liveTags = j.tags.trim();
    if (typeof j.paused === "boolean") paused = j.paused;
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
  const overhead = `${id} .cbz`.length;
  let out = "";
  let bytes = 0;
  for (const ch of cleaned) {
    const size = Buffer.byteLength(ch);
    if (overhead + bytes + size > 240) break;
    out += ch;
    bytes += size;
  }
  return `${id}${out ? ` ${out}` : ""}.cbz`;
}

async function throttleHtml() {
  const waitFor = lastHtmlAt + cfg.delay - Date.now();
  if (waitFor > 0) await wait(waitFor);
  lastHtmlAt = Date.now();
}

async function http(url, { referer } = {}) {
  const headers = {
    "User-Agent": cfg.ua,
    Accept: "text/html",
    Referer: referer || `${ORIGIN}/`,
  };
  if (cfg.cookie) headers.Cookie = cfg.cookie;
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
    if (res.status === 429 || res.status === 503 || res.status === 502) {
      const pause = Math.min(120_000, 4000 * 2 ** i);
      log("warn", `${res.status} ${url} — waiting ${Math.round(pause / 1000)}s`);
      await wait(pause);
      last = String(res.status);
      continue;
    }
    if (res.status === 403) throw new Error(`403 from ${url}. If this is Cloudflare, set COOKIE from a browser that can open the site, and set USER_AGENT to the same browser User-Agent.`);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    const text = await res.text();
    if (/Just a moment|cf-browser-verification|challenge-platform/i.test(text)) {
      throw new Error("Cloudflare challenge. Set COOKIE from a browser that can open the site.");
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

async function indexLibrary(root) {
  const ids = new Set();
  async function scan(dir, depth) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory() && depth < 2 && !entry.name.startsWith(".tmp-")) await scan(full, depth + 1);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".cbz")) {
        const m = entry.name.match(/^(\d+)\b/);
        if (m) ids.add(Number(m[1]));
      }
    }
  }
  await scan(root, 0);
  return ids;
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

const LOGIN_HELP = `Log in at ${ORIGIN} in your browser, copy the Cookie header of a request to the site, and put it in the COOKIE variable of the Unraid template.`;

async function httpFile(url, dest, { referer } = {}) {
  const headers = {
    "User-Agent": cfg.ua,
    Accept: "application/zip,application/octet-stream,*/*;q=0.8",
    Referer: referer || `${ORIGIN}/`,
  };
  if (cfg.cookie) headers.Cookie = cfg.cookie;
  let last = "no response";
  for (let i = 0; i < 4; i++) {
    await throttleHtml();
    status.downloadDone = 0;
    status.downloadTotal = 0;
    let res;
    try {
      res = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(cfg.zipTimeout * 1000) });
    } catch (err) {
      last = describeError(err);
      if (isTransient(err) && i < 3) {
        const pause = Math.min(60_000, 3000 * 2 ** i);
        log("warn", `${last} (${url}) - retrying in ${Math.round(pause / 1000)}s`);
        await wait(pause);
        continue;
      }
      throw new Error(`${last} (${url})`);
    }
    if (res.status === 429 || res.status === 503 || res.status === 502) {
      const pause = Math.min(120_000, 4000 * 2 ** i);
      log("warn", `${res.status} ${url} - waiting ${Math.round(pause / 1000)}s`);
      await wait(pause);
      last = String(res.status);
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`LOGIN REQUIRED: ${res.status} from ${url}. Your session may have expired, or Cloudflare is blocking the request (then also set USER_AGENT to the same browser). ${LOGIN_HELP}`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    const type = (res.headers.get("content-type") || "").toLowerCase();
    if (type.includes("text/html") || type.includes("json")) {
      const body = (await res.text()).slice(0, 4000);
      if (/Just a moment|cf-browser-verification|challenge-platform/i.test(body)) {
        throw new Error("Cloudflare challenge on the zip download. Set COOKIE (and USER_AGENT) from a browser that can open the site.");
      }
      throw new Error(`LOGIN REQUIRED: the site returned a web page instead of a zip, so the COOKIE is missing or expired. ${LOGIN_HELP}`);
    }
    status.downloadTotal = Number(res.headers.get("content-length")) || 0;
    try {
      const body = Readable.fromWeb(res.body);
      body.on("data", (chunk) => { status.downloadDone += chunk.length; });
      await pipeline(body, createWriteStream(dest));
    } catch (err) {
      await rm(dest, { force: true });
      last = describeError(err);
      if (i < 3 && !shuttingDown) {
        log("warn", `download interrupted (${last}) - retrying`);
        await wait(3000 * 2 ** i);
        continue;
      }
      throw new Error(`${last} (${url})`);
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
  throw new Error(`gave up ${url} (${last})`);
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

async function downloadGallery(id, have) {
  status.state = cfg.dry ? "dry-run" : "downloading";
  status.currentId = id;
  status.currentTitle = "";
  status.downloadDone = 0;
  status.downloadTotal = 0;
  status.message = `Gallery ${id}`;
  if (!cfg.dry && !cfg.cookie) {
    throw new Error(`LOGIN REQUIRED: COOKIE is not set. ${LOGIN_HELP}`);
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

  const tmp = join(cfg.library, `.tmp-${id}`);
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  try {
    const zipPath = join(tmp, `${id}.zip`);
    status.message = `Downloading zip for #${id}`;
    await httpFile(`${ORIGIN}/zip/${id}`, zipPath, { referer: `${ORIGIN}/view/${id}` });
    const pages = await addComicInfo(zipPath, (count) => comicInfo({ ...g, pages: count }));
    await rename(zipPath, dest);
    have.add(id);
    status.libraryCount = have.size;
    status.addedThisCycle += 1;
    log("info", `Wrote ${dest} (${pages} pages)`);
    pushEvent("wrote", { id, title: filename, pages });
    if (cfg.zipDelay) await wait(cfg.zipDelay);
    return "wrote";
  } finally {
    if (cfg.cleanup) await rm(tmp, { recursive: true, force: true });
  }
}

async function takeOne(id, have, skip) {
  try {
    if (skip.has(id)) return "blacklisted";
    if (have.has(id)) return "have";
    return await downloadGallery(id, have);
  } catch (err) {
    status.failedThisCycle += 1;
    const title = describeError(err);
    if (/^LOGIN REQUIRED/.test(title)) authFailed = true;
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
      await takeOne(id, have, skip);
      wantQueue.shift();
      if (authFailed && wantQueue.length) {
        log("warn", `Login required: dropped ${wantQueue.length} more queued book(s). Fix COOKIE and queue them again.`);
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
  while (page <= last && !shuttingDown) {
    if (paused && !runNow) { log("info", "Paused"); return; }
    if (cfg.maxPages && page > cfg.maxPages) return;
    const html = await http(searchUrl(query, page));
    const parsed = parseSearch(html);
    last = Math.max(last, parsed.last);
    status.searchPage = page;
    status.searchPages = last;
    status.state = "searching";
    status.message = `Search page ${page} / ${last}`;
    if (!parsed.ids.length) return;
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
  status.state = "searching";
  const have = await indexLibrary(cfg.library);
  const skip = new Set(await readIds(cfg.dont));
  status.libraryCount = have.size;
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
  if (liveTags && !shuttingDown && !(paused && !runNow)) await searchCycle(have, skip);
  if (!liveTags && !listed.length && !wantQueue.length) {
    status.state = "idle";
    status.message = "No query yet. Set one below, or paste a gallery link.";
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
        if (action === "pause") { paused = true; log("info", "Pause requested"); }
        else if (action === "run") { paused = false; runNow = true; log("info", "Run now"); wake(); }
        else return json(res, 400, { error: "action must be pause or run" });
        await saveLive();
        json(res, 200, snapshot());
      }).catch((err) => json(res, 400, { error: err.message }));
      return;
    }
    if (url.pathname === "/api/config" && req.method === "POST") {
      readBody(req).then(async (body) => {
        const tags = String(body.tags ?? "").trim();
        if (tags.length > 500) return json(res, 400, { error: "query too long" });
        liveTags = tags;
        log("info", `Query saved: ${tags || "(empty)"}`);
        await saveLive();
        json(res, 200, snapshot());
      }).catch((err) => json(res, 400, { error: err.message }));
      return;
    }
    if (url.pathname === "/api/want" && req.method === "POST") {
      readBody(req).then(async (body) => {
        const ids = parseWant(body.text);
        if (!ids.length) return json(res, 400, { error: "Paste a hentainexus.com/view/… link or an id" });
        for (const id of ids) if (!wantQueue.includes(id) && wantQueue.length < 500) wantQueue.push(id);
        log("info", `Queued ${ids.join(", ")}`);
        await saveLive();
        wake();
        json(res, 200, snapshot());
      }).catch((err) => json(res, 400, { error: err.message }));
      return;
    }
    if (url.pathname === "/api/import" && req.method === "POST") {
      if (!authorized(req.headers["x-api-key"])) { req.resume(); return json(res, 401, { ok: false, error: "unauthorized" }); }
      readBody(req).then(async (body) => {
        const ids = parseWant(body.url || body.id || "");
        if (ids.length !== 1) return json(res, 400, { ok: false, error: "bad request" });
        if (!wantQueue.includes(ids[0])) wantQueue.push(ids[0]);
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
  status.libraryCount = have.size;
  await saveLive();
}

// Sleep until the next cycle is due, but handle queued books as soon as they
// arrive, and return straight away when "Run now" is pressed.
async function sleepUntilDue() {
  while (!shuttingDown && !runNow) {
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
  if (cfg.port) startServer(cfg.port);
  log("info", `Nexus archivist ${VERSION}. library=${cfg.library} delay=${cfg.delay}ms query=${status.tags || "(none)"}`);
  log("info", `cookie=${cfg.cookie ? "set" : "not set"} user-agent=${process.env.USER_AGENT ? "custom" : "default"}`);
  if (!cfg.cookie) log("warn", `COOKIE is not set. Downloads need a logged-in session. ${LOGIN_HELP}`);
  for (;;) {
    if (shuttingDown) break;
    while (paused && !runNow && !wantQueue.length && !shuttingDown) {
      status.state = "paused";
      status.message = status.message || "Paused";
      await wait(400);
    }
    if (shuttingDown) break;
    if (!runNow && status.sleepUntil && Date.parse(status.sleepUntil) - Date.now() > 500) {
      await sleepUntilDue();
      continue;
    }
    const forced = runNow;
    runNow = false;
    try { await runCycle(); } catch (err) { log("error", describeError(err)); }
    if (cfg.once || shuttingDown) break;
    if (paused && !forced) continue;
    if (runNow) continue;
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