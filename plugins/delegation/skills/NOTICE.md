# Third-party code

## delegate-skills

`codex-delegate`, `agy-delegate`, `claude-delegate` and `delegate-setup` come from
[amElnagdy/delegate-skills](https://github.com/amElnagdy/delegate-skills) (version 0.5.0),
copyright (c) 2026 Ahmed Mohammed (amElnagdy), under the MIT licence in
`LICENSE-delegate-skills`.

Changes made for this plugin:

- Each worker skill starts with "First: is it worth delegating?", from a measured cost test.
- Briefs must name the files the implementer may change and keep shared test fixtures off-limits.
- In Claude Code, relays run in the foreground when nobody will resume the session.
- `codex-delegate`: run tests yourself when Codex's sandbox cannot reach the local environment.
- `agy-delegate`: a section on fast read-only questions about the codebase (`research` lane).
- Descriptions also trigger on "hand this over" / "hand it off".

The relay and setup scripts are unchanged.

## The official Codex plugin

`../codex/` (scripts, prompts, schemas, command texts) and the skills `gpt-5-4-prompting` and
`codex-result-handling` come from OpenAI's Codex plugin for Claude Code (`codex@openai-codex`,
version 1.0.6), under the Apache License 2.0 in `../codex/LICENSE`, with its `../codex/NOTICE`.

Changes made for this plugin:

- Slash names: `/codex:<name>` became `/codex-<name>` in every file.
- `/codex-rescue` runs the companion directly instead of through the `codex-rescue` subagent, and
  reviews the result; `transfer` and the `codex-cli-runtime` skill (for that subagent) are left out.
- `session-lifecycle-hook.mjs` no longer passes `CLAUDE_PLUGIN_DATA` on, so all companion runs keep
  state in one folder.
- `lib/app-server.mjs` reads the version from this plugin's manifest (one folder further up).
- Default models come from the delegation lanes: gpt-6-luna for rescue and review, gpt-6.1-sol for
  adversarial review.
