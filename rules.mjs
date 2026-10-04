// rules.mjs — the "doctor": decides the git steps from the REAL repo state.
// No AI here. Same state + same intent = same plan, every time.
//
// Usage:  import { plan } from "./rules.mjs";
//         const result = plan(state, "push");   // state comes from collect()

// Risk levels (the Guard re-checks every command before it runs).
export const RISK = { SAFE: "safe", NORMAL: "normal", CAREFUL: "careful", DANGEROUS: "dangerous" };

// Intents Gemma can map her message to.
export const INTENTS = ["status", "save", "push", "pull", "resolve", "force-push",
  "stash", "stash-list", "unstash", "reset", "rebase", "cherry-pick"];

// Intents that finish after one successful pass (no "keep going until in sync").
export const ONE_SHOT = new Set(["save", "pull", "stash", "stash-list", "unstash", "reset", "rebase", "cherry-pick"]);

// Branches nobody should ever rewrite, even with --force-with-lease.
export const PROTECTED = /^(main|master|develop|dev|release.*|production|prod)$/;

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
  // Conflict after "git stash pop" (no merge/rebase running). Git keeps the stash as a backup.
  if (!st.operation && st.conflicts.length) {
    const files = paths(st.conflicts);
    return {
      situation: "stash-conflict",
      steps: [
        { manual: true, display: `Choose which version to keep in ${files.join(", ")}`, why: "edit-conflicts", risk: RISK.SAFE },
        step(["add", ...files], "mark-resolved"),
        step(["restore", "--staged", ...files], "unstage", RISK.NORMAL, { note: "Leaves them as normal unsaved changes, like before you stashed." }),
      ],
      warnings: ["Your stashed work clashed with the latest code. Your stash is still kept in the stash list as a backup, so nothing is lost."],
      thenRetry: true,
    };
  }

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

function planSave(st) {
  const steps = saveSteps(st);
  return { situation: steps.length ? "uncommitted-changes" : "nothing-to-save", steps };
}


// --- "Commit or stash?" for unsaved work ------------------------------------
// Used by pull, clean-up (rebase) and cherry-pick. Returns { needs } or { before, after }.
const STASH_ASIDE = (why = "stash") => step(["stash", "push", "-u", "-m", "{stashName}"], why, RISK.NORMAL, {
  input: { name: "stashName", prompt: "Give this stash a name, like a commit message (e.g. login-form-wip):" },
  mark: "stashed",
});
const STASH_BACK = () => step(["stash", "pop", "stash@{0}"], "stash-pop-mine", RISK.NORMAL, {
  mark: "popped", note: "Brings back the work you just put aside.",
});

function keepWork(st, values, doing) {
  if (values.stashed) return { before: [], after: values.popped ? [] : [STASH_BACK()] };
  if (!hasChanges(st)) return { before: [], after: [] };
  if (!values.keepWork) {
    return { needs: {
      name: "keepWork",
      prompt: `You have unsaved changes. What should Ask Iche do with them before it ${doing}?`,
      options: [
        { value: "commit", label: "💾 Commit them", hint: "Save them as a commit on this branch (use this if the work is finished)" },
        { value: "stash", label: "📦 Stash them", hint: "Put them aside with a name, then bring them back right after (use this if you're not done yet)" },
      ],
    } };
  }
  return values.keepWork === "stash"
    ? { before: [STASH_ASIDE()], after: [STASH_BACK()] }
    : { before: saveSteps(st), after: [] };
}

function planPull(st, values) {
  if (!st.hasRemote) return { situation: "no-remote", steps: [] };
  if (!st.upstream) return { situation: "no-upstream", steps: [], warnings: [`Branch ${st.branch} isn't linked to a remote branch, so there's nothing to pull yet.`] };
  if (st.behind === 0 && !(values.stashed && !values.popped)) return { situation: "up-to-date", steps: [] };
  const k = keepWork(st, values, "pulls");
  if (k.needs) return { situation: "behind-with-changes", steps: [], needs: k.needs };
  const pull = st.behind > 0 ? [step(["pull", "--no-rebase", "--no-edit"], "pull")] : [];
  return { situation: values.keepWork === "stash" ? "pull-with-stash" : hasChanges(st) ? "behind-with-changes" : "behind", steps: [...k.before, ...pull, ...k.after] };
}

// --- stash ------------------------------------------------------------------
function planStash(st) {
  if (!hasChanges(st)) return { situation: "nothing-to-stash", steps: [] };
  const s = STASH_ASIDE();
  delete s.mark;
  return { situation: "stash", steps: [s] };
}

function planStashList(st) {
  return { situation: st.stashes.length ? "stash-list" : "no-stashes", steps: [] };
}

export function stashOptions(st) {
  return st.stashes.map(x => ({
    value: String(x.index),
    label: `#${x.index} · ${x.name}`,
    hint: [x.branch && `from ${x.branch}`, x.when].filter(Boolean).join(", "),
    aliases: [x.name, x.ref, `#${x.index}`],
  }));
}

function planUnstash(st, values) {
  if (!st.stashes.length) return { situation: "no-stashes", steps: [] };
  if (values.stash === undefined) {
    return { situation: "pick-stash", steps: [], needs: {
      name: "stash", prompt: "Which stash do you want back? Pick one, or type its number or name:", options: stashOptions(st), typed: true, byValue: true,
    } };
  }
  const x = st.stashes.find(s => String(s.index) === String(values.stash));
  if (!x) return { situation: "no-such-stash", steps: [], warnings: [`There's no stash #${values.stash}.`] };
  const warnings = [];
  if (x.branch && st.branch && x.branch !== st.branch)
    warnings.push(`"${x.name}" was stashed on branch ${x.branch}, but you're on ${st.branch}. It will be added to ${st.branch}.`);
  if (hasChanges(st))
    warnings.push("You also have unsaved changes now. If they touch the same files, git stops safely and nothing is changed.");
  return { situation: "unstash", warnings, steps: [step(["stash", "pop", x.ref], "stash-pop", RISK.NORMAL, {
    note: `Brings back "${x.name}" and removes it from the stash list.`,
  })] };
}

// --- undo commits (reset) ----------------------------------------------------
const stamp = () => new Date().toISOString().slice(0, 16).replace(/\D/g, "");

function planReset(st, values) {
  if (st.noCommitsYet || !st.recentCommits.length) return { situation: "nothing-to-undo", steps: [] };
  const local = [];
  for (const c of st.recentCommits) { if (c.pushed) break; local.push(c); }
  if (!local.length) {
    return { situation: "undo-pushed-refused", steps: [], warnings: [
      `Your latest commit (${st.recentCommits[0].hash} "${st.recentCommits[0].message}") is already on GitHub. Undoing it here would need a force push, which can delete your teammates' work, so Ask Iche won't do it. Ask the real Iche about "git revert" for this one.`,
    ] };
  }
  if (values.count === undefined) {
    return { situation: "pick-undo", steps: [], needs: {
      name: "count", prompt: "How many of your latest commits do you want to undo?",
      options: local.slice(0, 5).map((c, i) => ({
        value: String(i + 1),
        label: `Undo the last ${i + 1}: ${local.slice(0, i + 1).map(x => `"${x.message}"`).join(", ")}`,
        hint: local.slice(0, i + 1).map(x => x.hash).join(" "),
      })),
      note: local.length < st.recentCommits.length ? "Only commits that aren't on GitHub yet are shown. Pushed ones can't be undone safely." : null,
    } };
  }
  const n = Math.max(1, Math.min(local.length, Number(values.count) || 1));
  if (!values.mode) {
    return { situation: "pick-undo", steps: [], needs: {
      name: "mode", prompt: `What should happen to the changes inside ${n === 1 ? "that commit" : `those ${n} commits`}?`,
      options: [
        { value: "soft", label: "↩️ Soft: keep the changes, ready to commit again", hint: "git reset --soft. Nothing is lost. Good for fixing a commit message or combining commits." },
        { value: "mixed", label: "📝 Mixed: keep the changes as unsaved edits", hint: "git reset --mixed. Nothing is lost. Good when you want to redo the commit differently." },
        { value: "hard", label: "🗑️ Hard: throw the changes away", hint: `git reset --hard. The commit's changes${st.staged.length + st.unstaged.length ? " AND your current unsaved changes" : ""} are deleted. A backup branch is made first.` },
      ],
    } };
  }
  const mode = ["soft", "mixed", "hard"].includes(values.mode) ? values.mode : "mixed";
  const steps = [];
  const warnings = [];
  if (mode === "hard") {
    steps.push(step(["branch", `backup/${st.branch || "detached"}-${stamp()}`], "backup", RISK.NORMAL, {
      note: "Safety net: keeps a copy of your commits so this undo can be undone.",
    }));
    const lost = [...new Set([...paths(st.staged), ...paths(st.unstaged)])]; // untracked files survive reset --hard
    if (lost.length) {
      warnings.push(`Hard reset also deletes your unsaved changes in: ${lost.slice(0, 5).join(", ")}${lost.length > 5 ? ` (+${lost.length - 5} more)` : ""}. The backup branch can't save those. Stash them first if you want to keep them.`);
    }
  }
  steps.push(step(["reset", `--${mode}`, `HEAD~${n}`], `reset-${mode}`, mode === "hard" ? RISK.DANGEROUS : RISK.CAREFUL, {
    dangerOk: mode === "hard",
    note: `Undoes: ${local.slice(0, n).map(x => `"${x.message}"`).join(", ")}`,
  }));
  return { situation: `undo-${mode}`, steps, warnings };
}

// --- clean up for review (rebase onto main, optional squash) -----------------
function planRebase(st, values) {
  if (!st.base) return { situation: "no-base", steps: [], warnings: ["Ask Iche couldn't find a main branch (like origin/main) to clean up against."] };
  if (st.onBase || PROTECTED.test(st.branch || ""))
    return { situation: "on-main", steps: [], warnings: [`You're on ${st.branch}. Clean-up is for your own feature branch, not the shared one. Switch to your branch first.`] };
  if (!st.aheadBase && !values.rebased) return { situation: "nothing-to-clean", steps: [] };

  const k = keepWork(st, values, "cleans up your branch");
  if (k.needs) return { situation: "clean-with-changes", steps: [], needs: k.needs };

  const n = st.aheadBase + (values.keepWork === "commit" && hasChanges(st) ? 1 : 0);
  if (!values.style && !values.rebased) {
    if (n <= 1) values.style = "keep";
    else return { situation: "pick-clean", steps: [], needs: {
      name: "style", prompt: `Your branch has ${n} commits. How should it look for the reviewer?`,
      options: [
        { value: "squash", label: `🧹 Squash into 1 commit`, hint: `Combine all ${n} commits into one clean commit, then put it on top of the latest ${st.base}.` },
        { value: "keep", label: `📚 Keep my ${n} commits`, hint: `Keep them as they are, just move them on top of the latest ${st.base}.` },
      ],
    } };
  }

  const steps = [...k.before];
  const remote = st.remotes.includes("origin") ? "origin" : st.remotes[0];
  if (!values.rebased) {
    if (!values.backedUp) steps.push(step(["branch", `backup/${st.branch}-${stamp()}`], "backup", RISK.NORMAL, {
      mark: "backedUp", note: "Safety net: a copy of your branch exactly as it is now.",
    }));
    if (values.style === "squash" && st.mergeBase) {
      steps.push(step(["reset", "--soft", st.mergeBase.slice(0, 12)], "squash-reset", RISK.CAREFUL, {
        note: `Un-commits your ${n} commits but keeps every change staged.`,
      }));
      steps.push(step(["commit", "-m", "{message}"], "squash-commit", RISK.NORMAL, {
        input: { name: "message", prompt: "Message for your one clean commit (what does this branch do?):" },
      }));
    }
    if (st.behindBase > 0) {
      steps.push(step(["rebase", st.base], "rebase", RISK.DANGEROUS, {
        dangerOk: true, mark: "rebased",
        note: `Replays your work on top of the latest ${st.base}. A backup branch was made first.`,
      }));
    } else if (values.style !== "squash") {
      return { situation: "already-on-latest", steps: [], warnings: [`Your branch is already on top of the latest ${st.base}. Nothing to clean up.`] };
    }
  }
  steps.push(...k.after);
  if (remote) {
    if (st.upstream && !st.upstreamMismatch) {
      steps.push(step(["push", "--force-with-lease", remote, st.branch], "push-lease", RISK.DANGEROUS, {
        dangerOk: true,
        note: `Your branch's history changed, so GitHub needs a "force with lease" push. It only replaces YOUR branch ${st.branch}, and git refuses if someone else pushed to it meanwhile.`,
      }));
    } else {
      steps.push(step(["push", "-u", remote, st.branch], "push-new-branch"));
    }
  }
  return { situation: values.style === "squash" ? "clean-squash" : "clean-rebase", steps };
}

// --- copy a commit from another branch (cherry-pick) ------------------------
function planCherryPick(st, values) {
  if (values.picked) {
    const k = keepWork(st, values, "copies the commit");
    return { situation: "picked", steps: k.after || [] };
  }
  if (!st.branches.length) return { situation: "no-other-branches", steps: [] };
  if (!values.from) {
    return { situation: "pick-branch", steps: [], needs: {
      name: "from", prompt: "Which branch has the commit you want to copy?", typed: true,
      options: st.branches.slice(0, 12).map(b => ({ value: b, label: b, aliases: [b] })),
    } };
  }
  if (!st.pickable) return { situation: "pick-branch", steps: [] }; // runner loads it
  if (!st.pickable.length)
    return { situation: "nothing-to-pick", steps: [], warnings: [`Every commit on ${values.from} is already on your branch. Nothing to copy.`] };
  if (!values.commit) {
    return { situation: "pick-commit", steps: [], needs: {
      name: "commit", prompt: `Which commit from ${values.from} do you want to copy onto ${st.branch}?`, typed: true,
      options: st.pickable.map(c => ({ value: c.hash, label: `${c.hash} · ${c.message}`, hint: `${c.author}, ${c.when}`, aliases: [c.hash] })),
    } };
  }
  const c = st.pickable.find(x => x.hash === values.commit);
  if (!c) return { situation: "nothing-to-pick", steps: [], warnings: [`Couldn't find commit ${values.commit} on ${values.from}.`] };
  const k = keepWork(st, values, "copies the commit");
  if (k.needs) return { situation: "pick-with-changes", steps: [], needs: k.needs };
  return { situation: "cherry-pick", steps: [
    ...k.before,
    step(["cherry-pick", c.hash], "cherry-pick", RISK.NORMAL, { mark: "picked", note: `Copies "${c.message}" onto ${st.branch} as a new commit.` }),
    ...k.after,
  ] };
}

// --- main entry -------------------------------------------------------------

export function plan(st, intent = "status", values = {}) {
  const base = { intent, warnings: [], alternatives: [], thenRetry: false };

  const blocked = blockers(st);
  if (blocked) {
    const warnings = [...(blocked.warnings || [])];
    if (intent === "force-push")
      warnings.unshift("Force push can delete your teammates' work, so Ask Iche won't do it. Let's fix this first, then push safely.");
    return { ...base, ...blocked, warnings };
  }

  if (!st.hasIdentity && ["push", "pull", "save", "force-push", "stash", "rebase", "cherry-pick"].includes(intent)) {
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
    case "pull": r = planPull(st, values); break;
    case "stash": r = planStash(st); break;
    case "stash-list": r = planStashList(st); break;
    case "unstash": r = planUnstash(st, values); break;
    case "reset": r = planReset(st, values); break;
    case "rebase": r = planRebase(st, values); break;
    case "cherry-pick": r = planCherryPick(st, values); break;
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
