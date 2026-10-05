// collector.mjs — reads the REAL state of a git repo (read-only) and returns structured facts.
// The rules engine and Gemma both rely on this. The AI never guesses repo state.
//
// Usage as a CLI:   node collector.mjs [--fetch] [path/to/repo]
// Usage as module:  import { collect, toFacts } from "./collector.mjs";

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";


// Run a git command and return stdout. Throws on failure.
// Own spawn (not execFile): on Windows a timed-out "git fetch" can leave a helper (e.g. the credential
// manager) holding the pipe open, and execFile then waits forever. Here the timer always wins.
export function killTree(child) {
  try { if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }); else child.kill("SIGKILL"); } catch {}
}
function git(args, cwd, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-c", "core.quotepath=false", ...args], {
      cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      // never wait for a login prompt nobody can see
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", LC_ALL: "C" },
    });
    let out = "", err = "", done = false, code = null;
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", d => { out += d; }); child.stderr.on("data", d => { err += d; });
    const finish = e => { if (done) return; done = true; clearTimeout(timer); e ? reject(e) : resolve(out); };
    const fail = msg => Object.assign(new Error(msg), { stderr: err || msg });
    const timer = setTimeout(() => { killTree(child); finish(fail(`git ${args[0]} took too long (over ${Math.round(timeout / 1000)} s) and was stopped`)); }, timeout);
    child.on("error", e => finish(e));
    child.on("exit", c => { code = c; setTimeout(() => finish(c === 0 ? null : fail(err.trim() || `git ${args[0]} failed`)), 1500); }); // pipe held open by a helper
    child.on("close", c => finish((c ?? code) === 0 ? null : fail(err.trim() || `git ${args[0]} failed`)));
  });
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
        s.hasAB = true;
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
  // GitHub's copy was deleted ("upstream is gone"): git still names it but has no ahead/behind.
  // Treat the branch as not linked any more, so Upload makes a fresh copy with push -u.
  if (s.upstream && !s.hasAB) { s.upstreamGone = s.upstream; s.upstream = null; }
  delete s.hasAB;
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

  const logRaw = status.noCommitsYet ? "" : (await tryGit(["log", "--format=%h%x09%p%x09%s", "-10"], cwd)) || "";
  const recentCommits = logRaw.split("\n").filter(Boolean).map(l => {
    const [hash, parents = "", ...msg] = l.split("\t");
    return { hash, message: msg.join("\t"), merge: parents.trim().split(/\s+/).length > 1 };
  });

  // Stashes: index, the name she gave it, the branch it came from, and when
  const stashes = parseStashes((await tryGit(["stash", "list", "--format=%gd%x09%gs%x09%cr"], cwd)) || "");
  const stashCount = stashes.length;

  // The team's main branch (origin/main, origin/master, ...), used by "Clean up for review"
  const base = status.noCommitsYet ? null : await findBase(cwd, remotes);
  let aheadBase = 0, behindBase = 0, mergeBase = null, branchCommits = [];
  const onBase = !!(base && status.branch && base.replace(/^[^/]+\//, "") === status.branch);
  if (base && !status.detached) {
    const lr = (await tryGit(["rev-list", "--left-right", "--count", `${base}...HEAD`], cwd))?.trim().split(/\s+/);
    if (lr) { behindBase = +lr[0] || 0; aheadBase = +lr[1] || 0; }
    mergeBase = (await tryGit(["merge-base", base, "HEAD"], cwd))?.trim() || null;
    const bl = aheadBase ? (await tryGit(["log", "--format=%h%x09%s", "-30", `${base}..HEAD`], cwd)) || "" : "";
    branchCommits = bl.split("\n").filter(Boolean).map(l => { const [hash, ...m] = l.split("\t"); return { hash, message: m.join("\t") }; });
  }

  // Which recent commits are already shared (pushed)? Undoing those would need a force push.
  const localOnly = status.upstream ? status.ahead : base ? aheadBase : recentCommits.length;
  recentCommits.forEach((c, i) => { c.pushed = i >= localOnly; });

  // Other branches, for "Copy a commit" (cherry-pick)
  const refs = ((await tryGit(["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"], cwd)) || "")
    .split("\n").map(r => r.trim()).filter(r => r && !r.endsWith("/HEAD") && !remotes.includes(r) && !r.startsWith("backup/"));
  // Remote branches first (they're the latest). Skip a local branch if origin has the same one,
  // and skip her own branch (local or remote copy).
  const isRemote = r => remotes.some(x => r.startsWith(x + "/"));
  const short = r => (isRemote(r) ? r.slice(r.indexOf("/") + 1) : r);
  const branches = [...refs.filter(isRemote), ...refs.filter(r => !isRemote(r) && !refs.includes(`origin/${r}`))]
    .filter(r => short(r) !== status.branch);

  // Every branch, for "Branches" (switch / new / rename / delete)
  const heads = ((await tryGit(["for-each-ref", "--format=%(refname:short)%09%(objectname:short)", "refs/heads"], cwd)) || "")
    .split("\n").filter(Boolean).map(l => { const [name, hash] = l.split("\t"); return { name, hash }; });
  const localBranches = heads.map(h => h.name).filter(n => !n.startsWith("backup/"));
  const backups = heads.filter(h => h.name.startsWith("backup/"));
  const remoteOnly = refs.filter(isRemote).map(short).filter(b => !heads.some(h => h.name === b));
  // Every branch on GitHub (origin/x), for deleting it there
  const remoteBranches = refs.filter(isRemote).map(r => ({ remote: r.slice(0, r.indexOf("/")), name: short(r), ref: r }));
  const headHash = recentCommits[0]?.hash || null;

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
    stashes,
    base,
    onBase,
    aheadBase,
    behindBase,
    mergeBase,
    branchCommits,
    branches,
    localBranches,
    remoteOnly,
    remoteBranches,
    backups,
    headHash,
    recentCommits,
    fetched,
    fetchError,
    lastFetch,
  };
}

// "stash@{0}\tOn feature/login: login-form-wip\t2 hours ago"
export function parseStashes(raw) {
  return raw.split("\n").filter(Boolean).map(l => {
    const [ref, subject = "", when = ""] = l.split("\t");
    const m = subject.match(/^(?:WIP )?[Oo]n ([^:]+): (.*)$/);
    return { index: Number(ref.match(/\{(\d+)\}/)?.[1] ?? 0), ref, branch: m ? m[1] : null, name: m ? m[2] : subject, when };
  });
}

async function findBase(cwd, remotes) {
  const r = remotes.includes("origin") ? "origin" : remotes[0];
  if (r) {
    const head = (await tryGit(["rev-parse", "--abbrev-ref", `${r}/HEAD`], cwd))?.trim();
    if (head && head !== `${r}/HEAD`) return head;
  }
  for (const c of [...(r ? [`${r}/main`, `${r}/master`] : []), "main", "master"])
    if (await tryGit(["rev-parse", "--verify", "--quiet", c], cwd)) return c;
  return null;
}

/** Commits on `ref` that aren't on your branch yet (for cherry-pick). Newest first. */
export async function commitsOn(cwd, ref) {
  const raw = (await tryGit(["log", "--cherry-pick", "--right-only", "--no-merges", "-15",
    "--format=%h%x09%s%x09%an%x09%cr", `HEAD...${ref}`, "--"], cwd)) || "";
  return raw.split("\n").filter(Boolean).map(l => { const [hash, message, author, when] = l.split("\t"); return { hash, message, author, when }; });
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
  else if (st.upstreamGone && !st.detached) f.push(`GitHub's copy of ${st.branch} (${st.upstreamGone}) was deleted, so it isn't linked any more. Uploading makes a fresh copy.`);
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
  if (st.stashCount) {
    f.push(`You have ${(st.stashCount === 1 ? "1 stash" : `${st.stashCount} stashes`)} saved (work put aside):`);
    st.stashes.slice(0, 10).forEach(x => f.push(`  stash #${x.index}: "${x.name}"${x.branch ? ` (from branch ${x.branch}` : " ("}${x.when ? `, ${x.when}` : ""})`));
  }
  if (st.base && !st.onBase && !st.detached && (st.aheadBase || st.behindBase))
    f.push(`Compared with ${st.base}: your branch has ${plural(st.aheadBase, "commit")} of its own, and ${st.base} has ${plural(st.behindBase, "new commit")} you don't have.`);

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
  if (dirty && st.behind) return "You have unsaved work and new changes on the remote. Choose \"Upload my work\" and Iche will save, pull, and push safely.";
  if (dirty) return "You have unsaved work. Choose \"Save my work\" to commit it, or \"Upload my work\" to commit and push.";
  if (st.ahead) return `You have ${st.ahead} commit${st.ahead > 1 ? "s" : ""} that ${st.ahead > 1 ? "aren't" : "isn't"} on the remote yet. Choose "Upload my work" to push.`;
  if (st.behind) return "Your team has new changes. Choose \"Get latest\" to pull them.";
  if (st.upstreamGone && st.branch) return `GitHub's copy of ${st.branch} was deleted. Choose "Upload my work" if you want it back on GitHub.`;
  if (st.stashCount) return `You have ${st.stashCount} stash${st.stashCount > 1 ? "es" : ""} put aside. Choose "Bring back stashed work" when you want ${st.stashCount > 1 ? "one" : "it"} back.`;
  return null;
}
