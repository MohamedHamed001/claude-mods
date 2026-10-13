# claude-mods

An index of my plugins for [Claude Code](https://docs.claude.com/en/docs/claude-code). Each
plugin lives in its own repository; this one only lists them, so you can add one marketplace
and install any of them.

| Plugin | Repository | In one line |
|---|---|---|
| **delegation** | [claude-delegation](https://github.com/MohamedHamed001/claude-delegation) | Hand work to Codex, agy (Google Antigravity) or Claude subagents, only when it pays, and watch each job as a little Clawd above the prompt, one look per model, and what it costs. Bundles the Codex commands as `/codex-*` with matching `/agy-*` commands. |
| **focus** | [claude-focus](https://github.com/MohamedHamed001/claude-focus) | Keeps the one next action pinned above the prompt, with time on task, parked thoughts and today's wins |
| **cache-status** | [claude-cache-status](https://github.com/MohamedHamed001/claude-cache-status) | Shows when this session's prompt cache goes cold, and what re-reading the conversation would cost |
| **guard** | [claude-guard](https://github.com/MohamedHamed001/claude-guard) | Stops a push made with the wrong GitHub account, and asks before a command that deletes folders, drops databases or rewrites git history |
| **change-ledger** | [claude-change-ledger](https://github.com/MohamedHamed001/claude-change-ledger) | Lists every file Claude changed this session, grouped by owner, each with the request that caused it; copies the list as a standup note |
| **prompt-upgrade** | [claude-prompt-upgrade](https://github.com/MohamedHamed001/claude-prompt-upgrade) | Asks a few quick questions, then rewrites your short prompt into a detailed one you can edit, copy or run; Claude or Codex does the rewriting |

## Install

All of them through this index:

```
/plugin marketplace add MohamedHamed001/claude-mods
/plugin install delegation@hamed-mods
/plugin install focus@hamed-mods
/plugin install cache-status@hamed-mods
/plugin install guard@hamed-mods
/plugin install change-ledger@hamed-mods
/plugin install prompt-upgrade@hamed-mods
```

Or one plugin straight from its own repository, for example:

```
/plugin marketplace add MohamedHamed001/claude-focus
/plugin install focus@claude-focus
```

Then start a new session: a session reads its plugins once, when it starts. Update later with
`/plugin marketplace update hamed-mods` (or the plugin repository's marketplace name).

## Requirements

Claude Code 2.1.28x or newer: the plugins use function hooks, which older versions do not run.
Each repository's README lists anything else its plugin needs.

## Licence

MIT, see [LICENSE](LICENSE). Each plugin repository has its own licence file and credits.
