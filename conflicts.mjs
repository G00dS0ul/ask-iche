// conflicts.mjs — turns git's scary <<<<<<< ======= >>>>>>> blocks into simple choices.
// She never has to see or delete a marker. The code rebuilds the file from her choices.
//
// How: git keeps 3 copies of a conflicted file: :1 = original, :2 = yours, :3 = theirs.
// We merge those ourselves with `git merge-file --diff3`, split the result into
// "normal text" and "conflict" pieces, and rebuild the file from her picks.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, copyFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

const git = (cwd, args) => spawnSync("git", args, { cwd, encoding: "buffer", maxBuffer: 50e6 });

function stage(repoRoot, n, path) {
  const r = git(repoRoot, ["show", `:${n}:${path}`]);
  return r.status === 0 ? r.stdout : null;
}

/** Read one conflicted file. Returns { pieces, conflicts } or { unsupported: reason }. */
export function readConflict(repoRoot, path) {
  const base = stage(repoRoot, 1, path), mine = stage(repoRoot, 2, path), theirs = stage(repoRoot, 3, path);
  if (!mine || !theirs) return { unsupported: mine ? "deleted-theirs" : "deleted-mine" };
  if ([base, mine, theirs].some(b => b && b.includes(0))) return { unsupported: "binary" };

  const tmp = mkdtempSync(join(tmpdir(), "ask-ise-"));
  try {
    const f = n => join(tmp, n);
    writeFileSync(f("mine"), mine); writeFileSync(f("base"), base || ""); writeFileSync(f("theirs"), theirs);
    const r = spawnSync("git", ["merge-file", "-p", "--diff3", "-L", "mine", "-L", "base", "-L", "theirs",
      f("mine"), f("base"), f("theirs")], { encoding: "utf8", maxBuffer: 50e6 });
    if (r.status < 0 || r.error) return { unsupported: "merge-file-failed" };
    return parse(r.stdout);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

/** Split merge-file output into text pieces and conflict pieces. */
export function parse(text) {
  const lines = text.split(/(?<=\n)/); // keep line endings (CRLF safe)
  const pieces = []; let cur = null, buf = [], lineNo = 1;
  const flush = () => { if (buf.length) pieces.push({ text: buf.join("") }); buf = []; };
  for (const l of lines) {
    const t = l.replace(/\r?\n$/, "");
    if (!cur && t.startsWith("<<<<<<< mine")) { flush(); cur = { mine: [], base: [], theirs: [], at: "mine", line: lineNo }; continue; }
    if (cur && t.startsWith("||||||| base")) { cur.at = "base"; continue; }
    if (cur && t === "=======") { cur.at = "theirs"; continue; }
    if (cur && t.startsWith(">>>>>>> theirs")) {
      pieces.push({ conflict: true, line: cur.line, mine: cur.mine.join(""), base: cur.base.join(""), theirs: cur.theirs.join("") });
      lineNo += cur.mine.length; cur = null; continue;
    }
    if (cur) cur[cur.at].push(l); else { buf.push(l); lineNo++; }
  }
  flush();
  return { pieces, conflicts: pieces.filter(p => p.conflict) };
}

export const CHOICES = {
  mine: "Keep mine",
  theirs: "Keep theirs",
  "both-mine-first": "Keep both (mine first)",
  "both-theirs-first": "Keep both (theirs first)",
};

const nl = s => (s && !s.endsWith("\n") ? s + "\n" : s);
export function pick(c, choice) {
  if (choice === "mine") return c.mine;
  if (choice === "theirs") return c.theirs;
  if (choice === "both-mine-first") return nl(c.mine) + c.theirs;
  if (choice === "both-theirs-first") return nl(c.theirs) + c.mine;
  throw new Error("unknown choice " + choice);
}

/** Rebuild the file from her choices (one per conflict, in order). */
export function build(pieces, choices) {
  let i = 0;
  return pieces.map(p => (p.conflict ? pick(p, choices[i++]) : p.text)).join("");
}

/** Save the result, keeping a backup of whatever was in the file before. */
export function save(repoRoot, path, content) {
  const full = join(repoRoot, path);
  const backup = join(repoRoot, ".git", "ask-ise-backup", path);
  if (existsSync(full)) { mkdirSync(dirname(backup), { recursive: true }); copyFileSync(full, backup); }
  writeFileSync(full, content);
  return backup;
}
