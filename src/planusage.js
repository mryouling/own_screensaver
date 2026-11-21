// Claude plan usage straight from Anthropic, so it shows whichever Claude Code you use (VS Code, the desktop app,
// a terminal). Claude Code's own /usage screen reads the same numbers: GET api.anthropic.com/api/oauth/usage,
// signed in with the login Claude Code keeps in the macOS Keychain ("Claude Code-credentials").
//
// Read-only on purpose: the token is read through /usr/bin/security each time, sent only to api.anthropic.com,
// and never stored, logged or refreshed. Refreshing would rotate Claude Code's login behind its back; when the token
// has expired we wait until Claude Code (which refreshes it whenever you use it) has saved a new one.
//
// The result goes to usage.json in the status line's format (statusline.js), so the lock screen reads one file
// whichever source wrote it last.
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");

const ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const EVERY = 5 * 60e3;       // normal poll
const BACKOFF = 15 * 60e3;    // after a 429 or a server error
const TIMEOUT = 10e3;

let usageFile = null, enabled = () => false, timer = null, inFlight = null;
// What the last attempt found, for the settings page. Never holds the token.
const state = { status: "off", checked_at: 0, ok_at: 0, error: null };

// The Keychain account Claude Code files its login under, worked out the way Claude Code does (its own reads are
// `security find-generic-password -a "<account>" -w -s "Claude Code-credentials"`): $USER, else the login name, and
// "claude-code-user" when that has characters it doesn't accept. Asking for the account too avoids picking up some
// other item that happens to share the service name.
function keychainAccount() {
  let name;
  try { name = process.env.USER || os.userInfo().username; } catch { name = "claude-code-user"; }
  return /^[a-zA-Z0-9._-]+$/.test(name || "") ? name : "claude-code-user";
}

function readToken() {
  return new Promise((resolve) => {
    if (process.platform !== "darwin") return resolve({ error: "macOS only" });
    if (process.env.CLAUDE_LOCKSCREEN_NO_KEYCHAIN) return resolve({ error: "no-login" }); // check.js: hands off the real Keychain
    execFile("/usr/bin/security", ["find-generic-password", "-a", keychainAccount(), "-s", KEYCHAIN_SERVICE, "-w"], { timeout: 10e3 }, (err, out) => {
      if (err) return resolve({ error: "no-login" }); // not signed in to Claude Code, or Keychain access denied
      try {
        const o = JSON.parse(out).claudeAiOauth || {};
        if (!o.accessToken) return resolve({ error: "no-login" });
        resolve({ token: o.accessToken, expiresAt: Number(o.expiresAt) || 0 });
      } catch { resolve({ error: "no-login" }); }
    });
  });
}

// { utilization: 6.0, resets_at: "2026-11-21T05:30:00Z" } -> { used: 6, resets_at: <ms> }, as statusline.js saves it
function toWindow(w) {
  const pct = Number(w && w.utilization), at = Date.parse(w && w.resets_at);
  return Number.isFinite(pct) && Number.isFinite(at) ? { used: Math.max(0, Math.min(100, pct)), resets_at: at } : null;
}

function save(five, week) {
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(usageFile, "utf8")); } catch {}
  const now = Date.now();
  const out = { ...prev, five_hour: five || prev.five_hour || null, seven_day: week || prev.seven_day || null,
    updated_at: now, reported_at: now, api_at: now };
  fs.mkdirSync(path.dirname(usageFile), { recursive: true });
  const tmp = `${usageFile}.${process.pid}.api.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(out));
  fs.renameSync(tmp, usageFile);
}

// What a usage API answer means: { status, error, wait } plus the windows when there are some. `httpStatus` null:
// the request failed (offline); `body` undefined: the response wasn't JSON. Pure, so check.js can test it.
function classify(httpStatus, body) {
  if (httpStatus == null) return { status: "offline", error: null, wait: EVERY };
  if (httpStatus === 401 || httpStatus === 403) return { status: "expired", error: null, wait: EVERY };
  if (httpStatus < 200 || httpStatus >= 300) return { status: "error", error: `HTTP ${httpStatus}`, wait: BACKOFF };
  if (!body || typeof body !== "object") return { status: "error", error: "bad response", wait: BACKOFF };
  const five = toWindow(body.five_hour), week = toWindow(body.seven_day);
  if (!five && !week) return { status: "no-plan", error: null, wait: EVERY }; // API-key billing: no limits
  return { status: "ok", error: null, wait: EVERY, five, week };
}

async function fetchOnce() {
  state.checked_at = Date.now();
  const cred = await readToken();
  if (cred.error) return Object.assign(state, { status: cred.error, error: null }), EVERY;
  if (cred.expiresAt && cred.expiresAt < Date.now()) return Object.assign(state, { status: "expired", error: null }), EVERY;
  let res, body;
  try {
    res = await fetch(ENDPOINT, { signal: AbortSignal.timeout(TIMEOUT), cache: "no-store",
      headers: { authorization: `Bearer ${cred.token}`, "anthropic-beta": "oauth-2025-04-20", "content-type": "application/json" } });
  } catch {}
  if (res && res.ok) try { body = await res.json(); } catch {}
  const r = classify(res ? res.status : null, body);
  if (r.status === "ok") { save(r.five, r.week); state.ok_at = Date.now(); }
  Object.assign(state, { status: r.status, error: r.error });
  return r.wait;
}

function schedule(ms) {
  clearTimeout(timer);
  timer = setTimeout(tick, ms);
  timer.unref();
}
async function tick() {
  if (!enabled()) { state.status = "off"; return schedule(EVERY); }
  if (!inFlight) inFlight = fetchOnce().catch(() => EVERY).finally(() => { inFlight = null; });
  schedule(await inFlight);
}

// Fetch now (e.g. Show plan usage was just turned on), unless the last check was moments ago.
function refresh() {
  if (Date.now() - state.checked_at > 30e3) schedule(0);
}

function init(opts) {
  usageFile = opts.usageFile;
  enabled = opts.enabled;
  schedule(3e3);
}

// Off as soon as Show plan usage is turned off, not only at the next scheduled check.
function status() { return enabled() ? { ...state } : { ...state, status: "off", error: null }; }

module.exports = { init, refresh, status, classify };
