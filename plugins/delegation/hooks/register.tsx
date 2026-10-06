// Delegation: shows work handed to Claude subagents, Codex, agy and other relays.
//
// It also carries the delegation policy: the rule goes into every session's instructions,
// and a delegation of a one- or two-file task is refused unless the user asked for it.
//
// What you see:
//   - A one-line band while a job runs (or just finished, ran too long, or vanished).
//   - A pane (Delegations button or /delegations): what is running, with a Stop button
//     for relay jobs; every job of this session with what it cost; today's totals; and
//     the findings of the 6 Oct cost test.
//
// Where the information comes from:
//   Claude subagent starts      the Agent tool call (description, model, background)
//   its id and real model       the agent.spawn event
//   its cost and its finish     its own requests and its turn.complete, which carry its id
//   relay starts (Codex, ...)   a shell command running <name>-delegate/scripts/relay.mjs
//   Codex plugin jobs           a /codex:rescue subagent, or a codex-companion.mjs command;
//                               a background one is watched through its job id
//   a foreground relay's finish the command returning, with the relay's summary
//   a background relay's finish the relay process disappearing from the process list
//   Opus's cost while delegating every main-conversation request while a job is open
//
// The rules (recognising a relay, sizing a task, choosing the band line) are in logic.ts.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { DayTotals, Job } from '../types'
import {
  EMPTY_DAY,
  addToDay,
  bandFor,
  costUnits,
  dayOf,
  formatElapsed,
  formatUnits,
  COMPANION_WORK,
  DELEGATION_POLICY,
  backgroundCompanionJobId,
  filesNamed,
  isCodexRescue,
  isReadOnly,
  isReadOnlyRequest,
  isSmall,
  killMatchingArgv,
  laneMapText,
  listProcessesArgv,
  parseCompanion,
  platformFromUname,
  parseRelay,
  refusalReason,
  userAskedToDelegate,
  subagentWorker,
  titleFromBrief,
  touchedFiles,
  ACTION_DESCRIPTIONS,
  WORKER_ACTIONS,
  agyJobState,
  agyStatusTable,
  fillTemplate,
  modelFor,
  newAgyJobId,
  splitArgs,
  withModel,
} from './logic'
import type { AgyJob, Lane, Platform, Usage, Worker, WorkerAction } from './logic'

const PANE = 'delegations'
const TICK_MS = 15_000
const DAYS_KEY = 'days'
const SMALL_TASK_ADVICE =
  'Small task: in your cost test, Opus solo was cheaper and faster for 1-file changes'

// The lane map from delegate-setup, read at session start: as lines for the system prompt,
// and as data for the models the /codex-* and /agy-* commands pick.
let laneText = ''
let lanes: Record<string, Lane> = {}

// True when the official Codex plugin is installed too: our /codex-* commands then point to
// its /codex:* ones instead of running a second copy.
let officialCodex = false

// Where /agy-* jobs keep their files: one folder per job with job.json, brief.md, result.json.
let agyJobsRoot = ''

// Windows or macOS/Linux, decided once at session start; it picks the process commands.
let platform: Platform = 'windows'

// The user's latest message, typed by them. A small delegation is allowed when it asked
// for one. A plain variable: losing it on a reload only means one extra refusal.
let lastUserMessage = ''

/** The refusal sent back for a small delegation the user did not ask for, or null to allow. */
function smallDelegationRefusal(brief: string, readOnly: boolean): string | null {
  if (readOnly || !isSmall(brief) || userAskedToDelegate(lastUserMessage)) {
    return null
  }

  return refusalReason(filesNamed(brief))
}

const jobs = atom({ plugin: 'delegation', key: 'jobs' } as const, [])
const today = atom({ plugin: 'delegation', key: 'today' } as const, EMPTY_DAY)
const now = atom({ plugin: 'delegation', key: 'now' } as const, 0)

/** Change one job, found by its id. */
async function changeJob($: EngineInterface, id: string, change: (job: Job) => Job) {
  await update($, jobs, list => list.map(job => (job.id === id ? change(job) : job)))
}

/** Add numbers to today's totals, here and in the store all sessions share. */
async function addToday($: EngineInterface, change: Partial<DayTotals>) {
  const day = dayOf(await $.clock.now())
  const all = ((await $.store.get(DAYS_KEY)) ?? {}) as Record<string, DayTotals>
  const updated = addToDay(all[day] ?? EMPTY_DAY, change)
  // Keep only today's entry: older days are not shown anywhere.
  await $.store.set(DAYS_KEY, { [day]: updated })
  await update($, today, () => updated)
}

/** Record a new job and count it for today. */
async function startJob($: EngineInterface, job: Job, isRelay: boolean) {
  await update($, jobs, list => [...list, job])
  await addToday($, { jobs: 1, relayCalls: isRelay ? 1 : 0 })
  if (job.small) {
    $.ui.toast(SMALL_TASK_ADVICE)
  }
}

/** Mark a job ended. It keeps counting Opus requests until the current turn ends. */
async function finishJob($: EngineInterface, id: string, status: Job['status'], filesChanged?: number | null) {
  const at = await $.clock.now()
  await changeJob($, id, job =>
    job.status === 'running'
      ? { ...job, status, finishedAt: at, filesChanged: filesChanged ?? job.filesChanged }
      : job,
  )
  const job = (await read($, jobs)).find(one => one.id === id)
  if (job && status === 'done') {
    $.ui.toast(`${job.worker} finished: ${job.title}`)
  }
}

/**
 * The command lines of all running processes (PowerShell on Windows, ps elsewhere).
 * Used to tell whether a background job is still alive.
 */
async function processCommandLines($: EngineInterface): Promise<string> {
  const listed = await $.process.run(listProcessesArgv(platform), { timeoutMs: 15_000 })

  return listed.stdout
}

/** A background job whose process is gone has finished (or died). Check them all. */
async function checkBackgroundRelays($: EngineInterface) {
  const open = (await read($, jobs)).filter(job => job.status === 'running' && job.background && job.aliveMarker)
  if (open.length === 0) {
    return
  }
  const running = await processCommandLines($)
  for (const job of open) {
    if (!running.includes(job.aliveMarker as string)) {
      // We cannot tell success from failure here; the relay's result.json says that,
      // and Claude reads it when it is notified. "done" means "no longer running".
      await finishJob($, job.id, 'done')
    }
  }
}

/**
 * Stop a job by ending every process whose command line carries its marker: the brief
 * path of a relay job, or the job id of a background Codex plugin job.
 */
async function stopJob($: EngineInterface, job: Job) {
  if (!job.aliveMarker) {
    return
  }
  await $.process.run(killMatchingArgv(platform, job.aliveMarker), { timeoutMs: 20_000 }).catch(() => undefined)
  await finishJob($, job.id, 'stopped')
  $.ui.toast(`Stopped ${job.worker}: ${job.title}`)
}

/**
 * A codex-companion.mjs call from the official Codex plugin.
 *
 * Inside a /codex:rescue subagent it is that rescue job's actual Codex run, already
 * checked against the policy when the subagent started: only record its model and, for a
 * background run, its job id. Called directly, it is a job of its own, checked here.
 */
async function runCompanion(
  $: EngineInterface,
  e: { tool_use_id: string; agentId?: string },
  next: (e: never) => Promise<unknown>,
  call: import('./logic').CompanionCall,
) {
  const rescueJob = e.agentId
    ? (await read($, jobs)).find(job => job.agentId === e.agentId && job.status === 'running')
    : undefined

  if (!rescueJob) {
    const readOnly = call.subcommand !== 'task' || !call.write
    const refusal = smallDelegationRefusal(call.text, readOnly)
    if (refusal) {
      $.ui.toast('Refused a small delegation: doing it directly is cheaper')

      return { deny: refusal }
    }
    const job: Job = {
      id: e.tool_use_id,
      worker: call.subcommand === 'task' ? 'Codex' : `Codex ${call.subcommand}`,
      model: call.model,
      title: call.text ? titleFromBrief(call.text) : call.subcommand,
      startedAt: await $.clock.now(),
      finishedAt: null,
      status: 'running',
      background: call.background,
      small: isSmall(call.text),
      aliveMarker: null,
      agentId: null,
      opusRequests: 0,
      opusUnits: 0,
      workerUnits: 0,
      filesChanged: null,
      isTracking: true,
    }
    await startJob($, job, true).catch(() => undefined)
  } else if (call.model) {
    await changeJob($, rescueJob.id, job => ({ ...job, model: call.model })).catch(() => undefined)
  }

  const ran = await next(e as never)
  const ownerId = rescueJob ? rescueJob.id : e.tool_use_id
  const jobId = call.background ? backgroundCompanionJobId(JSON.stringify(ran)) : null
  if (jobId) {
    // Codex keeps working in a worker process that carries this id: watch it, and let
    // Stop end it.
    await changeJob($, ownerId, job => ({ ...job, background: true, aliveMarker: jobId })).catch(() => undefined)
  } else if (!rescueJob) {
    await finishJob($, ownerId, 'done').catch(() => undefined)
  }

  return ran
}

/** Read a brief file for its title and size. A missing file just gives defaults. */
async function readBrief($: EngineInterface, path: string): Promise<string> {
  try {
    const content = await $.fs.read(path)

    return typeof content === 'string' ? content : ''
  } catch {
    return ''
  }
}

// ---- The bundled worker commands: /codex-* and /agy-* ------------------------------------

const PLAIN_REVIEW_STYLE =
  'Ask agy for a careful code review of the patch: bugs, regressions, missing tests and unclear code.'
const ADVERSARIAL_STYLE =
  'Ask agy for an adversarial review: challenge whether this approach is the right one, which ' +
  'assumptions it depends on and where it could fail under real conditions, not only line-level ' +
  "defects. Include the user's focus, if any."

/** The plugin's folder with forward slashes, so paths in prompts work in Bash and PowerShell. */
function rootPath($: EngineInterface): string {
  return $.plugin.root.replace(/\\/g, '/')
}

/** Hand Claude a prompt without waiting: it only starts once the command has finished. */
function sendToClaude($: EngineInterface, text: string) {
  void $.prompt.submit({ text, asUser: true }).catch(() => undefined)
}

/** A JSON file's content, or null when it is missing or not JSON. */
async function readJson($: EngineInterface, path: string): Promise<any> {
  try {
    return JSON.parse(String(await $.fs.read(path)))
  } catch {
    return null
  }
}

/**
 * /codex-<action>: the vendored Codex companion. Status, result and cancel run it directly
 * and answer at once; the others hand Claude the upstream command text, with our model added.
 */
async function codexCommand($: EngineInterface, action: WorkerAction, args: string): Promise<{ text: string }> {
  if (officialCodex) {
    return {
      text: `The official Codex plugin is installed, so use /codex:${action}. This plugin still sizes and tracks its jobs.`,
    }
  }
  const codexRoot = `${rootPath($)}/codex`
  // setup only checks node, Codex and its sign-in, and prints how to install what is missing.
  if (action === 'status' || action === 'result' || action === 'cancel' || action === 'setup') {
    // CLAUDE_PLUGIN_DATA cleared: the companion then keeps state where Claude's shell runs do.
    const ran = await $.process.run(
      ['node', `${codexRoot}/scripts/codex-companion.mjs`, action, ...args.split(/\s+/).filter(Boolean)],
      { env: { CLAUDE_PLUGIN_DATA: '' }, timeoutMs: 60_000 },
    )

    return { text: (ran.stdout || ran.stderr).trim() || `The Codex companion printed nothing for ${action}.` }
  }

  const model = modelFor(`codex-${action}`, splitArgs(args).model, lanes)
  const template = String(await $.fs.read(`${codexRoot}/commands/${action}.md`))
  lastUserMessage = `delegate ${args}` // the user asked: the size check must not refuse it
  sendToClaude($, fillTemplate(template, { ARGUMENTS: withModel(args, model), CLAUDE_PLUGIN_ROOT: codexRoot }))

  return { text: `Sent to Claude: Codex ${action} (${model}).` }
}

/** Every agy job on this machine, newest first, with its state. */
async function agyJobs($: EngineInterface): Promise<Array<AgyJob & { state: ReturnType<typeof agyJobState> }>> {
  const entries = await $.fs.list(agyJobsRoot).catch(() => [])
  const running = entries.length > 0 ? await processCommandLines($).catch(() => '') : ''
  const rows = []
  for (const entry of entries.filter(one => one.kind === 'dir')) {
    const job: AgyJob | null = await readJson($, `${agyJobsRoot}/${entry.name}/job.json`)
    if (job) {
      const result = await readJson($, `${agyJobsRoot}/${entry.name}/result.json`)
      // The relay's command line carries the brief path, which carries the job id.
      rows.push({ ...job, state: agyJobState(result, running.includes(job.id)) })
    }
  }

  return rows.sort((a, b) => b.startedAt - a.startedAt)
}

/** /agy-<action>: the Codex commands' twins, built on the agy relay and a folder per job. */
async function agyCommand($: EngineInterface, action: WorkerAction, args: string): Promise<{ text: string }> {
  if (!agyJobsRoot) {
    return { text: 'No home folder found, so agy jobs have nowhere to keep their files.' }
  }
  const at = await $.clock.now()

  if (action === 'status') {
    return { text: agyStatusTable((await agyJobs($)).slice(0, 10), at) }
  }

  if (action === 'result' || action === 'cancel') {
    const all = await agyJobs($)
    const wanted = args.trim()
    const job = wanted
      ? all.find(one => one.id === wanted)
      : action === 'cancel'
        ? all.find(one => one.state === 'running')
        : all[0]
    if (!job) {
      return { text: wanted ? `No agy job ${wanted}. /agy-status lists them.` : `No agy job to ${action}.` }
    }
    if (action === 'cancel') {
      if (job.state !== 'running') {
        return { text: `${job.id} is not running (${job.state}).` }
      }
      await $.process.run(killMatchingArgv(platform, job.id), { timeoutMs: 20_000 }).catch(() => undefined)
      for (const tracked of (await read($, jobs)).filter(one => one.status === 'running' && one.aliveMarker?.includes(job.id))) {
        await finishJob($, tracked.id, 'stopped')
      }

      return { text: `Cancelled ${job.id}: ${job.title}` }
    }
    const result = await readJson($, `${agyJobsRoot}/${job.id}/result.json`)
    if (!result) {
      return { text: `${job.id} has no result yet (${job.state}).` }
    }
    // A review changes nothing: its git status is the changes it reviewed, not its own.
    const files =
      job.kind === 'rescue' && Array.isArray(result.touchedFiles)
        ? `\n\nFiles touched: ${result.touchedFiles.join(', ') || 'none'}`
        : ''
    const failure = result.status !== 'completed' && result.error ? `\n\nWhy it failed: ${result.error}` : ''

    return {
      text: `${job.id} · ${job.kind} · ${result.status} · ${job.model}\n\n${result.finalMessage || '(agy gave no final message)'}${failure}${files}`,
    }
  }

  if (action === 'setup') {
    const version = await $.process.run(['agy', '--version'], { timeoutMs: 15_000 }).catch(() => null)
    if (!version || version.exitCode !== 0) {
      return {
        text: 'agy is not installed or not on PATH. Install the Google Antigravity CLI, run `agy` once to sign in, then run /agy-setup again.',
      }
    }
    const models = await $.process.run(['agy', 'models'], { timeoutMs: 30_000 }).catch(() => null)
    const listed = models && models.exitCode === 0 ? models.stdout.trim().split('\n').filter(Boolean).length : 0

    return {
      text: [
        `agy ${version.stdout.trim()}`,
        listed > 0 ? `Signed in: ${listed} models available.` : 'Could not list models: run `agy` once to sign in.',
        `Defaults: rescue ${modelFor('agy-rescue', null, lanes)}, review ${modelFor('agy-review', null, lanes)}, ` +
          `adversarial review ${modelFor('agy-adversarial-review', null, lanes)}.`,
        'Lanes in the delegate-setup config change these; --model on a command overrides them.',
      ].join('\n'),
    }
  }

  // rescue, review, adversarial-review: record the job, then hand Claude the steps.
  const parsed = splitArgs(args)
  const model = modelFor(`agy-${action}`, parsed.model, lanes)
  const id = newAgyJobId(at)
  const jobDir = `${agyJobsRoot}/${id}`
  const job: AgyJob = { id, kind: action, title: parsed.text ? titleFromBrief(parsed.text) : action, model, startedAt: at }
  await $.fs.write(`${jobDir}/job.json`, JSON.stringify(job, null, 2))

  const template = String(await $.fs.read(`${rootPath($)}/agy/commands/${action === 'rescue' ? 'rescue' : 'review'}.md`))
  lastUserMessage = `delegate ${args}` // the user asked: the size check must not refuse it
  sendToClaude(
    $,
    fillTemplate(template, {
      JOB_ID: id,
      JOB_DIR: jobDir,
      RELAY: `${rootPath($)}/skills/agy-delegate/scripts/relay.mjs`,
      MODEL: model,
      TASK: parsed.text || '(none given)',
      BASE: parsed.base ?? 'none: review the working tree',
      BACKGROUND_NOTE: parsed.background ? ' with `run_in_background: true`, then tell the user to check `/agy-status`' : '',
      REVIEW_STYLE: action === 'adversarial-review' ? ADVERSARIAL_STYLE : PLAIN_REVIEW_STYLE,
    }),
  )

  return { text: `Sent to Claude: agy ${action} (${model}), job ${id}.` }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // Which process commands to use. `uname` is missing on most Windows machines.
    try {
      const uname = await $.process.run(['uname', '-s'], { timeoutMs: 5_000 })
      platform = platformFromUname(uname.exitCode === 0 ? uname.stdout : null)
    } catch {
      platform = 'windows'
    }

    try {
      const at = await $.clock.now()
      await update($, now, () => at)
      const all = ((await $.store.get(DAYS_KEY)) ?? {}) as Record<string, DayTotals>
      await update($, today, () => all[dayOf(at)] ?? EMPTY_DAY)
    } catch {
      // The band works without today's totals.
    }

    // The lane map lives where delegate-setup writes it: $XDG_CONFIG_HOME, else ~/.config.
    try {
      const xdg = await $.env.get('XDG_CONFIG_HOME')
      const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
      const configDir = xdg ?? (home ? `${home}/.config` : null)
      if (home) {
        agyJobsRoot = `${home.replace(/\\/g, '/')}/.claude/delegation/agy-jobs`
      }
      if (configDir) {
        const raw = await $.fs.read(`${configDir}/delegate-skills/config.json`)
        const config = JSON.parse(typeof raw === 'string' ? raw : '{}')
        laneText = laneMapText(config)
        lanes = config.lanes ?? {}
      }
    } catch {
      laneText = '' // no lanes yet: /delegate-setup creates them, and the commands use defaults
    }

    // The official Codex plugin names its commands codex:<name>.
    try {
      officialCodex = (await $.command.list()).some(command => command.name.startsWith('codex:'))
    } catch {
      officialCodex = false
    }

    // Each command on its own, so a name the app refuses does not block the others.
    // (/delegate-setup is the shipped delegate-setup skill itself, so it needs no command.)
    const commands = [
      { name: 'delegations', description: 'Open the delegations pane' },
      { name: 'delegate', description: 'Delegate a task, if it is worth it: /delegate <task>' },
      { name: 'explore', description: 'Ask agy a fast read-only question about the codebase: /explore <question>' },
    ]
    for (const worker of ['codex', 'agy'] as const) {
      const name = worker === 'codex' ? 'Codex' : 'agy'
      for (const action of WORKER_ACTIONS) {
        commands.push({ name: `${worker}-${action}`, description: ACTION_DESCRIPTIONS[action].replace('{worker}', name) })
      }
    }
    for (const command of commands) {
      await $.command.register(command).catch(() => undefined)
    }

    $.clock.every(TICK_MS, () => {
      void (async () => {
        const at = await $.clock.now()
        await update($, now, () => at)
        await checkBackgroundRelays($)
      })().catch(() => undefined)
    })

    return next(e)
  })

  on('command.run', { command: 'delegate' }, async ($, e) => {
    const task = e.args.trim()
    if (task === '') {
      return { text: 'Usage: /delegate <task>' }
    }
    lastUserMessage = `delegate ${task}` // the user asked: the size check must not refuse it
    // Not awaited: the prompt only starts once this command has finished, so waiting for it
    // here would wait forever and the command would never answer.
    void $.prompt
      .submit({
        text:
          'Delegate this task if it is worth it under the delegation policy; if it is not, say why ' +
          'and do it yourself. Pick the worker and lane, write a tight brief (files it may change, ' +
          `acceptance check), run it, then review the result.\n\nTask: ${task}`,
        asUser: true,
      })
      .catch(() => undefined)

    return { text: 'Sent to Claude to delegate.' }
  })

  on('command.run', { command: 'explore' }, async ($, e) => {
    const question = e.args.trim()
    if (question === '') {
      return { text: 'Usage: /explore <question about the codebase>' }
    }
    lastUserMessage = `delegate explore ${question}`
    // Not awaited, for the same reason as /delegate.
    void $.prompt
      .submit({
        text:
          'Answer this question about the codebase by asking agy read-only on its research lane ' +
          '(agy-delegate skill, --lane research --read-only). Ask it for file and line references, ' +
          `spot-check the key ones, then answer.\n\nQuestion: ${question}`,
        asUser: true,
      })
      .catch(() => undefined)

    return { text: 'Sent to Claude to ask agy.' }
  })

  on('command.run', { command: 'delegations' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Delegations' })

    return { text: 'Delegations pane opened.' }
  })

  for (const worker of ['codex', 'agy'] as const satisfies readonly Worker[]) {
    for (const action of WORKER_ACTIONS) {
      on('command.run', { command: `${worker}-${action}` }, async ($, e) => {
        try {
          return worker === 'codex' ? await codexCommand($, action, e.args) : await agyCommand($, action, e.args)
        } catch (error) {
          return { text: `/${worker}-${action} failed: ${error instanceof Error ? error.message : String(error)}` }
        }
      })
    }
  }

  // ---- The policy: in every session's instructions --------------------------------------

  // Appended to the system prompt, so the rule travels with the plugin instead of living in
  // each person's CLAUDE.md. "session" scope: it is ours, not shared across organizations.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)

    return {
      ...composed,
      sections: [
        ...composed.sections,
        {
          id: 'delegation:policy',
          text: laneText ? `${DELEGATION_POLICY}\n\n${laneText}` : DELEGATION_POLICY,
          scope: 'session' as const,
        },
      ],
    }
  })

  on('prompt.submit', ($, e, next) => {
    // Only what the person typed counts as asking; not text a plugin sent for them.
    if (e.origin?.kind === 'composer') {
      lastUserMessage = e.text
    }

    return next(e)
  })

  // ---- Claude subagents -------------------------------------------------------------

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    // Enforce the policy: a small task the user did not ask to delegate is refused, and
    // Claude gets the reason back as the tool's result.
    const rescue = isCodexRescue(e.subagent_type)
    const readOnly =
      isReadOnly({ subagentType: e.subagent_type }) || (rescue && isReadOnlyRequest(e.prompt))
    const refusal = smallDelegationRefusal(e.prompt, readOnly)
    if (refusal) {
      $.ui.toast('Refused a small delegation: doing it directly is cheaper')

      return { deny: refusal }
    }

    const background = e.run_in_background !== false
    try {
      const job: Job = {
        id: e.tool_use_id,
        // /codex:rescue: a Sonnet forwarder whose real worker is Codex.
        worker: rescue ? 'Codex (rescue)' : subagentWorker(e.model),
        model: rescue ? (e.prompt.match(/--model\s+(\S+)/)?.[1] ?? null) : (e.model ?? null),
        title: e.description,
        startedAt: await $.clock.now(),
        finishedAt: null,
        status: 'running',
        background,
        small: isSmall(e.prompt),
        aliveMarker: null,
        agentId: null,
        opusRequests: 0,
        opusUnits: 0,
        workerUnits: 0,
        filesChanged: null,
        isTracking: true,
      }
      await startJob($, job, false)
    } catch {
      // A job we failed to record only goes missing from the pane.
    }

    const ran = await next(e)
    // A foreground subagent has finished when the call returns. A background one only
    // started; its own turn.complete (below) says when it ends. A rescue subagent that
    // started Codex in the background has a job id marker by now: Codex is still working.
    const job = (await read($, jobs).catch(() => [] as Job[])).find(one => one.id === e.tool_use_id)
    if (!background && !(job && job.aliveMarker)) {
      await finishJob($, e.tool_use_id, 'done').catch(() => undefined)
    }

    return ran
  })

  // The spawn event links the tool call to the subagent's id and its real model.
  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    if (spawned.agentId) {
      const agentId = spawned.agentId
      await changeJob($, e.tool_use_id, job => ({
        ...job,
        agentId,
        model: spawned.model ?? job.model,
        worker: job.worker === 'Subagent' ? subagentWorker(spawned.model) : job.worker,
      })).catch(() => undefined)
    }

    return spawned
  })

  // ---- Relays: Codex, agy, a separate Claude CLI ---------------------------------------

  for (const shell of ['Bash', 'PowerShell'] as const) {
    on('tool.call', { tool: shell }, async ($, e, next) => {
      const companion = parseCompanion(e.command)
      if (companion && COMPANION_WORK.has(companion.subcommand)) {
        return runCompanion($, e, next, companion)
      }

      const relay = parseRelay(e.command)
      if (!relay) {
        return next(e)
      }

      const brief = await readBrief($, relay.briefPath)
      const refusal = smallDelegationRefusal(brief, isReadOnly({ command: e.command }))
      if (refusal) {
        $.ui.toast('Refused a small delegation: doing it directly is cheaper')

        return { deny: refusal }
      }

      const background = e.run_in_background === true
      try {
        const job: Job = {
          id: e.tool_use_id,
          worker: relay.worker,
          model: relay.model ?? (relay.lane ? `lane ${relay.lane}` : null),
          title: brief ? titleFromBrief(brief) : 'delegated task',
          startedAt: await $.clock.now(),
          finishedAt: null,
          status: 'running',
          background,
          small: isSmall(brief),
          aliveMarker: relay.briefPath,
          agentId: null,
          opusRequests: 0,
          opusUnits: 0,
          workerUnits: 0,
          filesChanged: null,
          isTracking: true,
        }
        await startJob($, job, true)
      } catch {
        // As above.
      }

      const ran = await next(e)
      if (!background) {
        // The relay ran in the foreground and has finished; its summary is the output.
        const output = JSON.stringify(ran)
        const failed = /"status"\s*:\s*\\?"(failed|timeout|aborted)/.test(output)
        await finishJob($, e.tool_use_id, failed ? 'failed' : 'done', touchedFiles(output.replace(/\\"/g, '"'))).catch(
          () => undefined,
        )
      }

      return ran
    })
  }

  // ---- Cost: every model request ------------------------------------------------------

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    try {
      if (result.usage) {
        const units = costUnits(result.usage as Usage)
        if (e.agentId) {
          // A subagent's request: it belongs to the job with that subagent id.
          const agentId = e.agentId
          const owner = (await read($, jobs)).find(job => job.agentId === agentId)
          if (owner) {
            await changeJob($, owner.id, job => ({ ...job, workerUnits: job.workerUnits + units }))
            await addToday($, { workerUnits: units })
          }
        } else {
          // An Opus request while delegation is open counts towards what delegating cost.
          const open = (await read($, jobs)).filter(job => job.isTracking)
          if (open.length > 0) {
            await update($, jobs, list =>
              list.map(job =>
                job.isTracking
                  ? { ...job, opusRequests: job.opusRequests + 1, opusUnits: job.opusUnits + units }
                  : job,
              ),
            )
            await addToday($, { opusRequests: 1, opusUnits: units })
          }
        }
      }
    } catch {
      // Never let bookkeeping break a model request.
    }

    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    try {
      if (e.agentId) {
        // A background subagent finished.
        const agentId = e.agentId
        const owner = (await read($, jobs)).find(job => job.agentId === agentId && job.status === 'running')
        if (owner) {
          await finishJob($, owner.id, e.isAborted ? 'failed' : 'done')
        }
      } else {
        // The main turn ended: jobs that finished stop counting Opus requests now,
        // which covers the review Opus did right after the result came back.
        await update($, jobs, list =>
          list.map(job => (job.isTracking && job.status !== 'running' ? { ...job, isTracking: false } : job)),
        )
      }
    } catch {
      // As above.
    }

    return result
  })

  // ---- Drawing --------------------------------------------------------------------------

  // The band: one line in the shared three-column layout, above what others draw.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const beneath = await next(e)
    if (e.props.hasSurvey) {
      return beneath
    }
    const time = await read($, now)
    const band = bandFor(await read($, jobs), time)
    if (band.kind === 'hidden') {
      return beneath
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const job = band.job
    const who = `${job.worker}${job.model ? ` (${job.model})` : ''}`

    return (
      <Box flexDirection="column" rowGap={1}>
        <Box columnGap={1} alignItems="center">
          <Box width={2}>
            {band.kind === 'running' && <Text color="warning">⠹</Text>}
            {band.kind === 'advice' && <Text color="warning">i</Text>}
            {band.kind === 'long' && <Text color="warning">!</Text>}
            {band.kind === 'finished' && (
              <Text color={job.status === 'done' ? 'success' : 'error'}>{job.status === 'done' ? '✓' : '✗'}</Text>
            )}
          </Box>

          <Box flexGrow={1} flexShrink={1}>
            {band.kind === 'running' && (
              <Text wrap="truncate-end">
                {who} · {job.title} · {formatElapsed(time - job.startedAt)}
                {band.count > 1 ? ` · ${band.count} running` : ''}
              </Text>
            )}
            {band.kind === 'advice' && (
              <Text color="warning" wrap="truncate-end">
                {SMALL_TASK_ADVICE}
              </Text>
            )}
            {band.kind === 'long' && (
              <Text color="warning" wrap="truncate-end">
                {who} running for {formatElapsed(time - job.startedAt)}. Still working?
              </Text>
            )}
            {band.kind === 'finished' && (
              <Text wrap="truncate-end">
                {job.worker} {job.status} in {formatElapsed((job.finishedAt ?? time) - job.startedAt)}
                {job.filesChanged !== null ? ` · ${job.filesChanged} files changed` : ''} · {job.title}
              </Text>
            )}
          </Box>

          {band.kind !== 'finished' && job.aliveMarker && job.status === 'running' && (
            <Button key="band-stop" label="Stop" onPress={() => stopJob($, job)} />
          )}
          <Button
            key="open-delegations"
            label="Delegations"
            onPress={() => $.ui.open({ id: PANE, title: 'Delegations' })}
          />
        </Box>
        {beneath}
      </Box>
    )
  })

  // The pane: running now, this session, today, and the cost test's findings.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const list = await read($, jobs)
    const day = await read($, today)
    const time = await read($, now)
    const { Box, Button, Text } = $.ui.resolve(e)
    const running = list.filter(job => job.status === 'running')

    /** One outlined card with a muted heading, as in the focus pane. */
    const section = (title: string, body: unknown) => (
      <Box flexDirection="column" rowGap={1} paddingX={1} borderStyle="round" borderDimColor>
        <Text dimColor>{title}</Text>
        {body}
      </Box>
    )

    /** A label on the left and its value on the right. */
    const row = (label: string, value: string) => (
      <Box columnGap={2}>
        <Box flexGrow={1}>
          <Text dimColor>{label}</Text>
        </Box>
        <Text>{value}</Text>
      </Box>
    )

    const statusMark: Record<Job['status'], string> = {
      running: '⠹',
      done: '✓',
      failed: '✗',
      stopped: '■',
    }

    return (
      <Box flexDirection="column" rowGap={1} padding={1}>
        {section(
          `Running now (${running.length})`,
          <Box flexDirection="column" rowGap={1}>
            {running.length === 0 && <Text dimColor>Nothing delegated right now</Text>}
            {running.map(job => (
              <Box columnGap={1} alignItems="center">
                <Text color="warning">⠹</Text>
                <Box flexGrow={1} flexShrink={1}>
                  <Text>
                    {job.worker}
                    {job.model ? ` (${job.model})` : ''} · {job.title}
                  </Text>
                </Box>
                <Text dimColor>{formatElapsed(time - job.startedAt)}</Text>
                {job.aliveMarker && (
                  <Button key={`stop:${job.id}`} label="Stop" onPress={() => stopJob($, job)} />
                )}
              </Box>
            ))}
          </Box>,
        )}

        {section(
          `This session (${list.length})`,
          <Box flexDirection="column" rowGap={1}>
            {list.length === 0 && <Text dimColor>No delegations yet in this session</Text>}
            {list.map(job => (
              <Box flexDirection="column">
                <Box columnGap={1}>
                  <Text color={job.status === 'done' ? 'success' : job.status === 'running' ? 'warning' : 'error'}>
                    {statusMark[job.status]}
                  </Text>
                  <Box flexGrow={1} flexShrink={1}>
                    <Text>
                      {job.worker} · {job.title}
                    </Text>
                  </Box>
                  {job.small && <Text dimColor>small</Text>}
                </Box>
                <Text dimColor>
                  {'  '}Opus {job.opusRequests} requests, {formatUnits(job.opusUnits)} units
                  {job.workerUnits > 0 ? ` · ${job.worker} ${formatUnits(job.workerUnits)} units` : ''}
                  {job.filesChanged !== null ? ` · ${job.filesChanged} files` : ''}
                  {job.finishedAt !== null ? ` · ${formatElapsed(job.finishedAt - job.startedAt)}` : ''}
                </Text>
              </Box>
            ))}
          </Box>,
        )}

        {section(
          'Today, all sessions',
          <Box flexDirection="column">
            {row('Delegations', String(day.jobs))}
            {row('Opus requests while delegating', String(day.opusRequests))}
            {row('Opus units while delegating', formatUnits(day.opusUnits))}
            {row('Claude worker units', formatUnits(day.workerUnits))}
            {row('Relay calls (Codex and others)', String(day.relayCalls))}
          </Box>,
        )}

        {section(
          'From your cost test (6 Oct)',
          <Box flexDirection="column">
            <Text>Opus solo: passed 3 of 3, fastest</Text>
            <Text>Codex: about 10% cheaper on Claude, 2 to 3 times slower</Text>
            <Text>Sonnet: most expensive every time</Text>
          </Box>,
        )}
      </Box>
    )
  })
}
