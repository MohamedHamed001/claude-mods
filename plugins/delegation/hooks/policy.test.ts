// Drives the real tool.call hooks: does the plugin refuse small delegations, and let the
// others through? The test's own tool.call hook stands for the tool actually running.

import { expect, test } from 'claude-code/testing'

const SMALL_PROMPT = 'Fix the limit conversion in src/infrastructure/parsers/arxml_signal_parser.py'

test('a small implementation delegation is refused with the reason', async ($, on) => {
  let ran = false
  on('tool.call', () => {
    ran = true

    return { result: { text: 'subagent output' } } as never
  })

  const answer = await $.tool.call({
    tool: 'Agent',
    description: 'fix parser',
    prompt: SMALL_PROMPT,
    subagent_type: 'general-purpose',
    model: 'sonnet',
  } as never)

  expect(ran).toBe(false)
  expect(JSON.stringify(answer)).toContain('Delegation refused by the delegation plugin')
})

test('a read-only exploration naming one file is allowed', async ($, on) => {
  let ran = false
  on('clock.now', () => ({ value: 1_000 }))
  on('tool.call', () => {
    ran = true

    return { result: { text: 'found it' } } as never
  })

  await $.tool.call({
    tool: 'Agent',
    description: 'find usages',
    prompt: 'Where is src/infrastructure/parsers/arxml_signal_parser.py imported?',
    subagent_type: 'Explore',
    run_in_background: false,
  } as never)

  expect(ran).toBe(true)
})

test('a small /codex:rescue the user did not ask for is refused', async ($, on) => {
  let ran = false
  on('tool.call', () => {
    ran = true

    return { result: { text: 'forwarded' } } as never
  })

  const answer = await $.tool.call({
    tool: 'Agent',
    description: 'codex fix',
    prompt: SMALL_PROMPT,
    subagent_type: 'codex:codex-rescue',
  } as never)

  expect(ran).toBe(false)
  expect(JSON.stringify(answer)).toContain('Delegation refused')
})

test('a small codex-companion task with --write, called directly, is refused', async ($, on) => {
  let ran = false
  on('tool.call', () => {
    ran = true

    return { result: { text: 'started' } } as never
  })

  const answer = await $.tool.call({
    tool: 'Bash',
    command: `node "/plugins/codex/scripts/codex-companion.mjs" task --write "${SMALL_PROMPT}"`,
  } as never)

  expect(ran).toBe(false)
  expect(JSON.stringify(answer)).toContain('Delegation refused')
})

test('a codex-companion review is read-only and allowed', async ($, on) => {
  let ran = false
  on('clock.now', () => ({ value: 1_000 }))
  on('tool.call', () => {
    ran = true

    return { result: { text: 'review done' } } as never
  })

  await $.tool.call({
    tool: 'Bash',
    command: 'node "/plugins/codex/scripts/codex-companion.mjs" review --wait --scope working-tree',
  } as never)

  expect(ran).toBe(true)
})
