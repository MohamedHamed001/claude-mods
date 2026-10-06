// Checks for the rules in logic.ts. Run with: claude plugin test <this mod's folder>

import { expect, test } from 'claude-code/testing'

import {
  ADVICE_MS,
  FINISHED_SHOWN_MS,
  LONG_RUNNING_MS,
  addToDay,
  bandFor,
  EMPTY_DAY,
  filesNamed,
  formatElapsed,
  isSmall,
  parseRelay,
  subagentWorker,
  titleFromBrief,
  touchedFiles,
  userAskedToDelegate,
  isReadOnly,
  refusalReason,
  parseCompanion,
  backgroundCompanionJobId,
  isCodexRescue,
  isReadOnlyRequest,
  platformFromUname,
  listProcessesArgv,
  killMatchingArgv,
  laneMapText,
  modelFor,
  splitArgs,
  withModel,
  fillTemplate,
  agyJobState,
  agyStatusTable,
} from './logic'
import type { Job } from '../types'

test('a Codex relay call is recognised, with its brief, lane and model', () => {
  const call = parseRelay(
    'node ~/.claude/skills/codex-delegate/scripts/relay.mjs --brief "C:/tmp/brief.txt" --cd "D:/x" --lane implement --model gpt-6-luna --timeout 9m',
  )
  expect(call).toEqual({ worker: 'Codex', briefPath: 'C:/tmp/brief.txt', model: 'gpt-6-luna', lane: 'implement' })
})

test('other relays get their own worker name', () => {
  expect(parseRelay('node a/agy-delegate/scripts/relay.mjs --brief b.txt')?.worker).toBe('agy')
  expect(parseRelay('node a\\claude-delegate\\scripts\\relay.mjs --brief b.txt')?.worker).toBe('Claude CLI')
})

test('help and ordinary commands are not delegations', () => {
  expect(parseRelay('node x/codex-delegate/scripts/relay.mjs --help')).toBe(null)
  expect(parseRelay('python -m pytest src/tests -q')).toBe(null)
})

test('a subagent is named after its model family', () => {
  expect(subagentWorker('sonnet')).toBe('Sonnet')
  expect(subagentWorker('claude-sonnet-5-5')).toBe('Sonnet')
  expect(subagentWorker(undefined)).toBe('Subagent')
})

test('task size is the number of distinct files a brief names', () => {
  const brief = 'Fix src/infrastructure/parsers/arxml_signal_parser.py and its test in src/tests/unit/test_x.py. Then rerun src/tests/unit/test_x.py.'
  expect(filesNamed(brief)).toBe(2)
  expect(isSmall(brief)).toBe(true)
  expect(isSmall('Refactor a.py, b.py and c.ts')).toBe(false)
  expect(isSmall('Investigate why the build is slow')).toBe(false) // names no file: unknown, not small
})

test('files changed are read from the relay summary', () => {
  expect(touchedFiles('{"status":"completed","touchedFiles":["a.py","b.py"]}')).toBe(2)
  expect(touchedFiles('{"touchedFiles": null}')).toBe(null)
  expect(touchedFiles('no summary')).toBe(null)
})

test('a brief becomes a short title from its first real line', () => {
  expect(titleFromBrief('\n## Task: convert ARXML limits\n\nDetails...')).toBe('Task: convert ARXML limits')
})

test('elapsed time is short', () => {
  expect(formatElapsed(45_000)).toBe('45s')
  expect(formatElapsed(372_000)).toBe('6m 12s')
  expect(formatElapsed(3_780_000)).toBe('1h 3m')
})

test('day totals add up', () => {
  expect(addToDay(addToDay(EMPTY_DAY, { jobs: 1, relayCalls: 1 }), { opusRequests: 2, opusUnits: 50_000 })).toEqual({
    jobs: 1, opusRequests: 2, opusUnits: 50_000, workerUnits: 0, relayCalls: 1,
  })
})

const job = (change: Partial<Job>): Job => ({
  id: 'j', worker: 'Codex', model: 'gpt-6-luna', title: 'task', startedAt: 0, finishedAt: null,
  status: 'running', background: true, small: false, aliveMarker: 'b.txt', agentId: null,
  opusRequests: 0, opusUnits: 0, workerUnits: 0, filesChanged: null, isTracking: true, ...change,
})

test('band: nothing when nothing was delegated', () => {
  expect(bandFor([], 1_000).kind).toBe('hidden')
})

test('band: a small job first shows the advice, then the running line', () => {
  expect(bandFor([job({ small: true })], ADVICE_MS - 1).kind).toBe('advice')
  expect(bandFor([job({ small: true })], ADVICE_MS + 1).kind).toBe('running')
})

test('band: a long run is flagged', () => {
  expect(bandFor([job({})], LONG_RUNNING_MS + 1).kind).toBe('long')
})

test('band: a finished job shows for ten minutes, then disappears', () => {
  const done = job({ status: 'done', finishedAt: 1_000 })
  expect(bandFor([done], 1_000 + FINISHED_SHOWN_MS - 1).kind).toBe('finished')
  expect(bandFor([done], 1_000 + FINISHED_SHOWN_MS + 1).kind).toBe('hidden')
})

test('a message asking for delegation is recognised', () => {
  expect(userAskedToDelegate('have Codex implement this')).toBe(true)
  expect(userAskedToDelegate('delegate the parser to a subagent')).toBe(true)
  expect(userAskedToDelegate('fix the parser bug')).toBe(false)
  expect(userAskedToDelegate('the console says resolved')).toBe(false) // "sol" only as a whole word
})

test('read-only delegations are never blocked', () => {
  expect(isReadOnly({ subagentType: 'Explore' })).toBe(true)
  expect(isReadOnly({ command: 'node x/codex-delegate/scripts/relay.mjs --brief b.txt --lane review' })).toBe(true)
  expect(isReadOnly({ command: 'node x/codex-delegate/scripts/relay.mjs --brief b.txt --read-only' })).toBe(true)
  expect(isReadOnly({ command: 'node x/codex-delegate/scripts/relay.mjs --brief b.txt --lane implement' })).toBe(false)
  expect(isReadOnly({ subagentType: 'general-purpose' })).toBe(false)
})

test('the refusal tells Claude what to do instead', () => {
  expect(refusalReason(1)).toContain('Do it directly')
})

test('a codex-companion task is recognised with its flags and task text', () => {
  const call = parseCompanion(
    'node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --background --write --model gpt-6-luna "Fix the limit conversion in src/parser.py and add a test"',
  )
  expect(call).toEqual({
    subcommand: 'task', background: true, write: true, model: 'gpt-6-luna',
    text: 'Fix the limit conversion in src/parser.py and add a test',
  })
  expect(parseCompanion('node x/codex-companion.mjs review --wait')?.subcommand).toBe('review')
  expect(parseCompanion('npm test')).toBe(null)
})

test('a background companion job id is read from its launch message', () => {
  expect(
    backgroundCompanionJobId('Fix parser started in the background as task-mgx1a2b. Check /codex:status task-mgx1a2b for progress.'),
  ).toBe('task-mgx1a2b')
  expect(backgroundCompanionJobId('done')).toBe(null)
})

test('the rescue subagent and read-only rescue requests are recognised', () => {
  expect(isCodexRescue('codex:codex-rescue')).toBe(true)
  expect(isCodexRescue('general-purpose')).toBe(false)
  expect(isReadOnlyRequest('investigate why the gate times out')).toBe(true)
  expect(isReadOnlyRequest('investigate and fix the gate timeout')).toBe(false)
})

test('platform: macOS and Linux are unix, Windows (with or without Git tools) is windows', () => {
  expect(platformFromUname('Darwin\n')).toBe('unix')
  expect(platformFromUname('Linux\n')).toBe('unix')
  expect(platformFromUname('MINGW64_NT-10.0-19045\n')).toBe('windows')
  expect(platformFromUname(null)).toBe('windows')
})

test('process commands differ per platform, and pkill gets a literal pattern', () => {
  expect(listProcessesArgv('unix')).toEqual(['ps', '-axo', 'command'])
  expect(listProcessesArgv('windows')[0]).toBe('powershell')
  expect(killMatchingArgv('unix', '/tmp/brief (1).txt')).toEqual(['pkill', '-f', '/tmp/brief \\(1\\)\\.txt'])
  expect(killMatchingArgv('windows', "C:/it's/brief.txt")[3]).toContain("Contains('C:/it''s/brief.txt')")
})

test('hand over / hand off count as asking for delegation', () => {
  expect(userAskedToDelegate('hand this over and keep going')).toBe(true)
  expect(userAskedToDelegate('can you hand it off?')).toBe(true)
  expect(userAskedToDelegate('write the handover notes')).toBe(true)
  expect(userAskedToDelegate('the handle is off by one')).toBe(false)
})

test('the lane map is grouped by implementer, and empty without lanes', () => {
  const text = laneMapText({
    lanes: {
      implement: { implementer: 'codex', model: 'gpt-6-luna' },
      'deep-review': { implementer: 'codex', model: 'gpt-6.1-sol', readOnly: true },
      research: { implementer: 'agy', model: 'gemini-3.8-flash-medium', readOnly: true },
    },
  })
  expect(text).toContain('- codex (codex-delegate): implement -> gpt-6-luna; deep-review -> gpt-6.1-sol, read-only')
  expect(text).toContain('- agy (agy-delegate): research -> gemini-3.8-flash-medium, read-only')
  expect(laneMapText({})).toBe('')
  expect(laneMapText(null)).toBe('')
})

test('a command runs --model if given, else its lane, else the default', () => {
  const lanes = { review: { implementer: 'codex', model: 'gpt-6-luna-custom' } }
  expect(modelFor('codex-review', 'gpt-6.1-sol', lanes)).toBe('gpt-6.1-sol')
  expect(modelFor('codex-review', null, lanes)).toBe('gpt-6-luna-custom')
  expect(modelFor('codex-adversarial-review', null, {})).toBe('gpt-6.1-sol')
  expect(modelFor('agy-rescue', null, {})).toBe('gemini-3.8-flash-high')
  expect(modelFor('agy-adversarial-review', null, {})).toBe('gemini-3.1-pro-high')
})

test('run flags come out of the arguments; the task text stays', () => {
  expect(splitArgs('--background --model gemini-3.8-flash-low fix the exporter --base main')).toEqual({
    background: true,
    model: 'gemini-3.8-flash-low',
    base: 'main',
    text: 'fix the exporter',
  })
  expect(splitArgs('--wait look at auth')).toEqual({ background: false, model: null, base: null, text: 'look at auth' })
})

test('Codex arguments get a model only when none was given', () => {
  expect(withModel('--background', 'gpt-6-luna')).toBe('--model gpt-6-luna --background')
  expect(withModel('--model gpt-6.1-sol focus', 'gpt-6-luna')).toBe('--model gpt-6.1-sol focus')
})

test('a command file becomes a prompt: front matter gone, placeholders filled', () => {
  const md = '---\ndescription: x\n---\n\nRun ${CLAUDE_PLUGIN_ROOT}/a.mjs "$ARGUMENTS" ${UNKNOWN}'
  expect(fillTemplate(md, { CLAUDE_PLUGIN_ROOT: '/p/codex', ARGUMENTS: '--wait' })).toBe('Run /p/codex/a.mjs "--wait" ${UNKNOWN}')
})

test('an agy job is done, failed, running or has no result', () => {
  expect(agyJobState({ status: 'completed' }, false)).toBe('done')
  expect(agyJobState({ status: 'timeout' }, false)).toBe('failed')
  expect(agyJobState({ status: 'failed' }, true)).toBe('running') // a rerun over an old result
  expect(agyJobState(null, true)).toBe('running')
  expect(agyJobState(null, false)).toBe('no result')
  const table = agyStatusTable(
    [{ id: 'agy-1', kind: 'review', title: 'auth', model: 'm', startedAt: 0, state: 'running' }],
    90_000,
  )
  expect(table).toContain('| agy-1 | review | running | m | 1m 30s ago | auth |')
  expect(agyStatusTable([], 0)).toContain('No agy jobs yet')
})
