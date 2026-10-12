export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Ttl = '5m' | '1h'
export type Context = { tokens?: number; window: number; percent?: number }

declare module 'claude-code' {
  interface PluginState {
    'headroom': {
      limits: Limit[]
      context: Context | null
      cacheAt: number | null
      isBusy: boolean
      now: number
      ttl: Ttl | null
      ttlReason: string
      keepWarm: boolean
      /** Keep-warm refreshes since the last main-thread turn. */
      refreshes: number
      isAutoWarm: boolean
      isWarmDismissed: boolean
      expectRebuild: boolean
      warned: string[]
      /** A main-thread turn has had an API response, so missing plan limits mean no subscription. */
      hasReply: boolean
    }
  }
}
