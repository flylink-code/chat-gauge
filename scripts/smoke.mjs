// Opt-in local data-path probe. Prints only aggregate metadata, never titles, IDs or contents.
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith('.ts') && /^\.\.?\/[\w/-]+$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context)
    }
    return nextResolve(specifier, context)
  }
})

const { listChats, nativeContext, resolveChat, findTranscript } = await import('../src/source.ts')
const { TranscriptTail } = await import('../src/tail.ts')
try {
  // Pass an explicit workspace selector to reproduce the worker's lookup from any directory.
  const chats = await listChats(process.argv[2] ?? 'active')
  const result = { localChats: chats.length, contextByAgent: Object.create(null), breakdownByAgent: Object.create(null), mapped: 0, transcripts: 0, samples: 0, timedSamples: 0, cacheSamples: 0 }
  for (const chat of chats) {
    const context = await nativeContext(chat.id)
    if (context && context.kind !== 'unknown') {
      result.contextByAgent[chat.agent] = (result.contextByAgent[chat.agent] ?? 0) + 1
      if (context.categories?.length) result.breakdownByAgent[chat.agent] = (result.breakdownByAgent[chat.agent] ?? 0) + 1
    }
    if (chat.agent !== 'claude') continue
    const session = await resolveChat(chat.id)
    if (!session) continue
    result.mapped++
    const path = await findTranscript(session)
    if (!path) continue
    result.transcripts++
    const sample = await new TranscriptTail(path, session.id).read()
    if (!sample) continue
    result.samples++
    if (sample.durationMs !== null) result.timedSamples++
    if (sample.cacheReadTokens !== undefined) result.cacheSamples++
  }
  console.log(JSON.stringify(result))
  if (!result.samples && !Object.keys(result.contextByAgent).length) process.exitCode = 1
} catch (error) {
  // Safe summary: an execFile error may carry private stdout or paths.
  console.error('Local discovery or transcript reading failed.', error?.name ?? 'Error', error?.code ?? '')
  process.exitCode = 1
}
