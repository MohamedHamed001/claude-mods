// Drives the real hooks the way a session does: a reply arrives, then the app draws
// the band and the pane. Catches wiring mistakes that logic.test.ts cannot see.

import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'focus',
  surface: 'desktop',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

test('after a reply with a Next line, the band shows it with a Do it button', async ($, on) => {
  // Stand-ins for what the app itself answers beneath every mod.
  on('clock.now', () => ({ value: 1_000_000 }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('ui.render', { component: 'AbovePrompt' }, ($$, e) => {
    const { Text } = $$.ui.resolve(e)

    return <Text>ENGINE</Text>
  })

  await $.turn.complete({
    answer: 'Fixed it.\n\nNext: run the tests and paste the first failing line.',
    durationMs: 1000,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
  })

  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ text: /Next: run the tests/ })) !== undefined).toBe(true)
  expect((await ui.find({ key: 'do-it' })) !== undefined).toBe(true)
  expect((await ui.find({ key: 'open-focus' })) !== undefined).toBe(true)
  // What other mods and the app drew is still there, under our line.
  expect((await ui.find({ text: /ENGINE/ })) !== undefined).toBe(true)
})

test('the pane draws on the desktop surface', async ($, on) => {
  const ui = await $.ui.mount({
    plugin: 'focus',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'focus',
    props: {} as never,
  })
  expect((await ui.find({ text: /Done today/ })) !== undefined).toBe(true)
  expect((await ui.find({ key: 'recap' })) !== undefined).toBe(true)
})
