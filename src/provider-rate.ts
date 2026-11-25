// Timed provider averages are independent of the current context-window sample.
export type ProviderRate = { scope: 'turn' | 'message'; outputTokens: number; durationMs: number; completedAt: number }
