#!/usr/bin/env node
// app.mjs — Ask Iche with a friendly face.
//   node app.mjs            → opens http://127.0.0.1:4321 in your browser
// Same engine as the CLI (collector → rules → guard → runner). Only the face is different.
// Everything stays on this laptop: the server only listens on 127.0.0.1.

import http from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir, platform } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { run } from "./runner.mjs";
import { toFacts, nextHint } from "./collector.mjs";
import { INTENTS, quickIntent, refuseText } from "./rules.mjs";
import { CHOICES } from "./conflicts.mjs";
import { MODEL, isAvailable, warmup, explainPlan, allFixed, detectIntent, explainConflict } from "./gemma.mjs";

const PORT = Number(process.env.PORT || 4321);
const TOKEN = randomBytes(16).toString("hex"); // stops other websites from talking to this server
const HERE = dirname(fileURLToPath(import.meta.url));
const flags = new Set(process.argv.slice(2));
let useAI = !flags.has("--no-ai");

let ai = useAI ? await isAvailable() : { up: false };
if (ai.up && ai.hasModel) warmup();
const aiOn = () => useAI && ai.up && ai.hasModel;

// ---------- events to the browser (Server-Sent Events) ----------
const clients = new Set();
let history = [];             // events of the current run, replayed if the page reloads
const pending = new Map();    // question id -> resolve()
let nextId = 1, busy = false;

function emit(ev) {
  history.push(ev);
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of clients) res.write(line);
}
function waitFor(ev) {
  const id = nextId++;
  return new Promise(r => { pending.set(id, r); emit({ ...ev, id }); });
}
function answerAll(value) { for (const [id, r] of pending) { pending.delete(id); r(value); } }

// ---------- the UI object the runner talks to ----------
const ui = {
  say: (text, kind) => emit({ type: "say", text, kind }),
  ask: async (prompt, meta = {}) => (await waitFor({ type: "ask", prompt, meta })) ?? "",
  confirm: async (prompt, strict, meta = {}) => {
    const v = await waitFor({ type: "confirm", prompt, strict, meta });
    return strict ? String(v ?? "").trim().toLowerCase() === "yes" : v === true;
  },
  show: async (p, st, round) => { if (round > 1) stopExplaining(); emit({ type: "show", round, facts: toFacts(st), warnings: p.warnings || [] }); },
  running: info => emit({ type: "running", ...info }),
  output: text => emit({ type: "output", text }),
  showConflict: async ({ file, conflict, index, total, labels }) => {
    emit({ type: "conflict", file, index, total, labels, line: conflict.line,
      base: conflict.base, mine: conflict.mine, theirs: conflict.theirs, choices: Object.values(CHOICES) });
    if (aiOn()) {
      stopExplaining(); // the conflict matters more than the plan's words; one Gemma job at a time
      emit({ type: "thinking", text: `Iche is reading both versions… (${MODEL}, on your laptop)` });
      const r = await explainConflict(file, conflict, { onLine: (key, text) => emit({ type: "conflict-line", key, text }) });
      emit({ type: "thinking-done", stats: r.stats });
    }
  },
  showResolved: async ({ file, picked }) => emit({ type: "resolved", file, picked }),
};

// The plan (and its Run buttons) shows right away. Gemma's words stream in on the side, so a slow
// laptop never blocks her. Each plan gets a number (seq); a newer plan stops the older explanation.
let explainSeq = 0, explainCtl = null;
function stopExplaining() { explainCtl?.abort(); explainCtl = null; }
function explain(p, st) {
  stopExplaining();
  if (p.blocked) return emit({ type: "blocked" }); // refusal already shown; no plan, no AI, nothing to click
  const seq = ++explainSeq, ctl = new AbortController(); explainCtl = ctl;
  emit({ type: "plan", seq, situation: p.situation, hint: p.steps.length ? null : nextHint(st), steps: p.steps.map(s => ({ display: s.display, risk: s.risk, manual: !!s.manual })) });
  if (aiOn() && !allFixed(p)) emit({ type: "thinking", seq, text: `Iche is thinking… (${MODEL}, on your laptop)` });
  explainPlan(p, toFacts(st), {
    onSummary: text => emit({ type: "summary", seq, text }),
    onReason: (index, text) => emit({ type: "reason", seq, index, text }),
    onTip: text => emit({ type: "tip", seq, text }),
    onPartial: (key, index, text) => emit({ type: "partial", seq, key, index, text }),
  }, { offline: !aiOn(), signal: ctl.signal })
    .then(r => emit({ type: "thinking-done", seq, stats: r.stats, fellBack: r.fellBack, aborted: !!r.aborted }))
    .catch(() => emit({ type: "thinking-done", seq }))
    .finally(() => { if (explainCtl === ctl) explainCtl = null; });
}

// ---------- intent (same rules as the CLI) ----------
const ALIASES = { sync: "push", upload: "push", update: "pull", download: "pull", commit: "save",
  fix: "resolve", conflict: "resolve", where: "status", check: "status", force: "force-push",
  stashes: "stash-list", pop: "unstash", unstash: "unstash", undo: "reset", uncommit: "reset",
  cleanup: "rebase", "clean up": "rebase", squash: "rebase", cherry: "cherry-pick",
  branch: "branch", branches: "branch", switch: "branch", checkout: "branch", log: "log", history: "log" };
const WORDS = { status: "check where you are", save: "save (commit) your work", push: "upload (push) your work",
  pull: "get the latest changes", resolve: "fix a conflict", "force-push": "force push",
  stash: "stash (put aside) your unfinished work", "stash-list": "see your stash list", unstash: "bring back stashed work",
  reset: "undo commits", rebase: "clean up your branch for review", "cherry-pick": "copy a commit from another branch",
  branch: "work with branches", log: "see the commit history" };

async function findIntent(text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return { intent: null };
  if (t === "revert") return { intent: null, refused: "Reverting pushed commits isn't in Ask Iche yet. Try \"Undo commits\" for ones you haven't pushed, or message Iche (the human one 😄)." };
  const no = refuseText(text); // hard safety blocks come first: nothing to click, nothing runs
  if (no?.refused) return { intent: null, refused: no.refused, blocked: true };
  if (no?.intent) return { ...no, words: WORDS[no.intent], direct: true };
  const quick = quickIntent(text);
  if (quick) return { ...quick, words: WORDS[quick.intent], direct: true };
  const direct = ALIASES[t] || (INTENTS.includes(t) ? t : null);
  if (!direct && !/[a-z]{2,}/.test(t)) return { intent: null }; // "0", "?", "1." are not requests
  if (direct) return { intent: direct, words: WORDS[direct], direct: true };
  const d = await detectIntent(text).catch(() => ({ intent: null }));
  return d.intent ? { intent: d.intent, words: WORDS[d.intent], by: d.by } : { intent: null };
}

// ---------- folder browser (so she never types a path) ----------
function listDirs(p) {
  const dir = resolve(p || homedir());
  const out = { path: dir, parent: dirname(dir) !== dir ? dirname(dir) : null, isRepo: existsSync(join(dir, ".git")), dirs: [] };
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules" || e.name.startsWith("$")) continue;
      const full = join(dir, e.name);
      let isRepo = false; try { isRepo = existsSync(join(full, ".git")); } catch {}
      out.dirs.push({ name: e.name, path: full, isRepo });
    }
  } catch (e) { out.error = "Can't open this folder."; }
  out.dirs.sort((a, b) => (b.isRepo - a.isRepo) || a.name.localeCompare(b.name));
  return out;
}

// ---------- HTTP ----------
const json = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
const body = async req => { let b = ""; for await (const c of req) b += c; try { return JSON.parse(b || "{}"); } catch { return {}; } };
const okHost = h => [`127.0.0.1:${PORT}`, `localhost:${PORT}`].includes(h); // blocks DNS-rebinding tricks

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (!okHost(req.headers.host)) { res.writeHead(403); return res.end("Forbidden"); }

  if (url.pathname === "/" && req.method === "GET") {
    const html = readFileSync(join(HERE, "app.html"), "utf8").replace("__TOKEN__", TOKEN);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(html);
  }
  if (!url.pathname.startsWith("/api/")) { res.writeHead(404); return res.end(); }
  const token = req.headers["x-token"] || url.searchParams.get("token");
  if (token !== TOKEN) return json(res, 403, { error: "bad token" });

  if (url.pathname === "/api/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(`data: ${JSON.stringify({ type: "replay", events: history, busy })}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 15000);
    req.on("close", () => { clearInterval(ping); clients.delete(res); });
    return;
  }
  if (url.pathname === "/api/info") {
    if (useAI && !(ai.up && ai.hasModel)) { ai = await isAvailable(); if (ai.up && ai.hasModel) warmup(); }
    return json(res, 200, { model: MODEL, useAI, aiUp: ai.up, hasModel: ai.hasModel, home: homedir(), busy });
  }
  if (url.pathname === "/api/dirs") return json(res, 200, listDirs(url.searchParams.get("path")));
  if (req.method !== "POST") return json(res, 405, { error: "POST only" });

  const b = await body(req);
  if (url.pathname === "/api/intent") return json(res, 200, await findIntent(b.text));
  if (url.pathname === "/api/answer") {
    const r = pending.get(Number(b.id));
    if (r) { pending.delete(Number(b.id)); emit({ type: "answered", id: Number(b.id), value: b.value }); r(b.value); }
    return json(res, 200, { ok: !!r });
  }
  if (url.pathname === "/api/stop") { answerAll(null); return json(res, 200, { ok: true }); }
  if (url.pathname === "/api/ai") { useAI = !!b.on; if (useAI) { ai = await isAvailable(); if (ai.up && ai.hasModel) warmup(); } return json(res, 200, { useAI, aiUp: ai.up, hasModel: ai.hasModel }); }
  if (url.pathname === "/api/run") {
    if (busy) return json(res, 409, { error: "Already working on something. Finish or stop it first." });
    const cwd = String(b.path || "");
    if (!cwd || !existsSync(cwd) || !statSync(cwd).isDirectory()) return json(res, 400, { error: "That folder doesn't exist." });
    const intent = INTENTS.includes(b.intent) ? b.intent : "status";
    // Only known keys, short strings (values typed in the main box, e.g. "pop 0" or "git checkout main")
    const preset = {};
    for (const k of ["stash", "action", "to", "branch", "target", "from", "ref", "style", "target"])
      if (typeof b.values?.[k] === "string") preset[k] = b.values[k].slice(0, 100);
    stopExplaining(); busy = true; history = [];
    emit({ type: "start", intent, path: cwd, words: WORDS[intent] });
    json(res, 200, { ok: true });
    try {
      const result = await run({ cwd, intent, ui, explain, fetch: b.fetch !== false, values: preset });
      emit({ type: "end", ok: !!result.ok, stopped: !!result.stopped, situation: result.situation, branch: result.state?.branch || null });
    } catch (e) {
      emit({ type: "say", kind: "error", text: "Something went wrong inside Ask Iche: " + e.message });
      emit({ type: "end", ok: false });
    } finally { busy = false; answerAll(null); }
    return;
  }
  json(res, 404, { error: "unknown" });
});

server.on("error", e => {
  if (e.code === "EADDRINUSE") console.log(`Port ${PORT} is busy. Is Ask Iche already open? Try http://127.0.0.1:${PORT} or set PORT=4322.`);
  else console.log(e.message);
  process.exit(1);
});
server.listen(PORT, "127.0.0.1", () => {
  const link = `http://127.0.0.1:${PORT}`;
  console.log(`\n🌿 Ask Iche is running at ${link}`);
  console.log(aiOn() ? `   Gemma (${MODEL}) is ready on your laptop.` : "   AI is off or Ollama isn't running, so built-in explanations will be used.");
  console.log("   Keep this window open. Press Ctrl+C to close Ask Iche.\n");
  if (!flags.has("--no-open")) {
    const os = platform();
    const cmd = os === "win32" ? ["cmd", ["/c", "start", "", link]] : os === "darwin" ? ["open", [link]] : ["xdg-open", [link]];
    try { spawn(cmd[0], cmd[1], { stdio: "ignore", detached: true }).on("error", () => {}).unref(); } catch {}
  }
});
