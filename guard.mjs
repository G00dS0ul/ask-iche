// guard.mjs — the bouncer. Every command is checked here right before it runs,
// no matter who suggested it (rules engine, Gemma, or anything added later).

export const LEVELS = ["safe", "normal", "careful", "dangerous", "blocked"];
const rank = r => LEVELS.indexOf(r);
export const maxRisk = (a, b) => (rank(a) >= rank(b) ? a : b);

const has = (args, ...flags) => args.some(a => flags.includes(a));

const PROTECTED = /^(main|master|develop|dev|release.*|production|prod)$/;
const pushTarget = a => a.filter(x => !x.startsWith("-")).slice(2).map(x => x.replace(/^\+/, "").split(":").pop());

// Never allowed, not even when a plan asks for it.
const NEVER = [
  [a => a[0] === "push" && has(a, "--force", "-f", "--mirror"),
    "Plain force push can delete other people's work. Ask Iche only ever uses --force-with-lease, on your own branch."],
  [a => a[0] === "push" && has(a, "--force-with-lease") && (pushTarget(a).length !== 1 || PROTECTED.test(pushTarget(a)[0])),
    "Rewriting a shared branch like main is never allowed."],
  [a => a[0] === "rebase" && has(a, "-i", "--interactive", "--exec", "-x", "--root"),
    "Interactive rebase needs an editor, so Ask Iche doesn't do it."],
];

// Each rule: [test(args), risk, reason]. First match wins.
// Dangerous commands only run when a deterministic plan step explicitly allows it (dangerOk),
// and she must type "yes".
const DANGER = [
  [a => a[0] === "push" && has(a, "--force-with-lease"),
    "dangerous", "This replaces your branch on GitHub with your cleaned-up version. --force-with-lease refuses if anyone else pushed to it."],
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
  [a => a[0] === "reset" && has(a, "--soft", "--mixed"),
    "careful", "This undoes commits. Your changes are kept, but the commits themselves are removed from this branch."],
  [a => a[0] === "stash" && has(a, "drop", "clear"),
    "dangerous", "This deletes saved stashes permanently."],
  [a => a[0] === "rebase" && !has(a, "--continue", "--abort", "--skip"),
    "dangerous", "Rebasing rewrites your branch's history. A backup branch is made first, and you can always abort."],
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
  "cherry-pick": a => (has(a, "--abort") ? "careful" : has(a, "--continue") ? "normal"
    : a.length === 2 && /^[0-9a-f]{4,40}$/i.test(a[1]) ? "normal" : null),
  restore: a => (has(a, "--staged") && !has(a, "--worktree", "-W", ".") ? "normal" : null),
  revert: a => (has(a, "--abort") ? "careful" : has(a, "--continue") ? "normal" : null),
  branch: a => (a.length === 1 || has(a, "-a", "-vv", "--list") ? "safe"
    : a.length === 2 && a[1].startsWith("backup/") ? "safe" : "normal"),
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

  for (const [test, reason] of NEVER) {
    if (test(args)) return { allowed: false, risk: "blocked", reason };
  }
  for (const [test, risk, reason] of DANGER) {
    if (test(args)) return { allowed: risk !== "dangerous" || allowDangerous, risk, reason };
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
    case "stashName":
      if (v.length < 3) return "Give it a name you'll recognise later, like login-form-wip.";
      return null;
    case "email":
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? null : "That doesn't look like an email address.";
    case "url":
      return /^(https:\/\/|git@)[^\s]+$/.test(v) ? null : "Paste the https:// or git@ URL from GitHub.";
    default:
      return null;
  }
}
