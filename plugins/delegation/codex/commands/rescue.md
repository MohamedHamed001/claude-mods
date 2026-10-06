---
description: Hand a task, an investigation or a follow-up to Codex
argument-hint: "[--background|--wait] [--resume|--fresh] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh>] [what Codex should investigate, solve, or continue]"
---

Hand this request to Codex through the Codex companion script. Adapted from the official
Codex plugin's /codex:rescue: you run the companion yourself instead of through a forwarding
subagent, because the forwarder only added cost.

Raw user request:
$ARGUMENTS

Execution mode:

- `--background`: run the companion `task` with `--background` and tell the user to check
  `/codex-status`. `--wait` or neither flag: run it in the foreground and wait for it.
- `--background` and `--wait` are not part of the task text. `--model` and `--effort` are passed
  to `task` as they are; they are not part of the task text either.
- If the request includes `--resume` or `--fresh`, the user already chose; pass it on.
- Otherwise check for a resumable Codex thread from this session:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task-resume-candidate --json
```

- If it reports `available: true`, ask once with `AskUserQuestion`: `Continue current Codex thread`
  or `Start a new Codex thread`. Put "Continue" first, marked `(Recommended)`, when the request is a
  follow-up ("continue", "keep going", "apply the top fix", "dig deeper"); otherwise put "Start" first.
  Continue adds `--resume`, new adds `--fresh`.

Running it:

- Write the task as a brief: the task, the files Codex may change, what must not change, and the
  acceptance check. The gpt-5-4-prompting skill has recipes for Codex prompts.
- Pass the brief as the last quoted argument of the command, so the delegation plugin can size it.
- Add `--write` unless the user asked only for diagnosis, review or research.
- One shell call: `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task [flags] "<brief>"`.
- If the companion says Codex is missing or not signed in, stop and tell the user to run `/codex-setup`.
- If the user gave no request, ask what Codex should investigate or fix.

Afterwards:

- Show Codex's output, then review it yourself: read the diff and run the acceptance check. Codex
  saying "done" is not evidence.
- Follow the codex-result-handling skill when presenting the result.
