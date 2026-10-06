// The delegation mod's rules, as plain functions with no access to the app.
// Tested on their own in logic.test.ts; register.tsx only does the wiring.

import type { DayTotals, Job } from '../types'

const SECOND = 1000
const MINUTE = 60 * SECOND

/** A running job past this age gets a warning: the Codex stall in the cost test hung for hours. */
export const LONG_RUNNING_MS = 15 * MINUTE
/** How long the "small task" advice stays in the band after a delegation starts. */
export const ADVICE_MS = 60 * SECOND
/** How long a finished job stays in the band. */
export const FINISHED_SHOWN_MS = 10 * MINUTE

/** The token counts the API reports for one request. */
export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

/**
 * One request in cost units: the API price list's ratios between token kinds
 * (fresh input 1, cache read 0.1, cache write 2, output 5). Same rule as the cache mod.
 */
export function costUnits(usage: Usage): number {
  return (
    usage.input_tokens +
    usage.cache_read_input_tokens * 0.1 +
    usage.cache_creation_input_tokens * 2 +
    usage.output_tokens * 5
  )
}

/** A relay command that hands work to another tool, as found in a shell command. */
export type RelayCall = {
  worker: string
  briefPath: string
  model: string | null
  lane: string | null
}

const RELAY_WORKERS: Record<string, string> = {
  'codex-delegate': 'Codex',
  'agy-delegate': 'agy',
  'claude-delegate': 'Claude CLI',
  'cursor-delegate': 'Cursor',
  'opencode-delegate': 'opencode',
}

/** Read one flag's value: `--model gpt-6-luna` or `--model "gpt 6"` -> the value. */
function flag(command: string, name: string): string | null {
  const match = command.match(new RegExp(`--${name}\\s+(?:"([^"]+)"|'([^']+)'|(\\S+))`))

  return match ? (match[1] ?? match[2] ?? match[3]) : null
}

/**
 * Recognise a delegation in a shell command: a `relay.mjs` call with a brief.
 * Returns null for anything else, including `relay.mjs --help`.
 */
export function parseRelay(command: string): RelayCall | null {
  const relay = command.match(/([\w-]+-delegate)[\\/]scripts[\\/]relay\.mjs/)
  if (!relay) {
    return null
  }
  const briefPath = flag(command, 'brief')
  if (!briefPath) {
    return null // --help, or a brief piped on stdin, which we cannot read back
  }

  return {
    worker: RELAY_WORKERS[relay[1]] ?? relay[1],
    briefPath,
    model: flag(command, 'model'),
    lane: flag(command, 'lane'),
  }
}

/** The worker name for a Claude subagent, from the model it was asked to use. */
export function subagentWorker(model: string | undefined): string {
  if (!model) {
    return 'Subagent'
  }
  const family = model.replace(/^claude-/, '').split('-')[0]

  return family.charAt(0).toUpperCase() + family.slice(1)
}

/**
 * How many distinct files a brief names, counted from path-like words with a code
 * extension. A rough measure of task size: good enough to flag a one-file job.
 */
export function filesNamed(text: string): number {
  const paths = text.match(
    /[\w.\\/-]+\.(?:py|ts|tsx|js|jsx|mjs|cjs|json|sql|ya?ml|toml|cs|java|go|rs|html|css|scss|vue|kt|swift|rb|php)\b/g,
  )

  return new Set(paths ?? []).size
}

/** One or two named files: the size where Opus solo was cheaper and faster in the cost test. */
export function isSmall(text: string): boolean {
  const count = filesNamed(text)

  return count > 0 && count <= 2
}

/** Files the relay says the worker changed: `"touchedFiles": ["a", "b"]` -> 2. */
export function touchedFiles(output: string): number | null {
  const match = output.match(/"touchedFiles"\s*:\s*(\[[^\]]*\]|null)/)
  if (!match || match[1] === 'null') {
    return null
  }

  return (match[1].match(/"[^"]*"/g) ?? []).length
}

/** A short task name from a brief: its first non-empty line, without markdown, cut to fit. */
export function titleFromBrief(brief: string): string {
  const line =
    brief
      .split('\n')
      .map(text => text.replace(/^[#>*\-\s]+/, '').replace(/[*_`]/g, '').trim())
      .find(text => text !== '') ?? 'delegated task'

  return line.length <= 60 ? line : `${line.slice(0, 59).trimEnd()}…`
}

/** 372_000 -> "45s"-style elapsed time: "45s", "6m 12s", "1h 3m". */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / SECOND))
  if (seconds < 60) {
    return `${seconds}s`
  }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return `${minutes}m ${seconds % 60}s`
  }

  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** 186_432 -> "186k". */
export function formatUnits(units: number): string {
  if (units >= 1_000_000) {
    return `${(units / 1_000_000).toFixed(1)}M`
  }

  return units >= 1_000 ? `${Math.round(units / 1_000)}k` : String(Math.round(units))
}

/** The calendar day of a moment, in local time: "2026-10-06". */
export function dayOf(ms: number): string {
  const date = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export const EMPTY_DAY: DayTotals = { jobs: 0, opusRequests: 0, opusUnits: 0, workerUnits: 0, relayCalls: 0 }

/** Add one set of numbers to a day's totals. */
export function addToDay(day: DayTotals, change: Partial<DayTotals>): DayTotals {
  return {
    jobs: day.jobs + (change.jobs ?? 0),
    opusRequests: day.opusRequests + (change.opusRequests ?? 0),
    opusUnits: day.opusUnits + (change.opusUnits ?? 0),
    workerUnits: day.workerUnits + (change.workerUnits ?? 0),
    relayCalls: day.relayCalls + (change.relayCalls ?? 0),
  }
}

/** What the band shows. */
export type Band =
  | { kind: 'hidden' }
  | { kind: 'advice'; job: Job }
  | { kind: 'running'; job: Job; count: number }
  | { kind: 'long'; job: Job }
  | { kind: 'finished'; job: Job }

/**
 * Pick the one thing worth a line, most urgent first:
 *   long      a job has been running for 15 minutes or more
 *   advice    a small job started less than a minute ago
 *   running   a job is in progress
 *   finished  a job ended in the last 10 minutes
 */
export function bandFor(jobs: readonly Job[], now: number): Band {
  const running = jobs.filter(job => job.status === 'running')
  const newest = running.at(-1)
  if (newest) {
    const oldest = running[0]
    if (now - oldest.startedAt >= LONG_RUNNING_MS) {
      return { kind: 'long', job: oldest }
    }
    if (newest.small && now - newest.startedAt < ADVICE_MS) {
      return { kind: 'advice', job: newest }
    }

    return { kind: 'running', job: newest, count: running.length }
  }

  const finished = jobs
    .filter(job => job.finishedAt !== null && now - job.finishedAt < FINISHED_SHOWN_MS)
    .at(-1)

  return finished ? { kind: 'finished', job: finished } : { kind: 'hidden' }
}

// ---------------------------------------------------------------------------
// The delegation policy this plugin carries, so nobody has to copy it into CLAUDE.md.
// ---------------------------------------------------------------------------

/** Added to every session's system prompt by the prompt.compose hook. */
export const DELEGATION_POLICY = `# Delegation policy (from the delegation plugin)

Delegate only where it pays. Measured on real tasks of 1 to 6 files, each done three ways:
Opus alone passed every task and was fastest; Opus with a Sonnet subagent cost about a
third more on the Claude side and failed once; Opus with Codex cost about a tenth less on
the Claude side but took two to three times as long and failed once.

Why: a session carries a large context before any work, and every main-model request
re-reads it. Delegating saves only when it removes main-model requests; briefing, waiting
and reviewing usually add about as many as they remove.

Default: do the work yourself. Delegate only when at least one holds:
1. The work is large and separable (many files, or a long run-and-fix loop) and has an
   acceptance check the worker can run itself.
2. The user's Claude limit is the constraint and time is not: use Codex.
3. The user explicitly asks for delegation.
4. It is an independent, read-only review or second opinion.
5. It is fast, read-only exploration (sweeping the codebase, "where is X", "how does Y work")
   that would otherwise read many files into your own context: ask agy on its research lane
   and spot-check the key file and line claims, since fast models are less careful.

Do not delegate changes to one or two files, quick fixes, or work you will have to re-read
in full to review. Do not hand implementation to Sonnet subagents.

When you do delegate: write one tight brief with the acceptance check and the exact files
the worker may change (workers have broken shared test fixtures); run Codex relays in the
foreground when nobody will resume the session; keep the review to reading the diff and
running the tests.

When the user says "delegate", "hand this over", "hand it off" or names a worker (Codex,
agy, Sonnet), treat it as a request to delegate, even without a slash command.

This plugin ships the skills codex-delegate, agy-delegate, claude-delegate, delegate-setup,
gpt-5-4-prompting and codex-result-handling; the commands /delegate, /explore, /delegate-setup
and /delegations; and for Codex and for agy the same seven commands: rescue (hand over a task),
review, adversarial-review, status, result, cancel and setup (/codex-review, /agy-rescue, ...).
It refuses a delegation whose brief names only one or two files, unless the user asked for
delegation or the delegation is read-only.`

/** Does the user's own message ask for delegation? Then a small delegation is allowed. */
export function userAskedToDelegate(message: string): boolean {
  return (
    /\b(delegat\w*|codex|sonnet|haiku|subagents?|sub-agents?|agy|antigravity|luna|terra|sol)\b/i.test(message) ||
    /\bhand(?:ing|ed)?[\s-]*(?:(?:it|this|that|them)\s+)?(?:over|off)\b|\bhandover\b/i.test(message)
  )
}

/** Read-only work (exploring, reviewing, second opinions) is never blocked. */
export function isReadOnly(options: { subagentType?: string; command?: string }): boolean {
  if (options.subagentType && /^(explore|plan|claude-code-guide)$/i.test(options.subagentType)) {
    return true
  }
  const command = options.command ?? ''

  return /--read-only\b|--sandbox\s+read-only|--lane\s+(review|deep-review|explore|second-opinion|third-opinion|research)\b/.test(
    command,
  )
}

/** The reason given back to Claude when a small delegation is refused. */
export function refusalReason(files: number): string {
  return (
    `Delegation refused by the delegation plugin: the brief names only ${files} file(s). ` +
    'For changes this small, doing the work yourself was cheaper and faster in measured runs. ' +
    'Do it directly. (Delegation is allowed when the user asks for it, or for read-only work.)'
  )
}

// ---------------------------------------------------------------------------
// The official Codex plugin (openai-codex): /codex:rescue and codex-companion.mjs.
//
// /codex:rescue starts a "codex:codex-rescue" subagent, a thin forwarder that runs one
// shell command: `node .../codex-companion.mjs task [--background] [--write] ... "<task>"`.
// The companion can also be called directly (review, adversarial-review). A background
// task prints "<title> started in the background as <job-id>.", and its worker process
// carries `--job-id <job-id>` on its command line.
// ---------------------------------------------------------------------------

/** One codex-companion.mjs command. */
export type CompanionCall = {
  subcommand: string
  background: boolean
  /** --write: Codex may edit files. Without it the companion runs Codex read-only. */
  write: boolean
  model: string | null
  /** The task text: the last long quoted argument. */
  text: string
}

/** Companion subcommands that do work; status, result, cancel and setup are bookkeeping. */
export const COMPANION_WORK = new Set(['task', 'review', 'adversarial-review'])

/** The subagent type /codex:rescue uses. */
export function isCodexRescue(subagentType: string | undefined): boolean {
  return subagentType === 'codex:codex-rescue'
}

/** The last quoted argument long enough to be a task description. */
function lastQuoted(command: string): string {
  const quoted = [...command.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)]
    .map(match => match[1] ?? match[2])
    .filter(text => text.length > 15 && !/codex-companion\.mjs/.test(text))

  return quoted.at(-1) ?? ''
}

/** Recognise a codex-companion.mjs call in a shell command, or null. */
export function parseCompanion(command: string): CompanionCall | null {
  const match = command.match(/codex-companion\.mjs["']?\s+([a-z-]+)/)
  if (!match) {
    return null
  }

  return {
    subcommand: match[1],
    background: /--background\b/.test(command),
    write: /--write\b/.test(command),
    model: flag(command, 'model'),
    text: lastQuoted(command),
  }
}

/** The job id a background companion task reports, or null. */
export function backgroundCompanionJobId(output: string): string | null {
  return output.match(/started in the background as ([\w.-]+?)\.(?:\s|$|\\n|")/)?.[1] ?? null
}

/** A rescue request that only asks for diagnosis, review or research runs Codex read-only. */
export function isReadOnlyRequest(text: string): boolean {
  return (
    /\b(read-only|review|diagnos\w*|investigat\w*|research)\b/i.test(text) &&
    !/\b(fix|implement|change|write)\b/i.test(text)
  )
}

// ---------------------------------------------------------------------------
// Processes, on Windows and on macOS/Linux.
// ---------------------------------------------------------------------------

export type Platform = 'windows' | 'unix'

/**
 * Decide the platform from `uname -s`. On Windows `uname` is usually missing (null); when
 * Git's tools provide it, it answers MINGW/MSYS/CYGWIN, which is still Windows.
 */
export function platformFromUname(output: string | null): Platform {
  return output && !/MINGW|MSYS|CYGWIN|Windows/i.test(output) ? 'unix' : 'windows'
}

/** The command that prints every running process's full command line. */
export function listProcessesArgv(platform: Platform): string[] {
  return platform === 'windows'
    ? ['powershell', '-NoProfile', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object CommandLine']
    : ['ps', '-axo', 'command']
}

/** Characters that mean something in a regular expression, escaped so pkill matches literally. */
function escapeForPattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The command that ends every process whose command line contains `marker`: with its
 * child processes on Windows (taskkill /T); on macOS/Linux, pkill on the matching ones.
 */
export function killMatchingArgv(platform: Platform, marker: string): string[] {
  if (platform === 'unix') {
    return ['pkill', '-f', escapeForPattern(marker)]
  }
  // PowerShell single-quoted strings escape a quote by doubling it.
  const literal = marker.replace(/'/g, "''")

  return [
    'powershell',
    '-NoProfile',
    '-Command',
    `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${literal}') -and $_.CommandLine -notmatch 'Get-CimInstance' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F | Out-Null }`,
  ]
}

// ---------------------------------------------------------------------------
// The lane map from delegate-setup, for the system prompt.
// ---------------------------------------------------------------------------

/** One lane as delegate-setup writes it in ~/.config/delegate-skills/config.json. */
export type Lane = { implementer?: string; model?: string; effort?: string; variant?: string; readOnly?: boolean }

/**
 * The lane map as a few lines for the system prompt, grouped by implementer:
 *   - codex (codex-delegate): implement -> gpt-6-luna; deep-review -> gpt-6.1-sol, read-only
 * Empty when no lanes are configured; /delegate-setup creates them.
 */
export function laneMapText(config: unknown): string {
  const lanes = (config as { lanes?: Record<string, Lane> } | null)?.lanes
  if (!lanes || Object.keys(lanes).length === 0) {
    return ''
  }
  const byImplementer = new Map<string, string[]>()
  for (const [name, lane] of Object.entries(lanes)) {
    if (!lane.implementer) {
      continue
    }
    const dials = [lane.model, lane.effort && `effort ${lane.effort}`, lane.variant && `variant ${lane.variant}`, lane.readOnly && 'read-only']
      .filter(Boolean)
      .join(', ')
    const entries = byImplementer.get(lane.implementer) ?? []
    entries.push(dials ? `${name} -> ${dials}` : name)
    byImplementer.set(lane.implementer, entries)
  }
  const lines = [...byImplementer].map(
    ([implementer, entries]) => `- ${implementer} (${implementer}-delegate): ${entries.join('; ')}`,
  )

  return [
    '# Delegation lanes (from delegate-setup)',
    'Pass `--lane <name>` to the matching relay; an explicit `--model` overrides the lane.',
    ...lines,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// The bundled worker commands: /codex-* (the official Codex plugin's, vendored under
// codex/) and /agy-* (the same commands for agy, built on the agy relay).
// ---------------------------------------------------------------------------

export type Worker = 'codex' | 'agy'

/** The seven commands each worker gets, in the order the typeahead lists them. */
export const WORKER_ACTIONS = ['rescue', 'review', 'adversarial-review', 'status', 'result', 'cancel', 'setup'] as const
export type WorkerAction = (typeof WORKER_ACTIONS)[number]

/** One line each for the typeahead. */
export const ACTION_DESCRIPTIONS: Record<WorkerAction, string> = {
  rescue: 'Hand a task to {worker}',
  review: 'Read-only {worker} review of your local changes',
  'adversarial-review': '{worker} review that challenges the design and its assumptions',
  status: 'Show {worker} jobs, running and recent',
  result: "Show a finished {worker} job's report",
  cancel: 'Cancel a running {worker} job',
  setup: 'Check that {worker} is installed and signed in',
}

/**
 * The lane each model-running command reads its model from, and the model used when that
 * lane is not configured. An explicit --model on the command beats both.
 */
export const COMMAND_MODELS: Record<string, { lane: string; model: string }> = {
  'codex-rescue': { lane: 'implement', model: 'gpt-6-luna' },
  'codex-review': { lane: 'review', model: 'gpt-6-luna' },
  'codex-adversarial-review': { lane: 'deep-review', model: 'gpt-6.1-sol' },
  'agy-rescue': { lane: 'agy-implement', model: 'gemini-3.8-flash-high' },
  'agy-review': { lane: 'agy-review', model: 'gemini-3.8-flash-high' },
  'agy-adversarial-review': { lane: 'third-opinion', model: 'gemini-3.1-pro-high' },
}

/** The model a command runs: --model if given, else its lane's model, else the default. */
export function modelFor(command: string, requested: string | null, lanes: Record<string, Lane>): string {
  const defaults = COMMAND_MODELS[command]

  return requested ?? lanes[defaults.lane]?.model ?? defaults.model
}

/** A command's arguments with the run flags taken out; `text` is what is left. */
export type CommandArgs = { background: boolean; model: string | null; base: string | null; text: string }

export function splitArgs(args: string): CommandArgs {
  let text = args
  const take = (name: string): string | null => {
    const value = flag(text, name)
    text = text.replace(new RegExp(`--${name}\\s+(?:"[^"]+"|'[^']+'|\\S+)`), '')

    return value
  }
  const model = take('model')
  const base = take('base')
  const background = /--background\b/.test(text)
  text = text.replace(/--(background|wait)\b/g, '')

  return { background, model, base, text: text.replace(/\s+/g, ' ').trim() }
}

/** Codex commands pass the arguments on as typed; this adds `--model` when it is missing. */
export function withModel(args: string, model: string): string {
  return /--model\s/.test(args) ? args : `--model ${model} ${args}`.trim()
}

/**
 * A command file turned into a prompt: the front matter dropped, and each `${KEY}` (and the
 * Claude Code `$ARGUMENTS`) replaced. Unknown placeholders are left as they are.
 */
export function fillTemplate(markdown: string, values: Record<string, string>): string {
  const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim()

  return body
    .replace(/\$\{([A-Z_]+)\}/g, (whole, key: string) => values[key] ?? whole)
    .replace(/\$ARGUMENTS/g, values.ARGUMENTS ?? '')
}

/** A new agy job id from the clock, short enough to type: agy-<base 36 time>. */
export function newAgyJobId(now: number): string {
  return `agy-${now.toString(36)}`
}

/** What agy-status shows for a job, from its result.json and whether its relay still runs. */
// "no result": the relay is not running and wrote no result: not started yet, or killed.
export type AgyJobState = 'running' | 'done' | 'failed' | 'no result'

export function agyJobState(result: { status?: string } | null, alive: boolean): AgyJobState {
  // A live relay wins: a rerun in the same folder leaves the last run's result.json behind.
  if (alive) {
    return 'running'
  }
  if (result) {
    return result.status === 'completed' ? 'done' : 'failed'
  }

  return 'no result'
}

/** One agy job as its job.json records it. */
export type AgyJob = { id: string; kind: string; title: string; model: string; startedAt: number }

/** The agy jobs as a Markdown table, newest first. */
export function agyStatusTable(rows: Array<AgyJob & { state: AgyJobState }>, now: number): string {
  if (rows.length === 0) {
    return 'No agy jobs yet. Start one with /agy-rescue or /agy-review.'
  }
  const lines = rows.map(
    row =>
      `| ${row.id} | ${row.kind} | ${row.state} | ${row.model} | ${formatElapsed(now - row.startedAt)} ago | ${row.title} |`,
  )

  return ['| Job | Kind | State | Model | Started | Task |', '|---|---|---|---|---|---|', ...lines].join('\n')
}
