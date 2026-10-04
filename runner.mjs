// runner.mjs — runs a plan ONE step at a time, with her confirmation,
// then re-checks the repo and keeps going until she's done (or stops).

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { collect, commitsOn } from "./collector.mjs";
import { plan as makePlan, ONE_SHOT } from "./rules.mjs";
import { check, maxRisk, validateInput } from "./guard.mjs";
import { readConflict, build, pick, save, CHOICES } from "./conflicts.mjs";

const MAX_ROUNDS = 6;

// Run git, show its output live, and capture it for error explanations.
function runGit(args, cwd, onOutput) {
  return new Promise(resolve => {
    const child = spawn("git", args, {
      cwd,
      windowsHide: true,
      stdio: ["inherit", "pipe", "pipe"], // stdin inherited so credential prompts still work
      env: { ...process.env, GIT_EDITOR: "true", GIT_MERGE_AUTOEDIT: "no",
        // hide the scary-looking "LF will be replaced by CRLF" warning on Windows
        GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.safecrlf", GIT_CONFIG_VALUE_0: "false" }, // never open vim on her
    });
    let out = "";
    child.stdout.on("data", d => { out += d; onOutput ? onOutput(String(d)) : process.stdout.write(d); });
    child.stderr.on("data", d => { out += d; onOutput ? onOutput(String(d)) : process.stderr.write(d); });
    child.on("error", e => resolve({ code: -1, out: String(e.message) }));
    child.on("close", code => resolve({ code, out }));
  });
}

// Turn scary git errors into plain English.
export function explainError(out) {
  const o = out.toLowerCase();
  if (o.includes("conflict")) return "Git found a conflict: the same lines changed on both sides. Let's fix it together.";
  if (o.includes("could not resolve host") || o.includes("unable to access")) return "Couldn't reach GitHub. Check your internet connection and try again.";
  if (o.includes("authentication failed") || o.includes("permission denied") || o.includes("403"))
    return "GitHub didn't accept your login. You may need to sign in again or check that you have access to this repo.";
  if (o.includes("rejected") && (o.includes("fetch first") || o.includes("non-fast-forward")))
    return "The remote has new commits you don't have yet. Iche will pull them first.";
  if (o.includes("please commit your changes or stash them") || o.includes("would be overwritten"))
    return "Your unsaved changes touch the same files, so git stopped safely. Nothing was changed. Commit or stash them first.";
  if (o.includes("stale info") || (o.includes("rejected") && o.includes("lease")))
    return "Someone else pushed to your branch, so git refused to replace it. Nothing was overwritten. Get latest first.";
  if (o.includes("no local changes to save")) return "There was nothing to stash.";
  if (o.includes("not fully merged")) return "Git won't delete that branch because it has commits that aren't merged anywhere yet. Nothing was deleted, so nothing is lost.";
  if (o.includes("already exists")) return "A branch with that name already exists. Nothing was changed. Try another name.";
  if (o.includes("invalid reference") || o.includes("did not match any")) return "Git couldn't find that branch. Nothing was changed.";
  if (o.includes("nothing to commit")) return "There was nothing new to commit.";
  if (o.includes("divergent branches")) return "Your branch and the remote both changed. Iche will merge them.";
  return null;
}

// The files git lists under "...would be overwritten by checkout:"
export function clashFiles(out) {
  const files = [];
  let on = false;
  for (const line of String(out).split(/\r?\n/)) {
    if (/would be overwritten/i.test(line)) { on = true; continue; }
    if (!on) continue;
    if (/^\s+\S/.test(line) && !/^\s*(please|aborting)/i.test(line)) files.push(line.trim());
    else if (files.length) on = false;
  }
  return files;
}

const q = a => (/[\s"']/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
const show = args => "git " + args.map(q).join(" ");

function fill(args, values) {
  return args.map(a => a.replace(/^\{(\w+)\}$/, (_, k) => values[k] ?? a));
}

function hasMarkers(root, files) {
  return files.filter(f => {
    try { return /^(<{7}|>{7}|={7})( |$)/m.test(readFileSync(join(root, f), "utf8")); } catch { return false; }
  });
}

// Extra data some plans need after a choice (e.g. commits on the branch she picked).
async function enrich(state, intent, values, cwd) {
  if (intent === "cherry-pick" && values.from && !state.pickable) state.pickable = await commitsOn(cwd, values.from);
}

// Ask her to pick one option. She can answer with the option number, or (if typed) a name / hash.
// For stashes (byValue) a number means the stash's own #index, the one she sees on screen.
async function pickOne(needs, ui) {
  const opts = needs.options;
  for (let tries = 1; tries <= 3; tries++) {
    const a = ((await ui.ask(needs.prompt, { kind: "pick", name: needs.name, options: opts, typed: !!needs.typed, byValue: !!needs.byValue, note: needs.note, blocker: needs.blocker || null })) ?? "").trim();
    if (!a) return null;
    const low = a.toLowerCase().replace(/^#/, "");
    const hit = needs.byValue
      ? opts.find(o => o.value === low || (o.aliases || []).some(x => x.toLowerCase().replace(/^#/, "") === low))
      : /^\d+$/.test(a) && +a >= 1 && +a <= opts.length ? opts[+a - 1]
      : opts.find(o => o.value.toLowerCase() === a.toLowerCase() || (o.aliases || []).some(x => x.toLowerCase() === a.toLowerCase()));
    if (hit) return hit.value;
    ui.say(needs.byValue ? "Type the stash number (like 0) or its name." : `Please pick one of the ${opts.length} options${needs.typed ? " (number, or type its name)" : ""}.`, "warn");
  }
  return null;
}

/**
 * Run an intent end-to-end.
 * @param {object} o
 * @param {string} o.cwd
 * @param {string} o.intent          push | pull | save | resolve | force-push | status
 * @param {object} o.ui              { say(text, kind), ask(prompt) -> string, confirm(prompt, strict) -> bool, show(plan, state) }
 * @param {function} [o.explain]     async (plan, state) -> void   (Gemma hook, optional)
 * @param {boolean} [o.fetch=true]
 * @param {function} [o.onEvent]     telemetry hook (e.g. Sentry later)
 */
export async function run({ cwd, intent, ui, explain, fetch = true, onEvent = () => {}, values: preset = {} }) {
  const values = { ...preset };
  let mustFetch = false; // set when a push is rejected: the remote has news we must download
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const state = await collect({ cwd, fetch: fetch || mustFetch });
    mustFetch = false;
    await enrich(state, intent, values, cwd);
    let p = makePlan(state, intent, values);

    if (!state.ok || !state.isRepo) { ui.say(p.message || "Can't continue here.", "error"); return { ok: false, situation: p.situation }; }

    await ui.show(p, state, round);

    // The plan needs a choice from her first (commit or stash? which stash? how many commits?...)
    const shown = new Set(p.warnings);
    while (p.needs) {
      const v = await pickOne(p.needs, ui);
      if (v === null) { ui.say("Okay, stopped. Nothing was changed.", "info"); return { ok: false, stopped: true }; }
      values[p.needs.name] = v;
      onEvent({ type: "choice", name: p.needs.name, value: v });
      await enrich(state, intent, values, cwd);
      p = makePlan(state, intent, values);
      for (const w of p.warnings) if (!shown.has(w)) { shown.add(w); ui.say(w, "warn"); }
    }
    onEvent({ type: "plan", round, situation: p.situation, steps: p.steps.map(s => s.display) });
    if (explain) await explain(p, state);

    if (!p.steps.length) return { ok: true, situation: p.situation, state };

    let failed = false;
    for (const [i, s] of p.steps.entries()) {
      // Manual step (fix conflict markers in an editor)
      if (s.manual) {
        const files = state.conflicts.map(c => c.path);
        // Guided mode: show both versions side by side and let her pick. No markers.
        if (ui.showConflict) {
          ui.say(`Step ${i + 1}: ${s.display}`, "info");
          const labels = state.operation === "rebase"
            ? { mine: `the latest ${state.base || "main"}`, theirs: "your commit" } // git swaps sides during rebase
            : state.operation === "cherry-pick" ? { mine: "your branch", theirs: "the commit you're copying" }
            : !state.operation ? { mine: "the latest code", theirs: "your stashed work" } // stash pop
            : { mine: "your laptop", theirs: state.upstream || "the other branch" };
          const manual = [];
          for (const f of files) {
            const r = await guideFile(state.repoRoot, f, labels, ui, onEvent);
            if (r === "stop") { ui.say("No problem. Nothing else was changed. Run Ask Iche again when you're ready.", "info"); return { ok: false, stopped: true }; }
            if (r === "manual") manual.push(f);
          }
          if (!manual.length) continue;
          ui.say(`Okay, fix ${manual.join(", ")} in your editor. Look for the lines between <<<<<<< and >>>>>>>, keep what you want, and delete the marker lines.`, "info");
        }
        for (;;) {
          const go = await ui.confirm(`Step ${i + 1}: ${s.display}\n   Done fixing? `, false, { kind: "manual", index: i, files });
          if (!go) { ui.say("No problem. Nothing else was changed. Run Ask Iche again when you're ready.", "info"); return { ok: false, stopped: true }; }
          const left = hasMarkers(state.repoRoot, files);
          if (!left.length) break;
          ui.say(`Still see conflict markers (<<<<<<< / >>>>>>>) in: ${left.join(", ")}`, "warn");
        }
        continue;
      }

      // Fill {placeholders}
      if (s.input && values[s.input.name] === undefined) {
        for (let tries = 1; ; tries++) {
          const v = (await ui.ask(s.input.prompt, { kind: "input", name: s.input.name, index: i })) ?? "";
          const err = validateInput(s.input.name, v);
          if (!err) { values[s.input.name] = v.trim(); break; }
          ui.say(err, "warn");
          if (tries >= 3) { ui.say("Okay, stopped. Nothing else was changed.", "info"); return { ok: false, stopped: true }; }
        }
      }
      const args = fill(s.args, values);

      // Guard: final check right before running
      const g = check(args, { allowDangerous: !!s.dangerOk });
      const risk = maxRisk(s.risk, g.risk);
      onEvent({ type: "guard", cmd: args.join(" "), risk, allowed: g.allowed });
      if (!g.allowed) { ui.say(`Blocked: ${show(args)}\n   ${g.reason}`, "error"); return { ok: false, blocked: true }; }

      const strict = risk === "careful" || risk === "dangerous";
      const label = `Step ${i + 1}: ${show(args)}${s.note ? `  (${s.note})` : ""}`;
      const yes = risk === "safe" ? true : await ui.confirm(strict ? `${label}\n   ${g.reason || s.note || "Be careful with this one."}\n   Type "yes" to run: ` : `${label}\n   Run it? `, strict,
        { kind: "step", index: i, cmd: show(args), risk, strict, note: s.note, warning: strict ? (g.reason || s.note || "Be careful with this one.") : null });
      if (!yes) {
        ui.say("Okay, stopped. Nothing else was changed.", "info");
        if (values.stashed && !values.popped) ui.say(`Your unsaved work is safe in the stash "${values.stashName}". Use "Bring back stashed work" (ask-iche pop) to get it back.`, "warn");
        return { ok: false, stopped: true };
      }

      const t0 = Date.now();
      ui.running?.({ index: i, cmd: show(args) });
      const r = await runGit(args, cwd, ui.output);
      onEvent({ type: "exec", cmd: args.join(" "), code: r.code, ms: Date.now() - t0 });
      if (s.mark && (r.code === 0 || /conflict/i.test(r.out))) values[s.mark] = true; // remember what already happened
      if (r.code !== 0) {
        const friendly = explainError(r.out);
        ui.say(friendly || "That command didn't work. Iche will check what happened.", "warn");
        failed = true;
        // Unsaved changes are in the way (switch / new branch): forget "take them with me" and ask again,
        // as a blocker card, instead of offering the same plan in a loop.
        if (/would be overwritten|please commit your changes or stash them/i.test(r.out)) {
          if (values.clash && values.keepWork !== "carry") { ui.say("Git still won't do it because of your unsaved changes. Nothing was changed. Try Commit, or message Iche (the human one 😄).", "warn"); return { ok: false, blockedByChanges: true }; }
          values.clash = { files: clashFiles(r.out), cmd: show(args) };
          delete values.keepWork;
        }
        if (/rejected|fetch first|non-fast-forward/i.test(r.out)) mustFetch = true;
        break; // re-collect and re-plan (e.g. pull hit a conflict -> conflict flow)
      }
      ui.say("✓ done", "ok");
    }

    if (!failed && !p.thenRetry) {
      const after = await collect({ cwd, fetch: false });
      const again = makePlan(after, intent);
      if (!again.steps.length || ONE_SHOT.has(intent)) {
        ui.say("All done! 🎉", "ok");
        return { ok: true, situation: p.situation, state: after };
      }
    }
    // otherwise loop: re-collect, re-plan, continue
  }
  ui.say("This is taking more rounds than expected. Time to message Iche (the human one 😄).", "warn");
  return { ok: false, tooManyRounds: true };
}

// One file, guided: each conflict -> her choice -> preview -> save.
async function guideFile(repoRoot, file, labels, ui, onEvent) {
  const r = readConflict(repoRoot, file);
  if (r.unsupported) {
    const why = { binary: "it isn't a text file", "deleted-mine": "you deleted it but the other side changed it",
      "deleted-theirs": "the other side deleted it but you changed it" }[r.unsupported] || "it's an unusual kind of conflict";
    ui.say(`I can't show ${file} side by side, because ${why}.`, "warn");
    return "manual";
  }
  if (!r.conflicts.length) return "done";
  const keys = Object.keys(CHOICES), choices = [];
  // Identical on both sides (only line endings or spaces differ): nothing to choose.
  if (r.conflicts.every(c => c.identical)) {
    const backup = save(repoRoot, file, build(r.pieces, r.conflicts.map(() => "mine")));
    ui.say(`✓ Both versions of ${file} are the same (only invisible line endings or spaces differed), so Iche kept it as it is. Nothing to choose. (Old copy backed up in ${relative(repoRoot, backup).replace(/\\/g, "/")})`, "ok");
    onEvent({ type: "conflict-choice", file, choice: "identical" });
    return "done";
  }
  for (const [k, c] of r.conflicts.entries()) {
    if (c.identical) { choices.push("mine"); continue; } // same on both sides, skip
    await ui.showConflict({ file, conflict: c, index: k, total: r.conflicts.length, labels });
    for (let tries = 1; ; tries++) {
      const a = ((await ui.ask(`Your choice (1-${keys.length + 1}):`, { kind: "choice", file, index: k })) ?? "").trim();
      const n = Number(a);
      if (n >= 1 && n <= keys.length) { choices.push(keys[n - 1]); onEvent({ type: "conflict-choice", file, choice: keys[n - 1] }); break; }
      if (n === keys.length + 1) return "manual";
      if (!a || tries >= 3) return "stop";
      ui.say(`Please type a number from 1 to ${keys.length + 1}.`, "warn");
    }
  }
  await ui.showResolved?.({ file, conflicts: r.conflicts, picked: r.conflicts.map((c, k) => pick(c, choices[k])), choices });
  if (!(await ui.confirm(`Save ${file} like this? `, false, { kind: "save", file }))) return "stop";
  const backup = save(repoRoot, file, build(r.pieces, choices));
  ui.say(`✓ Saved ${file}. (Your old copy is backed up in ${relative(repoRoot, backup).replace(/\\/g, "/")})`, "ok");
  if (choices.some(c => c.startsWith("both")) && /\.(js|mjs|ts|dart|json|cs|py|java|kt|go)$/.test(file))
    ui.say("You kept both versions in a code file. Quickly check it still makes sense (no duplicate method or variable) before pushing.", "warn");
  return "done";
}
