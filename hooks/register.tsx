import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Context, Limit, Ttl } from '../types'

const limits = atom({ plugin: 'headroom', key: 'limits' } as const, [])
const context = atom({ plugin: 'headroom', key: 'context' } as const, null)
const cacheAt = atom({ plugin: 'headroom', key: 'cacheAt' } as const, null)
const isBusy = atom({ plugin: 'headroom', key: 'isBusy' } as const, false)
const now = atom({ plugin: 'headroom', key: 'now' } as const, 0)
const ttl = atom({ plugin: 'headroom', key: 'ttl' } as const, null)
const ttlReason = atom({ plugin: 'headroom', key: 'ttlReason' } as const, '')
const refreshes = atom({ plugin: 'headroom', key: 'refreshes' } as const, 0)
const keepWarm = atom({ plugin: 'headroom', key: 'keepWarm' } as const, false)
const isAutoWarm = atom({ plugin: 'headroom', key: 'isAutoWarm' } as const, false)
const isWarmDismissed = atom({ plugin: 'headroom', key: 'isWarmDismissed' } as const, false)
const expectRebuild = atom({ plugin: 'headroom', key: 'expectRebuild' } as const, false)
const warned = atom({ plugin: 'headroom', key: 'warned' } as const, [])
const hasReply = atom({ plugin: 'headroom', key: 'hasReply' } as const, false)

// Tokyo Night accents. label is the theme's error color, which follows light and dark mode; it is meant
// to match the inline-code red (text-danger-000) in the desktop app.
const HEX = { label: 'error', blue: '#7aa2f7', green: '#9ece6a', yellow: '#e0af68', red: '#f7768e', purple: '#bb9af7', muted: '#565f89' }

const LABELS: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'Spend' }
const TTL_MS: Record<Ttl, number> = { '5m': 300_000, '1h': 3_600_000 }
// Like Pi's warmer: refresh at 90% of the cache lifetime.
const PING_AT = 0.9
const LIMIT_WARNINGS = [80, 95]

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  if (m >= 10) return `${m}m`
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

export function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

// A turn missed the cache when it had to write more of the prompt than it could read back.
export function isMiss(read: number, write: number): boolean {
  return write > 2000 && write > read
}

let forced: Ttl | null = null
let keepWarmMs = 3 * 3_600_000
let autoWarmTokens = 100_000
let isWarning = true
let pingTimer: { cancel: () => void } | null = null
let expiryTimer: { cancel: () => void } | null = null
let idleSince = 0
let credential: 'bearer' | 'api-key' | null = null

// Claude Code 2.1.294's rule for the main thread (bce/Nen in the binary): env and settings overrides
// first, then 1h for a subscriber within plan limits, 5m for API keys or extra (overage) usage.
// Plan limits only arrive with the first API response, so until then the session's credential decides:
// an API key is 5m, a sign-in (bearer) 1h, anything else unknown. Once a reply came back without
// limits, it is not a subscription: 5m.
async function resolveTtl($: EngineInterface, rateLimits: Limit[]): Promise<void> {
  let found: [Ttl | null, string]
  const fromEnv = await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL')
  const fromSettings = ((await $.settings.read()) as Record<string, unknown>).promptCacheTtl
  const isSubscriber = rateLimits.length > 0
  const isReplied = await read($, hasReply)
  if (forced) found = [forced, 'set in this mod’s options']
  else if (await $.env.get('FORCE_PROMPT_CACHING_5M')) found = ['5m', 'FORCE_PROMPT_CACHING_5M is set']
  else if (fromEnv === '5m' || fromEnv === '1h') found = [fromEnv, 'CLAUDE_CODE_PROMPT_CACHE_TTL is set']
  else if (fromSettings === '5m' || fromSettings === '1h') found = [fromSettings, 'promptCacheTtl in settings']
  else if (await $.env.get('ENABLE_PROMPT_CACHING_1H')) found = ['1h', 'ENABLE_PROMPT_CACHING_1H is set']
  else if (!isSubscriber && credential === 'api-key') found = ['5m', 'API key']
  else if (!isSubscriber && isReplied) found = ['5m', 'no plan limits reported']
  else if (!isSubscriber && credential === 'bearer') found = ['1h', 'signed in; plan limits not reported yet']
  else if (!isSubscriber) found = [null, 'waiting for the first response']
  else if (rateLimits.some(l => l.percentUsed >= 100)) found = ['5m', 'extra usage past your plan limit']
  else found = ['1h', 'subscription within plan limits']
  await update($, ttl, () => found[0])
  await update($, ttlReason, () => found[1])
}

async function ttlMs($: EngineInterface): Promise<number> {
  return TTL_MS[(await read($, ttl)) ?? '5m']
}

async function ping($: EngineInterface): Promise<void> {
  pingTimer = null
  if ((await read($, isBusy)) || !(await read($, keepWarm))) return
  const r = await $.model.fork({ prompt: 'Keep-alive ping. Reply with only: ok' })
  if (!r.isAnswered) return
  await update($, cacheAt, () => Date.now())
  await update($, refreshes, n => n + 1)
  await schedulePing($)
}

// Refreshes the cache shortly before it lapses, while keep-warm is on and within its time limit.
async function schedulePing($: EngineInterface): Promise<void> {
  pingTimer?.cancel()
  pingTimer = null
  const last = await read($, cacheAt)
  if (!(await read($, keepWarm)) || last === null) return
  const at = Date.now()
  const wait = Math.max(1000, last + (await ttlMs($)) * PING_AT - at)
  if (at + wait - idleSince > keepWarmMs) return
  pingTimer = $.clock.after(wait, () => void ping($))
}

// Notifies a few minutes before an idle cache expires, unless keep-warm will refresh it.
async function scheduleExpiryNotice($: EngineInterface): Promise<void> {
  expiryTimer?.cancel()
  expiryTimer = null
  const last = await read($, cacheAt)
  if (!isWarning || last === null) return
  const span = await ttlMs($)
  const lead = span >= TTL_MS['1h'] ? 5 * 60_000 : 60_000
  const wait = last + span - lead - Date.now()
  if (wait <= 0) return
  expiryTimer = $.clock.after(wait, async () => {
    expiryTimer = null
    if ((await read($, isBusy)) || (await read($, keepWarm))) return
    await $.ui.notify(`Prompt cache expires in ${duration(lead)}. Send a message or turn on Keep warm.`, {
      title: 'Claude Code cache',
    })
  })
}

async function setKeepWarm($: EngineInterface, isOn: boolean): Promise<void> {
  await update($, keepWarm, () => isOn)
  await update($, isAutoWarm, () => false)
  if (!isOn) await update($, isWarmDismissed, () => true)
  idleSince = Date.now()
  await schedulePing($)
}

async function warnLimits($: EngineInterface, list: Limit[]): Promise<void> {
  if (!isWarning) return
  const seen = await read($, warned)
  for (const l of list) {
    const crossed = LIMIT_WARNINGS.filter(t => l.percentUsed >= t).pop()
    const id = `${l.kind}:${crossed}:${l.resetsAt ?? ''}`
    if (crossed === undefined || seen.includes(id)) continue
    await update($, warned, ids => [...ids, id].slice(-50))
    const reset = l.resetsAt ? `, resets in ${duration(Date.parse(l.resetsAt) - Date.now())}` : ''
    $.ui.toast(`${LABELS[l.kind] ?? l.kind} usage at ${Math.round(l.percentUsed)}%${reset}`, { timeoutMs: 8000 })
  }
}

export const register: Register = (on, options) => {
  forced = options.cacheTtl === '5m' || options.cacheTtl === '1h' ? (options.cacheTtl as Ttl) : null
  keepWarmMs = Math.max(0.25, Number(options.keepWarmHours ?? 3)) * 3_600_000
  autoWarmTokens = Math.max(0, Number(options.autoKeepWarmTokens ?? 100_000))
  isWarning = options.warnings !== false
  pingTimer = null
  expiryTimer = null

  on('session.start', async ($, e, next) => {
    try {
      credential = (await $.session.authorize())?.kind ?? null
    } catch {
      credential = null
    }
    const usage = await $.session.usage()
    await update($, limits, () => usage.rateLimits)
    await update($, context, () => usage.context)
    await resolveTtl($, usage.rateLimits)
    await update($, now, () => Date.now())
    $.clock.every(1000, () => void update($, now, () => Date.now()))
    await $.command.register({ name: 'keep-warm', description: 'Toggle keeping the prompt cache warm while idle' })

    return next(e)
  })

  on('command.run', { command: 'keep-warm' }, async $ => {
    await setKeepWarm($, !(await read($, keepWarm)))
    return { text: `Keep warm ${(await read($, keepWarm)) ? 'on' : 'off'}.` }
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) {
      await update($, limits, () => e.rateLimits)
      const before = await read($, ttl)
      await resolveTtl($, e.rateLimits)
      await warnLimits($, e.rateLimits)
      if ((await read($, ttl)) !== before && !(await read($, isBusy))) {
        await schedulePing($)
        await scheduleExpiryNotice($)
      }
    }
    if (e.changed.includes('context')) {
      await update($, context, () => e.context)
    }
    return next(e)
  })

  // A compacted prompt is rebuilt from scratch: that write is expected, not a miss.
  on('session.compact', async ($, e, next) => {
    await update($, expectRebuild, () => true)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    pingTimer?.cancel()
    pingTimer = null
    expiryTimer?.cancel()
    expiryTimer = null
    await update($, isBusy, () => true)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) {
      const at = await $.clock.now()
      idleSince = at
      const lastAt = await read($, cacheAt)
      const isRebuild = await read($, expectRebuild)
      await update($, expectRebuild, () => false)
      if (isWarning && e.usage && lastAt !== null && !isRebuild) {
        const { cache_read_input_tokens: hit, cache_creation_input_tokens: write } = e.usage
        if (isMiss(hit, write)) {
          $.ui.toast(`Cache miss, ${tokens(write)} tokens re-cached after ${duration(at - lastAt)} idle`, { timeoutMs: 8000 })
        }
      }
      await update($, cacheAt, () => at)
      await update($, isBusy, () => false)
      await update($, refreshes, () => 0)
      // The first API response settles whether plan limits exist; usage marks a turn that reached the API.
      if (e.usage && !(await read($, hasReply))) {
        await update($, hasReply, () => true)
        const latest = (await $.session.usage()).rateLimits
        await update($, limits, () => latest)
        await resolveTtl($, latest)
      }

      const size = (await read($, context))?.tokens ?? 0
      const shouldArm = autoWarmTokens > 0 && size >= autoWarmTokens
      if (shouldArm && !(await read($, keepWarm)) && !(await read($, isWarmDismissed))) {
        await update($, keepWarm, () => true)
        await update($, isAutoWarm, () => true)
        $.ui.toast(`Keep warm turned on for this ${tokens(size)}-token context`, { timeoutMs: 6000 })
      }
      await schedulePing($)
      await scheduleExpiryNotice($)
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const list: Limit[] = await read($, limits)
    const ctx: Context | null = await read($, context)
    const at = (await read($, now)) || Date.now()
    const last = await read($, cacheAt)
    const busy = await read($, isBusy)
    const warmOn = await read($, keepWarm)
    const refreshCount = await read($, refreshes)
    const known = await read($, ttl)
    const isReplied = await read($, hasReply)
    const span = TTL_MS[known ?? '5m']
    const left = last === null ? 0 : Math.max(0, last + span - at)
    const isSvg = e.surface !== 'terminal'
    const { Box, Text, Button, Svg } = $.ui.resolve(e) as ReturnType<typeof $.ui.resolve> & { Svg?: any }

    // Fixed, compact bars: the band holds four meters and a button without wrapping.
    const barPx = 48
    const barCells = 10

    const bar = (fraction: number, color: string) => {
      const f = Math.min(1, Math.max(0, fraction))
      if (isSvg && Svg) {
        const w = barPx
        const svg =
          `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="4" viewBox="0 0 ${w} 4">` +
          `<rect width="${w}" height="4" rx="2" fill="rgba(128,128,128,0.25)"/>` +
          (f > 0 ? `<rect width="${Math.max(4, f * w)}" height="4" rx="2" fill="${color}"/>` : '') +
          `</svg>`
        return <Svg source={svg} alt={`${Math.round(f * 100)}%`} width={w} height={4} />
      }
      // The sextant that fills a cell's middle third (U+1FB0B): a thick bar centred on the text line.
      // Ghostty, Kitty and WezTerm draw it themselves, so the cells join without gaps.
      const filled = Math.round(f * barCells)
      return (
        <Text>
          <Text color={color}>{'\u{1FB0B}'.repeat(filled)}</Text>
          <Text color="inactive">{'\u{1FB0B}'.repeat(barCells - filled)}</Text>
        </Text>
      )
    }

    // The terminal's fonts lack a crisp ↻, so it draws the Nerd Font refresh icon (nf-md-refresh) instead.
    const resetIcon = isSvg ? '↻' : '\u{F0450}'

    const meters = list.map(l => {
      const color = l.percentUsed >= 90 ? HEX.red : l.percentUsed >= 70 ? HEX.yellow : HEX.blue
      const reset = l.resetsAt ? duration(Date.parse(l.resetsAt) - at) : ''
      return (
        <Box flexDirection="row" alignItems="center" gap={1} flexShrink={0}>
          <Text color={HEX.label}>{LABELS[l.kind] ?? l.kind}</Text>
          {bar(l.percentUsed / 100, color)}
          <Text bold>{`${Math.round(l.percentUsed)}%`}</Text>
          {reset && <Text bold color={HEX.blue}>{`${resetIcon} ${reset}`}</Text>}
        </Box>
      )
    })

    const ctxPercent = ctx?.percent ?? (ctx?.tokens ? (ctx.tokens / ctx.window) * 100 : 0)
    const ctxColor = ctxPercent >= 85 ? HEX.red : ctxPercent >= 70 ? HEX.yellow : HEX.blue
    const ctxMeter = (
      <Box flexDirection="row" alignItems="center" gap={1} flexShrink={0}>
        <Text color={HEX.label}>Context</Text>
        {bar(ctxPercent / 100, ctxColor)}
        <Text bold>{`${Math.round(ctxPercent)}%`}</Text>
      </Box>
    )

    let cacheLabel: string
    let cacheColor: string
    if (busy) {
      cacheLabel = 'Live'
      cacheColor = HEX.green
    } else if (last === null) {
      cacheLabel = 'Cold'
      cacheColor = HEX.muted
    } else if (left === 0) {
      cacheLabel = 'Expired'
      cacheColor = HEX.yellow
    } else {
      cacheLabel = duration(left)
      cacheColor = left < 60_000 ? HEX.yellow : HEX.green
    }

    return (
      <Box flexDirection="row" alignItems="center" justifyContent="space-between" width="100%" gap={2} flexWrap="nowrap">
        {meters.length ? (
          meters
        ) : isReplied ? (
          <Text color="inactive">No plan limits</Text>
        ) : (
          <Text color={HEX.purple}>Limits load after first reply</Text>
        )}
        {ctxMeter}
        <Box flexDirection="row" alignItems="center" gap={1} flexShrink={0}>
          <Text color={HEX.label}>{`Cache ${known ?? '…'}`}</Text>
          {bar(busy ? 1 : left / span, cacheColor)}
          <Text bold={last !== null || busy} color={last === null && !busy ? 'inactive' : undefined}>
            {cacheLabel}
          </Text>
          <Button
            key="keep-warm"
            label={warmOn ? (refreshCount > 0 ? `● Warm · ${refreshCount}` : '● Warm') : '○ Warm'}
            variant={warmOn ? 'primary' : undefined}
            dimColor={!warmOn}
            onPress={() => setKeepWarm($, !warmOn)}
          />
        </Box>
      </Box>
    )
  })
}
