// Checks for the rules in logic.ts. Run with: claude plugin test <this mod's folder>

import { expect, test } from 'claude-code/testing'

import {
  BREAK_MS,
  bandFor,
  createdTaskId,
  extractEstimateMinutes,
  extractNext,
  formatDuration,
  overEstimateMs,
  stepProgress,
  titleFromPrompt,
  updateTask,
  winsToday,
} from './logic'

const MINUTE = 60_000

test('the next action is read from the reply’s Next line', () => {
  expect(extractNext('Fixed the import.\n\nNext: run the tests and paste the first failing line.')).toBe(
    'run the tests and paste the first failing line.',
  )
})

test('markdown around the Next line is removed', () => {
  expect(extractNext('**Next:** open `src/auth.ts` and read [the docs](https://x.y)')).toBe(
    'open src/auth.ts and read the docs',
  )
  expect(extractNext('- Next step: press **Start**')).toBe('press Start')
})

test('with several Next lines, the last one is the current one', () => {
  expect(extractNext('Next: do A\nmore text\nNext: do B')).toBe('do B')
})

test('a reply without a Next line gives nothing to pin', () => {
  expect(extractNext('All done. The next thing to consider is caching.')).toBe(null)
})

test('a very long next action is cut to fit one line', () => {
  const action = extractNext(`Next: ${'word '.repeat(80)}`)
  expect(action?.length).toBe(160)
  expect(action?.endsWith('…')).toBe(true)
})

test('estimates are read in minutes', () => {
  expect(extractEstimateMinutes('This is about 15 minutes of work.')).toBe(15)
  expect(extractEstimateMinutes('Roughly 2 hours if tests exist.')).toBe(120)
  expect(extractEstimateMinutes('~1.5 hrs')).toBe(90)
})

test('a time that is not an estimate is ignored', () => {
  expect(extractEstimateMinutes('The server restarted 5 minutes ago.')).toBe(null)
})

test('a prompt becomes a short task title', () => {
  expect(titleFromPrompt('fix the frontend start\nit fails with a rolldown error')).toBe(
    'fix the frontend start',
  )
  expect(titleFromPrompt('x'.repeat(100)).length).toBe(60)
})

test('durations are short and readable', () => {
  expect(formatDuration(20_000)).toBe('<1m')
  expect(formatDuration(47 * MINUTE)).toBe('47m')
  expect(formatDuration(130 * MINUTE)).toBe('2h 10m')
})

test('only wins from the same day count as today', () => {
  const now = new Date(2026, 9, 6, 15, 0).getTime()
  const yesterday = new Date(2026, 9, 5, 23, 50).getTime()
  const thisMorning = new Date(2026, 9, 6, 9, 5).getTime()
  expect(
    winsToday([{ text: 'old', at: yesterday }, { text: 'new', at: thisMorning }], now).map(w => w.text),
  ).toEqual(['new'])
})

test('a created task’s id is read from the tool’s answer', () => {
  expect(createdTaskId('Task #3 created successfully: Write the parser')).toBe('3')
  expect(createdTaskId('something else')).toBe(null)
})

const TASKS = [
  { id: '1', subject: 'Parser', status: 'completed' as const },
  { id: '2', subject: 'Mapper', status: 'in_progress' as const },
  { id: '3', subject: 'Tests', status: 'pending' as const },
]

test('a task update changes status and subject, and a delete removes it', () => {
  expect(updateTask(TASKS, '3', { status: 'in_progress' })[2].status).toBe('in_progress')
  expect(updateTask(TASKS, '3', { subject: 'More tests' })[2].subject).toBe('More tests')
  expect(updateTask(TASKS, '2', { status: 'deleted' }).map(t => t.id)).toEqual(['1', '3'])
  expect(updateTask(TASKS, '9', { status: 'completed' })).toEqual(TASKS) // unknown id: no change
})

test('step progress counts finished tasks plus the one in hand', () => {
  expect(stepProgress(TASKS)).toEqual({ step: 2, of: 3 })
  expect(stepProgress([])).toBe(null)
  // All finished: stay at "3 of 3", not "4 of 3".
  expect(stepProgress(TASKS.map(t => ({ ...t, status: 'completed' as const })))).toEqual({ step: 3, of: 3 })
})

test('over-estimate appears only once the estimate has passed', () => {
  const task = { title: 't', startedAt: 0, estimateMinutes: 15 }
  expect(overEstimateMs(task, 10 * MINUTE)).toBe(null)
  expect(overEstimateMs(task, 47 * MINUTE)).toBe(32 * MINUTE)
  expect(overEstimateMs({ ...task, estimateMinutes: null }, 47 * MINUTE)).toBe(null)
})

const BASE = {
  hasReply: true,
  next: 'run the tests',
  current: { title: 'fix the frontend start', startedAt: 0, estimateMinutes: null },
  lastActivityAt: 0,
  now: 5 * MINUTE,
  isWorking: false,
  hasExtras: false,
}

test('band: normally shows the pinned next action', () => {
  expect(bandFor(BASE)).toEqual({ kind: 'next', next: 'run the tests' })
})

test('band: warns when the last reply had no next action', () => {
  expect(bandFor({ ...BASE, next: null })).toEqual({ kind: 'missing' })
})

test('band: after a break it reminds you what you were doing', () => {
  expect(bandFor({ ...BASE, now: BREAK_MS + MINUTE })).toEqual({
    kind: 'welcome',
    awayMs: BREAK_MS + MINUTE,
    title: 'fix the frontend start',
    next: 'run the tests',
  })
})

test('band: a long turn is not treated as you being away', () => {
  expect(bandFor({ ...BASE, now: BREAK_MS + MINUTE, isWorking: true }).kind).toBe('next')
})

test('band: a fresh session with parked thoughts shows counters only, no warning', () => {
  expect(bandFor({ ...BASE, hasReply: false, next: null, current: null, hasExtras: true })).toEqual({ kind: 'idle' })
})

test('band: hidden in a fresh session with nothing to show', () => {
  expect(bandFor({ ...BASE, hasReply: false, next: null, current: null })).toEqual({ kind: 'hidden' })
})
