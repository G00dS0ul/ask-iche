// runner.mjs — runs a plan ONE step at a time, with her confirmation,
// then re-checks the repo and keeps going until she's done (or stops).

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { collect } from "./collector.mjs";
import { plan as makePlan } from "./rules.mjs";
import { check, maxRisk, validateInput } from "./guard.mjs";
import { readConflict, build, pick, save, CHOICES } from "./conflicts.mjs";

const MAX_ROUNDS = 6;

// Run git, show its output live, and capture it for error explanations.
function runGit(args, cwd) {
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
    child.stdout.on("data", d => { out += d; process.stdout.write(d); });
    child.stderr.on("data", d => { out += d; process.stderr.write(d); });
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
    return "The remote has new commits you don't have yet. Ask Ise will pull them first.";
  if (o.includes("please commit your changes or stash them")) return "Your unsaved changes are in the way. Ask Ise will save them first.";
  if (o.includes("nothing to commit")) return "There was nothing new to commit.";
  if (o.includes("divergent branches")) return "Your branch and the remote both changed. Ask Ise will merge them.";
  return null;
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
export async function run({ cwd, intent, ui, explain, fetch = true, onEvent = () => {} }) {
  const values = {};
  let mustFetch = false; // set when a push is rejected: the remote has news we must download
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const state = await collect({ cwd, fetch: fetch || mustFetch });
    mustFetch = false;
    const p = makePlan(state, intent);
    onEvent({ type: "plan", round, situation: p.situation, steps: p.steps.map(s => s.display) });

    if (!state.ok || !state.isRepo) { ui.say(p.message || "Can't continue here.", "error"); return { ok: false, situation: p.situation }; }

    await ui.show(p, state, round);
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
            ? { mine: "the branch you're rebasing onto", theirs: "your commit" } // git swaps sides during rebase
            : { mine: "your laptop", theirs: state.upstream || "the other branch" };
          const manual = [];
          for (const f of files) {
            const r = await guideFile(state.repoRoot, f, labels, ui, onEvent);
            if (r === "stop") { ui.say("No problem. Nothing else was changed. Run Ask Ise again when you're ready.", "info"); return { ok: false, stopped: true }; }
            if (r === "manual") manual.push(f);
          }
          if (!manual.length) continue;
          ui.say(`Okay, fix ${manual.join(", ")} in your editor. Look for the lines between <<<<<<< and >>>>>>>, keep what you want, and delete the marker lines.`, "info");
        }
        for (;;) {
          const go = await ui.confirm(`Step ${i + 1}: ${s.display}\n   Done fixing? `, false);
          if (!go) { ui.say("No problem. Nothing else was changed. Run Ask Ise again when you're ready.", "info"); return { ok: false, stopped: true }; }
          const left = hasMarkers(state.repoRoot, files);
          if (!left.length) break;
          ui.say(`Still see conflict markers (<<<<<<< / >>>>>>>) in: ${left.join(", ")}`, "warn");
        }
        continue;
      }

      // Fill {placeholders}
      if (s.input && values[s.input.name] === undefined) {
        for (let tries = 1; ; tries++) {
          const v = (await ui.ask(s.input.prompt)) ?? "";
          const err = validateInput(s.input.name, v);
          if (!err) { values[s.input.name] = v.trim(); break; }
          ui.say(err, "warn");
          if (tries >= 3) { ui.say("Okay, stopped. Nothing else was changed.", "info"); return { ok: false, stopped: true }; }
        }
      }
      const args = fill(s.args, values);

      // Guard: final check right before running
      const g = check(args);
      const risk = maxRisk(s.risk, g.risk);
      onEvent({ type: "guard", cmd: args.join(" "), risk, allowed: g.allowed });
      if (!g.allowed) { ui.say(`Blocked: ${show(args)}\n   ${g.reason}`, "error"); return { ok: false, blocked: true }; }

      const strict = risk === "careful" || risk === "dangerous";
      const label = `Step ${i + 1}: ${show(args)}${s.note ? `  (${s.note})` : ""}`;
      const yes = risk === "safe" ? true : await ui.confirm(strict ? `${label}\n   ${g.reason || s.note || "Be careful with this one."}\n   Type "yes" to run: ` : `${label}\n   Run it? `, strict);
      if (!yes) { ui.say("Okay, stopped. Nothing else was changed.", "info"); return { ok: false, stopped: true }; }

      const t0 = Date.now();
      const r = await runGit(args, cwd);
      onEvent({ type: "exec", cmd: args.join(" "), code: r.code, ms: Date.now() - t0 });
      if (r.code !== 0) {
        const friendly = explainError(r.out);
        ui.say(friendly || "That command didn't work. Ask Ise will check what happened.", "warn");
        failed = true;
        if (/rejected|fetch first|non-fast-forward/i.test(r.out)) mustFetch = true;
        break; // re-collect and re-plan (e.g. pull hit a conflict -> conflict flow)
      }
      ui.say("✓ done", "ok");
    }

    if (!failed && !p.thenRetry) {
      const after = await collect({ cwd, fetch: false });
      const again = makePlan(after, intent);
      if (!again.steps.length || intent === "save" || intent === "pull") {
        ui.say("All done! 🎉", "ok");
        return { ok: true, situation: p.situation, state: after };
      }
    }
    // otherwise loop: re-collect, re-plan, continue
  }
  ui.say("This is taking more rounds than expected. Time to ask the real Ise. 😅", "warn");
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
  for (const [k, c] of r.conflicts.entries()) {
    await ui.showConflict({ file, conflict: c, index: k, total: r.conflicts.length, labels });
    for (let tries = 1; ; tries++) {
      const a = ((await ui.ask(`Your choice (1-${keys.length + 1}):`)) ?? "").trim();
      const n = Number(a);
      if (n >= 1 && n <= keys.length) { choices.push(keys[n - 1]); onEvent({ type: "conflict-choice", file, choice: keys[n - 1] }); break; }
      if (n === keys.length + 1) return "manual";
      if (!a || tries >= 3) return "stop";
      ui.say(`Please type a number from 1 to ${keys.length + 1}.`, "warn");
    }
  }
  await ui.showResolved?.({ file, conflicts: r.conflicts, picked: r.conflicts.map((c, k) => pick(c, choices[k])), choices });
  if (!(await ui.confirm(`Save ${file} like this? `, false))) return "stop";
  const backup = save(repoRoot, file, build(r.pieces, choices));
  ui.say(`✓ Saved ${file}. (Your old copy is backed up in ${relative(repoRoot, backup).replace(/\\/g, "/")})`, "ok");
  if (choices.some(c => c.startsWith("both")) && /\.(js|mjs|ts|dart|json|cs|py|java|kt|go)$/.test(file))
    ui.say("You kept both versions in a code file. Quickly check it still makes sense (no duplicate method or variable) before pushing.", "warn");
  return "done";
}
