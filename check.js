#!/usr/bin/env node
// The checks CI runs on every push and pull request (.github/workflows/ci.yml). Run them here with `node check.js`.
//   1. Every script parses: the .js files, and the inline <script> of index.html and settings.html.
//   2. The server starts, serves /, /settings and /status, and checks what POST /config accepts.
//   3. The hook, setup-hooks.js, plan usage and iCal parsing behave (all in temporary folders, never ~/.claude).
//   4. Nothing that must stay private is committed (google-client.json).
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const http = require("http");
const { spawn, execFileSync } = require("child_process");

const ROOT = __dirname;
const SRC = path.join(ROOT, "src");
const SOURCES = ["index.html", "settings.html", "server.js", "calendar.js", "google.js", "battery.js", "planusage.js", "hook.js", "statusline.js", "setup-hooks.js"];
const TOOLS = ["check.js", "macos/bundle.js"];
let failed = 0;

function ok(msg) { console.log(`  ok  ${msg}`); }
function fail(msg) { failed++; console.log(`  FAIL  ${msg}`); }

// Parses a script without running it; an HTML page's inline <script> blocks are parsed one by one.
function parses(name, text) {
  const scripts = name.endsWith(".html")
    ? [...text.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1])
    : [text.replace(/^#!.*/, "")];
  if (!scripts.length) throw new Error("no inline <script> found");
  for (const s of scripts) new vm.Script(name.endsWith(".js") ? `(function (exports, require, module, __filename, __dirname) {${s}\n})` : s, { filename: name });
}

function syntax(files) {
  for (const [name, text] of files) {
    try { parses(name, text); ok(`${name} parses`); }
    catch (e) { fail(`${name}: ${e.message}`); }
  }
}

// This fork ships one theme, gotham: none of the original theme ids may be left behind.
// Only theme-id positions count (data-theme="x", theme: "x", id: "x", x: { / x: [ keys, ["x", …] lists),
// so the same words used as plain text ("a warm light", tone: "warm") don't trip it.
const OLD_THEMES = ["warm", "pixel", "cosmic"];
function oldThemeIn(text) {
  return OLD_THEMES.find((id) => [
    new RegExp(`data-theme="${id}"`),
    new RegExp(`\\b(theme|id)\\s*:\\s*["']${id}["']`),
    new RegExp(`(^|[\\s{,])${id}\\s*:\\s*[{[]`, "m"),
    new RegExp(`THEMES\\s*=\\s*\\[[^\\]]*["']${id}["']`),
    new RegExp(`\\(\\)\\s*=>\\s*["']${id}["']`), // a default, like battery.js's theme = () => "…"
  ].some((re) => re.test(text)));
}
function onlyGotham() {
  for (const [sample, want] of [['const tone = "warm"; // a warm light', undefined], ['<html data-theme="cosmic">', "cosmic"], ['const PAL = { pixel: { a: 1 } };', "pixel"], ['const THEMES = ["cosmic"];', "cosmic"]])
    if (oldThemeIn(sample) !== want) fail(`theme check misreads ${JSON.stringify(sample)}`);
  for (const f of ["src/index.html", "src/settings.html", "src/server.js", "src/battery.js"]) {
    const hit = oldThemeIn(fs.readFileSync(path.join(ROOT, f), "utf8"));
    if (hit) fail(`${f} still has theme "${hit}"`); else ok(`${f} has only gotham`);
  }
  // The battery samples the app keeps (battery.json in its data folder, read only) are filed by theme too.
  const dirs = [process.env.CLAUDE_LOCKSCREEN_DIR, path.join(os.homedir(), ".claude", "agent-foudre"), path.join(os.homedir(), ".claude", "lockscreen")];
  const file = dirs.filter(Boolean).map((d) => path.join(d, "battery.json")).find((f) => fs.existsSync(f));
  if (!file) return ok("no battery.json here, skipped");
  try {
    const text = fs.readFileSync(file, "utf8");
    const hit = oldThemeIn(text) || ((JSON.parse(text).samples || []).find((x) => OLD_THEMES.includes(x && x.theme)) || {}).theme;
    if (hit) fail(`${file} still has theme "${hit}"`); else ok("battery.json has only gotham");
  } catch (e) { fail(`${file}: ${e.message}`); }
}

// The bat's sprites follow the mascot contract drawCrab and stepWalker rely on.
function batSprites() {
  const text = fs.readFileSync(path.join(SRC, "index.html"), "utf8");
  const m = text.match(/\/\/ BAT-SPRITES-BEGIN([\s\S]*?)\/\/ BAT-SPRITES-END/);
  if (!m) return fail("BAT-SPRITES markers not found in src/index.html");
  let s;
  try { s = vm.runInNewContext(`${m[1]};({ BAT, BAT_FEET, BAT_SNEAK_FEET })`); } catch (e) { return fail(`bat sprites: ${e.message}`); }
  let bad = 0;
  for (const pose of ["normal", "wave", "sleep", "sneak", "sneakL", "sneakR"]) if (!Array.isArray(s.BAT[pose])) { bad++; fail(`bat pose "${pose}" missing`); }
  const frames = [...Object.entries(s.BAT).map(([k, rows]) => [`pose ${k}`, rows]),
    ...s.BAT_FEET.map((f, i) => [`feet ${i}`, f]), ...s.BAT_SNEAK_FEET.map((f, i) => [`sneak feet ${i}`, f])];
  for (const [name, rows] of frames) rows.forEach((r, i) => { if (!/^[.XE]{16}$/.test(r)) { bad++; fail(`bat ${name} row ${i}: "${r}"`); } });
  if (s.BAT_FEET.length !== 2 || s.BAT_SNEAK_FEET.length !== 2) { bad++; fail("bat needs 2 feet frames and 2 sneak feet frames"); }
  if (!s.BAT.normal.some((r) => r.includes("E"))) { bad++; fail("bat normal pose has no eyes"); }
  if (!bad) ok("bat sprites are 16 wide with every pose");
}

function request(port, p, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, method, headers, timeout: 3000 }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode, body: text }));
    });
    req.on("timeout", () => { req.destroy(); reject(new Error(`${method} ${p} timed out`)); });
    req.on("error", reject);
    req.end(body);
  });
}
const get = (port, p) => request(port, p);
const post = (port, p, body, type = "application/json") =>
  request(port, p, { method: "POST", headers: { "content-type": type }, body: typeof body === "string" ? body : JSON.stringify(body) });

// Runs a script with the given stdin and environment: { code, out, err }.
function run(args, { input = "", env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    const kill = setTimeout(() => child.kill("SIGKILL"), 10e3);
    child.on("close", (code) => { clearTimeout(kill); resolve({ code, out, err }); });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "foudre-check-")); }

// The Claude Code hook: always exits 0 and prints nothing (anything else would get in Claude's way), and keeps the
// session file up to date.
async function hook() {
  const home = tempDir(), data = path.join(home, "data");
  const env = { HOME: home, CLAUDE_LOCKSCREEN_DIR: data };
  const file = path.join(data, "sessions", "s-1.json");
  const fire = (e) => run([path.join(SRC, "hook.js")], { input: typeof e === "string" ? e : JSON.stringify(e), env });
  const base = { session_id: "s-1", cwd: "/work/my-project", transcript_path: path.join(home, "none.jsonl") };
  const steps = [
    [{ ...base, hook_event_name: "SessionStart", source: "startup" }, { state: "idle", action: "Ready", project: "my-project" }],
    [{ ...base, hook_event_name: "UserPromptSubmit" }, { state: "thinking", action: "Thinking" }],
    [{ ...base, hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/work/my-project/a.js" } }, { state: "working", action: "Reading a.js", tools: 1 }],
    [{ ...base, hook_event_name: "PostToolUse", tool_name: "Read" }, { state: "thinking" }],
    [{ ...base, hook_event_name: "Stop", last_assistant_message: "All done." }, { state: "done", action: "Finished" }],
    ["this is not json {", { state: "done" }], // garbage: nothing changes
    ["", { state: "done" }],
  ];
  try {
    for (const [event, want] of steps) {
      const name = typeof event === "string" ? `garbage ${JSON.stringify(event.slice(0, 12))}` : event.hook_event_name;
      const r = await fire(event);
      if (r.code !== 0 || r.out || r.err) { fail(`hook ${name}: exit ${r.code}, printed ${JSON.stringify(r.out + r.err)}`); continue; }
      let s;
      try { s = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { fail(`hook ${name}: no session file (${e.message})`); continue; }
      const off = Object.entries(want).filter(([k, v]) => s[k] !== v);
      if (off.length) fail(`hook ${name}: ${off.map(([k, v]) => `${k} ${JSON.stringify(s[k])}, want ${JSON.stringify(v)}`).join("; ")}`);
      else ok(`hook ${name} exits 0, prints nothing, session ${s.state}`);
    }
    const leftovers = fs.readdirSync(path.dirname(file)).filter((f) => f !== "s-1.json");
    if (leftovers.length) fail(`hook left files behind: ${leftovers.join(", ")}`); else ok("hook leaves no temp files");
    const r = await fire({ ...base, hook_event_name: "SessionEnd" });
    if (r.code === 0 && !r.out && !r.err && !fs.existsSync(file)) ok("hook SessionEnd removes the session file");
    else fail(`hook SessionEnd: exit ${r.code}, file ${fs.existsSync(file) ? "still there" : "gone"}`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// setup-hooks.js against a settings.json in a temporary home: idempotent, keeps the user's own hooks and status
// line, quotes paths for the shell, and --uninstall puts everything back.
async function setupHooks() {
  const real = path.join(os.homedir(), ".claude", "settings.json");
  const realBefore = fs.existsSync(real) ? fs.statSync(real).mtimeMs : null;
  const home = tempDir(), data = path.join(home, "data");
  const settings = path.join(home, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  const original = { model: "opus", statusLine: { type: "command", command: "echo mine", padding: 1 },
    hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } };
  const originalText = JSON.stringify(original, null, 2) + "\n";
  fs.writeFileSync(settings, originalText);
  const env = { HOME: home, CLAUDE_LOCKSCREEN_DIR: data };
  const node = path.join(home, `My "Apps" $HOME 'x' \`y\``, "foudre-node"); // everything the shell would expand
  const setup = (...args) => run([path.join(SRC, "setup-hooks.js"), ...args], { env });
  try {
    let r = await setup(node, "agent-foudre-hook");
    if (r.code !== 0) return fail(`setup-hooks: exit ${r.code} ${r.err.trim()}`);
    const once = fs.readFileSync(settings, "utf8");
    const s = JSON.parse(once);
    const commands = Object.values(s.hooks).flat().flatMap((g) => g.hooks.map((h) => h.command));
    const ours = commands.filter((c) => c.includes("agent-foudre-hook"));
    if (ours.length === 9 && commands.includes("say done")) ok("setup-hooks adds a hook for each of the 9 events, keeps the user's");
    else fail(`setup-hooks: ${ours.length} hooks of ours, user's ${commands.includes("say done") ? "kept" : "lost"}`);
    const words = execFileSync("/bin/sh", ["-c", `printf '%s\\n' ${ours[0]}`], { encoding: "utf8" }).split("\n").slice(0, -1);
    if (JSON.stringify(words) === JSON.stringify([node, "agent-foudre-hook"])) ok("setup-hooks quotes the node path for the shell");
    else fail(`setup-hooks quoting: the shell reads ${JSON.stringify(ours[0])} as ${JSON.stringify(words)}`);
    if (s.statusLine.command.includes("agent-foudre-statusline") && s.statusLine.padding === 1 &&
      JSON.parse(fs.readFileSync(path.join(data, "statusline-chain.json"), "utf8")).command === "echo mine") ok("setup-hooks wraps the user's status line");
    else fail(`setup-hooks status line: ${JSON.stringify(s.statusLine)}`);
    if (fs.readFileSync(`${settings}.bak-lockscreen`, "utf8") === originalText) ok("setup-hooks backs up settings.json first");
    else fail("setup-hooks: no backup of the original settings.json");

    r = await setup(node, "agent-foudre-hook");
    if (r.code === 0 && fs.readFileSync(settings, "utf8") === once) ok("setup-hooks run twice changes nothing");
    else fail(`setup-hooks is not idempotent (exit ${r.code})`);

    r = await setup("/usr/local/bin/node", "agent-foudre-hook"); // the app moved
    if (r.code === 0 && fs.readFileSync(`${settings}.bak-lockscreen-latest`, "utf8") === once && fs.readFileSync(`${settings}.bak-lockscreen`, "utf8") === originalText)
      ok("setup-hooks keeps the first backup and refreshes the latest one");
    else fail("setup-hooks backups: first or latest is wrong");

    r = await setup("--uninstall");
    const after = fs.readFileSync(settings, "utf8");
    if (r.code === 0 && after === originalText) ok("setup-hooks --uninstall restores settings.json");
    else fail(`setup-hooks --uninstall left ${after}`);
    const strays = fs.readdirSync(path.dirname(settings)).filter((f) => f.endsWith(".tmp"));
    if (strays.length) fail(`setup-hooks left ${strays.join(", ")}`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    if ((fs.existsSync(real) ? fs.statSync(real).mtimeMs : null) !== realBefore) fail("the real ~/.claude/settings.json changed during the checks");
  }
}

// The app's bundled binary runs the hook, and an unknown mode never exits 2, which Claude Code would read as "block this tool call".
async function bundleModes() {
  const home = tempDir(), data = path.join(home, "data"), out = path.join(home, "foudre.js");
  try {
    execFileSync(process.execPath, [path.join(ROOT, "macos", "bundle.js"), SRC, out]);
    const env = { HOME: home, CLAUDE_LOCKSCREEN_DIR: data, AGENT_FOUDRE_RESOURCES: SRC };
    const event = JSON.stringify({ session_id: "b-1", cwd: "/w/p", hook_event_name: "UserPromptSubmit" });
    for (const mode of ["agent-foudre-hook"]) {
      const r = await run([out, mode], { input: event, env });
      if (r.code === 0 && !r.out && fs.existsSync(path.join(data, "sessions", "b-1.json"))) ok(`bundled binary runs the hook as ${mode}`);
      else fail(`bundled ${mode}: exit ${r.code} ${r.err.trim()}`);
      fs.rmSync(path.join(data, "sessions"), { recursive: true, force: true });
    }
    const r = await run([out, "no-such-mode"], { env });
    if (r.code !== 0 && r.code !== 2) ok("an unknown mode fails without blocking Claude Code (exit 1)"); else fail(`unknown mode exit ${r.code}`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function planUsage() {
  const { classify } = require("./src/planusage.js");
  const cases = [
    [[null], "offline"], [[401], "expired"], [[403], "expired"], [[429], "error"], [[500], "error"],
    [[200, undefined], "error"], [[200, {}], "no-plan"], [[200, { five_hour: null, seven_day: null }], "no-plan"],
    [[200, { five_hour: { utilization: 6, resets_at: "2026-11-21T05:30:00Z" } }], "ok"],
  ];
  const bad = cases.filter(([args, want]) => classify(...args).status !== want);
  for (const [args, want] of bad) fail(`plan usage ${JSON.stringify(args)}: ${classify(...args).status}, want ${want}`);
  const r = classify(200, { five_hour: { utilization: 130, resets_at: "2026-11-21T05:30:00Z" }, seven_day: { utilization: 41.5, resets_at: "2026-11-25T00:00:00Z" } });
  if (r.five.used !== 100 || r.five.resets_at !== Date.parse("2026-11-21T05:30:00Z") || r.week.used !== 41.5) { bad.push(1); fail(`plan usage windows: ${JSON.stringify(r)}`); }
  if (classify(429).wait <= classify(null).wait) { bad.push(1); fail("plan usage doesn't back off after a 429"); }
  if (!bad.length) ok("plan usage answers map to the right status");
}

async function iCal() {
  const calendar = require("./src/calendar.js");
  // Weekly on Tuesday and Thursday at 9:00 New York time, from Tuesday 2026-10-27, across the US DST change
  // (Nov 1), with one Thursday removed and one moved.
  const ics = [
    "BEGIN:VCALENDAR", "X-WR-CALNAME:Work",
    "BEGIN:VEVENT", "UID:standup", "SUMMARY:Stand\\, up", "DTSTART;TZID=America/New_York:20261027T090000",
    "DTEND;TZID=America/New_York:20261027T093000", "RRULE:FREQ=WEEKLY;BYDAY=TU,TH;COUNT=6",
    "EXDATE;TZID=America/New_York:20261105T090000",
    "BEGIN:VALARM", "TRIGGER:-PT10M", "SUMMARY:not the event", "END:VALARM", "END:VEVENT",
    "BEGIN:VEVENT", "UID:standup", "SUMMARY:Stand up (moved)", "RECURRENCE-ID;TZID=America/New_York:20261029T090000",
    "DTSTART;TZID=America/New_York:20261029T110000", "DTEND;TZID=America/New_York:20261029T113000", "END:VEVENT",
    "BEGIN:VEVENT", "UID:x", "SUMMARY:Cancelled", "DTSTART:20261028T150000Z", "DURATION:PT1H", "STATUS:CANCELLED", "END:VEVENT",
    "END:VCALENDAR", "",
  ].join("\r\n");
  const cal = calendar.parseICS(ics);
  const got = calendar.instances(cal, Date.UTC(2026, 9, 26), Date.UTC(2026, 10, 20))
    .map((e) => `${new Date(e.start).toISOString().slice(0, 16)} ${e.title} ${(e.end - e.start) / 60e3}m`);
  const want = [
    "2026-10-27T13:00 Stand, up 30m", // EDT, UTC-4
    "2026-10-29T15:00 Stand up (moved) 30m",
    "2026-11-03T14:00 Stand, up 30m", // EST, UTC-5
    // Nov 5 removed by EXDATE (it still counts toward COUNT)
    "2026-11-10T14:00 Stand, up 30m",
    "2026-11-12T14:00 Stand, up 30m",
  ];
  if (cal.name === "Work" && JSON.stringify(got) === JSON.stringify(want)) ok("iCal: weekly recurrence across DST, EXDATE, override, cancelled");
  else fail(`iCal instances ${cal.name}: ${JSON.stringify(got)}`);
  const big = await calendar.readCapped(new Response("x".repeat(5000)), 1000).then(() => "read", (e) => e.message);
  const small = await calendar.readCapped(new Response("BEGIN:VCALENDAR"), 1000).catch((e) => e.message);
  if (big === "The calendar is too large" && small === "BEGIN:VCALENDAR") ok("calendar download stops at the size limit");
  else fail(`calendar size limit: ${big} / ${small}`);
}

async function serves(port) {
  const data = tempDir();
  // HOME too, so the server reads no real ~/.claude/settings.json.
  const env = { ...process.env, HOME: data, CLAUDE_LOCKSCREEN_PORT: String(port), CLAUDE_LOCKSCREEN_DIR: data, CLAUDE_LOCKSCREEN_NO_OPEN: "1", CLAUDE_LOCKSCREEN_NO_KEYCHAIN: "1" };
  fs.writeFileSync(path.join(data, "config.json"), JSON.stringify({ theme: "cosmic" })); // a theme this fork removed
  // A session that says it's working, though its transcript ends with an interrupt: the server marks it stopped.
  fs.mkdirSync(path.join(data, "sessions"));
  const transcript = path.join(data, "t.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } }) + "\n");
  fs.writeFileSync(path.join(data, "sessions", "s-2.json"), JSON.stringify({ id: "s-2", state: "working", action: "Reading a.js", transcript, updated_at: Date.now() - 5000 }));
  const server = spawn(process.execPath, [path.join(SRC, "server.js")], { env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  server.stderr.on("data", (c) => (stderr += c));
  try {
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      await new Promise((r) => setTimeout(r, 100));
      up = await get(port, "/status").then(() => true, () => false);
    }
    if (!up) return fail(`server did not start${stderr ? `: ${stderr.trim()}` : ""}`);
    for (const [p, expect] of [["/", "<html"], ["/settings", "<html"], ["/status", '"sessions"']]) {
      const r = await get(port, p);
      if (r.status === 200 && r.body.includes(expect)) ok(`server GET ${p}`);
      else fail(`server GET ${p}: ${r.status}`);
    }
    const status = JSON.parse((await get(port, "/status")).body);
    const cfg = status.config;
    if (cfg.theme === "gotham" && JSON.stringify(cfg.themes) === '["gotham"]') ok("a removed saved theme falls back to gotham, the only theme");
    else fail(`theme ${cfg.theme}, themes ${JSON.stringify(cfg.themes)}`);
    if (!("update" in status) && (await post(port, "/update/open", {})).status === 404) ok("no update check");
    else fail("the update check is still there");
    if (status.usage.api.status === "off" && status.usage.connected === false) ok("plan usage is off until turned on");
    else fail(`plan usage: ${JSON.stringify(status.usage.api)}`);
    const s2 = status.sessions.find((s) => s.id === "s-2");
    const saved = JSON.parse(fs.readFileSync(path.join(data, "sessions", "s-2.json"), "utf8"));
    if (s2 && s2.action === "Stopped" && s2.state === "idle" && saved.action === "Stopped") ok("an interrupted session shows as stopped");
    else fail(`interrupted session: ${JSON.stringify(s2)}`);

    // POST /config keeps only what's valid.
    let r = await post(port, "/config", { theme: "cosmic", customText: "x".repeat(300), showDetails: "yes", sessionNames: false,
      presets: [" Lunch ", "Lunch", 7, "", "y".repeat(200)], unknown: 1 });
    const c = r.status === 200 && JSON.parse(r.body);
    if (c && c.theme === "gotham" && c.customText.length === 140 && !("showDetails" in c) && c.sessionNames === false &&
      JSON.stringify(c.presets) === JSON.stringify(["Lunch", "y".repeat(140)]) && !("unknown" in c) && !("calendars" in c)) ok("POST /config keeps only valid settings");
    else fail(`POST /config: ${r.status} ${r.body.slice(0, 300)}`);
    r = await post(port, "/config", { showUsage: false, showDetails: true });
    if (r.status === 200 && JSON.parse(r.body).showDetails === true && JSON.parse(fs.readFileSync(path.join(data, "config.json"), "utf8")).showDetails === true) ok("POST /config saves");
    else fail(`POST /config save: ${r.status}`);
    // A status line of ours counts as connected only while Show plan usage is on.
    fs.mkdirSync(path.join(data, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(data, ".claude", "settings.json"), JSON.stringify({ statusLine: { type: "command", command: '"/x/foudre-node" "agent-foudre-statusline"' } }));
    await post(port, "/config", { showUsage: true });
    const onU = JSON.parse((await get(port, "/status")).body).usage;
    await post(port, "/config", { showUsage: false });
    const offU = JSON.parse((await get(port, "/status")).body).usage;
    if (onU.connected === true && offU.connected === false && offU.api.status === "off") ok("turning plan usage off shows at once");
    else fail(`plan usage on ${JSON.stringify(onU.connected)}, off ${JSON.stringify(offU.connected)} ${offU.api.status}`);
    r = await post(port, "/config", "theme=gotham", "application/x-www-form-urlencoded");
    if (r.status === 415) ok("POST /config refuses a form post (415)"); else fail(`POST /config form: ${r.status}`);
    r = await post(port, "/config", "{}", "text/plain");
    if (r.status === 415) ok("POST /config refuses text/plain (415)"); else fail(`POST /config text/plain: ${r.status}`);
    r = await post(port, "/config", "{nope");
    if (r.status === 400) ok("POST /config refuses bad JSON (400)"); else fail(`POST /config bad JSON: ${r.status}`);
    r = await post(port, "/config", { customText: "z".repeat(50e3) }).catch((e) => ({ status: e.code }));
    if (r.status === 413) ok("POST /config refuses a body over 20 kB (413)"); else fail(`POST /config oversized: ${r.status}`);
    if (JSON.parse(fs.readFileSync(path.join(data, "config.json"), "utf8")).customText.length === 140) ok("an oversized post changes nothing");
    else fail("an oversized post changed config.json");
    if ((await get(port, "/status")).status === 200) ok("server still answers after the bad posts"); else fail("server stopped answering");

    // DNS rebinding: a page whose own host name now points at 127.0.0.1 sends that name as Host.
    r = await request(port, "/status", { headers: { host: `evil.example:${port}` } });
    if (r.status === 403) ok("refuses a request for another host name (403)"); else fail(`rebinding GET /status: ${r.status}`);
    r = await request(port, "/config", { method: "POST", headers: { "content-type": "application/json", origin: "http://evil.example" }, body: '{"customText":"pwned"}' });
    if (r.status === 403 && !JSON.parse(fs.readFileSync(path.join(data, "config.json"), "utf8")).customText.includes("pwned")) ok("refuses a post from another origin (403)");
    else fail(`cross-origin POST /config: ${r.status}`);
    r = await request(port, "/config", { method: "POST", headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}`, host: `localhost:${port}` }, body: "{}" });
    if (r.status === 200) ok("accepts its own pages (localhost and 127.0.0.1)"); else fail(`same-origin POST /config: ${r.status}`);

    // A cleared data folder doesn't take the server down.
    fs.rmSync(path.join(data, "sessions"), { recursive: true, force: true });
    r = await get(port, "/status");
    if (r.status === 200 && JSON.parse(r.body).sessions.length === 0 && fs.existsSync(path.join(data, "sessions"))) ok("survives the sessions folder being deleted");
    else fail(`after deleting sessions: ${r.status}`);

    // A second copy on the same port waits for it instead of crashing (launchd would restart a crash forever).
    const second = spawn(process.execPath, [path.join(SRC, "server.js")], { env: { ...env, CLAUDE_LOCKSCREEN_DIR: tempDir() }, stdio: ["ignore", "ignore", "pipe"] });
    let err2 = "";
    second.stderr.on("data", (c) => (err2 += c));
    await new Promise((res) => setTimeout(res, 1000));
    if (second.exitCode === null && /in use, retrying/.test(err2)) ok("waits for a busy port instead of crashing");
    else fail(`second server on a busy port: exit ${second.exitCode} ${err2.trim().slice(0, 200)}`);
    second.kill();
  } finally {
    server.kill();
    fs.rmSync(data, { recursive: true, force: true });
  }
}

(async () => {
  console.log("Syntax");
  syntax(SOURCES.map((f) => [`src/${f}`, fs.readFileSync(path.join(SRC, f), "utf8")]));
  syntax(TOOLS.map((f) => [f, fs.readFileSync(path.join(ROOT, f), "utf8")]));

  console.log("Themes");
  onlyGotham();
  batSprites();

  console.log("Server");
  await serves(4891);

  console.log("Hooks");
  await hook();
  await setupHooks();
  await bundleModes();

  console.log("Plan usage and calendars");
  planUsage();
  await iCal();

  console.log("Committed files");
  try {
    const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split("\n");
    if (tracked.some((f) => path.basename(f) === "google-client.json")) fail("google-client.json is committed");
    else ok("google-client.json is not committed");
  } catch { ok("not a git checkout, skipped"); }

  console.log(failed ? `\n${failed} check(s) failed` : "\nAll checks passed");
  process.exit(failed ? 1 : 0);
})();
