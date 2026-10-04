// gemma.mjs — the "nurse". Gemma (via Ollama) only EXPLAINS steps the rules engine chose,
// and helps understand what she typed. If Ollama isn't running, Ask Iche still works
// with built-in explanations.

export const MODEL = process.env.ASK_ICHE_MODEL || "gemma3:4b";
const HOST = (process.env.OLLAMA_HOST || "http://localhost:11434").replace(/\/$/, "");

// ---------- built-in explanations (fallback + safety net) ----------
export const CANNED = {
  stage: "Picks the changed files to include in your next save (commit).",
  commit: "Saves a snapshot of your work with a short note about what changed.",
  pull: "Downloads the new commits from the remote and merges them into your branch.",
  push: "Uploads your commits to the remote so others can see them.",
  "push-new-branch": "Uploads your branch to the remote for the first time and links them, so next time plain push works.",
  "edit-conflicts": "Ask Iche shows you both versions side by side, and you pick which one to keep. No scary markers.",
  "mark-resolved": "Tells git you've finished fixing the conflict in these files.",
  "finish-merge": "Completes the merge with git's default message.",
  "continue-rebase": "Continues the rebase now that the conflict is fixed.",
  "continue-op": "Continues the operation now that the conflict is fixed.",
  "create-branch": "Creates a new branch right here so your work has a safe home.",
  "add-remote": "Connects this folder to your repo on GitHub.",
  "set-name": "Tells git the name to put on your commits.",
  "set-email": "Tells git the email to put on your commits.",
};

function fallbackSummary(plan) {
  const s = {
    "behind-and-ahead": "The remote has new commits you don't have yet, so git won't accept your push until you bring them in first.",
    behind: "The remote has new commits you don't have yet.",
    "behind-with-changes": "There are new commits on the remote, and you have unsaved work. Save it first, then pull.",
    "uncommitted-changes": "You have changes that aren't saved in a commit yet.",
    "new-branch": "This branch only exists on your laptop so far.",
    "ready-to-push": "You have commits ready to upload.",
    conflict: "Git couldn't combine two versions of the same lines, so it needs you to choose.",
    "detached-head": "You're not on a branch right now, so new work could get lost.",
    "no-identity": "Git needs your name and email before it can save commits.",
    "no-remote": "This folder isn't connected to GitHub yet.",
    "force-push-refused": "Force push can delete other people's work, so here's the safe way instead.",
    "up-to-date": "You're already up to date. Nothing to pull.",
    "nothing-to-push": "Nothing to push, you're already in sync.",
    "nothing-to-save": "There's nothing new to save.",
  };
  return s[plan.situation] || "Here's where your repo is right now.";
}

// ---------- Ollama plumbing ----------
export async function isAvailable() {
  try {
    const r = await fetch(`${HOST}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return { up: false };
    const { models = [] } = await r.json();
    const has = models.some(m => m.name === MODEL || m.model === MODEL || m.name === `${MODEL}:latest`);
    return { up: true, hasModel: has };
  } catch { return { up: false }; }
}

// Load the model in the background so she doesn't wait for it later.
export function warmup() {
  fetch(`${HOST}/api/generate`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, keep_alive: "30m" }),
  }).catch(() => {});
}

async function chatStream(messages, { onToken, options = {}, format } = {}) {
  const t0 = Date.now();
  const res = await fetch(`${HOST}/api/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL, messages, stream: true, keep_alive: "30m",
      ...(format ? { format } : {}),
      options: { temperature: 0.3, num_predict: 300, ...options },
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`Ollama error ${res.status}`);
  let text = "", buf = "", stats = {}, firstTokenMs = null;
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      const j = JSON.parse(line);
      const tok = j.message?.content || "";
      if (tok) { if (firstTokenMs === null) firstTokenMs = Date.now() - t0; text += tok; onToken?.(tok); }
      if (j.done) stats = { totalMs: Date.now() - t0, firstTokenMs, evalCount: j.eval_count, loadMs: Math.round((j.load_duration || 0) / 1e6) };
    }
  }
  return { text, stats };
}

// ---------- 1) Explain a plan (streams line by line) ----------
const EXPLAIN_SYSTEM = `You are "Ask Iche", a friendly git mentor helping a beginner with her own repo.
You receive FACTS about her repo and STEPS that are already correct.

Rules:
- Speak directly to her as "you". Never say "she" or "her".
- Do NOT change, add, remove, or reorder the steps. Never suggest other commands.
- Give exactly one reason per step, in the same order, describing what THAT step does.
- If FACTS say she is BEHIND, say clearly in the summary that she is behind and by how many commits.
- "git pull" downloads new commits AND merges them. Never call it "fetch".
- "git pull" may STOP with a conflict if both sides changed the same lines. It never fixes conflicts itself.
- Never mention <<<<<<<, =======, or >>>>>>> markers. Ask Iche shows conflicts as simple side-by-side choices.
- Conflicts are normal and nothing is lost. Never tell her to "check for conflicts before pulling".
- "git add" stages files for the next commit. "git commit" saves them as a snapshot. "git push" uploads commits.
- Only mention files, branches, and numbers that appear in FACTS. Never invent any.
- Short, simple, encouraging sentences. One line each.

Reply in EXACTLY this format, nothing else:
SUMMARY: <1-2 sentences on what is going on and why>
1: <reason for step 1>
2: <reason for step 2>
(one numbered line per step)
TIP: <one short learning tip>`;

const STATUS_SYSTEM = `You are "Ask Iche", a friendly git mentor. Speak to her as "you".
Using ONLY the FACTS, explain where her repo is in 1-2 short sentences, then give one tip.
Never suggest commands. Never invent files, branches, or numbers.
Reply in EXACTLY this format:
SUMMARY: <1-2 sentences>
TIP: <one short tip>`;

/**
 * @param {object} plan   from rules.plan()
 * @param {string[]} facts from collector.toFacts()
 * @param {object} cb     { onSummary(text), onReason(index, text), onTip(text) } — called as lines arrive
 * @returns {{ ai: boolean, summary, reasons: string[], tip, stats?, fellBack?: string }}
 */
export async function explainPlan(plan, facts, cb = {}, { offline = false } = {}) {
  const steps = plan.steps;
  const canned = () => ({
    summary: fallbackSummary(plan),
    reasons: steps.map(s => CANNED[s.why] || s.display),
    tip: null,
  });
  if (offline) {
    const c = canned();
    cb.onSummary?.(c.summary);
    c.reasons.forEach((r, i) => cb.onReason?.(i, r));
    return { ai: false, ...c };
  }

  const user = `FACTS:\n- ${facts.join("\n- ")}\n${plan.warnings.length ? `WARNINGS:\n- ${plan.warnings.join("\n- ")}\n` : ""}SITUATION: ${plan.situation}\n` +
    (steps.length ? `STEPS:\n${steps.map((s, i) => `${i + 1}. ${s.display}`).join("\n")}` : "STEPS: none");

  const seen = { summary: null, reasons: [], tip: null };
  let partial = "";
  const handleLine = line => {
    const m = line.match(/^\s*(SUMMARY|TIP|\d+)\s*[:.)-]\s*(.+)$/i);
    if (!m) return;
    const key = m[1].toUpperCase(), val = m[2].trim();
    if (key === "SUMMARY" && !seen.summary) { seen.summary = val; cb.onSummary?.(val); }
    else if (key === "TIP" && !seen.tip) { seen.tip = val; cb.onTip?.(val); }
    else if (/^\d+$/.test(key)) {
      const i = +key - 1;
      if (i === seen.reasons.length && i < steps.length) { seen.reasons.push(val); cb.onReason?.(i, val); }
    }
  };

  try {
    const { stats } = await chatStream(
      [{ role: "system", content: steps.length ? EXPLAIN_SYSTEM : STATUS_SYSTEM }, { role: "user", content: user }],
      { onToken: t => { partial += t; let nl; while ((nl = partial.indexOf("\n")) >= 0) { handleLine(partial.slice(0, nl)); partial = partial.slice(nl + 1); } } }
    );
    if (partial) handleLine(partial);

    // Safety net: anything missing or broken gets the built-in text
    const c = canned();
    let fellBack = null;
    if (!seen.summary) { seen.summary = c.summary; cb.onSummary?.(c.summary); fellBack = "summary"; }
    for (let i = seen.reasons.length; i < steps.length; i++) { cb.onReason?.(i, c.reasons[i]); seen.reasons.push(c.reasons[i]); fellBack = fellBack || "reasons"; }
    return { ai: true, ...seen, stats, fellBack };
  } catch (e) {
    const c = canned();
    cb.onSummary?.(c.summary);
    c.reasons.forEach((r, i) => cb.onReason?.(i, r));
    return { ai: false, ...c, error: e.message };
  }
}

// ---------- 2) Understand what she typed ----------
const KEYWORDS = [
  ["force-push", /\bforce\b/i],
  ["resolve", /conflict|<<<<<<<|resolve|merge (error|fail|problem)/i],
  ["push", /\bpush|upload|send (my|it|the)|rejected|share my (work|code)/i],
  ["pull", /\bpull|update my|get (the )?(latest|new|their|her|his)|download|sync with/i],
  ["save", /\bcommit|save my|save (the|these) changes|snapshot/i],
  ["status", /status|where am i|what('?s| is) (going on|happening)|which branch|state of|confused|lost/i],
];

export async function detectIntent(text) {
  for (const [intent, re] of KEYWORDS) if (re.test(text)) return { intent, by: "keywords" };
  // Ambiguous: ask Gemma, but force the answer into the allowed list
  try {
    const { text: out } = await chatStream([
      { role: "system", content: "Classify the user's git request. Reply with JSON only." },
      { role: "user", content: `Request: "${text}"\nChoose one intent: status (wants to know what's going on), save (commit work), push (upload work), pull (get latest changes), resolve (fix a conflict), unknown.` },
    ], {
      format: { type: "object", properties: { intent: { type: "string", enum: ["status", "save", "push", "pull", "resolve", "unknown"] } }, required: ["intent"] },
      options: { temperature: 0, num_predict: 20 },
    });
    const intent = JSON.parse(out).intent;
    return { intent: intent === "unknown" ? null : intent, by: "gemma" };
  } catch {
    return { intent: null, by: "none" };
  }
}

// ---------------------------------------------------------------------------
// Conflict helper: Gemma describes, in plain English, what each side changed.
// It only DESCRIBES. It never picks for her and never writes the merged code.
const CONFLICT_SYSTEM = `You are "Ask Iche", a calm, friendly git mentor. Speak to her as "you".
Two people changed the same lines of a file. You get ORIGINAL, YOURS and THEIRS.
Describe in plain English what each side changed compared to ORIGINAL. Start the YOU line with "You" (never "I") and the THEM line with "They". Be specific (name the method, value or text).
Do not pick a winner. Do not write code. Do not mention git markers. Keep each line short.
Reply in EXACTLY this format:
YOU: <what you changed>
THEM: <what they changed>
NOTE: <one calm sentence on what to think about when choosing, e.g. if keeping both would duplicate something>`;

const cap = (s, n = 40) => { const l = (s || "").split("\n"); return l.length > n ? l.slice(0, n).join("\n") + "\n...(cut)" : s || "(empty)"; };

export async function explainConflict(file, c, cb = {}) {
  const user = `FILE: ${file}\nORIGINAL:\n${cap(c.base)}\nYOURS:\n${cap(c.mine)}\nTHEIRS:\n${cap(c.theirs)}`;
  const seen = {};
  const handle = line => {
    const m = line.replace(/\*\*/g, "").match(/^\s*(YOU|THEM|NOTE)\s*:\s*(.+)$/i);
    if (!m) return;
    const k = m[1].toLowerCase(); if (seen[k]) return;
    let t = m[2].trim();
    if (k === "you") t = t.replace(/^I\b/, "You").replace(/^I've\b/, "You've").replace(/^I'm\b/, "You're"); // Gemma sometimes speaks as her
    seen[k] = t; cb.onLine?.(k, t);
  };
  let partial = "";
  try {
    const { stats } = await chatStream(
      [{ role: "system", content: CONFLICT_SYSTEM }, { role: "user", content: user }],
      { options: { num_predict: 160 }, onToken: t => { partial += t; let nl; while ((nl = partial.indexOf("\n")) >= 0) { handle(partial.slice(0, nl)); partial = partial.slice(nl + 1); } } });
    if (partial) handle(partial);
    return { ok: true, ...seen, stats };
  } catch (e) { return { ok: false, error: e.message }; }
}
