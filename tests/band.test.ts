import { expect, test } from 'claude-code/testing'

import { duration, isMiss, tokens } from '../hooks/register'

test('formats durations and limits', async () => {
  expect(duration(272_000)).toBe('4:32')
  expect(duration(2 * 3600_000 + 14 * 60_000)).toBe('2h 14m')
})

test('band shows limits and a cold cache', async ($, on) => {
  on('session.measure', ($, e) => ({ changed: e.changed }))
  await $.session.measure({
    context: { contextWindowSize: 200_000 } as never,
    rateLimits: [{ kind: 'seven_day', percentUsed: 41 }],
    changed: ['rateLimits'],
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'headroom', surface, component: 'AbovePrompt', props: {} as never })
    expect(await ui.find({ type: 'Text', text: '41%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Cold' })).toBeDefined()
    await ui.unmount()
  }
})


test('counts tokens and spots cache misses', async () => {
  expect(tokens(142_300)).toBe('142k')
  expect(tokens(1_250_000)).toBe('1.3M')
  expect(isMiss(150_000, 900)).toBe(false)
  expect(isMiss(3_000, 140_000)).toBe(true)
})

test('band shows a context meter without a details button', async $ => {
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'headroom', surface, component: 'AbovePrompt', props: {} as never })
    expect(await band.find({ type: 'Text', text: 'Context' })).toBeDefined()
    expect(await band.find({ key: 'details' })).toBeUndefined()
    expect(await band.find({ key: 'keep-warm' })).toBeDefined()
    await band.unmount()
  }
})
