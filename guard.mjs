// guard.mjs — the bouncer. Every command is checked here right before it runs,
// no matter who suggested it (rules engine, Gemma, or anything added later).

export const LEVELS = ["safe", "normal", "careful", "dangerous", "blocked"];
const rank = r => LEVELS.indexOf(r);
export const maxRisk = (a, b) => (rank(a) >= rank(b) ? a : b);

const has = (args, ...flags) => args.some(a => flags.includes(a));

// Each rule: [test(args), risk, reason]. First match wins.
const DANGER = [
  [a => a[0] === "push" && has(a, "--force", "-f", "--force-with-lease", "--mirror") ,
    "dangerous", "Force push can overwrite and delete other people's work on the remote."],
  [a => a[0] === "push" && (has(a, "--delete", "-d") || a.some(x => x.startsWith(":"))),
    "dangerous", "This deletes a branch on the remote."],
  [a => a[0] === "reset" && has(a, "--hard"),
    "dangerous", "reset --hard throws away all uncommitted changes permanently."],
  [a => a[0] === "clean" && a.some(x => /^-[a-z]*f/.test(x)),
    "dangerous", "git clean deletes untracked files permanently (they don't go to the recycle bin)."],
  [a => a[0] === "branch" && has(a, "-D", "--delete", "-d"),
    "dangerous", "This deletes a branch, and any commits only on it can be lost."],
  [a => (a[0] === "checkout" || a[0] === "restore") && (has(a, ".", "--") || has(a, "--worktree")),
    "dangerous", "This throws away your unsaved changes to files."],
  [a => a[0] === "stash" && has(a, "drop", "clear"),
    "dangerous", "This deletes saved stashes permanently."],
  [a => a[0] === "rebase" && !has(a, "--continue", "--abort", "--skip"),
    "dangerous", "Rebasing rewrites history and is easy to get wrong."],
  [a => a[0] === "commit" && has(a, "--amend"),
    "dangerous", "Amending rewrites a commit that may already be pushed."],
];

// Allowed commands and their normal risk level.
const ALLOW = {
  status: "safe", log: "safe", diff: "safe", show: "safe", fetch: "safe",
  add: "normal", commit: "normal", pull: "normal", push: "normal",
  switch: "normal", checkout: "normal", stash: "normal",
  merge: a => (has(a, "--abort") ? "careful" : has(a, "--continue") ? "normal" : null),
  rebase: a => (has(a, "--abort") ? "careful" : has(a, "--continue") ? "normal" : null),
  "cherry-pick": a => (has(a, "--abort") ? "careful" : has(a, "--continue") ? "normal" : null),
  revert: a => (has(a, "--abort") ? "careful" : has(a, "--continue") ? "normal" : null),
  branch: a => (a.length === 1 || has(a, "-a", "-vv", "--list") ? "safe" : "normal"),
  config: a => (has(a, "user.name", "user.email") ? "normal" : null),
  remote: a => (a[1] === "add" || a[1] === "-v" || a.length === 1 ? "normal" : null),
};

/**
 * Check a git command (args WITHOUT the leading "git").
 * @returns {{ allowed: boolean, risk: string, reason?: string }}
 */
export function check(args, { allowDangerous = false } = {}) {
  if (!Array.isArray(args) || !args.length) return { allowed: false, risk: "blocked", reason: "Empty command." };
  if (args.some(a => typeof a !== "string")) return { allowed: false, risk: "blocked", reason: "Invalid command." };
  if (args.some(a => /^\{.+\}$/.test(a))) return { allowed: false, risk: "blocked", reason: "Command still has an unfilled {placeholder}." };

  for (const [test, risk, reason] of DANGER) {
    if (test(args)) return { allowed: allowDangerous, risk, reason };
  }

  const rule = ALLOW[args[0]];
  const risk = typeof rule === "function" ? rule(args) : rule;
  if (!risk) return { allowed: false, risk: "blocked", reason: `"git ${args[0]}" isn't on Ask Iche's allowed list.` };
  return { allowed: true, risk };
}

// --- input validation for {placeholders} ---------------------------------
export function validateInput(name, value) {
  const v = (value ?? "").trim();
  if (!v) return "This can't be empty.";
  switch (name) {
    case "message":
      if (v.length < 3) return "Write a little more so future-you knows what changed.";
      return null;
    case "branch":
      if (/\s/.test(v)) return "Branch names can't have spaces. Try dashes, like fix-login.";
      if (!/^[A-Za-z0-9._\/-]+$/.test(v) || v.startsWith("-") || v.includes("..") || v.endsWith("/") || v.endsWith(".lock"))
        return "Use letters, numbers, dashes, dots or slashes only (e.g. feature/login-fix).";
      return null;
    case "email":
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? null : "That doesn't look like an email address.";
    case "url":
      return /^(https:\/\/|git@)[^\s]+$/.test(v) ? null : "Paste the https:// or git@ URL from GitHub.";
    default:
      return null;
  }
}
