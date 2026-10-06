// Drives the plugin's slash commands through the real command.run hooks: each must answer.
// (A handler that waited for the prompt it sends never answered: that prompt can only start
// after the command has finished.)

import { expect, test } from 'claude-code/testing'

const RUN = { origin: { kind: 'composer' }, presentation: {} }

// The question itself is sent as a queued prompt that only starts after the command has
// finished, so it is not observable here; what matters is that the command answers.
test('/explore answers at once, and with no question explains its usage', async ($, on) => {
  on('prompt.submit', () => ({ turnId: 't' }) as never)

  expect(
    JSON.stringify(await $.command.run({ ...RUN, command: 'explore', args: 'where is the evidence package built?' } as never)),
  ).toContain('Sent to Claude to ask agy')
  expect(JSON.stringify(await $.command.run({ ...RUN, command: 'explore', args: '' } as never))).toContain(
    'Usage: /explore',
  )
})

test('/delegate answers at once, and with no task explains its usage', async ($, on) => {
  on('prompt.submit', () => ({ turnId: 't' }) as never)

  expect(JSON.stringify(await $.command.run({ ...RUN, command: 'delegate', args: 'refactor the exporter' } as never))).toContain(
    'Sent to Claude to delegate',
  )
  expect(JSON.stringify(await $.command.run({ ...RUN, command: 'delegate', args: '  ' } as never))).toContain(
    'Usage: /delegate <task>',
  )
})

test('/delegations opens the pane', async ($, on) => {
  on('ui.open', () => ({ value: {} }) as never)

  expect(JSON.stringify(await $.command.run({ ...RUN, command: 'delegations', args: '' } as never))).toContain(
    'Delegations pane opened',
  )
})

// ---- The bundled /codex-* and /agy-* commands --------------------------------------------

/** A session started on a fake machine: HOME /home/me, no lanes file, the given commands. */
function fakeMachine(on: any, files: Record<string, string>, commands: string[] = []) {
  const written: Record<string, string> = {}
  const ran: string[][] = []
  on('clock.now', () => ({ value: 1_000_000 }))
  on('clock.every', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('command.register', (_$: unknown, e: { name: string }) => ({ value: { command: e.name } }))
  on('command.list', () => ({ value: commands.map(name => ({ name, description: '', source: 'plugin' })) }))
  on('env.get', (_$: unknown, e: { name: string }) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
  on('fs.read', (_$: unknown, e: { path: string }) => {
    const found = Object.entries(files).find(([path]) => e.path.replace(/\\/g, '/').endsWith(path))
    if (!found) {
      throw new Error(`ENOENT ${e.path}`)
    }

    return { value: found[1] }
  })
  on('fs.write', (_$: unknown, e: { path: string; text: string }) => {
    written[e.path] = e.text

    return { value: undefined }
  })
  on('fs.list', () => ({ value: [] }))
  on('process.run', (_$: unknown, e: { argv: string[] }) => {
    ran.push([...e.argv])

    return { value: { exitCode: 1, stdout: '', stderr: 'no uname' } }
  })
  on('prompt.submit', () => ({ value: { turnId: 't' } }))
  on('session.start', (_$: unknown, e: object) => ({ ...e, cwd: 'D:/Projects/claude-mods' }))

  return { written, ran }
}

const text = async ($: any, command: string, args = '') =>
  JSON.stringify(await $.command.run({ ...RUN, command, args } as never))

test('/agy-rescue records a job and answers with its id and model', async ($, on) => {
  const { written } = fakeMachine(on, { 'agy/commands/rescue.md': 'job ${JOB_ID} ${MODEL} ${TASK}' })
  await ($ as any).session.start({ source: 'startup', cwd: 'D:/Projects/claude-mods' } as never)

  expect(await text($, 'agy-rescue', 'refactor the exporter')).toContain('agy rescue (gemini-3.8-flash-high)')
  const [path, job] = Object.entries(written).find(([one]) => one.endsWith('job.json')) ?? []
  expect(String(path).replace(/\\/g, '/')).toContain('/home/me/.claude/delegation/agy-jobs/agy-')
  expect(JSON.parse(job as string)).toMatchObject({ kind: 'rescue', model: 'gemini-3.8-flash-high' })
})

test('/agy-adversarial-review uses the stronger model; --model overrides it', async ($, on) => {
  fakeMachine(on, { 'agy/commands/review.md': '${REVIEW_STYLE}' })
  await ($ as any).session.start({ source: 'startup', cwd: 'D:/Projects/claude-mods' } as never)

  expect(await text($, 'agy-adversarial-review')).toContain('gemini-3.1-pro-high')
  expect(await text($, 'agy-review', '--model gemini-3.8-flash-low')).toContain('gemini-3.8-flash-low')
})

test('/agy-status with no jobs says how to start one', async ($, on) => {
  fakeMachine(on, {})
  await ($ as any).session.start({ source: 'startup', cwd: 'D:/Projects/claude-mods' } as never)

  expect(await text($, 'agy-status')).toContain('No agy jobs yet')
  expect(await text($, 'agy-result')).toContain('No agy job to result')
})

test('/codex-status runs the bundled companion directly', async ($, on) => {
  const { ran } = fakeMachine(on, {})
  await ($ as any).session.start({ source: 'startup', cwd: 'D:/Projects/claude-mods' } as never)

  await text($, 'codex-status', '--all')
  expect(ran.some(argv => argv[0] === 'node' && argv[1].endsWith('/codex/scripts/codex-companion.mjs') && argv[2] === 'status' && argv[3] === '--all')).toBe(true)
})

test('/codex-review sends the upstream command with our default model', async ($, on) => {
  fakeMachine(on, { 'codex/commands/review.md': 'review $ARGUMENTS', 'codex/commands/adversarial-review.md': 'adversarial $ARGUMENTS' })
  await ($ as any).session.start({ source: 'startup', cwd: 'D:/Projects/claude-mods' } as never)

  expect(await text($, 'codex-review')).toContain('Codex review (gpt-6-luna)')
  expect(await text($, 'codex-adversarial-review')).toContain('gpt-6.1-sol')
})

test('with the official Codex plugin installed, /codex-* points to /codex:*', async ($, on) => {
  fakeMachine(on, {}, ['codex:rescue', 'codex:review'])
  await ($ as any).session.start({ source: 'startup', cwd: 'D:/Projects/claude-mods' } as never)

  expect(await text($, 'codex-rescue', 'fix it')).toContain('use /codex:rescue')
  expect(await text($, 'agy-status')).toContain('No agy jobs yet') // agy is unaffected
})
