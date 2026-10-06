// The focus mod's rules, as plain functions with no access to the app.
// They are tested on their own in logic.test.ts; register.tsx only does the wiring.

import type { Current, Task, Win } from '../types'

const MINUTE_MS = 60_000
/** A gap this long counts as "you went away and came back". */
export const BREAK_MS = 20 * MINUTE_MS
const MAX_NEXT_LENGTH = 160
const MAX_TITLE_LENGTH = 60

/** Remove the markdown that would show up as stray symbols in a one-line band. */
function plain(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // [label](url) -> label
    .replace(/[*_`]/g, '')
    .trim()
}

function shorten(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`
}

/**
 * Find the next action in a reply.
 * The ADHD writing rules make replies end with a line like "Next: run the tests".
 * If a reply has several, the last one wins, because it is the current one.
 * Returns null when the reply has no such line.
 */
export function extractNext(reply: string): string | null {
  // Start of a line, optional bold markers, "Next" or "Next step", a colon, then the action.
  const matches = [...reply.matchAll(/^[ \t>*_-]*Next(?: step)?[*_]*\s*:[*_]*\s*(.+)$/gim)]
  const last = matches.at(-1)
  if (!last) {
    return null
  }

  const action = plain(last[1])

  return action === '' ? null : shorten(action, MAX_NEXT_LENGTH)
}

/**
 * Find a time estimate in a reply, in minutes: "about 15 minutes" -> 15, "~2 hours" -> 120.
 * Only phrases that sound like an estimate count (about, around, roughly, ~, ≈), so a
 * plain "5 minutes ago" is not mistaken for one.
 */
export function extractEstimateMinutes(reply: string): number | null {
  const match = reply.match(
    /(?:about|around|roughly|approximately|~|≈)\s*(\d+(?:\.\d+)?)\s*(minutes?|mins?|hours?|hrs?)\b/i,
  )
  if (!match) {
    return null
  }

  const amount = Number(match[1])

  return Math.round(match[2].toLowerCase().startsWith('h') ? amount * 60 : amount)
}

/** A prompt turned into a short task name: first line only, trimmed to fit. */
export function titleFromPrompt(prompt: string): string {
  const firstLine = plain(prompt).split('\n')[0] ?? ''

  return shorten(firstLine, MAX_TITLE_LENGTH)
}

/** 47 minutes -> "47m", 130 minutes -> "2h 10m", under a minute -> "<1m". */
export function formatDuration(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / MINUTE_MS)
  if (minutes < 1) {
    return '<1m'
  }
  if (minutes < 60) {
    return `${minutes}m`
  }

  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** The calendar day of a moment, in local time, as "2026-10-06". Used to reset wins daily. */
export function dayOf(ms: number): string {
  const date = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** "10:42" in local time. */
export function clockTime(ms: number): string {
  const date = new Date(ms)

  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** Only the wins from the same calendar day as `now`. */
export function winsToday(wins: readonly Win[], now: number): Win[] {
  const today = dayOf(now)

  return wins.filter(win => dayOf(win.at) === today)
}

/**
 * The id of a newly created task, read from the tool's own answer:
 * "Task #3 created successfully: Write the parser" -> "3".
 */
export function createdTaskId(resultText: string): string | null {
  return resultText.match(/Task #(\S+) created/)?.[1] ?? null
}

/** Apply a TaskUpdate call to the list. Unknown ids are ignored. */
export function updateTask(
  tasks: readonly Task[],
  id: string,
  change: { subject?: string; status?: string },
): Task[] {
  // A deleted task is removed; any other status we do not know is left as it was.
  if (change.status === 'deleted') {
    return tasks.filter(task => task.id !== id)
  }
  const status =
    change.status === 'pending' || change.status === 'in_progress' || change.status === 'completed'
      ? change.status
      : undefined

  return tasks.map(task =>
    task.id === id
      ? { ...task, subject: change.subject ?? task.subject, status: status ?? task.status }
      : task,
  )
}

/** "Step 3 of 5": finished tasks plus the one in hand. Null when there is no task list. */
export function stepProgress(tasks: readonly Task[]): { step: number; of: number } | null {
  if (tasks.length === 0) {
    return null
  }
  const done = tasks.filter(task => task.status === 'completed').length

  return { step: Math.min(done + 1, tasks.length), of: tasks.length }
}

/** Minutes over the estimate so far, or null when on track or there is no estimate. */
export function overEstimateMs(current: Current | null, now: number): number | null {
  if (!current || current.estimateMinutes === null) {
    return null
  }
  const over = now - current.startedAt - current.estimateMinutes * MINUTE_MS

  return over > 0 ? over : null
}

/** What the one-line band should show. */
export type Band =
  | { kind: 'hidden' }
  | { kind: 'idle' }
  | { kind: 'next'; next: string }
  | { kind: 'missing' }
  | { kind: 'welcome'; awayMs: number; title: string | null; next: string | null }

/**
 * Decide the band's form.
 *   hidden   nothing to say yet (no reply, nothing parked, no wins)
 *   idle     no reply yet, but there are parked thoughts or wins: counters only
 *   welcome  you have been away for a while: remind what you were doing
 *   next     the normal case: the pinned next action
 *   missing  the last reply gave no next action
 */
export function bandFor(input: {
  hasReply: boolean
  next: string | null
  current: Current | null
  lastActivityAt: number
  now: number
  isWorking: boolean
  hasExtras: boolean
}): Band {
  if (!input.hasReply) {
    // Before the first reply there is no next action to judge, but parked thoughts
    // or wins carried over from earlier are still worth a line.
    return input.hasExtras ? { kind: 'idle' } : { kind: 'hidden' }
  }

  const awayMs = input.now - input.lastActivityAt
  // Not while Claude is working: a long turn is not you being away.
  if (!input.isWorking && awayMs >= BREAK_MS && (input.next || input.current)) {
    return { kind: 'welcome', awayMs, title: input.current?.title ?? null, next: input.next }
  }

  return input.next ? { kind: 'next', next: input.next } : { kind: 'missing' }
}
