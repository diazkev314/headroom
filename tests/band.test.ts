import { expect, mock, test } from 'claude-code/testing'

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

// A fresh session before its first reply: no plan limits yet, only the credential to go by.
async function start($: any, on: any, kind: 'bearer' | 'api-key' | null) {
  mock.env(on, {})
  mock.clock(on)
  let rateLimits: { kind: string; percentUsed: number }[] = []
  on('session.authorize', () => ({ value: kind ? { handle: 'h', kind } : null }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { contextWindowSize: 200_000 }, rateLimits } }))
  on('settings.read', () => ({ value: {} }))
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }))
  on('session.measure', ($: any, e: any) => ({ changed: e.changed }))
  on('turn.complete', ($: any, e: any) => ({ text: e.answer, usage: e.usage }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  return {
    setLimits: (l: typeof rateLimits) => (rateLimits = l),
    reply: () =>
      $.turn.complete({
        answer: 'ok', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }),
  }
}

async function cacheLabel($: any): Promise<string | undefined> {
  const ui = await $.ui.mount({ plugin: 'headroom', surface: 'terminal', component: 'AbovePrompt', props: {} as never })
  const found = ['Cache 1h', 'Cache 5m', 'Cache …']
  let label: string | undefined
  for (const text of found) if (await ui.find({ type: 'Text', text })) label = text
  await ui.unmount()
  return label
}

test('a signed-in session shows 1h before the first reply', async ($, on) => {
  await start($, on, 'bearer')
  expect(await cacheLabel($)).toBe('Cache 1h')
})

test('an API key shows 5m before the first reply', async ($, on) => {
  await start($, on, 'api-key')
  expect(await cacheLabel($)).toBe('Cache 5m')
})

test('an unknown credential waits, then settles on the first reply', async ($, on) => {
  const s = await start($, on, null)
  expect(await cacheLabel($)).toBe('Cache …')
  await s.reply()
  expect(await cacheLabel($)).toBe('Cache 5m')
})

test('an unknown credential becomes 1h once plan limits arrive', async ($, on) => {
  const s = await start($, on, null)
  const rateLimits = [{ kind: 'five_hour', percentUsed: 12 }]
  s.setLimits(rateLimits)
  await $.session.measure({ context: { contextWindowSize: 200_000 } as never, rateLimits, changed: ['rateLimits'] })
  expect(await cacheLabel($)).toBe('Cache 1h')
  await s.reply()
  expect(await cacheLabel($)).toBe('Cache 1h')
})
