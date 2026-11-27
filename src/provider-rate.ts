// Timed provider averages are independent of the current context-window sample.
/** Model streaming only (no tool or approval time): output tokens over summed stream time. */
export type AgyDecode = { outputTokens: number; streamMs: number; firstTokenMs: number | null; calls: number }
export type ProviderRate = { scope: 'turn' | 'message'; outputTokens: number; durationMs: number; completedAt: number; decode?: AgyDecode }
