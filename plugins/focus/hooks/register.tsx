// Focus: keeps the one next action in front of you.
//
// What you see:
//   - A one-line band above the prompt: the pinned next action with a "Do it" button,
//     then three small counters (time on task, done today, parked) and a Focus button.
//   - A pane (Focus button or /focus-pane) with five sections: Now, Time, Parked,
//     Done today, Where you left off.
//
// Where each piece of information comes from:
//   next action     the "Next: ..." line at the end of Claude's reply
//   steps           Claude's task list, when the session uses one
//   time            a clock started by your first prompt of a task
//   parked          things you typed after /park
//   wins            tasks Claude marked completed, or your press of Done
//   recap           one question to the model, only when you press Refresh recap
//
// The rules (how a reply is read, when the band changes form) are in logic.ts.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Current, Task, Win } from '../types'
import {
  bandFor,
  clockTime,
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

const PANE = 'focus'
const TICK_MS = 30_000
// Saved values. Parked thoughts are kept per project folder, wins for everyone.
const PARKED_KEY = 'parked'
const WINS_KEY = 'wins'

// An atom is a named value the app stores for this mod. Writing to one makes the app
// redraw whatever read it, which is how the band and pane update by themselves.
const next = atom({ plugin: 'focus', key: 'next' } as const, null)
const hasReply = atom({ plugin: 'focus', key: 'hasReply' } as const, false)
const current = atom({ plugin: 'focus', key: 'current' } as const, null)
const tasks = atom({ plugin: 'focus', key: 'tasks' } as const, [])
const parked = atom({ plugin: 'focus', key: 'parked' } as const, [])
const wins = atom({ plugin: 'focus', key: 'wins' } as const, [])
const lastActivityAt = atom({ plugin: 'focus', key: 'lastActivityAt' } as const, 0)
const sessionStartedAt = atom({ plugin: 'focus', key: 'sessionStartedAt' } as const, 0)
const recap = atom({ plugin: 'focus', key: 'recap' } as const, null)
const now = atom({ plugin: 'focus', key: 'now' } as const, 0)

// The project folder this session runs in; the key parked thoughts are saved under.
let projectFolder = ''

/** Save the parked list for this project. */
async function saveParked($: EngineInterface, list: readonly string[]) {
  const all = ((await $.store.get(PARKED_KEY)) ?? {}) as Record<string, readonly string[]>
  await $.store.set(PARKED_KEY, { ...all, [projectFolder]: list })
}

/** Change the parked list and save it. */
async function changeParked($: EngineInterface, change: (list: string[]) => string[]) {
  await update($, parked, change)
  await saveParked($, await read($, parked))
}

/** Record something as finished: add it to today's wins and close the current task. */
async function recordWin($: EngineInterface, text: string) {
  const at = await $.clock.now()
  const win: Win = { text, at }

  // Other sessions add wins too, so start from the saved list, not only ours.
  const saved = ((await $.store.get(WINS_KEY)) ?? []) as Win[]
  const today = [...winsToday(saved, at), win]
  await $.store.set(WINS_KEY, today)
  await update($, wins, () => today)

  // The task is over: the next prompt starts a new one with a fresh clock.
  await update($, current, () => null)
  $.ui.toast(`Done: ${text} · ${today.length} today`)
}

/**
 * Note a failure where it can be found later, without disturbing the session.
 * Hooks here must never break a prompt or a turn, so their errors are caught. Caught
 * errors that vanish are impossible to debug, so the last one is saved to the mod's
 * store (a small JSON file under ~/.claude/plugins/store/).
 */
async function report($: EngineInterface, where: string, error: unknown) {
  try {
    await $.store.set('lastError', { where, error: String(error), at: await $.clock.now() })
  } catch {
    // Nothing more can be done if even this fails.
  }
}

/** Send text to Claude as if you had typed it. */
async function send($: EngineInterface, text: string) {
  // Not awaited: a submitted prompt only starts once the session is idle, so waiting for it
  // from a button press could hold the press until a running turn ends.
  void $.prompt.submit({ text, asUser: true }).catch(() => undefined)
}

/** Ask the model for a short "where you left off" summary. Costs one model call. */
async function refreshRecap($: EngineInterface) {
  await update($, recap, () => 'Asking Claude…')
  const answer = await $.model.fork({
    prompt:
      'In two short plain sentences, say what the user was working on in this ' +
      'conversation and what state it is in. No preamble, no formatting.',
  })
  const text = answer.isAnswered ? answer.text.trim() : 'Could not get a recap just now.'
  await update($, recap, () => text)
}

/** Called for every prompt you send. */
async function onPrompt($: EngineInterface, text: string) {
  const at = await $.clock.now()
  await update($, lastActivityAt, () => at)
  await update($, now, () => at)

  // No task in hand: this prompt starts one. Slash commands are not tasks.
  if ((await read($, current)) === null && !text.trimStart().startsWith('/')) {
    const started: Current = { title: titleFromPrompt(text), startedAt: at, estimateMinutes: null }
    await update($, current, () => started)
  }
}

/** Called when Claude finishes a reply in the main conversation. */
async function onReply($: EngineInterface, answer: string) {
  const at = await $.clock.now()
  const action = extractNext(answer)
  await update($, next, () => action)
  await update($, hasReply, () => true)
  await update($, lastActivityAt, () => at)
  await update($, now, () => at)

  // Keep the first estimate given for a task, so later replies cannot move the goalposts.
  const estimate = extractEstimateMinutes(answer)
  if (estimate !== null) {
    await update($, current, task =>
      task && task.estimateMinutes === null ? { ...task, estimateMinutes: estimate } : task,
    )
  }
}

/** Read the text out of a tool's result, whatever shape this build gives it. */
function resultText(ran: unknown): string {
  const result = (ran as { result?: { text?: unknown } } | undefined)?.result

  return typeof result?.text === 'string' ? result.text : ''
}

export const register: Register = on => {
  on('session.start', async ($, e, next_) => {
    // Nothing here may stop the session from starting, so the setup is optional.
    try {
      projectFolder = e.cwd
      const at = await $.clock.now()
      await update($, now, () => at)
      await update($, lastActivityAt, value => (value === 0 ? at : value))
      await update($, sessionStartedAt, value => (value === 0 ? at : value))

      const allParked = ((await $.store.get(PARKED_KEY)) ?? {}) as Record<string, string[]>
      await update($, parked, () => allParked[projectFolder] ?? [])
      const savedWins = ((await $.store.get(WINS_KEY)) ?? []) as Win[]
      await update($, wins, () => winsToday(savedWins, at))

      // /park first: it matters more, and a refused name must not block the other.
      // (The app refuses a name it already uses itself; /focus is one of those.)
      await $.command.register({
        name: 'park',
        description: 'Set a thought aside for later: /park <thought>',
      })
      await $.command.register({ name: 'focus-pane', description: 'Open the focus pane' })
    } catch (error) {
      await report($, 'session.start', error)
      // The band still works without saved values or commands.
    }

    const tick = async () => {
      const time = await $.clock.now()
      await update($, now, () => time)
    }
    $.clock.every(TICK_MS, () => void tick())

    return next_(e)
  })

  on('command.run', { command: 'focus-pane' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Focus' })

    return { text: 'Focus pane opened.' }
  })

  on('command.run', { command: 'park' }, async ($, e) => {
    const thought = e.args.trim()
    if (thought === '') {
      return { text: 'Usage: /park <thought to come back to later>' }
    }
    await changeParked($, list => [...list, thought])

    return { text: `Parked: ${thought}` }
  })

  on('prompt.submit', async ($, e, next_) => {
    try {
      await onPrompt($, e.text)
    } catch (error) {
      await report($, 'prompt.submit', error)
      // Never let bookkeeping stop a prompt from being sent.
    }

    return next_(e)
  })

  on('turn.complete', async ($, e, next_) => {
    const result = await next_(e)

    // Subagents have their own conversations; only the main reply sets the next action.
    if (!e.agentId) {
      try {
        await onReply($, e.answer)
      } catch (error) {
      await report($, 'turn.complete', error)
        // Same rule: reading the reply must not affect the turn.
      }
    }

    return result
  })

  // Claude's task list, when it keeps one. We let each call run, then mirror it.
  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next_) => {
    const ran = await next_(e)
    try {
      const id = createdTaskId(resultText(ran))
      if (id && !e.agentId) {
        const task: Task = { id, subject: e.subject, status: 'pending' }
        await update($, tasks, list => [...list.filter(one => one.id !== id), task])
      }
    } catch (error) {
      await report($, 'TaskCreate', error)
      // A task list we cannot mirror only costs the "step N of M" line.
    }

    return ran
  })

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next_) => {
    const ran = await next_(e)
    try {
      if (!e.agentId) {
        const before = (await read($, tasks)).find(task => task.id === e.taskId)
        await update($, tasks, list => updateTask(list, e.taskId, { subject: e.subject, status: e.status }))

        // A task moving to "completed" is a win, counted once.
        if (before && before.status !== 'completed' && e.status === 'completed') {
          await recordWin($, e.subject ?? before.subject)
        }
        // A task moving to "in progress" names what you are working on now.
        if (before && e.status === 'in_progress') {
          const at = await $.clock.now()
          const title = e.subject ?? before.subject
          await update($, current, () => ({ title, startedAt: at, estimateMinutes: null }))
        }
      }
    } catch (error) {
      await report($, 'TaskUpdate', error)
      // As above.
    }

    return ran
  })

  // The band: one line, drawn above whatever other mods draw here.
  //
  // Every mod's band line uses the same three columns so the lines stack neatly:
  //   [ 2-cell icon ] [ text, takes the free space ] [ counters and buttons ]
  // The text column growing is what pushes the buttons to the right edge.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next_) => {
    const beneath = await next_(e)
    if (e.props.hasSurvey) {
      return beneath
    }

    const task = await read($, current)
    const time = await read($, now)
    const todayWins = await read($, wins)
    const parkedList = await read($, parked)
    const band = bandFor({
      hasReply: await read($, hasReply),
      next: await read($, next),
      current: task,
      lastActivityAt: await read($, lastActivityAt),
      now: time,
      isWorking: e.props.isWorking,
      hasExtras: todayWins.length > 0 || parkedList.length > 0,
    })
    if (band.kind === 'hidden') {
      return beneath
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const action = band.kind === 'next' || band.kind === 'welcome' ? band.next : null

    return (
      <Box flexDirection="column" rowGap={1}>
        <Box columnGap={1} alignItems="center">
          <Box width={2}>
            {band.kind === 'missing' ? <Text color="warning">!</Text> : <Text dimColor>→</Text>}
          </Box>

          <Box flexGrow={1} flexShrink={1}>
            {band.kind === 'next' && <Text wrap="truncate-end">Next: {band.next}</Text>}
            {band.kind === 'idle' && <Text dimColor>No next action yet</Text>}
            {band.kind === 'missing' && (
              <Text color="warning" wrap="truncate-end">
                No next action in the last reply
              </Text>
            )}
            {band.kind === 'welcome' && (
              <Text wrap="truncate-end">
                Away {formatDuration(band.awayMs)}.
                {band.title ? ` You were: ${band.title}.` : ''}
                {band.next ? ` Next: ${band.next}` : ''}
              </Text>
            )}
          </Box>

          {/* The three counters. Each is left out when it has nothing to say. */}
          {task && <Text dimColor>{formatDuration(time - task.startedAt)}</Text>}
          {todayWins.length > 0 && <Text color="success">✓ {todayWins.length}</Text>}
          {parkedList.length > 0 && <Text dimColor>{parkedList.length} parked</Text>}

          {action && (
            <Button key="do-it" label="Do it" variant="primary" onPress={() => send($, action)} />
          )}
          {band.kind === 'missing' && (
            <Button
              key="ask-next"
              label="Ask for one"
              onPress={() => send($, 'What is the single next action? End with a "Next:" line.')}
            />
          )}
          <Button
            key="open-focus"
            label="Focus"
            onPress={() => $.ui.open({ id: PANE, title: 'Focus' })}
          />
        </Box>
        {beneath}
      </Box>
    )
  })

  // The pane: five sections, each in its own outlined card.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const task = await read($, current)
    const action = await read($, next)
    const time = await read($, now)
    const taskList = await read($, tasks)
    const parkedList = await read($, parked)
    const todayWins = await read($, wins)
    const summary = await read($, recap)
    const lastActive = await read($, lastActivityAt)
    const startedAt = await read($, sessionStartedAt)
    const { Box, Button, Text } = $.ui.resolve(e)

    const progress = stepProgress(taskList)
    const over = overEstimateMs(task, time)

    // Two small builders so every section and every row is laid out the same way.
    // They are plain functions returning elements, not new element types.

    /** One outlined card with a muted heading. */
    const section = (title: string, body: unknown) => (
      <Box flexDirection="column" rowGap={1} paddingX={1} borderStyle="round" borderDimColor>
        <Text dimColor>{title}</Text>
        {body}
      </Box>
    )

    /** A label on the left and its value on the right. */
    const row = (label: string, value: string, tone?: 'warning') => (
      <Box columnGap={2}>
        <Box flexGrow={1}>
          <Text dimColor={tone === undefined} color={tone}>
            {label}
          </Text>
        </Box>
        <Text dimColor={tone === undefined} color={tone}>
          {value}
        </Text>
      </Box>
    )

    return (
      <Box flexDirection="column" rowGap={1} padding={1}>
        {section(
          'Now',
          <Box flexDirection="column" rowGap={1}>
            <Text bold>{task ? task.title : 'No task in hand. Your next message starts one.'}</Text>
            {progress && (
              <Box columnGap={1}>
                {/* One dot per task: done ones filled green, the rest hollow. */}
                <Text color="success">{'●'.repeat(progress.step - 1)}</Text>
                <Text>●</Text>
                <Text dimColor>{'○'.repeat(progress.of - progress.step)}</Text>
                <Text dimColor>
                  Step {progress.step} of {progress.of}
                </Text>
              </Box>
            )}
            <Box columnGap={2} alignItems="center">
              <Box flexGrow={1} flexShrink={1}>
                <Text>{action ? `Next: ${action}` : 'No next action yet.'}</Text>
              </Box>
              {action && (
                <Button
                  key="pane-do-it"
                  label="Do it"
                  variant="primary"
                  onPress={() => send($, action)}
                />
              )}
              {task && <Button key="done" label="Done" onPress={() => recordWin($, task.title)} />}
            </Box>
          </Box>,
        )}

        {section(
          'Time',
          <Box flexDirection="column">
            {task && row('On this task', formatDuration(time - task.startedAt))}
            {task &&
              task.estimateMinutes !== null &&
              row('Estimate given', formatDuration(task.estimateMinutes * 60_000))}
            {over !== null && row('Over by', formatDuration(over), 'warning')}
            {row('Session', formatDuration(time - startedAt))}
          </Box>,
        )}

        {section(
          `Parked (${parkedList.length})`,
          <Box flexDirection="column" rowGap={1}>
            {parkedList.map((thought, index) => (
              <Box columnGap={1} alignItems="center">
                <Box flexGrow={1} flexShrink={1}>
                  <Text>{thought}</Text>
                </Box>
                <Button
                  key={`park-start:${index}`}
                  label="Start"
                  onPress={async () => {
                    await changeParked($, list => list.filter((_, i) => i !== index))
                    await send($, thought)
                  }}
                />
                <Button
                  key={`park-drop:${index}`}
                  label="Drop"
                  onPress={() => changeParked($, list => list.filter((_, i) => i !== index))}
                />
              </Box>
            ))}
            <Text dimColor>Type /park and a thought to add one</Text>
          </Box>,
        )}

        {section(
          `Done today (${todayWins.length})`,
          <Box flexDirection="column">
            {todayWins.map(win => (
              <Box columnGap={1}>
                <Text color="success">✓</Text>
                <Box flexGrow={1} flexShrink={1}>
                  <Text>{win.text}</Text>
                </Box>
                <Text dimColor>{clockTime(win.at)}</Text>
              </Box>
            ))}
            {todayWins.length === 0 && <Text dimColor>Nothing yet today</Text>}
          </Box>,
        )}

        {section(
          'Where you left off',
          <Box flexDirection="column" rowGap={1}>
            {row('Last activity', `${formatDuration(time - lastActive)} ago`)}
            {summary && <Text>{summary}</Text>}
            <Box columnGap={2} alignItems="center">
              <Button key="recap" label="Refresh recap" onPress={() => refreshRecap($)} />
              <Text dimColor>uses one model call</Text>
            </Box>
          </Box>,
        )}
      </Box>
    )
  })
}
