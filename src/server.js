#!/usr/bin/env node
// Serves the lock screen page and the live state written by hook.js.
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile, spawn } = require("child_process");
const crypto = require("crypto");
const calendar = require("./calendar");
const google = require("./google");
const battery = require("./battery");
const planUsage = require("./planusage");

const PORT = Number(process.env.CLAUDE_LOCKSCREEN_PORT) || 4777;
const DATA = process.env.CLAUDE_LOCKSCREEN_DIR || path.join(os.homedir(), ".claude", "lockscreen");
const SESSIONS = path.join(DATA, "sessions");
const CONFIG = path.join(DATA, "config.json");
const USAGE = path.join(DATA, "usage.json"); // written by statusline.js and planusage.js
const CLAUDE_SETTINGS = path.join(os.homedir(), ".claude", "settings.json");
const PAGE = path.join(__dirname, "index.html");
const SETTINGS_PAGE = path.join(__dirname, "settings.html");
const THEMES = ["gotham"]; // this fork ships one theme
function themes() {
  const list = THEMES.slice();
  return list;
}
const DAY = 24 * 3600e3;
const MAX_PRESETS = 24;
const MAX_CALENDARS = 16; // several Google and Outlook accounts, each with a few calendars
// Starter presets until the user saves their own list.
const DEFAULT_PRESETS = ["Back in 10 min, grabbing coffee ☕", "In a meeting 📅", "Lunch break 🥗", "Deep work. My agents are on it 🦀", "Gone for the day, see you tomorrow 👋"];

fs.mkdirSync(SESSIONS, { recursive: true });

function readConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG, "utf8")); } catch {}
  if (!Array.isArray(cfg.presets)) cfg.presets = DEFAULT_PRESETS;
  if (!Array.isArray(cfg.calendars)) cfg.calendars = [];
  return cfg;
}
function writeConfig(cfg) {
  writeAtomic(CONFIG, JSON.stringify(cfg, null, 2), { mode: 0o600 }); // holds secret calendar addresses
  fs.chmodSync(CONFIG, 0o600);
}
// Config as pages see it: calendar addresses are secrets and stay on the server.
function publicConfig() {
  const { calendars, ...cfg } = readConfig();
  const available = themes();
  // No saved theme, or one that isn't on the list any more, uses the default (a saved one comes back if it returns).
  return { ...cfg, theme: available.includes(cfg.theme) ? cfg.theme : THEMES[0], themes: available };
}

function cleanPresets(list) {
  const seen = new Set();
  return list
    .filter((p) => typeof p === "string")
    .map((p) => p.trim().slice(0, 140))
    .filter((p) => p && !seen.has(p) && seen.add(p))
    .slice(0, MAX_PRESETS);
}

// Every page polls /status each second, so a session file is read again only when it changed (hook.js replaces the
// whole file, so its modification time and size tell).
const sessionText = new Map(); // file -> { mtimeMs, size, text }
function readSessions() {
  const now = Date.now();
  const out = [], transcripts = new Set();
  let names = [];
  try { names = fs.readdirSync(SESSIONS); } catch (e) {
    // Someone cleared the data folder: recreate it rather than crash (the 10 s awake timer would take the server down).
    if (e.code === "ENOENT") try { fs.mkdirSync(SESSIONS, { recursive: true }); } catch {}
  }
  const files = names.filter((f) => f.endsWith(".json")).map((f) => path.join(SESSIONS, f));
  for (const file of sessionText.keys()) if (!files.includes(file)) sessionText.delete(file);
  for (const file of files) {
    try {
      const st = fs.statSync(file);
      let c = sessionText.get(file);
      if (!c || c.mtimeMs !== st.mtimeMs || c.size !== st.size) sessionText.set(file, (c = { mtimeMs: st.mtimeMs, size: st.size, text: fs.readFileSync(file, "utf8") }));
      const s = JSON.parse(c.text);
      if (now - (s.updated_at || 0) > DAY) { fs.unlinkSync(file); continue; }
      if (s.transcript) transcripts.add(s.transcript);
      if (wasStopped(s, now)) {
        const stopped = { ...s, state: "idle", action: "Stopped", updated_at: now };
        // hook.js may have written a newer state since this read: only replace the file if it's still what was read.
        const cur = fs.statSync(file);
        if (cur.mtimeMs === c.mtimeMs && cur.size === c.size && fs.readFileSync(file, "utf8") === c.text) {
          writeAtomic(file, JSON.stringify(stopped));
          Object.assign(s, stopped);
        }
      }
      out.push(s);
    } catch {}
  }
  for (const t of transcriptSeen.keys()) if (!transcripts.has(t)) transcriptSeen.delete(t); // ended sessions
  return out;
}

// Writes a file whole or not at all: a reader never sees it half written.
function writeAtomic(file, text, opts) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try { fs.writeFileSync(tmp, text, opts); fs.renameSync(tmp, file); }
  catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
}

// Stopping Claude mid-turn (Esc, or the stop button) sends no hook event, so a stopped session would look busy
// until it went stale. Claude Code does write "[Request interrupted by user]" to the session's transcript: for a
// session that says it's working, look at the transcript's last message whenever the file changes.
const transcriptSeen = new Map(); // transcript path -> size last checked
function wasStopped(s, now) {
  if ((s.state !== "working" && s.state !== "thinking") || !s.transcript || now - (s.updated_at || 0) < 1500) return false;
  try {
    if (transcriptSeen.get(s.transcript) === fs.statSync(s.transcript).size) return false; // unchanged: not even opened
    const fd = fs.openSync(s.transcript, "r");
    try {
      const size = fs.fstatSync(fd).size;
      if (transcriptSeen.get(s.transcript) === size) return false;
      transcriptSeen.set(s.transcript, size);
      const len = Math.min(size, 65536), buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString("utf8").split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        let entry; try { entry = JSON.parse(lines[i]); } catch { continue; }
        if (entry.type !== "user" && entry.type !== "assistant") continue;
        if (entry.type === "assistant") return false;
        const c = entry.message && entry.message.content;
        const text = typeof c === "string" ? c : Array.isArray(c) && c[0] && c[0].type === "text" ? c[0].text : "";
        return /^\[Request interrupted by user/.test(String(text));
      }
    } finally { fs.closeSync(fd); }
  } catch {}
  return false;
}

// Claude plan usage as last saved, by Anthropic's usage API (planusage.js, works with any Claude Code) or by the
// status line (statusline.js, terminal only). `statusline`: whether that status line is still ours (Claude Code's
// /statusline command, or the user, can replace it). `api`: what the last API check found.
function readUsage() {
  let u = null, statusline = false;
  try { u = JSON.parse(fs.readFileSync(USAGE, "utf8")); } catch {}
  try { statusline = /agent-foudre-statusline|\/lockscreen\/app\/statusline\.js/.test(String(JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, "utf8")).statusLine?.command || "")); } catch {}
  // Show plan usage off: "off" and not connected right away, not at the next scheduled check.
  const api = planUsage.status(), on = readConfig().showUsage === true;
  return { connected: on && (statusline || api.status === "ok"), statusline, api, five_hour: u?.five_hour || null, seven_day: u?.seven_day || null,
    updated_at: u?.updated_at || 0, seen_at: u?.seen_at || 0, reported_at: u?.reported_at || 0 };
}

function send(res, code, body) {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

// A JSON content type forces a CORS preflight, so other websites can't post to these routes.
function readJson(req, res, then) {
  if (!String(req.headers["content-type"]).startsWith("application/json")) return send(res, 415, { error: "json only" });
  let body = "", size = 0;
  req.on("data", (c) => {
    size += c.length;
    if (size > 1e6) return req.destroy(); // still sending after being told no
    if (res.headersSent) return; // too big, answered already: drain the rest so the client reads the answer
    body += c;
    if (body.length > 2e4) { body = ""; res.setHeader("connection", "close"); send(res, 413, { error: "too large" }); }
  });
  req.on("end", () => {
    if (res.headersSent) return;
    let data;
    try { data = JSON.parse(body); } catch { return send(res, 400, { error: "bad json" }); }
    Promise.resolve().then(() => then(data)).catch((e) => { if (!res.headersSent) send(res, 500, { error: String(e.message || e) }); });
  });
}

function updateConfig(req, res) {
  readJson(req, res, (patch) => {
    const cfg = readConfig();
    if (themes().includes(patch.theme)) cfg.theme = patch.theme;
    if (typeof patch.customText === "string") cfg.customText = patch.customText.slice(0, 140);
    if (typeof patch.showDetails === "boolean") cfg.showDetails = patch.showDetails;
    if (typeof patch.sessionNames === "boolean") cfg.sessionNames = patch.sessionNames;
    if (Array.isArray(patch.presets)) cfg.presets = cleanPresets(patch.presets);
    if (typeof patch.calTitles === "boolean") cfg.calTitles = patch.calTitles;
    if (typeof patch.showUsage === "boolean") cfg.showUsage = patch.showUsage;
    if (patch.showUsage === true) planUsage.refresh();
    if (typeof patch.keepAwake === "boolean") cfg.keepAwake = patch.keepAwake;
    if (typeof patch.powerSaver === "boolean") cfg.powerSaver = patch.powerSaver;
    writeConfig(cfg);
    updateAwake();
    send(res, 200, publicConfig());
  });
}

// Adds an iCal address after checking it really is a calendar we can read.
function addCalendar(req, res) {
  readJson(req, res, async ({ url }) => {
    const cfg = readConfig();
    const clean = calendar.normalizeUrl(url);
    if (!clean) return send(res, 400, { error: "Paste a calendar address starting with https:// or webcal://" });
    if (cfg.calendars.some((c) => c.url === clean)) return send(res, 409, { error: "That calendar is already connected" });
    if (cfg.calendars.length >= MAX_CALENDARS) return send(res, 400, { error: `Up to ${MAX_CALENDARS} calendars` });
    const probe = await calendar.sync({ id: "probe", url: clean, events: [] });
    if (!probe.ok) return send(res, 422, { error: probe.error });
    const entry = { id: crypto.randomBytes(6).toString("hex"), url: clean, name: probe.name };
    cfg.calendars.push(entry);
    writeConfig(cfg);
    calendar.setFeeds(cfg.calendars);
    Object.assign(calendar.feeds.get(entry.id), { ok: true, name: probe.name, syncedAt: probe.syncedAt, events: probe.events });
    send(res, 200, calendar.snapshot());
  });
}
function removeCalendar(req, res) {
  readJson(req, res, ({ id }) => {
    const cfg = readConfig();
    cfg.calendars = cfg.calendars.filter((c) => c.id !== id);
    writeConfig(cfg);
    calendar.setFeeds(cfg.calendars);
    send(res, 200, calendar.snapshot());
  });
}
/* ---------- Keep the Mac awake while agents work ---------- */
// With "Keep Mac awake" on, macOS's own caffeinate holds off idle sleep (-i: the system only, so the display still
// sleeps and the screensaver and locking work as usual) while a session is actively working, and lets go when none is.
// "Actively" matches the lock screen: a working session that hasn't reported for a while has probably stalled (an
// interrupted turn sends no Stop), so it stops counting after 5 min of thinking or 20 min inside one tool.
// -w ties caffeinate to this server, so it never outlives it.
let caffeinate = null;
function workingSessions(list = readSessions(), now = Date.now()) {
  return list.filter((s) => (s.state === "working" || s.state === "thinking") &&
    now - (s.updated_at || 0) <= (s.state === "thinking" ? 5 : 20) * 60e3).length;
}
function awakeStatus(list) {
  const working = workingSessions(list);
  return { on: readConfig().keepAwake === true, holding: !!caffeinate, working };
}
function updateAwake() {
  const want = process.platform === "darwin" && readConfig().keepAwake === true && workingSessions() > 0;
  if (want && !caffeinate) {
    caffeinate = spawn("/usr/bin/caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" });
    caffeinate.on("error", () => { caffeinate = null; });
    caffeinate.on("exit", function () { if (caffeinate === this) caffeinate = null; });
  } else if (!want && caffeinate) {
    caffeinate.kill();
    caffeinate = null;
  }
}

/* ---------- Sign in with Google ---------- */
function googleRoute(req, res, action) {
  readJson(req, res, async (body) => {
    try {
      if (action === "connect") {
        const url = google.startAuth();
        // Google blocks sign-in inside embedded web views, so it opens in the default browser.
        if (!process.env.CLAUDE_LOCKSCREEN_NO_OPEN) execFile("/usr/bin/open", [url]);
        return send(res, 200, { url, google: google.status() });
      }
      if (action === "calendars") google.setSelected(body.ids);
      if (action === "disconnect") await google.disconnect();
      send(res, 200, { google: google.status(), calendar: calendar.snapshot() });
    } catch (e) {
      send(res, 400, { error: String(e.message || e) });
    }
  });
}
function callbackPage(ok, text) {
  const color = ok ? "#2f8f5b" : "#c0392b";
  return `<!doctype html><meta charset="utf-8"><title>Agent Foudre</title><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f4ef;color:#1f1e1d;font:15px/1.5 -apple-system,BlinkMacSystemFont,sans-serif}
@media(prefers-color-scheme:dark){body{background:#1b1a19;color:#f0eee6}}main{max-width:440px;padding:32px;text-align:center}
.i{width:52px;height:52px;border-radius:50%;margin:0 auto 16px;display:grid;place-items:center;background:${color};color:#fff;font-size:26px}h1{font-size:20px;margin:0 0 6px}p{margin:0;opacity:.7}</style>
<main><div class="i">${ok ? "✓" : "!"}</div><h1>${ok ? "Google Calendar connected" : "Couldn't connect Google Calendar"}</h1><p>${text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)}</p></main>`;
}
async function googleCallback(req, res, query) {
  let ok = true, text;
  try {
    const email = await google.handleCallback(query);
    text = `Signed in${email ? ` as ${email}` : ""}. Your meetings will show on the lock screen. You can close this tab.`;
  } catch (e) { ok = false; text = String(e.message || e); }
  res.writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(callbackPage(ok, text));
}

// The app's version, from the Info.plist of the app that bundles this server (foudre-node lives in Contents/MacOS).
// Unknown when running from source (node server.js).
const APP_VERSION = process.env.CLAUDE_LOCKSCREEN_VERSION || (() => {
  try {
    const plist = fs.readFileSync(path.join(path.dirname(process.execPath), "..", "Info.plist"), "utf8");
    return /<key>CFBundleShortVersionString<\/key>\s*<string>([\d.]+)<\/string>/.exec(plist)?.[1] || null;
  } catch { return null; }
})();

function syncCalendars(req, res) {
  readJson(req, res, async () => {
    await Promise.all([...calendar.feeds.values()].map(calendar.sync));
    send(res, 200, calendar.snapshot());
  });
}

// DNS rebinding: a web page can point its own host name at 127.0.0.1 and then read /status or POST settings as if it
// were same-origin (the JSON-only rule stops plain cross-site posts, not this). The browser still sends that page's
// host name, so only requests addressed to this server by its own name are served, and writes must come from its own
// pages or from a client that sends no Origin (the app, curl).
const OWN_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const OWN_ORIGINS = new Set([...OWN_HOSTS].map((h) => `http://${h}`));
function trusted(req) {
  if (!OWN_HOSTS.has(String(req.headers.host || "").toLowerCase())) return false;
  const origin = req.headers.origin;
  return req.method === "GET" || req.method === "HEAD" || origin === undefined || OWN_ORIGINS.has(origin);
}

const server = http.createServer((req, res) => {
  if (!trusted(req)) return send(res, 403, { error: "forbidden" });
  const { pathname } = new URL(req.url, "http://localhost");
  if (req.method === "GET" && pathname === "/status") {
    battery.markShown(new URL(req.url, "http://localhost").searchParams.get("shown"));
    const cfg = publicConfig();
    // "Use session names" (on by default): label each agent by its Claude session name, else by its folder.
    const sessions = readSessions().map((s) => (cfg.sessionNames !== false && s.title ? { ...s, project: s.title } : s));
    return send(res, 200, { now: Date.now(), sessions, config: cfg, calendar: calendar.snapshot(), google: google.status(), usage: readUsage(), battery: battery.summary(), awake: awakeStatus(sessions), version: APP_VERSION });
  }
  if (req.method === "POST" && pathname === "/config") return updateConfig(req, res);
  if (req.method === "POST" && pathname === "/calendars/add") return addCalendar(req, res);
  if (req.method === "POST" && pathname === "/calendars/remove") return removeCalendar(req, res);
  if (req.method === "POST" && pathname === "/calendars/sync") return syncCalendars(req, res);
  const g = /^\/google\/(connect|calendars|disconnect)$/.exec(pathname);
  if (req.method === "POST" && g) return googleRoute(req, res, g[1]);
  if (req.method === "GET" && pathname === "/google/callback") return googleCallback(req, res, new URL(req.url, "http://localhost").searchParams);
  if (req.method === "GET" && pathname === "/settings") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return fs.createReadStream(SETTINGS_PAGE).pipe(res);
  }
  if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return fs.createReadStream(PAGE).pipe(res);
  }
  send(res, 404, { error: "not found" });
});

calendar.setFeeds(readConfig().calendars);
google.init({ dataDir: DATA, port: PORT });
battery.init({ dataDir: DATA, currentTheme: () => publicConfig().theme });
planUsage.init({ usageFile: USAGE, enabled: () => readConfig().showUsage === true });
setInterval(updateAwake, 10e3).unref();
updateAwake();

// Port taken (a `node src/server.js` dev run, another copy): crashing made launchd's KeepAlive restart this every
// ~10 s forever. Keep the process and retry with a growing wait instead, so it takes over once the port is free.
let listenDelay = 2e3;
server.on("error", (e) => {
  if (e.code !== "EADDRINUSE") throw e;
  console.error(`Agent Foudre: port ${PORT} is in use, retrying in ${listenDelay / 1e3}s`);
  setTimeout(() => server.listen(PORT, "127.0.0.1"), listenDelay);
  listenDelay = Math.min(listenDelay * 2, 60e3);
});
server.on("listening", () => {
  listenDelay = 2e3;
  console.log(`Agent Foudre: http://127.0.0.1:${PORT}  (data: ${DATA})`);
});
server.listen(PORT, "127.0.0.1");
