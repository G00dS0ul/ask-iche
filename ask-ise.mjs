#!/usr/bin/env node
// ask-ise.mjs — the CLI.
//   node ask-ise.mjs push [repo]                    (a command)
//   node ask-ise.mjs "my push got rejected" [repo]  (plain English)
// Flags: --no-ai (built-in explanations only), --no-fetch

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { existsSync } from "node:fs";
import { run } from "./runner.mjs";
import { toFacts } from "./collector.mjs";
import { INTENTS } from "./rules.mjs";
import { MODEL, isAvailable, warmup, explainPlan, detectIntent, explainConflict } from "./gemma.mjs";
import { CHOICES } from "./conflicts.mjs";

const c = { dim: s => `\x1b[2m${s}\x1b[0m`, bold: s => `\x1b[1m${s}\x1b[0m`, green: s => `\x1b[32m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`, red: s => `\x1b[31m${s}\x1b[0m`, cyan: s => `\x1b[36m${s}\x1b[0m`, magenta: s => `\x1b[35m${s}\x1b[0m` };
const riskTag = { safe: c.green("[safe]"), normal: c.cyan("[confirm]"), careful: c.yellow("[careful]"), dangerous: c.red("[DANGER]") };

const flags = new Set(process.argv.slice(2).filter(a => a.startsWith("--")));
const args = process.argv.slice(2).filter(a => !a.startsWith("--"));
const useAI = !flags.has("--no-ai");

// Last argument is the repo path if it exists as a folder
let cwd = process.cwd();
if (args.length > 1 && existsSync(args[args.length - 1])) cwd = args.pop();
const said = args.join(" ").trim() || "status";

// Start loading Gemma right away (in parallel with everything else)
const ai = useAI ? await isAvailable() : { up: false };
if (ai.up && ai.hasModel) warmup();

const rl = createInterface({ input: stdin, terminal: false });
// Answers are queued line by line. If input ends (Ctrl+D or piped input runs out),
// every later answer counts as "no", so nothing runs by accident.
const lines = [], waiting = [];
let inputClosed = false;
rl.on("line", l => waiting.length ? waiting.shift()(l) : lines.push(l));
rl.on("close", () => { inputClosed = true; while (waiting.length) waiting.shift()(null); });
async function question(q) {
  stdout.write(q);
  const a = lines.length ? lines.shift() : inputClosed ? null : await new Promise(r => waiting.push(r));
  if (a === null) { console.log(c.dim("(no answer, so: no)")); return ""; }
  if (!stdin.isTTY) console.log(a); // echo piped answers so the transcript reads right
  return a;
}

// ----- work out the intent -----
const ALIASES = { sync: "push", upload: "push", update: "pull", download: "pull", commit: "save",
  fix: "resolve", conflict: "resolve", where: "status", check: "status", force: "force-push" };
let intent = ALIASES[said.toLowerCase()] || (INTENTS.includes(said.toLowerCase()) ? said.toLowerCase() : null);

if (!intent) {
  if (["revert", "undo", "reset"].includes(said.toLowerCase())) {
    console.log(c.yellow(`Undoing commits is risky, so Ask Ise doesn't do it yet. Ask the real Ise for this one. 😅`));
    rl.close(); process.exit(1);
  }
  const d = ai.up && ai.hasModel ? await detectIntent(said) : await detectIntent(said).catch(() => ({ intent: null }));
  if (!d.intent) {
    console.log(c.yellow(`I'm not sure what you want to do with "${said}".`) + " Nothing was changed.");
    console.log("Try: " + ["status", "save", "push", "pull", "resolve"].map(c.bold).join(", ") + c.dim(`  or describe it, e.g. "my push got rejected"`));
    rl.close(); process.exit(1);
  }
  const words = { status: "check where you are", save: "save (commit) your work", push: "push your work", pull: "get the latest changes", resolve: "fix a conflict", "force-push": "force push" };
  const ok = (await question(`Sounds like you want to ${c.bold(words[d.intent])}. Right? ${c.dim("[Y/n] ")}`)).trim().toLowerCase();
  if (ok === "n" || ok === "no" || (ok === "" && inputClosed)) { console.log("Okay! Try saying it another way, or use: status, save, push, pull, resolve."); rl.close(); process.exit(1); }
  intent = d.intent;
}

if (!useAI) console.log(c.dim("(AI is off (--no-ai), so using built-in explanations.)"));
else if (!(ai.up && ai.hasModel))
  console.log(c.dim(ai.up ? `(Model ${MODEL} isn't downloaded. Run: ollama pull ${MODEL}. Using built-in explanations.)`
                          : "(Ollama isn't running, so using built-in explanations. Start the Ollama app for friendlier ones.)"));

// ----- UI -----
function block(text, color, max = 15) {
  const lines = text.replace(/\r?\n$/, "").split(/\r?\n/);
  if (!text) { console.log(c.dim("    │ (nothing, this part was removed)")); return; }
  lines.slice(0, max).forEach(l => console.log(color("    │ " + l)));
  if (lines.length > max) console.log(c.dim(`    │ …(+${lines.length - max} more lines)`));
}
const ui = {
  say: (t, kind) => console.log(({ ok: c.green, warn: c.yellow, error: c.red, info: c.dim })[kind]?.(t) ?? t),
  ask: async q => question(c.bold(q) + " "),
  confirm: async (q, strict) => {
    for (let tries = 1; ; tries++) {
      const a = (await question(q + (strict ? "" : c.dim("[y/N] ")))).trim().toLowerCase();
      if (strict) return a === "yes";
      if (["y", "yes"].includes(a)) return true;
      if (["", "n", "no"].includes(a) || (inputClosed && !lines.length) || tries >= 3) return false;
      console.log(c.yellow(`   "${a}" isn't y or n. Type y to run it, or n to stop.`)); // a typo shouldn't stop everything
    }
  },
  showConflict: async ({ file, conflict: k, index, total, labels }) => {
    console.log("\n" + c.bold(`── Conflict ${index + 1} of ${total} in ${file} (around line ${k.line}) ──`));
    if (k.base.trim()) { console.log(c.dim("  Before anyone changed it:")); block(k.base, c.dim); }
    console.log(c.green(`  ① Yours (${labels.mine}):`)); block(k.mine, c.green);
    console.log(c.cyan(`  ② Theirs (${labels.theirs}):`)); block(k.theirs, c.cyan);
    if (ai.up && ai.hasModel) {
      process.stdout.write(c.dim(`\n  Ask Ise is reading both versions… (${MODEL})`));
      let first = true;
      const r = await explainConflict(file, k, { onLine: (key, t) => {
        if (first) { process.stdout.write("\r\x1b[K"); first = false; }
        console.log((key === "you" ? c.magenta("💬 ") + c.green("You: ") : key === "them" ? "   " + c.cyan("Them: ") : "   " + c.dim("Note: ")) + t);
      } });
      if (first) process.stdout.write("\r\x1b[K");
      if (r.stats && flags.has("--stats")) console.log(c.dim(`   [${MODEL}: first words ${(r.stats.firstTokenMs / 1000).toFixed(1)}s, total ${(r.stats.totalMs / 1000).toFixed(1)}s]`));
    }
    console.log("\nWhat do you want to keep?");
    Object.values(CHOICES).forEach((t, n) => console.log(`  ${n + 1}) ${t}`));
    console.log(`  ${Object.keys(CHOICES).length + 1}) I'll fix it myself in my editor`);
  },
  showResolved: async ({ file, picked }) => {
    console.log("\n" + c.bold(`Here's how ${file} will look in ${picked.length > 1 ? "those spots" : "that spot"}:`));
    picked.forEach(t => block(t, s => s));
  },
  show: async (p, st, round) => {
    console.log("\n" + c.bold(round === 1 ? "Here's where you are:" : "Checking again..."));
    toFacts(st).forEach(f => console.log(c.dim("  • " + f)));
    p.warnings.forEach(w => console.log(c.yellow("⚠️  " + w)));
  },
};

async function explain(p, st) {
  const facts = toFacts(st);
  if (!p.steps.length && !(ai.up && ai.hasModel)) { console.log(c.green("\nNothing to do. You're all set ✓\n")); return; }
  if (ai.up && ai.hasModel) process.stdout.write(c.dim(`\n  Ask Ise is thinking… (${MODEL}, on your laptop)`));
  let cleared = false;
  const clear = () => { if (!cleared && ai.up && ai.hasModel) { process.stdout.write("\r\x1b[K"); cleared = true; } };
  const r = await explainPlan(p, facts, {
    onSummary: t => { clear(); console.log("\n" + c.magenta("💬 ") + t); if (p.steps.length) console.log(c.bold("\nThe plan:")); },
    onReason: (i, t) => { clear(); const s = p.steps[i]; console.log(`  ${i + 1}. ${riskTag[s.risk] || ""} ${c.bold(s.display)}\n     ${c.dim(t)}`); },
    onTip: t => { clear(); console.log(c.cyan("\n💡 " + t)); },
  }, { offline: !(ai.up && ai.hasModel) });
  if (r.stats && flags.has("--stats")) console.log(c.dim(`   [${MODEL}: first words ${(r.stats.firstTokenMs / 1000).toFixed(1)}s, total ${(r.stats.totalMs / 1000).toFixed(1)}s${r.fellBack ? `, filled ${r.fellBack} from built-in` : ""}]`));
  if (!p.steps.length) console.log(c.green("\nNothing to do. You're all set ✓"));
  console.log();
}

const result = await run({ cwd, intent, ui, explain, fetch: !flags.has("--no-fetch") });
rl.close();
process.exit(result.ok ? 0 : 1);
