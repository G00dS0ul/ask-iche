// rules.mjs — the "doctor": decides the git steps from the REAL repo state.
// No AI here. Same state + same intent = same plan, every time.
//
// Usage:  import { plan } from "./rules.mjs";
//         const result = plan(state, "push");   // state comes from collect()

// Risk levels (the Guard re-checks every command before it runs).
export const RISK = { SAFE: "safe", NORMAL: "normal", CAREFUL: "careful", DANGEROUS: "dangerous" };

// Intents Gemma can map her message to.
export const INTENTS = ["status", "save", "push", "pull", "resolve", "force-push",
  "stash", "stash-list", "unstash", "reset", "rebase", "cherry-pick", "branch", "log"];

// Intents that finish after one successful pass (no "keep going until in sync").
export const ONE_SHOT = new Set(["save", "pull", "stash", "stash-list", "unstash", "reset", "rebase", "cherry-pick", "branch", "log"]);

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

function blockers(st, values = {}) {
  if (!st.ok) return { situation: st.error, message: st.message, steps: [] };
  if (!st.isRepo) return { situation: "not-a-repo", message: "This folder isn't a git repository.", steps: [] };

  // Unfinished merge / rebase (with or without conflicts)
  // Conflict after "git stash pop" (no merge/rebase running). Git keeps the stash as a backup.
  if (!st.operation && st.conflicts.length) {
    const files = paths(st.conflicts);
    // From "Bring back stashed work": once it's fixed, the stash's changes ARE in her files. Offer to remove the
    // leftover copy, so she doesn't bring the same stash back twice (that clashes again, with identical sides).
    const ps = values.poppedStash;
    const left = ps && st.stashes.find(x => x.ref === ps.ref && x.name === ps.name);
    const steps = [
      { manual: true, display: `Choose which version to keep in ${files.join(", ")}`, why: "edit-conflicts", risk: RISK.SAFE,
        reason: "Iche shows you both versions side by side, and you pick which one to keep. No scary markers." },
      step(["add", ...files], "mark-resolved", undefined, { reason: "Tells git you've finished fixing the conflict in these files." }),
      step(["restore", "--staged", ...files], "unstage", RISK.NORMAL, { note: "Leaves them as normal unsaved changes, like before you stashed.",
        reason: "Keeps your fixed files as normal unsaved changes, just like before you stashed." }),
    ];
    if (left) steps.push(step(["stash", "drop", left.ref], "stash-drop-leftover", RISK.DANGEROUS, { dangerOk: true,
      note: `Its changes are in your files now, so the copy in the stash list isn't needed.`,
      reason: `Removes the leftover copy of "${left.name}" from the stash list. Its changes are already in your files, so bringing it back again would only clash with itself.` }));
    return {
      situation: "stash-conflict",
      steps,
      summary: left ? `Your stash "${left.name}" clashed with your latest code. Pick what to keep, then Iche tidies up so it's back to normal unsaved changes.`
        : "Your stashed work clashed with your latest code. Pick what to keep, and your files go back to normal unsaved changes.",
      warnings: [left ? `Your stash "${left.name}" clashed with the latest code. Git keeps it in the stash list until you've fixed this, so nothing is lost.`
        : "Your stashed work clashed with the latest code. Your stash is still kept in the stash list as a backup, so nothing is lost."],
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

function planPush(st, values = {}) {
  const steps = [];
  const warnings = [];
  // "push to main" while on another branch: never push into someone else's branch.
  if (values.target && values.target !== st.branch) {
    return { situation: "push-other-refused", steps: [], blocked: true, warnings: [
      `🚫 Blocked. You're on ${st.branch}, and Iche only uploads a branch to its own place on GitHub, never into ${values.target}. To get your work into ${values.target}, upload your branch, then open a Pull Request on GitHub so the team can review it.`,
    ] };
  }

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
  reason: "Puts your unsaved changes aside in a new stash, with the name you type. Your other stashes aren't touched.",
});
const STASH_BACK = () => step(["stash", "pop", "stash@{0}"], "stash-pop-mine", RISK.NORMAL, {
  mark: "popped", note: "Brings back the work you just put aside.",
  reason: "Brings back the stash you just made (the newest one, stash@{0}) into your files.",
});

function keepWork(st, values, doing) {
  if (values.stashed) return { before: [], after: values.popped ? [] : [STASH_BACK()] };
  if (!hasChanges(st)) return { before: [], after: [] };
  if (!values.keepWork) {
    return { needs: {
      name: "keepWork",
      prompt: `You have unsaved changes. What should Iche do with them before it ${doing}?`,
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
  return { situation: "stash", steps: [s], summary: "You're putting your unsaved changes aside in a new stash, so your files go back to your last commit." };
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
  // Already brought back in this run (maybe through a conflict): don't pop it (or the next one) again.
  if (values.unstashed) return { situation: "unstash-done", steps: [],
    summary: values.poppedStash ? `Your stash "${values.poppedStash.name}" is back in your files as unsaved changes.` : "Your stash is back in your files as unsaved changes.",
    tip: "Look over the files, then use 💾 Save my work when you're happy with them." };
  if (!st.stashes.length) return { situation: "no-stashes", steps: [] };
  if (values.stash === undefined) {
    return { situation: "pick-stash", steps: [], needs: {
      name: "stash", prompt: "Which stash do you want back? Pick one, or type its number or name:", options: stashOptions(st), typed: true, byValue: true,
    } };
  }
  const want = String(values.stash).trim().toLowerCase().replace(/^#|^stash@\{|\}$/g, "");
  const x = st.stashes.find(s => String(s.index) === want) || st.stashes.find(s => s.name.toLowerCase() === want);
  if (!x) {
    return { situation: "pick-stash", steps: [], warnings: [`There's no stash called "${values.stash}". Pick one from the list.`], needs: {
      name: "stash", prompt: "Which stash do you want back? Pick one, or type its number or name:", options: stashOptions(st), typed: true, byValue: true,
    } };
  }
  const warnings = [];
  if (x.branch && st.branch && x.branch !== st.branch)
    warnings.push(`"${x.name}" was stashed on branch ${x.branch}, but you're on ${st.branch}. It will be added to ${st.branch}.`);
  values.poppedStash = { ref: x.ref, name: x.name };
  // Git refused: her unsaved changes touch the same files as the stash. Show what's in the way and the ways out.
  if (values.clash && !values.keepWork) {
    const files = values.clash.files?.length ? values.clash.files : paths([...st.staged, ...st.unstaged]);
    return { situation: "unstash-blocked-by-changes", steps: [], warnings, needs: {
      name: "keepWork",
      prompt: `What should Iche do with your unsaved changes before bringing back "${x.name}"?`,
      blocker: { title: "🧱 Your unsaved changes are in the way", files,
        text: `Your stash "${x.name}" changes the same files, and git won't pour it over unsaved work. Nothing was changed. Save your changes first, then Iche brings the stash back.` },
      options: [
        { value: "commit", label: "💾 Commit them first", hint: `Save them as a commit on ${st.branch || "this branch"}, then bring the stash back` },
        { value: "stash", label: "📦 Stash them too", hint: `Put them aside as a new stash, then bring "${x.name}" back` },
      ] } };
  }
  if (values.keepWork === "commit") {
    return { situation: "unstash-after-commit", warnings,
      summary: `First your unsaved changes become a commit, then your stash "${x.name}" comes back into your files.`,
      steps: [
        step(["add", "-A"], "stage-all", RISK.NORMAL, { reason: "Gets all your unsaved changes ready to be saved." }),
        step(["commit", "-m", "{message}"], "commit", RISK.NORMAL, { input: { name: "message", prompt: "Describe what you changed (commit message):" },
          reason: "Saves your changes as a commit with the message you type." }),
        step(["stash", "pop", x.ref], "stash-pop", RISK.NORMAL, { mark: "unstashed",
          note: `Brings back "${x.name}" and removes it from the stash list.`,
          reason: `Brings back "${x.name}" (${x.ref}) into your files and removes it from the stash list.` }),
      ] };
  }
  if (values.keepWork === "stash") {
    const shifted = `stash@{${x.index + 1}}`; // the new stash becomes stash@{0}, so hers moves down one
    values.poppedStash = { ref: shifted, name: x.name };
    return { situation: "unstash-after-stash", warnings,
      summary: `First your unsaved changes go into a new stash, then your stash "${x.name}" comes back into your files.`,
      steps: [
        step(["stash", "push", "-u", "-m", "{stashName}"], "stash-push", RISK.NORMAL, {
          input: { name: "stashName", prompt: "Give this stash a name, like a commit message (e.g. login-form-wip):" },
          reason: "Puts your unsaved changes aside in a new stash, with the name you type. Your other stashes aren't touched." }),
        step(["stash", "pop", shifted], "stash-pop", RISK.NORMAL, { mark: "unstashed",
          note: `Brings back "${x.name}" (now ${shifted}, because the new stash is on top).`,
          reason: `Brings back "${x.name}" into your files. It's ${shifted} now, because your new stash went on top.` }),
      ] };
  }
  if (hasChanges(st))
    warnings.push("You also have unsaved changes now. If they touch the same files, git stops safely and nothing is changed.");
  return { situation: "unstash", warnings,
    summary: `You're bringing back your stash "${x.name}" (${x.ref}) into your files.`,
    context: [`She picked stash ${x.ref} named "${x.name}". Only talk about that one stash.`],
    steps: [step(["stash", "pop", x.ref], "stash-pop", RISK.NORMAL, { mark: "unstashed",
      note: `Brings back "${x.name}" and removes it from the stash list.`,
      reason: `Brings back "${x.name}" (${x.ref}) into your files and removes it from the stash list.`,
    })] };
}

// "pop 0", "pop #1", "pop stash@{1}", "bring back login-form-wip", "unstash scratch-notes"
// -> { intent: "unstash", values: { stash } } so she can skip the picker.
export function quickIntent(text) {
  const t = String(text || "").trim().replace(/\s+/g, " ");
  let m = t.match(/^(?:git\s+)?(?:stash\s+)?(?:pop|unstash|bring back|apply)\s+(?:the\s+)?(?:stash\s+)?(?:called\s+|named\s+)?["']?([^"'\s]+)["']?$/i);
  if (m) return { intent: "unstash", values: { stash: m[1] } };
  const B = "([A-Za-z0-9._\\/-]+)";
  const rx = s => new RegExp(s.replace(/B/g, B), "i");
  // branches, typed as git commands
  if ((m = t.match(rx("^git (?:checkout -b|switch -c|switch --create) B(?: (\\S+))?$"))))
    return { intent: "branch", values: { action: "new", branch: m[1], from: m[2] && /(^|\/)(main|master)$/.test(m[2]) ? "base" : "here" } };
  if ((m = t.match(rx("^git branch -m(?: \\S+)? B$")))) return { intent: "branch", values: { action: "rename", branch: m[1] } };
  if ((m = t.match(rx("^git branch (?:-d|--delete) B$")))) return { intent: "branch", values: { action: "delete", target: m[1] } };
  if ((m = t.match(rx("^git (?:checkout|switch) B$"))) && !m[1].startsWith("-")) return { intent: "branch", values: { action: "switch", to: m[1] } };
  if ((m = t.match(rx("^git branch B$"))) && !m[1].startsWith("-")) return { intent: "branch", values: { action: "new", branch: m[1], from: "here" } };
  if (/^git branch(?: -a| -v| -vv| --list)?$/i.test(t)) return { intent: "branch", values: { action: "switch" } };
  // branches, in plain words
  if ((m = t.match(rx("^(?:switch|go|move|change|checkout)(?: back)? (?:to )?(?:the )?(?:branch )?B(?: branch)?$"))) && !/^(branch|another|a|other)$/i.test(m[1]))
    return { intent: "branch", values: { action: "switch", to: m[1] } };
  if ((m = t.match(rx("^(?:create|make|start|new)(?: a)?(?: new)? branch(?: called| named)? B$")))) return { intent: "branch", values: { action: "new", branch: m[1] } };
  if ((m = t.match(rx("^(?:delete|remove)(?: the)? branch B$")))) return { intent: "branch", values: { action: "delete", target: m[1] } };
  if ((m = t.match(rx("^rename(?: my| this| the)?(?: branch)? to B$")))) return { intent: "branch", values: { action: "rename", branch: m[1] } };
  // history
  if ((m = t.match(/^git log\b(.*)$/i))) {
    const rest = m[1].trim().split(" ").filter(Boolean);
    const ref = rest.find(x => !x.startsWith("-"));
    return { intent: "log", values: { ...(rest.includes("--oneline") ? { style: "oneline" } : {}), ...(ref ? { ref } : {}) } };
  }
  return null;
}

// --- undo commits (reset) ----------------------------------------------------
// Local time (her clock), e.g. 202610041021
const stamp = (d = new Date()) => [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()].map(n => String(n).padStart(2, "0")).join("");

// A backup branch, unless she already has one of exactly this commit (no clutter).
function backupStep(st, extra = {}) {
  const same = (st.backups || []).find(b => st.headHash && b.name.startsWith(`backup/${st.branch}-`) && (b.hash.startsWith(st.headHash) || st.headHash.startsWith(b.hash)));
  if (same) return { step: null, warning: `You already have a backup of exactly this state: ${same.name}. Iche will use that one instead of making another.` };
  const name = `backup/${st.branch || "detached"}-${stamp()}`;
  return { step: step(["branch", name], "backup", RISK.NORMAL, {
    reason: `Makes a safety copy of your branch called ${name}. It does not switch branches.`, ...extra,
  }) };
}

function planReset(st, values) {
  if (st.noCommitsYet || !st.recentCommits.length) return { situation: "nothing-to-undo", steps: [] };
  const local = [];
  let stoppedAtMerge = null;
  for (const c of st.recentCommits) {
    if (c.pushed) break;
    if (c.merge) { stoppedAtMerge = c; break; } // undoing a merge also undoes the teammates' work it brought in
    local.push(c);
  }
  if (!local.length && stoppedAtMerge) {
    return { situation: "undo-merge-refused", steps: [], warnings: [
      `Your latest commit is a merge ("${stoppedAtMerge.message}"). Undoing it would also undo the teammates' work it brought in, so Iche won't do it here. Message Iche (the human one 😄) for this one.`,
    ] };
  }
  if (!local.length) {
    return { situation: "undo-pushed-refused", steps: [], warnings: [
      `Your latest commit (${st.recentCommits[0].hash} "${st.recentCommits[0].message}") is already on GitHub. Undoing it here would need a force push, which can delete your teammates' work, so Iche won't do it. Message Iche (the human one 😄) about "git revert" for this one.`,
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
      note: stoppedAtMerge ? `The list stops at the merge commit ("${stoppedAtMerge.message.slice(0, 60)}"). Undoing a merge would also undo your teammates' work, so it isn't offered.`
        : local.length < st.recentCommits.length ? "Only commits that aren't on GitHub yet are shown. Pushed ones can't be undone safely." : null,
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
    const b = backupStep(st, { note: "Safety net: keeps a copy of your commits so this undo can be undone." });
    if (b.step) steps.push(b.step); else warnings.push(b.warning);
    const lost = [...new Set([...paths(st.staged), ...paths(st.unstaged)])]; // untracked files survive reset --hard
    if (lost.length) {
      warnings.push(`Hard reset also deletes your unsaved changes in: ${lost.slice(0, 5).join(", ")}${lost.length > 5 ? ` (+${lost.length - 5} more)` : ""}. The backup branch can't save those. Stash them first if you want to keep them.`);
    }
  }
  steps.push(step(["reset", `--${mode}`, `HEAD~${n}`], `reset-${mode}`, mode === "hard" ? RISK.DANGEROUS : RISK.CAREFUL, {
    dangerOk: mode === "hard",
    note: `Undoes: ${local.slice(0, n).map(x => `"${x.message}"`).join(", ")}`,
  }));
  const backupName = steps[0]?.args?.[0] === "branch" ? steps[0].args[1] : (warnings.join(" ").match(/backup\/\S+?(?=\.?\s|\.$|$)/) || [])[0];
  const tip = mode === "hard" && backupName ? `Changed your mind? Your backup branch ${backupName} still has those commits.` : null;
  return { situation: `undo-${mode}`, steps, warnings, ...(tip ? { tip } : {}) };
}

// --- clean up for review (rebase onto main, optional squash) -----------------
function planRebase(st, values) {
  if (!st.base) return { situation: "no-base", steps: [], warnings: ["Iche couldn't find a main branch (like origin/main) to clean up against."] };
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
  const cleanWarnings = [];
  const remote = st.remotes.includes("origin") ? "origin" : st.remotes[0];
  if (!values.rebased) {
    if (!values.backedUp) {
      const b = backupStep(st, { mark: "backedUp", note: "Safety net: a copy of your branch exactly as it is now." });
      if (b.step) steps.push(b.step); else cleanWarnings.push(b.warning);
    }
    if (values.style === "squash" && st.mergeBase) {
      steps.push(step(["reset", "--soft", st.mergeBase.slice(0, 12)], "squash-reset", RISK.CAREFUL, {
        note: `Un-commits your ${n} commits but keeps every change staged.`,
        reason: `Un-commits your ${n} commits but keeps every change staged, so they can become one commit. Nothing is lost.`,
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
  return { situation: values.style === "squash" ? "clean-squash" : "clean-rebase", steps, warnings: cleanWarnings };
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
  return { situation: "cherry-pick", context: [`She is copying commit ${c.hash} ("${c.message}") FROM branch ${values.from} ONTO her branch ${st.branch}.`], steps: [
    ...k.before,
    step(["cherry-pick", c.hash], "cherry-pick", RISK.NORMAL, { mark: "picked", note: `Copies "${c.message}" onto ${st.branch} as a new commit.`,
      reason: `Copies commit ${c.hash} ("${c.message}") from ${values.from} onto ${st.branch} as a new commit.` }),
    ...k.after,
  ] };
}

// --- branches: switch / new / rename / delete --------------------------------
const branchOpts = (list, hint) => list.map(b => ({ value: b, label: b, hint, aliases: [b] }));

function planBranch(st, values) {
  if (!values.action) {
    return { situation: "pick-branch-action", steps: [], needs: {
      name: "action", prompt: `You're on ${st.branch || "no branch"}. What do you want to do?`,
      options: [
        { value: "switch", label: "🔀 Switch to another branch", hint: "Go to a branch on your laptop or on GitHub" },
        { value: "new", label: "🌱 Create a new branch", hint: "Start a fresh branch for new work" },
        { value: "rename", label: `✏️ Rename ${st.branch || "this branch"}`, hint: "Give this branch a better name" },
        { value: "delete", label: "🗑️ Delete a branch", hint: "Remove a branch you don't need (also old backup/ copies)" },
      ],
    } };
  }
  const exists = b => st.localBranches.includes(b) || st.backups.some(x => x.name === b);
  const warnings = [];

  if (values.action === "switch") {
    if (values.to && values.to === st.branch) { warnings.push(`You're already on ${st.branch}.`); delete values.to; }
    if (values.to && !exists(values.to) && !st.remoteOnly.includes(values.to.replace(/^origin\//, ""))) {
      warnings.push(`There's no branch called "${values.to}". Pick one from the list.`); delete values.to;
    }
    if (!values.to) {
      const mine = st.localBranches.filter(b => b !== st.branch);
      const opts = [...branchOpts(mine, "on your laptop"), ...branchOpts(st.remoteOnly, "on GitHub (Iche makes a local copy)")];
      if (!opts.length) return { situation: "no-other-branches", steps: [], warnings: ["There's no other branch to switch to. Create one with 🌱 Create a new branch."] };
      return { situation: "pick-switch", steps: [], warnings, needs: { name: "to", prompt: "Which branch do you want to go to?", options: opts, typed: true } };
    }
    const to = values.to.replace(/^origin\//, "");
    if (hasChanges(st) && !values.keepWork) {
      return { situation: values.clash ? "switch-blocked-by-changes" : "switch-with-changes", steps: [], warnings,
        needs: keepWorkNeeds(st, values, to, `switching to ${to}`, `🎒 Take them with me to ${to}`) };
    }
    const before = !hasChanges(st) || values.keepWork === "carry" ? [] : values.keepWork === "stash" ? [STASH_ASIDE()] : saveSteps(st);
    if (values.keepWork === "stash") warnings.push(`After switching, your stashed work stays in the stash list. When you come back to ${st.branch}, use 📤 Bring back stashed work.`);
    const remote = !exists(to);
    const kept = values.keepWork === "stash" ? " Your unsaved changes go into a stash first." : values.keepWork === "commit" ? " Your unsaved changes are committed first." : values.keepWork === "carry" ? " Your unsaved changes come with you." : "";
    return { situation: "switch", warnings, summary: `You're switching from ${st.branch} to ${to}.${kept}`, steps: [...before, step(["switch", to], "switch", RISK.NORMAL, {
      note: remote ? `Makes a local copy of origin/${to} and switches to it.` : `Moves you to ${to}. Your files change to match that branch.`,
      reason: remote ? `Makes your own copy of ${to} from GitHub and switches you to it.` : `Switches you from ${st.branch} to ${to}. Your files change to match ${to}; nothing is lost.`,
    })] };
  }

  if (values.action === "new") {
    if (values.branch && (validateBranchName(values.branch) || exists(values.branch))) {
      warnings.push(exists(values.branch) ? `A branch called "${values.branch}" already exists. Choose another name.` : `"${values.branch}" can't be a branch name. ${validateBranchName(values.branch)}`);
      delete values.branch;
    }
    if (!values.from) {
      if (!st.base || st.onBase) values.from = "here";
      else return { situation: "pick-new-from", steps: [], warnings, needs: {
        name: "from", prompt: "Where should the new branch start?",
        options: [
          { value: "base", label: `🆕 From the latest ${st.base}`, hint: "Best for new, separate work" },
          { value: "here", label: `📍 From here (${st.branch})`, hint: `Keeps everything that's on ${st.branch} now` },
        ],
      } };
    }
    const args = ["switch", "-c", "{branch}", ...(values.from === "base" ? ["--no-track", st.base] : [])];
    const from = values.from === "base" ? `the latest ${st.base}` : st.branch;
    // From here, unsaved changes always come along. From origin/main they can clash, so ask first.
    if (values.from === "base" && hasChanges(st) && !values.keepWork) {
      return { situation: values.clash ? "new-branch-blocked-by-changes" : "new-branch-with-changes", steps: [], warnings,
        needs: keepWorkNeeds(st, values, st.base, `starting the new branch from ${st.base}`, "🎒 Take them with me") };
    }
    const before = values.from !== "base" || !hasChanges(st) || values.keepWork === "carry" ? [] : values.keepWork === "stash" ? [STASH_ASIDE()] : saveSteps(st);
    if (hasChanges(st)) {
      if (values.from !== "base") warnings.push("Your unsaved changes come with you to the new branch.");
      else if (values.keepWork === "carry") warnings.push(`Your unsaved changes come with you. If they clash with ${st.base}, git stops safely and nothing changes.`);
      else if (values.keepWork === "stash") warnings.push(`Your stashed work stays in the stash list. When you come back to ${st.branch}, use 📤 Bring back stashed work.`);
    }
    return { situation: "new-branch", warnings,
      summary: `${values.from === "base" && hasChanges(st) && values.keepWork === "stash" ? "First your unsaved changes go into a stash. Then you're" : values.from === "base" && hasChanges(st) && values.keepWork === "commit" ? "First your unsaved changes are committed. Then you're" : "You're"} making a new branch, with the name you type, starting from ${from}, and switching to it.${values.from === "base" ? ` It isn't linked to GitHub yet. That happens the first time you upload it.` : ""}`,
      tip: "Short names with a slash work well, like feature/login-fix or fix/typo.",
      context: [`The new branch starts from ${from}${values.from === "base" ? " (not from the current branch)" : ""}. She types the name herself, so don't invent one. It does not track any remote branch yet.`],
      steps: [...before, step(args, "new-branch", RISK.NORMAL, {
      input: { name: "branch", prompt: "Name for the new branch (e.g. feature/login-fix):" },
      note: `Starts from ${from} and switches you to it.`,
      reason: `Creates a new branch starting from ${from} and switches you to it.`,
    })] };
  }

  if (values.action === "rename") {
    if (!st.branch || PROTECTED.test(st.branch))
      return { situation: "rename-refused", steps: [], blocked: true, warnings: [`🚫 ${st.branch || "This"} is a shared branch, so Iche won't rename it. Everyone else's setup points at that name.`] };
    if (values.branch && (validateBranchName(values.branch) || exists(values.branch))) {
      warnings.push(exists(values.branch) ? `A branch called "${values.branch}" already exists. Choose another name.` : `"${values.branch}" can't be a branch name. ${validateBranchName(values.branch)}`);
      delete values.branch;
    }
    if (st.upstream) warnings.push(`${st.branch} is already on GitHub. Renaming here doesn't rename it there. Next time you upload, it goes up under the new name. Then delete the old one with 🌿 Branches → Delete → ☁️.`);
    return { situation: "rename-branch", warnings, summary: `You're giving ${st.branch} a new name. Your commits stay the same.`, steps: [step(["branch", "-m", "{branch}"], "rename-branch", RISK.NORMAL, {
      input: { name: "branch", prompt: `New name for ${st.branch}:` },
      reason: `Renames your branch ${st.branch} to the new name. Your commits stay exactly the same.`,
    })] };
  }

  if (values.action === "delete") {
    const remote = st.remotes.includes("origin") ? "origin" : st.remotes[0];
    const onGitHub = (st.remoteBranches || []).filter(b => !PROTECTED.test(b.name));
    // "origin/x" (or "github:x") means the copy on GitHub
    const ghName = t => { const m = String(t || "").match(/^(?:github:|(?:origin|upstream)\/)(.+)$/); return m ? m[1] : null; };
    if (values.target && ghName(values.target)) {
      const name = ghName(values.target);
      if (PROTECTED.test(name))
        return { situation: "delete-remote-refused", steps: [], blocked: true, warnings: [`🚫 ${name} is a shared branch, so Iche won't delete it on GitHub. Everyone's work depends on it.`] };
      const b = onGitHub.find(x => x.name === name);
      if (!b) { warnings.push(`There's no branch called "${name}" on GitHub. Pick one from the list.`); delete values.target; }
      else {
        const local = st.localBranches.includes(name);
        const bk = `backup/${name}-${stamp()}`;
        const steps = [];
        if (!local) steps.push(step(["branch", "--no-track", bk, b.ref], "backup", RISK.NORMAL, {
          reason: `Makes a safety copy of GitHub's ${name} on your laptop, called ${bk}, so its commits aren't lost.`,
          note: "Safety net: keeps the commits on your laptop." }));
        steps.push(step(["push", b.remote, "--delete", name], "delete-remote", RISK.DANGEROUS, {
          dangerOk: true,
          note: `Deletes ${name} on GitHub for everyone.`,
          reason: `Deletes the branch ${name} on GitHub. ${local ? `Your laptop copy ${name} stays.` : `Your safety copy ${bk} stays on your laptop.`}`,
        }));
        return { situation: "delete-remote-branch",
          summary: `You're deleting ${name} on GitHub. ${local ? `Your own copy on this laptop isn't touched.` : `Iche makes a safety copy on your laptop first.`}`,
          tip: "Only delete branches on GitHub that are merged or that nobody else is using.",
          warnings: [`This deletes ${name} on GitHub for everyone on the team. Open pull requests from it will close.${name === st.branch ? " You're on this branch, so your next upload would create it again." : ""}`],
          steps };
      }
    }
    const backups = (st.backups || []).map(b => b.name).filter(n => n.startsWith("backup/") && n !== st.branch);
    if (values.target === "all-backups") {
      if (!backups.length) { warnings.push("There are no backup copies to delete."); delete values.target; }
      else return { situation: "delete-all-backups",
        summary: `You're deleting all ${backups.length} safety copies Iche made on this laptop. Your real branches and GitHub aren't touched.`,
        tip: "Keep a backup if you might still want to undo something.",
        warnings: [`Once these ${backups.length} backups are deleted, you can't use them to undo anymore.`],
        steps: [step(["branch", "-D", ...backups], "delete-backups", RISK.DANGEROUS, {
          dangerOk: true,
          note: `Deletes ${backups.length} safety copies from your laptop.`,
          reason: `Deletes the safety copies ${backups.join(", ")} from your laptop. Nothing else changes.`,
        })] };
    }
    const can = b => b !== st.branch && !PROTECTED.test(b);
    if (values.target && (!exists(values.target) || !can(values.target))) {
      warnings.push(!exists(values.target) ? `There's no branch called "${values.target}" on your laptop.`
        : values.target === st.branch ? `You can't delete the branch you're on (${st.branch}). Switch to another branch first.`
        : `🚫 ${values.target} is a shared branch, so Iche won't delete it.`);
      delete values.target;
    }
    if (!values.target) {
      const opts = [...branchOpts(st.localBranches.filter(can), "on your laptop"),
        ...(backups.length > 1 ? [{ value: "all-backups", label: `🧹 Delete all old backups (${backups.length})`, hint: "every backup/ safety copy on your laptop", aliases: ["all backups", "all-backups", "backups"] }] : []),
        ...st.backups.map(b => ({ value: b.name, label: b.name, hint: "safety copy made by Iche", aliases: [b.name] })),
        ...onGitHub.map(b => ({ value: b.ref, label: `☁️ ${b.name}`, hint: "on GitHub (deletes it there for everyone)", aliases: [b.ref, `github:${b.name}`, `☁️ ${b.name}`, `☁️${b.name}`] }))];
      if (!opts.length) return { situation: "nothing-to-delete", steps: [], warnings: [...warnings, "There's no branch you can delete. (Iche never deletes the branch you're on, or shared ones like main.)"] };
      return { situation: "pick-delete", steps: [], warnings, needs: { name: "target", prompt: "Which branch do you want to delete? (☁️ = the copy on GitHub)", options: opts, typed: true } };
    }
    const backup = values.target.startsWith("backup/");
    return { situation: "delete-branch",
      summary: backup ? `You're deleting the safety copy ${values.target} from your laptop.` : `You're deleting ${values.target} from your laptop. GitHub isn't touched.`,
      tip: backup ? "Only delete backups you're sure you won't need to undo with." : "If git says the branch isn't fully merged, it still has work you'd lose, so it's kept safe.",
      warnings: backup ? [`${values.target} is a safety copy. Once it's deleted, you can't use it to undo anymore.`] : [],
      steps: [step(["branch", backup ? "-D" : "-d", values.target], "delete-branch", backup ? RISK.DANGEROUS : RISK.CAREFUL, {
        dangerOk: backup,
        note: backup ? "Deletes this safety copy from your laptop." : "Safe delete: git refuses if this branch has work that isn't merged anywhere.",
        reason: backup ? `Deletes the safety copy ${values.target} from your laptop.` : `Deletes ${values.target} from your laptop only. Git refuses if it has commits that aren't merged anywhere, so nothing is lost by accident.`,
      })] };
  }
  return { situation: "status", steps: [] };
}

// "What about your unsaved changes?" for switch / new branch.
// After git refused because they clash (values.clash), it becomes a blocker card and "take them with me" is gone.
function keepWorkNeeds(st, values, target, doing, carryLabel) {
  const opts = [
    { value: "stash", label: "📦 Stash them here", hint: `Put them aside with a name. Bring them back when you return to ${st.branch}.` },
    { value: "commit", label: "💾 Commit them", hint: `Save them as a commit on ${st.branch} first` },
  ];
  if (values.clash) {
    const files = values.clash.files?.length ? values.clash.files : paths([...st.staged, ...st.unstaged]);
    return { name: "keepWork", options: opts,
      prompt: `Git stopped: your unsaved changes clash with ${target}. Nothing was changed. What should Iche do with them first?`,
      blocker: { title: "🧱 Your unsaved changes are in the way", files,
        text: `${target} has different versions of ${files.length === 1 ? "this file" : "these files"}. Taking your changes along would overwrite them, so git said no. Put them somewhere safe first, then Iche carries on ${doing}.` } };
  }
  return { name: "keepWork", prompt: `You have unsaved changes on ${st.branch}. What should Iche do with them before ${doing}?`,
    options: [...opts, { value: "carry", label: carryLabel, hint: `Git only allows this if they don't clash with ${target}. If they do, it stops safely.` }] };
}

function validateBranchName(v) {
  if (/\s/.test(v)) return "Branch names can't have spaces. Try dashes, like fix-login.";
  if (!/^[A-Za-z0-9._\/-]+$/.test(v) || v.startsWith("-") || v.includes("..") || v.endsWith("/") || v.endsWith(".lock") || v.startsWith("backup/"))
    return "Use letters, numbers, dashes, dots or slashes only (e.g. feature/login-fix).";
  return null;
}

// --- history (git log) ---------------------------------------------------------
function planLog(st, values) {
  if (st.noCommitsYet) return { situation: "no-commits", steps: [] };
  const remote = st.remotes.includes("origin") ? "origin" : st.remotes[0];
  const refs = [
    { value: "HEAD", label: `📍 This branch (${st.branch || "where you are"})`, hint: "Your commits on your laptop" },
    ...(st.upstream ? [{ value: st.upstream, label: `☁️ GitHub's copy (${st.upstream})`, hint: "What's uploaded so far" }] : []),
    ...(st.base && st.base !== st.upstream ? [{ value: st.base, label: `🏠 Main (${st.base})`, hint: "The team's shared branch" }] : []),
  ];
  if (values.ref && values.ref !== "HEAD" && !refs.some(r => r.value === values.ref) &&
      !st.localBranches.includes(values.ref) && !st.branches.includes(values.ref) && !st.remoteOnly.includes(values.ref)) {
    const w = [`There's no branch called "${values.ref}". Pick one from the list.`]; delete values.ref;
    return { situation: "pick-log", steps: [], warnings: w, needs: { name: "ref", prompt: "Whose history do you want to see?", options: refs, typed: true } };
  }
  if (!values.ref) return { situation: "pick-log", steps: [], needs: { name: "ref", prompt: "Whose history do you want to see? (or type any branch name)", options: refs, typed: true } };
  if (!values.style) return { situation: "pick-log", steps: [], needs: {
    name: "style", prompt: "How much detail?",
    options: [
      { value: "oneline", label: "📄 One line each", hint: "Quick list: short id + message (last 20)" },
      { value: "detailed", label: "📖 Detailed", hint: "Who, when, message and which files changed (last 10)" },
    ],
  } };
  const ref = values.ref;
  const args = values.style === "oneline" ? ["log", "--oneline", "--decorate", "-20", ref] : ["log", "--stat", "--date=relative", "-10", ref];
  const name = ref === "HEAD" ? st.branch || "this branch" : ref;
  return { situation: "log", context: [`She is looking at the commit history of ${name}${remote && ref.startsWith(remote + "/") ? " (the copy on GitHub)" : ""}.`],
    steps: [step(args, "log", RISK.SAFE, { reason: values.style === "oneline"
      ? `Lists the last 20 commits on ${name}, one line each (short id + message). Read-only, nothing changes.`
      : `Shows the last 10 commits on ${name} with author, time and the files each one changed. Read-only, nothing changes.` })] };
}

// --- hard safety refusals for what she TYPES (checked before anything else) ----
export const FORCE_REFUSED = "🚫 Blocked. Iche never force-pushes: it can delete your teammates' work on GitHub. If your push was rejected, use ⬇️ Get latest and then ⬆️ Upload my work. If you cleaned up your branch, 🧹 Clean up for review uploads it safely with --force-with-lease, on your own branch only.";
const BLOCKS = [
  [/\bpush\b.*(\s--force(?!-with-lease)\b|\s-f\b|\s--mirror\b|\s\+\S)|\bforce[\s-]*push|\bpush[\s-]*(--)?force(?!-with-lease)|\bforce\b.*\b(upload|overwrite)\b|overwrite (the )?(remote|github|origin)/i, FORCE_REFUSED],
  [/\brebase\b.*(\s-i\b|--interactive|--root|--exec|\s-x\b)|interactive rebase/i,
    "🚫 Blocked. Interactive rebase opens an editor full of commands, and one wrong word can drop commits. Iche doesn't do it. To combine commits, use 🧹 Clean up for review → Squash into 1 commit. To undo commits, use ↩️ Undo commits."],
  [/\bclean\b.*\s-\w*f/i, "🚫 Blocked. git clean deletes new files permanently (they don't go to the recycle bin). Iche won't run it. Use 📦 Stash my work to put them aside instead."],
  [/\bbranch\s+(-D\b|--delete\s+--force|-d\s+-f\b|-df\b)/, "🚫 Blocked. Force-deleting a branch can throw away commits that only live there. Use 🌿 Branches → Delete a branch: it uses the safe delete, which refuses if work would be lost."],
  [/\bpush\b.*(\s--delete\b|\s-d\b|\s:\S)/i, "🚫 Blocked. Iche deletes one branch at a time on GitHub, and never shared ones like main. Use 🌿 Branches → Delete → pick the ☁️ one."],
  [/\b(checkout|restore)\b.*\s(\.|--\s+\.)\s*$|discard (all )?(my )?(changes|work)|throw away (my )?(changes|work)/i, "🚫 Blocked. That throws away your unsaved changes for good. Use 📦 Stash my work to put them aside instead, so you can get them back."],
  [/\bcommit\b.*--amend/i, "🚫 Blocked. --amend rewrites a commit, which breaks things if it's already on GitHub. To change your last commit, use ↩️ Undo commits → Soft, then save again."],
  [/\breset\b.*--hard\s+(origin|upstream)\//i, "🚫 Blocked. That throws away all your local commits and changes to match GitHub. Use ↩️ Undo commits instead: it shows exactly what will go and makes a backup first."],
];
const PUSH_PROTECTED = /\bpush\b.*?(?:\bto\b|\binto\b|\bonto\b|\borigin\b|:)\s*(?:the\s+)?(?:origin\s+|origin\/)?(main|master|develop|dev|production|prod|release\S*)\b/i;

// -> { refused } | { intent, values } | null
export function refuseText(text) {
  const t = String(text || "").trim();
  // Deleting ONE branch on GitHub is a guided Branches action now (backup first, type yes).
  const del = t.match(/^git push (\S+) (?:--delete|-d) ([A-Za-z0-9._\/-]+)$/i) || t.match(/^git push (\S+) :([A-Za-z0-9._\/-]+)$/i)
    || t.match(/^(?:delete|remove)(?: the)?(?: branch)? ([A-Za-z0-9._\/-]+) (?:on|from) (github|the remote|origin)$/i);
  if (del) {
    const name = del.length === 3 && /^(github|the remote|origin)$/i.test(del[2]) && !/^git /i.test(t) ? del[1] : del[2];
    return { intent: "branch", values: { action: "delete", target: `origin/${name}` } };
  }
  for (const [re, msg] of BLOCKS) if (re.test(t)) return { refused: msg };
  const m = t.match(PUSH_PROTECTED);
  if (m) return { intent: "push", values: { target: m[1].toLowerCase() } };
  return null;
}

// --- main entry -------------------------------------------------------------

export function plan(st, intent = "status", values = {}) {
  const base = { intent, warnings: [], alternatives: [], thenRetry: false };

  const blocked = blockers(st, values);
  if (blocked) {
    const warnings = [...(blocked.warnings || [])];
    if (intent === "force-push")
      warnings.unshift("Force push can delete your teammates' work, so Iche won't do it. Let's fix this first, then push safely.");
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
    case "push": r = planPush(st, values); break;
    case "branch": r = planBranch(st, values); break;
    case "log": r = planLog(st, values); break;
    case "pull": r = planPull(st, values); break;
    case "stash": r = planStash(st); break;
    case "stash-list": r = planStashList(st); break;
    case "unstash": r = planUnstash(st, values); break;
    case "reset": r = planReset(st, values); break;
    case "rebase": r = planRebase(st, values); break;
    case "cherry-pick": r = planCherryPick(st, values); break;
    case "save": r = planSave(st); break;
    case "force-push":
      // The trap: never plan a force push. Hard stop, nothing to click.
      r = { situation: "force-push-refused", steps: [], blocked: true, warnings: [FORCE_REFUSED] };
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
  if (p.thenRetry) console.log("→ After these steps, Iche checks again and continues.");
}
