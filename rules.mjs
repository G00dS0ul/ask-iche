// rules.mjs — the "doctor": decides the git steps from the REAL repo state.
// No AI here. Same state + same intent = same plan, every time.
//
// Usage:  import { plan } from "./rules.mjs";
//         const result = plan(state, "push");   // state comes from collect()

// Risk levels (the Guard re-checks every command before it runs).
export const RISK = { SAFE: "safe", NORMAL: "normal", CAREFUL: "careful", DANGEROUS: "dangerous" };

// Intents Gemma can map her message to.
export const INTENTS = ["status", "save", "push", "pull", "resolve", "force-push"];

const MAX_EXPLICIT_FILES = 5;

function step(args, why, risk = RISK.NORMAL, extra = {}) {
  return { args, display: "git " + args.join(" "), why, risk, ...extra };
}

const paths = list => list.map(x => (typeof x === "string" ? x : x.path));

// --- building blocks --------------------------------------------------------

function saveSteps(st) {
  const changed = [...new Set([...paths(st.unstaged), ...paths(st.untracked)])];
  const steps = [];
  if (changed.length) {
    steps.push(
      changed.length <= MAX_EXPLICIT_FILES
        ? step(["add", ...changed], "stage")
        : step(["add", "-A"], "stage", RISK.NORMAL, { note: `Stages all ${changed.length} changed/new files.` })
    );
  }
  if (changed.length || st.staged.length) {
    steps.push(step(["commit", "-m", "{message}"], "commit", RISK.NORMAL, {
      input: { name: "message", prompt: "Describe what you changed (commit message):" },
    }));
  }
  return steps;
}

function hasChanges(st) {
  return st.staged.length + st.unstaged.length + st.untracked.length > 0;
}

// --- situations that block everything else ----------------------------------

function blockers(st) {
  if (!st.ok) return { situation: st.error, message: st.message, steps: [] };
  if (!st.isRepo) return { situation: "not-a-repo", message: "This folder isn't a git repository.", steps: [] };

  // Unfinished merge / rebase (with or without conflicts)
  if (st.operation || st.conflicts.length) {
    const op = st.operation || "merge";
    const files = paths(st.conflicts);
    const steps = [];
    if (files.length) {
      steps.push({
        manual: true,
        display: `Choose which version to keep in ${files.join(", ")}`,
        why: "edit-conflicts",
        risk: RISK.SAFE,
      });
      steps.push(step(["add", ...files], "mark-resolved"));
    }
    if (op === "rebase") steps.push(step(["rebase", "--continue"], "continue-rebase"));
    else if (op === "merge") steps.push(step(["commit", "--no-edit"], "finish-merge"));
    else steps.push(step([op, "--continue"], "continue-op"));

    const abort = op === "merge" || op === "rebase" || op === "cherry-pick" || op === "revert"
      ? step([op, "--abort"], "abort", RISK.CAREFUL, { note: `Cancels the ${op} and goes back to how things were before it.` })
      : null;

    return {
      situation: files.length ? "conflict" : `${op}-in-progress`,
      steps,
      alternatives: abort ? [abort] : [],
      thenRetry: true, // after this, re-collect and plan the original intent again
    };
  }

  // Only blocks intents that need to commit; checked in plan()
  if (st.detached) {
    return {
      situation: "detached-head",
      steps: [step(["switch", "-c", "{branch}"], "create-branch", RISK.NORMAL, {
        input: { name: "branch", prompt: "Name for a new branch to keep your work:" },
      })],
      thenRetry: true,
    };
  }
  return null;
}

// --- intents ----------------------------------------------------------------

function planPush(st) {
  const steps = [];
  const warnings = [];

  if (!st.hasRemote) {
    return {
      situation: "no-remote",
      steps: [step(["remote", "add", "origin", "{url}"], "add-remote", RISK.NORMAL, {
        input: { name: "url", prompt: "Paste the repo URL (from GitHub):" },
      })],
      thenRetry: true,
    };
  }

  steps.push(...saveSteps(st));

  if (st.upstream && st.behind > 0) {
    // --no-rebase avoids git's "divergent branches" error when pull.rebase isn't configured
    steps.push(step(["pull", "--no-rebase", "--no-edit"], "pull"));
  }

  const committing = steps.some(s => s.why === "commit");
  const remote = st.remotes.includes("origin") ? "origin" : st.remotes[0];

  if (!st.upstream || st.upstreamMismatch) {
    if (st.upstreamMismatch)
      warnings.push(`Your branch ${st.branch} is linked to ${st.upstream}. This will push to ${remote}/${st.branch} instead and link it there.`);
    steps.push(step(["push", "-u", remote, st.branch], "push-new-branch"));
  } else if (st.ahead > 0 || committing) {
    steps.push(step(["push"], "push"));
  }

  if (!steps.length) return { situation: "nothing-to-push", steps: [], warnings };

  let situation = "ready-to-push";
  if (st.behind > 0 && (st.ahead > 0 || committing)) situation = "behind-and-ahead";
  else if (st.behind > 0) situation = "behind";
  else if (!st.upstream) situation = "new-branch";
  else if (committing) situation = "uncommitted-changes";

  return { situation, steps, warnings };
}

function planPull(st) {
  if (!st.hasRemote) return { situation: "no-remote", steps: [] };
  if (!st.upstream) return { situation: "no-upstream", steps: [], warnings: [`Branch ${st.branch} isn't linked to a remote branch, so there's nothing to pull yet.`] };
  if (st.behind === 0) return { situation: "up-to-date", steps: [] };
  const steps = [...saveSteps(st), step(["pull", "--no-rebase", "--no-edit"], "pull")];
  return { situation: hasChanges(st) ? "behind-with-changes" : "behind", steps };
}

function planSave(st) {
  const steps = saveSteps(st);
  return { situation: steps.length ? "uncommitted-changes" : "nothing-to-save", steps };
}

// --- main entry -------------------------------------------------------------

export function plan(st, intent = "status") {
  const base = { intent, warnings: [], alternatives: [], thenRetry: false };

  const blocked = blockers(st);
  if (blocked) {
    const warnings = [...(blocked.warnings || [])];
    if (intent === "force-push")
      warnings.unshift("Force push can delete your teammates' work, so Ask Iche won't do it. Let's fix this first, then push safely.");
    return { ...base, ...blocked, warnings };
  }

  if (!st.hasIdentity && ["push", "pull", "save", "force-push"].includes(intent)) {
    return {
      ...base,
      situation: "no-identity",
      steps: [
        step(["config", "--global", "user.name", "{name}"], "set-name", RISK.NORMAL, { input: { name: "name", prompt: "Your name (shown on your commits):" } }),
        step(["config", "--global", "user.email", "{email}"], "set-email", RISK.NORMAL, { input: { name: "email", prompt: "Your email (use the one on your GitHub account):" } }),
      ],
      thenRetry: true,
    };
  }

  if (st.fetchError) base.warnings.push("Couldn't reach the remote, so ahead/behind may be out of date.");

  let r;
  switch (intent) {
    case "push": r = planPush(st); break;
    case "pull": r = planPull(st); break;
    case "save": r = planSave(st); break;
    case "force-push":
      // The trap: never plan a force push. Offer the safe push instead.
      r = planPush(st);
      r.situation = "force-push-refused";
      r.warnings = [
        "Force push can delete your teammates' work on the remote, so Ask Iche won't do it. Here's the safe way instead.",
        ...(r.warnings || []),
      ];
      break;
    case "resolve":
      r = { situation: "no-conflicts", steps: [] };
      break;
    case "status":
    default:
      r = { situation: "status", steps: [] };
  }
  return { ...base, ...r, warnings: [...base.warnings, ...(r.warnings || [])] };
}

// CLI for testing:  node rules.mjs <intent> [path]
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { collect, toFacts } = await import("./collector.mjs");
  const [intent = "push", path = process.cwd()] = process.argv.slice(2).filter(a => !a.startsWith("--"));
  const st = await collect({ cwd: path, fetch: process.argv.includes("--fetch") });
  const p = plan(st, intent);
  console.log("FACTS:\n- " + toFacts(st).join("\n- "));
  console.log(`\nINTENT: ${intent}   SITUATION: ${p.situation}`);
  p.warnings.forEach(w => console.log("⚠️  " + w));
  p.steps.forEach((s, i) => console.log(`${i + 1}. [${s.risk}] ${s.display}${s.note ? "   (" + s.note + ")" : ""}`));
  if (!p.steps.length) console.log("(no steps needed)");
  p.alternatives.forEach(a => console.log(`   alt: [${a.risk}] ${a.display}`));
  if (p.thenRetry) console.log("→ After these steps, Ask Iche checks again and continues.");
}
