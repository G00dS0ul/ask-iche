// collector.mjs — reads the REAL state of a git repo (read-only) and returns structured facts.
// The rules engine and Gemma both rely on this. The AI never guesses repo state.
//
// Usage as a CLI:   node collector.mjs [--fetch] [path/to/repo]
// Usage as module:  import { collect, toFacts } from "./collector.mjs";

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const exec = promisify(execFile);

// Run a git command and return stdout. Throws on failure.
async function git(args, cwd, timeout = 15000) {
  const { stdout } = await exec("git", ["-c", "core.quotepath=false", ...args], {
    cwd,
    timeout,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
  });
  return stdout;
}

// Same as git(), but returns null instead of throwing.
async function tryGit(args, cwd, timeout) {
  try { return await git(args, cwd, timeout); } catch { return null; }
}

const CHANGE = { M: "modified", A: "added", D: "deleted", R: "renamed", C: "copied", T: "typechange" };

// Parse `git status --porcelain=v2 --branch -z`
export function parseStatus(raw) {
  const s = {
    branch: null, detached: false, noCommitsYet: false,
    upstream: null, ahead: 0, behind: 0,
    staged: [], unstaged: [], untracked: [], conflicts: [],
  };
  const parts = raw.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (!line) continue;

    if (line.startsWith("# ")) {
      const [, key, ...rest] = line.split(" ");
      const val = rest.join(" ");
      if (key === "branch.oid") s.noCommitsYet = val === "(initial)";
      else if (key === "branch.head") {
        if (val === "(detached)") s.detached = true; else s.branch = val;
      } else if (key === "branch.upstream") s.upstream = val;
      else if (key === "branch.ab") {
        const m = val.match(/\+(\d+) -(\d+)/);
        if (m) { s.ahead = +m[1]; s.behind = +m[2]; }
      }
      continue;
    }

    const type = line[0];
    if (type === "?") { s.untracked.push(line.slice(2)); continue; }
    if (type === "!") continue; // ignored files

    if (type === "1" || type === "2") {
      // 1 XY sub mH mI mW hH hI path
      // 2 XY sub mH mI mW hH hI Xscore path  (+ next NUL field = original path)
      const fields = line.split(" ");
      const xy = fields[1];
      const fixed = type === "1" ? 8 : 9;
      const path = fields.slice(fixed).join(" ");
      const from = type === "2" ? parts[++i] : undefined;
      const [x, y] = xy;
      if (x !== ".") s.staged.push({ path, change: CHANGE[x] || x, ...(from ? { from } : {}) });
      if (y !== ".") s.unstaged.push({ path, change: CHANGE[y] || y });
      continue;
    }

    if (type === "u") {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const fields = line.split(" ");
      s.conflicts.push({ path: fields.slice(10).join(" "), code: fields[1] });
    }
  }
  return s;
}

// Detect a merge / rebase / cherry-pick / revert that is in progress.
function detectOperation(gitDir) {
  if (existsSync(join(gitDir, "rebase-merge")) || existsSync(join(gitDir, "rebase-apply"))) return "rebase";
  if (existsSync(join(gitDir, "MERGE_HEAD"))) return "merge";
  if (existsSync(join(gitDir, "CHERRY_PICK_HEAD"))) return "cherry-pick";
  if (existsSync(join(gitDir, "REVERT_HEAD"))) return "revert";
  return null;
}

/**
 * Collect the repo state (read-only, except optional `git fetch`).
 * @param {object} opts
 * @param {string}  [opts.cwd]   repo folder (default: current folder)
 * @param {boolean} [opts.fetch] run `git fetch` first so ahead/behind is up to date (needs network)
 */
export async function collect({ cwd = process.cwd(), fetch = false } = {}) {
  cwd = resolve(cwd);

  if (!existsSync(cwd) || !statSync(cwd).isDirectory())
    return { ok: false, error: "folder-not-found", message: `This folder doesn't exist: ${cwd}` };

  try { await git(["--version"], cwd); }
  catch (e) {
    if (e.code === "ENOENT") return { ok: false, error: "git-not-found", message: "Git isn't installed or isn't on PATH." };
    return { ok: false, error: "git-failed", message: (e.stderr || e.message || "").toString().trim() };
  }

  const inside = (await tryGit(["rev-parse", "--is-inside-work-tree"], cwd))?.trim();
  if (inside !== "true") return { ok: true, isRepo: false, cwd };

  const repoRoot = (await git(["rev-parse", "--show-toplevel"], cwd)).trim();
  const gitDir = resolve(cwd, (await git(["rev-parse", "--git-dir"], cwd)).trim());

  const remotes = ((await tryGit(["remote"], cwd)) || "").split("\n").map(r => r.trim()).filter(Boolean);

  let fetched = false, fetchError = null;
  if (fetch && remotes.length) {
    try { await git(["fetch", "--quiet"], cwd, 30000); fetched = true; }
    catch (e) { fetchError = (e.stderr || e.message || "").toString().trim().split("\n")[0]; }
  }

  const status = parseStatus(await git(["status", "--porcelain=v2", "--branch", "-z"], cwd));

  const logRaw = status.noCommitsYet ? "" : (await tryGit(["log", "--format=%h%x09%s", "-5"], cwd)) || "";
  const recentCommits = logRaw.split("\n").filter(Boolean).map(l => {
    const [hash, ...msg] = l.split("\t");
    return { hash, message: msg.join("\t") };
  });

  const stashRaw = (await tryGit(["stash", "list"], cwd)) || "";
  const stashCount = stashRaw.split("\n").filter(Boolean).length;

  // Commits fail without a name/email, a common first-time problem
  const userName = (await tryGit(["config", "user.name"], cwd))?.trim() || null;
  const userEmail = (await tryGit(["config", "user.email"], cwd))?.trim() || null;

  const fetchHead = join(gitDir, "FETCH_HEAD");
  const lastFetch = existsSync(fetchHead) ? statSync(fetchHead).mtime.toISOString() : null;

  // e.g. branch "feature/x" tracking "origin/main" -> pushing could go to the wrong place
  let upstreamMismatch = false;
  if (status.upstream && status.branch) {
    const r = remotes.find(r => status.upstream.startsWith(r + "/"));
    const upBranch = r ? status.upstream.slice(r.length + 1) : status.upstream;
    upstreamMismatch = upBranch !== status.branch;
  }

  return {
    ok: true,
    isRepo: true,
    repoRoot,
    ...status,
    upstreamMismatch,
    hasRemote: remotes.length > 0,
    remotes,
    operation: detectOperation(gitDir),
    hasIdentity: Boolean(userName && userEmail),
    stashCount,
    recentCommits,
    fetched,
    fetchError,
    lastFetch,
  };
}

function ago(d) {
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  return `${Math.round(hrs / 24)} days ago`;
}

// Turn the state into plain-English FACTS lines for Gemma's prompt.
export function toFacts(st) {
  if (!st.ok) return [`Problem: ${st.message}`];
  if (!st.isRepo) return ["This folder is not a git repository."];

  const f = [];
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const files = (list, max = 5) => {
    const names = list.map(x => (typeof x === "string" ? x : x.path));
    const shown = names.slice(0, max).join(", ");
    return names.length > max ? `${shown} (+${names.length - max} more)` : shown;
  };

  if (st.detached) f.push("You are not on any branch (detached HEAD).");
  else f.push(`You are on branch ${st.branch}.`);
  if (st.noCommitsYet) f.push("This repo has no commits yet.");

  if (!st.hasRemote) f.push("This repo has no remote (nothing to push to yet).");
  else if (!st.upstream && !st.detached) f.push(`Branch ${st.branch} is not linked to a remote branch yet.`);
  else if (st.upstream) {
    if (st.ahead === 0 && st.behind === 0) f.push(`You are up to date with ${st.upstream}.`);
    if (st.behind > 0) f.push(`You are ${plural(st.behind, "commit")} BEHIND ${st.upstream}.`);
    if (st.ahead > 0) f.push(`You are ${plural(st.ahead, "commit")} AHEAD of ${st.upstream} (not pushed yet).`);
    if (st.ahead > 0 && st.behind > 0) f.push("Your branch and the remote have both changed (diverged).");
  }

  if (st.upstreamMismatch)
    f.push(`Warning: branch ${st.branch} is linked to ${st.upstream}, which has a different name.`);

  if (st.operation) f.push(`A ${st.operation} is in progress and not finished.`);
  if (st.conflicts.length) f.push(`Conflicts in: ${files(st.conflicts)}.`);
  else f.push("There are no conflicts.");
  if (st.staged.length) f.push(`${plural(st.staged.length, "file")} staged (ready to commit): ${files(st.staged)}.`);
  if (st.unstaged.length) f.push(`${plural(st.unstaged.length, "file")} with unsaved changes (not staged): ${files(st.unstaged)}.`);
  if (st.untracked.length) f.push(`${plural(st.untracked.length, "new file")} git isn't tracking yet: ${files(st.untracked)}.`);
  if (!st.staged.length && !st.unstaged.length && !st.untracked.length && !st.conflicts.length)
    f.push("You have no uncommitted changes.");
  if (!st.hasIdentity) f.push("Git doesn't know your name and email yet, so commits will fail.");
  if (st.stashCount) f.push(`You have ${plural(st.stashCount, "stash")} saved.`);

  if (st.fetchError) f.push(`Could not check the remote (${st.fetchError}). Ahead/behind may be out of date.`);
  else if (st.hasRemote && !st.fetched) {
    const mins = st.lastFetch ? (Date.now() - new Date(st.lastFetch)) / 60000 : Infinity;
    if (mins > 5) f.push(`Remote last checked: ${st.lastFetch ? ago(new Date(st.lastFetch)) : "never"}. Ahead/behind may be out of date.`);
  }

  return f;
}

// CLI entry: node collector.mjs [--fetch] [path]
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const doFetch = args.includes("--fetch");
  const path = args.find(a => !a.startsWith("--")) || process.cwd();
  const state = await collect({ cwd: path, fetch: doFetch });
  console.log(JSON.stringify(state, null, 2));
  console.log("\nFACTS:\n- " + toFacts(state).join("\n- "));
}

/** For "Where am I?": a friendly next step when there's still work to do, or null if all clean. */
export function nextHint(st) {
  if (!st || !st.ok || !st.isRepo) return null;
  if (st.conflicts?.length || st.operation) return "You're in the middle of fixing a conflict. Choose \"Fix a conflict\" to finish it.";
  const dirty = st.staged.length + st.unstaged.length + st.untracked.length;
  if (dirty && st.behind) return "You have unsaved work and new changes on the remote. Choose \"Upload my work\" and Ask Iche will save, pull, and push safely.";
  if (dirty) return "You have unsaved work. Choose \"Save my work\" to commit it, or \"Upload my work\" to commit and push.";
  if (st.ahead) return `You have ${st.ahead} commit${st.ahead > 1 ? "s" : ""} that ${st.ahead > 1 ? "aren't" : "isn't"} on the remote yet. Choose "Upload my work" to push.`;
  if (st.behind) return "Your team has new changes. Choose \"Get latest\" to pull them.";
  return null;
}
