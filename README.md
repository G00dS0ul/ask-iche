# Ask Iche 🌿

**A local AI git buddy for beginners.** It reads your real repo, makes a safe plan, explains it in plain English with [Gemma](https://ai.google.dev/gemma), and runs each step only after you say yes.

I built it for my colleague of 6 months. She's a Flutter dev learning a Node.js backend, and git (push, pull, fetch, conflicts) is where she always gets stuck. Until now the fix was "ask Iche". Now she can ask *Ask Iche*. And her work repo never leaves her laptop.

> Built for the DEV Hacktoberfest Weekend Challenge: *Build for a Friend*.

## What it does

```bash
node ask-iche.mjs "my push got rejected" ~/projects/my-app
```

1. **Reads your repo** (read-only): branch, ahead/behind, unsaved files, conflicts.
2. **Makes a plan** with plain code, not AI: e.g. add → commit → pull → push.
3. **Gemma explains** what's going on and why each step is needed, streamed live word by word, on your laptop. The plan and its Run buttons show right away, so a slow CPU never makes you wait.
4. **Runs one step at a time**, only after you confirm.
5. **Re-checks after each step.** If a pull hits a conflict, it switches to the conflict helper.

### No scary conflict markers

You never see `<<<<<<<`, `=======` or `>>>>>>>`. Ask Iche shows each conflict side by side:

```
── Conflict 1 of 1 in api.js (around line 7) ──
  Before anyone changed it:
    │ return { ok: true, token: "demo-token" };
  ① Yours (your laptop):
    │ return { ok: true, token: "demo-token", expiresIn: 3600 };
  ② Theirs (origin/main):
    │ return { ok: true, token: createToken(email) };

💬 You: You added expiresIn: 3600 to the object.
   Them: They changed the return value to use createToken(email).

What do you want to keep?
  1) Keep mine   2) Keep theirs   3) Keep both (mine first)
  4) Keep both (theirs first)   5) I'll fix it myself in my editor
```

It previews the result, backs up the old file to `.git/ask-iche-backup/`, and the **code** rebuilds the file, not the AI.

### More git tools

| Button / command | What it does |
| --- | --- |
| 📦 **Stash my work** · `stash` | Puts unfinished work aside. You always give the stash a name, like a commit message. |
| 🗂️ **My stashes** · `stashes` | Shows your stash list: number, name, branch, and when. |
| 📤 **Bring back stashed work** · `pop` | Pops a stash. Pick it, or type its number (`0`) or its name (`login-form-wip`). |
| ⬇️ **Get latest** with unsaved work | Asks: **commit** it or **stash** it? Stash → named stash, pull, then pop it back on top. |
| ↩️ **Undo commits** · `undo` | Soft (keep changes staged), mixed (keep as unsaved edits) or hard (throw away). Only for commits not pushed yet. |
| 🧹 **Clean up for review** · `cleanup` | Rebases your branch on the latest `main`. Optionally squashes all your commits into one clean commit, then pushes with `--force-with-lease`. |
| 🍒 **Copy a commit** · `cherry-pick` | Pick a branch, pick a commit, and copy it onto your branch. |
| 🌿 **Branches** · `branch` | Switch, create (from here or the latest `main`), rename, or delete a branch. Unsaved work? It asks: stash, commit, or take it with you. If git refuses because they clash, a 🧱 card shows which files are in the way and offers stash or commit. Delete uses the safe `-d`, and old `backup/` copies can be cleaned up here too. Branches marked ☁️ are GitHub's copies: Ask Iche makes a safety copy on your laptop first, then deletes it on GitHub (type `yes`). `main`/`master`/`develop` are never deleted. |
| 📜 **History** · `log` | Commit history of your branch, GitHub's copy, or `main`: one line each, or detailed (author, time, files). |
| 🎓 **Learn mode** (app only) | A tiny 5-question git quiz tied to the buttons, with instant feedback and your best score saved. It never touches your repo. |

You can also type real git commands in the box: `git checkout main`, `git checkout -b feature/x`, `git branch -m new-name`, `git log --oneline origin/main`, `git push origin --delete old-branch`. Ask Iche turns them into the same guided steps.

If a stash pop, rebase or cherry-pick hits a conflict, the same side-by-side conflict helper takes over.

### Safety first

- **The code plans, the model teaches.** I benchmarked 3 open models on the same git problem. None planned correctly twice in a row, so a deterministic rules engine decides the steps and Gemma only explains them.
- **A guard checks every command** right before it runs. Unknown commands are blocked. Plain `--force` push, rewriting `main`/`master`/`develop`, and interactive rebase are **never** allowed.
- **Dangerous requests are a hard stop.** Type `git push --force`, `force push to main`, `git rebase -i`, `git clean -fd`, `git branch -D`, `git checkout .` or `git commit --amend` and Ask Iche refuses with a red "Blocked" card. It tells you the safe button to use instead, but there's nothing to click and nothing runs. `git push origin main` from your own branch is blocked too (use a Pull Request).
- **Risky steps only run when the plan asks for them**, and you must type `yes`: `reset --hard`, `rebase`, and `push --force-with-lease` (only on your own branch). A `backup/...` branch is made first, so you can always get your commits back.
- **Never opens vim.** Merges finish without dropping you into an editor.
- **Works without AI.** If Ollama isn't running, Ask Iche still works with built-in explanations.

## Setup

1. Install [Node.js 18+](https://nodejs.org) and [git](https://git-scm.com).
2. Install [Ollama](https://ollama.com/download), then pull Gemma:
   ```bash
   ollama pull gemma3:4b
   ```
3. Clone this repo:
   ```bash
   git clone https://github.com/G00dS0ul/ask-iche.git
   cd ask-iche
   ```
No `npm install` needed. There are no dependencies.

> **On Windows?** Use one git per folder: either Windows git or WSL git, not both. If you do mix them, run `git config core.autocrlf true` in that folder so line endings (CRLF vs LF) don't show up as fake changes or fake conflicts.

## Usage: the friendly app (recommended)

```bash
node app.mjs
```

Your browser opens **Ask Iche** at `http://127.0.0.1:4321`:

1. **Pick your project folder** with 📁 Browse (no typing paths).
2. **Click what you want:** Where am I? · Save my work · Upload my work · Get latest · Fix a conflict. Or type what happened, e.g. *"my push got rejected"*.
3. **Read the plan.** Gemma explains each step, and you click **▶ Run this step** one at a time.
4. **Conflicts** show up as two cards, *Yours* and *Theirs*, with buttons: Keep mine / Keep theirs / Keep both.
5. **Practice** with 🎓 Learn mode, a tiny quiz. Friendly bouncy animations and a little confetti when things work (turned off if your system asks for reduced motion).

It runs 100% on your laptop. The server only listens on `127.0.0.1`, and every request needs a secret token that's created fresh each time, so other websites can't talk to it.

Options: `node app.mjs --no-ai` (built-in explanations) · `--no-open` (don't open the browser) · `PORT=4322 node app.mjs`. Add `?stats` to the URL to see Gemma timings.

## Usage: the terminal (CLI)

```bash
node ask-iche.mjs status   [repo-path]       # where am I?
node ask-iche.mjs push     [repo-path]       # save + upload my work safely
node ask-iche.mjs pull     [repo-path]       # get the latest changes
node ask-iche.mjs save     [repo-path]       # commit my work
node ask-iche.mjs resolve  [repo-path]       # fix a conflict
node ask-iche.mjs stash    [repo-path]       # put unfinished work aside (named)
node ask-iche.mjs stashes  [repo-path]       # see the stash list
node ask-iche.mjs pop      [repo-path]       # bring a stash back (by number or name)
node ask-iche.mjs undo     [repo-path]       # undo commits: soft / mixed / hard
node ask-iche.mjs cleanup  [repo-path]       # rebase on main (+ squash) for review
node ask-iche.mjs cherry-pick [repo-path]    # copy one commit from another branch
node ask-iche.mjs branch   [repo-path]       # switch / create / rename / delete a branch
node ask-iche.mjs log      [repo-path]       # commit history (one line or detailed)
node ask-iche.mjs "git checkout main" [repo-path]   # real git commands work too
node ask-iche.mjs "my push got rejected" [repo-path]   # or just describe it
```

Flags:

| Flag | What it does |
| --- | --- |
| `--no-ai` | Use built-in explanations only (no Ollama needed) |
| `--no-fetch` | Don't check the remote first (faster, offline) |
| `--stats` | Show Gemma timings |

Use a different model: `ASK_ICHE_MODEL=qwen2.5-coder:3b node ask-iche.mjs status`

> 💡 Try it on a throwaway GitHub repo first. A *copied* folder still points at the real remote.

## How it works

```
Your message ─┐
              ▼
  [Collector]     read-only git commands → facts
              ▼
  [Rules engine]  facts + intent → exact steps (no AI)
              ▼
  [Gemma]         facts + steps → friendly explanation (streamed)
              ▼
  [Guard]         every command checked against an allowlist
              ▼
  [Runner]        confirm → run → re-check → repeat
```

| File | Job |
| --- | --- |
| `collector.mjs` | Reads repo state (`git status --porcelain=v2`) into facts |
| `rules.mjs` | Deterministic planner: state + intent → steps |
| `guard.mjs` | Blocks dangerous and unknown commands |
| `runner.mjs` | Runs steps with confirmation, re-plans after failures |
| `conflicts.mjs` | Side-by-side conflict helper (no markers) |
| `gemma.mjs` | Ollama client: streaming explanations + intent detection |
| `ask-iche.mjs` | The CLI |
| `app.mjs` + `app.html` | The friendly app: a local web UI on the same engine |

## Why local and open

- Her work repo stays on her laptop. Nothing is sent to a cloud API.
- It costs $0 to run and works offline.
- The model is one environment variable away from being swapped, so I could benchmark open models freely.

## Roadmap

- [x] A friendly web UI instead of the terminal (`node app.mjs`)
- [x] Stash (named), stash list, pop by number or name
- [x] Undo commits (soft / mixed / hard reset) with a backup branch
- [x] Clean up for review: rebase on main + optional squash
- [x] Copy a commit (cherry-pick)
- [x] Branches (switch / create / rename / delete) and History (git log)
- [ ] Revert for commits that are already pushed
- [x] Learn mode: a tiny git quiz
- [x] Delete branches on GitHub (with a laptop safety copy first)

## License

MIT
