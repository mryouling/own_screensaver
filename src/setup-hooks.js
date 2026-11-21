#!/usr/bin/env node
// Adds (or with --uninstall removes) the lock screen hook in ~/.claude/settings.json, plus the status
// line wrapper (statusline.js) that saves Claude's plan usage. The user's own status line keeps working:
// it's saved in statusline-chain.json and the wrapper runs it; uninstalling puts it back.
// Usage: node setup-hooks.js <node-binary> <hook.js path> [--no-usage]   |   node setup-hooks.js --uninstall
// The app runs it as: foudre-node setup-hooks <foudre-node path> agent-foudre-hook
const fs = require("fs");
const path = require("path");
const os = require("os");

const SETTINGS = path.join(os.homedir(), ".claude", "settings.json");
const DATA = process.env.CLAUDE_LOCKSCREEN_DIR || path.join(os.homedir(), ".claude", "lockscreen");
const CHAIN = path.join(DATA, "statusline-chain.json");
// The app's status line mode, and statusline.js from the script install (~/.claude/lockscreen/app). Only
// these: plenty of people call their own script statusline.js, and that one must never count as ours.
const STATUSLINE_MARKERS = ["agent-foudre-statusline", "/lockscreen/app/statusline.js"];
const isOurs = (sl) => !!sl && STATUSLINE_MARKERS.some((m) => String(sl.command || "").includes(m));
// Hooks from the script install (node + hook.js) and the app (foudre-node agent-foudre-hook).
const MARKERS = ["lockscreen/app/hook.js", "agent-foudre-hook"];
const isOurHook = (command) => MARKERS.some((m) => command.includes(m));
const EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Notification", "PreCompact", "Stop", "SessionEnd"];
const WITH_MATCHER = new Set(["PreToolUse", "PostToolUse", "PermissionRequest"]);

const BACKUP = `${SETTINGS}.bak-lockscreen`; // settings.json as it was before the first change: kept for good
const LATEST = `${SETTINGS}.bak-lockscreen-latest`; // as it was before the most recent change
const before = fs.existsSync(SETTINGS) ? fs.readFileSync(SETTINGS, "utf8") : null;
const settings = before !== null ? JSON.parse(before) : {};
const hooks = settings.hooks || {};

// Drop any previous lock screen entries so re-running is idempotent.
for (const ev of Object.keys(hooks)) {
  hooks[ev] = hooks[ev]
    .map((group) => ({ ...group, hooks: (group.hooks || []).filter((h) => !isOurHook(String(h.command || ""))) }))
    .filter((group) => group.hooks.length);
  if (!hooks[ev].length) delete hooks[ev];
}

// Takes our status line out, putting back the one it wraps (if any).
function removeStatusLine() {
  if (!isOurs(settings.statusLine)) return;
  let chained = null;
  try { chained = JSON.parse(fs.readFileSync(CHAIN, "utf8")).statusLine || null; } catch {}
  if (chained && chained.command) settings.statusLine = chained; else delete settings.statusLine;
  try { fs.unlinkSync(CHAIN); } catch {}
}

// Claude Code runs these commands with the shell. Double quotes when nothing inside is special to the shell (that's
// the form the app looks for to tell its hook is installed), otherwise single quotes, which keep everything literal.
function shellQuote(s) {
  s = String(s);
  return /^[^"$`\\!]*$/.test(s) ? `"${s}"` : `'${s.replace(/'/g, `'\\''`)}'`;
}

const [first, ...rest] = process.argv.slice(2);
const usage = !rest.includes("--no-usage");
if (first === "--uninstall") removeStatusLine();
else {
  const [node, hookPath] = [first, rest[0]];
  const command = `${shellQuote(node)} ${shellQuote(hookPath)}`;
  for (const ev of EVENTS) {
    const group = { hooks: [{ type: "command", command, timeout: 5 }] };
    if (WITH_MATCHER.has(ev)) group.matcher = "*";
    (hooks[ev] = hooks[ev] || []).push(group);
  }
  if (!usage) removeStatusLine();
  else {
    // The app's binary has a status line mode; the script install has statusline.js next to hook.js.
    const wrapper = `${shellQuote(node)} ${shellQuote(/^agent-[a-z]+-hook$/.test(hookPath) ? hookPath.replace(/-hook$/, "-statusline") : path.join(path.dirname(hookPath), "statusline.js"))}`;
    const prev = settings.statusLine;
    if (!isOurs(prev)) {
      fs.mkdirSync(DATA, { recursive: true });
      writeAtomic(CHAIN, JSON.stringify({ statusLine: prev && prev.command ? prev : null, command: (prev && prev.command) || "" }, null, 2) + "\n");
    }
    // Keep the user's other status line options (padding, refreshInterval); only the command is ours.
    settings.statusLine = { ...(prev || {}), type: "command", command: wrapper };
  }
}

if (Object.keys(hooks).length) settings.hooks = hooks; else delete settings.hooks;
const text = JSON.stringify(settings, null, 2) + "\n";
if (text !== before) {
  // Back up before every change: the first-ever backup stays, the latest one is replaced each time.
  if (before !== null) {
    if (!fs.existsSync(BACKUP)) fs.writeFileSync(BACKUP, before);
    writeAtomic(LATEST, before);
  }
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  // A symlinked settings.json (dotfiles) stays a symlink: its target is what gets replaced.
  let target = SETTINGS;
  try { target = fs.realpathSync(SETTINGS); } catch {}
  writeAtomic(target, text);
}
console.log(first === "--uninstall" ? "Removed lock screen hooks and status line." : `Added lock screen hooks for ${EVENTS.length} events${usage ? " and the plan usage status line" : ""}.`);
if (before !== null) console.log(`Backups: ${BACKUP} (before the first change), ${LATEST} (before the last one)`);

// Whole file or nothing, so Claude Code never reads a half-written settings.json.
function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  let mode = 0o644;
  try { mode = fs.statSync(file).mode & 0o777; } catch {}
  try { fs.writeFileSync(tmp, data, { mode }); fs.chmodSync(tmp, mode); fs.renameSync(tmp, file); }
  catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
}
