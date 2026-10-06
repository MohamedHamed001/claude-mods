# claude-mods

Three plugins for [Claude Code](https://docs.claude.com/en/docs/claude-code) that draw inside
the app itself, in the terminal and in the desktop app's Code tab:

| Plugin | In one line |
|---|---|
| [**delegation**](#delegation) | Hand work to Codex, agy (Google Antigravity) or Claude subagents, only when it pays, and watch what it costs |
| [**focus**](#focus) | Keeps the one next action pinned above the prompt, with time on task, parked thoughts and today's wins |
| [**cache-status**](#cache-status) | Shows when this session's prompt cache goes cold, and what re-reading the conversation would cost |

Each plugin is independent: install one, two or all three.

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [delegation](#delegation)
- [focus](#focus)
- [cache-status](#cache-status)
- [Repository layout](#repository-layout)
- [Developing](#developing)
- [Troubleshooting](#troubleshooting)
- [Credits and licences](#credits-and-licences)

## Requirements

- **Claude Code 2.1.28x or newer.** The plugins use function hooks (TypeScript modules the app
  loads), which older versions do not run.
- **Windows, macOS or Linux.** Process handling is detected per session: PowerShell on Windows,
  `ps` and `pkill` elsewhere. Developed on Windows; macOS has not been tested yet.
- For **delegation** only, the workers you want to use:
  - [Node.js](https://nodejs.org) 18 or newer (the relay and Codex scripts are Node scripts).
  - Codex: `npm install -g @openai/codex`, then `codex login`.
  - agy: the Google Antigravity CLI, signed in by running `agy` once.
  - Claude subagents need nothing extra.

## Install

In any Claude Code session:

```
/plugin marketplace add MohamedHamed001/claude-mods
/plugin install delegation@hamed-mods
/plugin install focus@hamed-mods
/plugin install cache-status@hamed-mods
```

Then **start a new session**: a session reads its plugins once, when it starts.

Update later with:

```
/plugin marketplace update hamed-mods
```

Remove one with `/plugin`, then uninstall it.

---

## delegation

Everything for delegating coding work, in one plugin: worker skills, slash commands, a
delegation policy that is enforced, and a live view of running jobs and what they cost.

### Why it exists

Delegating feels cheaper than it is. A session carries a large context before any work, and
every main-model request re-reads it; briefing a worker, waiting for it and reviewing its work
add about as many requests as the delegation removes. A controlled test on real tasks of 1 to 6
files, each done three ways, found:

| Setup | Passed | Claude-side cost | Time |
|---|---|---|---|
| Opus alone | 3 of 3 | baseline | fastest |
| Opus + Sonnet subagent | 2 of 3 | about a third more | slower |
| Opus + Codex | 2 of 3 | about a tenth less | 2 to 3 times slower |

So the plugin's default is: **do the work yourself**, and delegate only when it pays.

### What you get

| Part | What it does |
|---|---|
| Policy | Added to every session's system prompt, so nobody has to copy rules into `CLAUDE.md`. Delegate only: large separable work with a check the worker can run; work that should move off the Claude limit (Codex); when you ask; read-only review; fast read-only exploration (agy). |
| Enforcement | A delegation whose brief names only one or two files is refused, and Claude is told to do it directly. Allowed anyway when you asked for delegation, or when it is read-only. |
| Plain words | Saying "delegate this", "hand this over" or naming a worker (Codex, agy, Sonnet) counts as asking, no slash command needed. |
| Band | One line above the prompt while a job runs, when it finishes, or when it has run for 15+ minutes, with a **Stop** button. |
| Pane | `Delegations` button or `/delegations`: jobs running now, every job this session with what it cost, today's totals across sessions, and the cost test's findings. |
| Skills | `codex-delegate`, `agy-delegate`, `claude-delegate`, `delegate-setup`, `gpt-5-4-prompting`, `codex-result-handling`. |

### Commands

| Command | What it does |
|---|---|
| `/delegate <task>` | Delegates the task if it is worth it under the policy; otherwise says why and does it directly |
| `/explore <question>` | Asks agy a fast, read-only question about the codebase; Claude spot-checks its file and line claims |
| `/delegate-setup` | Chooses which worker and model handles which kind of work (writes the lane map) |
| `/delegations` | Opens the pane |

And the same seven commands for each worker:

| Action | `/codex-…` | `/agy-…` |
|---|---|---|
| `rescue <task>` | Hands a task to Codex (may edit the workspace) | Hands a task to agy (runs with permissions skipped, see below) |
| `review` | Read-only review of your local changes | Read-only review of your local changes |
| `adversarial-review [focus]` | Review that challenges the design and its assumptions | Same, on agy's stronger model |
| `status` | Running and recent jobs | Running and recent jobs |
| `result [job-id]` | A finished job's full report | A finished job's report |
| `cancel [job-id]` | Stops a running job | Stops a running job |
| `setup` | Checks Node, Codex and its sign-in | Checks agy and its sign-in, lists default models |

Flags on rescue and the reviews: `--background` (run detached; check with `status`),
`--model <name>`, and for reviews `--base <ref>` (review a branch against a base instead of
the working tree). `/codex-setup --enable-review-gate` turns on Codex's optional stop-time
review gate (off by default).

`status`, `result`, `cancel` and `setup` answer at once without a Claude turn. Rescue and
the reviews hand Claude a prompt: it writes the brief, runs the worker, then reviews the
result itself.

### Which model a command uses

`--model` on the command wins; otherwise the command's lane in your lane map; otherwise:

| Command | Lane | Default model |
|---|---|---|
| `/codex-rescue` | `implement` | gpt-6-luna |
| `/codex-review` | `review` | gpt-6-luna |
| `/codex-adversarial-review` | `deep-review` | gpt-6.1-sol |
| `/agy-rescue` | `agy-implement` | gemini-3.8-flash-high |
| `/agy-review` | `agy-review` | gemini-3.8-flash-high |
| `/agy-adversarial-review` | `third-opinion` | gemini-3.1-pro-high |
| `/explore` | `research` | gemini-3.8-flash-medium |

Rule of thumb: the cheapest model that can do the job. Fast models for lookups, a mid model for
edits and reviews, the strongest only for design challenges.

### First run

1. Install the workers you want (see [Requirements](#requirements)).
2. Run `/codex-setup` and `/agy-setup` to check them.
3. Run `/delegate-setup` once to pick your lanes. The lane map is stored in
   `~/.config/delegate-skills/config.json` (or `$XDG_CONFIG_HOME/delegate-skills/`).

Without a lane map the commands use the defaults above.

### Things to know

- **agy and permissions.** agy runs headless and cannot ask for permission, so any action that
  needs approval is refused and the run fails. `/agy-rescue` therefore passes
  `--dangerously-skip-permissions`: agy can then do anything on your machine, not only in the
  repository. Running `/agy-rescue` is that approval. Reviews and `/explore` run in agy's
  read-only plan mode and are told not to run shell commands at all.
- **agy job files.** Each agy job keeps its files in `~/.claude/delegation/agy-jobs/<id>/`:
  `job.json`, `brief.md`, `diff.patch` (reviews), `result.json` and agy's logs.
- **Keep reviews small.** A fast model asked to review a large diff can explore the repository
  for a long time. Review a few files at a time; the relay stops a run at its timeout.
- **The official Codex plugin.** This plugin bundles it (see [Credits](#credits-and-licences)).
  If `codex@openai-codex` is installed as well, the bundled `/codex-*` commands step aside and
  point to its `/codex:*` ones; the policy and job tracking still apply to them.
- **Cost figures.** Claude subagents report tokens, so their cost is shown. Codex and agy report
  nothing to Claude, so they show as calls and time, with the Opus requests made while they ran.

### How it knows what is running

| Source | What it tells the plugin |
|---|---|
| The Agent tool call and `agent.spawn` | A Claude subagent started, its id and its real model |
| The subagent's own requests and `turn.complete` | What it cost and when it finished |
| A shell command running `<name>-delegate/scripts/relay.mjs --brief <file>` | A relay job (Codex, agy, Claude CLI); a background one counts as finished when its process is gone |
| A shell command running `codex-companion.mjs task\|review\|adversarial-review` | A Codex plugin job; a background one is followed through the job id it prints |
| Main-conversation requests while a job is open | What delegating cost on the Opus side |

---

## focus

Keeps the one next action in front of you. Built for the "I have ADHD" writing style, where
every reply ends with a `Next:` line.

**Band (one line above the prompt).**

| State | Line |
|---|---|
| Normal | `→ Next: run the tests  [Do it]  47m  ✓ 4  2 parked  [Focus]` |
| Back after 20+ minutes | `Away 2h. You were: fix the frontend start. Next: run the tests  [Do it]  [Focus]` |
| Reply had no `Next:` line | `No next action in the last reply  [Ask for one]  ...` |

**Pane (`Focus` button or `/focus-pane`).**

| Section | Shows | Comes from |
|---|---|---|
| Now | Task name, step N of M, next action, `Do it` and `Done` | Your first prompt of a task; Claude's task list when it keeps one |
| Time | Time on task, estimate given, over by, session length | A clock started by your prompt; the first "about N minutes" in a reply |
| Parked | Thoughts set aside, each with `Start` and `Drop` | `/park <thought>`; saved per project folder |
| Done today | What was finished, with times | Tasks Claude marked completed, or your press of `Done`; shared across sessions, reset daily |
| Where you left off | Time since last activity, an optional summary | `Refresh recap` asks the model once; nothing is sent unless you press it |

**Commands.** `/park <thought>` sets a thought aside without derailing the current task.
`/focus-pane` opens the pane.

`Do it`, `Ask for one` and `Start` send a message for you. Nothing else does.

---

## cache-status

One line above the prompt showing the prompt cache for the current session.

**What the prompt cache is.** Every message re-sends the whole conversation to the model. The
server keeps the already-processed conversation for a while, so the next message only pays a
small "read" price for it. If no request arrives before that timer runs out, the cache is
dropped ("cold") and the next message pays full price to process everything again. That is a
re-ingest. Every request restarts the timer.

**What you see.**

| State | Line |
|---|---|
| Turn running | `● cache in use · 186k context` |
| Warm | `● cache warm · ~42m left · 186k context` |
| Last 5 minutes | the same, with an amber dot |
| Cold | `○ cache cold · next message re-ingests about 186k tokens` |
| After a re-ingest | pop-up: `Cache was cold: re-ingested 186k tokens. 5h window 41% → 44% this turn.` |

Once it has seen enough of your turns, the warm and cold lines also show what a re-ingest would
cost: `re-ingest ≈ 3.0% of 5h`.

**What is exact and what is estimated.**

- Context size: exact, from the token counts of the last response.
- Whether a re-ingest happened: exact, seen after the fact (almost nothing was read from the
  cache).
- Time left: an estimate. The server never reports when the cache expires, so this is "last
  request + assumed lifetime". The lifetime starts at 1 hour (5 minutes if a usage window is
  used up, or whatever `promptCacheTtl` says in your settings) and is corrected by what later
  requests show.
- Share of the 5-hour window: an estimate learned from your own turns. It weighs tokens by the
  API price list's ratios (cache read 0.1, fresh input 1, cache write 1.25 or 2, output 5). How
  subscription limits really weigh them is not documented. Turns that are small, use a subagent
  or two models, or span a window reset are not used. The rate is the median of the last 40
  usable turns per model, shared across your sessions on one machine.

**Switch it off.** `/plugin` and disable `cache-status`. It listens to every model request, so
this is the first thing to try if replies ever stall after installing it.

---

## Repository layout

```
.claude-plugin/marketplace.json     the marketplace: lists the three plugins
plugins/
  <plugin>/
    .claude-plugin/plugin.json      name, version, description
    hooks/hooks.json                which module to load (delegation also: Codex's session hooks)
    hooks/logic.ts                  the rules, as plain functions
    hooks/register.tsx              the wiring: which app event calls which rule, and the drawing
    hooks/*.test.ts                 tests (claude plugin test)
    types/index.d.ts                the shape of the values the plugin stores
  delegation/
    skills/                         the worker skills, with NOTICE.md and their licence
    codex/                          the bundled Codex companion (Apache 2.0)
    agy/commands/                   the prompts behind /agy-rescue and the agy reviews
```

Each plugin keeps its rules in `logic.ts` (no app calls, easy to test) and its wiring in
`register.tsx`.

## Developing

Validate and test a plugin:

```
claude plugin validate plugins/delegation
claude plugin test plugins/delegation
```

Current results: cache-status 22 tests, focus 22, delegation 42, all passing.

To run your working copy instead of the installed version, list the plugin folders in
`CLAUDE_CODE_PLUGIN_DIRS` (separated by `;` on Windows, `:` elsewhere), for example in the `env`
block of `~/.claude/settings.json`, then start a new session. Open sessions reload a plugin
from such a folder when its files change.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| A command says no hook answered it | The session started before the plugin was installed or updated: start a new session |
| Bands overlap or one hides another | Another plugin draws above the prompt without keeping what is beneath it |
| `/codex-*` says to use `/codex:*` | The official Codex plugin is installed too; uninstall it to use the bundled commands |
| An agy run fails at once with a permission error | It tried an action that needs approval; reviews must not run shell commands, and rescue needs `--dangerously-skip-permissions` |
| `/agy-status` shows `no result` | The relay never started, or was killed before writing `result.json` |
| Replies stall after installing | Disable `cache-status` first, then the others, to find which |

## Credits and licences

This repository is under the [MIT licence](LICENSE).

It includes third-party code, each under its own licence, listed with every change in
[`plugins/delegation/skills/NOTICE.md`](plugins/delegation/skills/NOTICE.md):

- The skills `codex-delegate`, `agy-delegate`, `claude-delegate` and `delegate-setup` from
  [amElnagdy/delegate-skills](https://github.com/amElnagdy/delegate-skills) (MIT).
- The Codex companion, its command texts and the skills `gpt-5-4-prompting` and
  `codex-result-handling` from OpenAI's Codex plugin for Claude Code (`codex@openai-codex`
  1.0.6), under the [Apache License 2.0](plugins/delegation/codex/LICENSE) with its
  [NOTICE](plugins/delegation/codex/NOTICE).

Not affiliated with Anthropic, OpenAI or Google.
