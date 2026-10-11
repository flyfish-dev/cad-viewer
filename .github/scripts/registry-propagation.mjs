// Only registry reads are retried. The caller owns the single publication write.
export async function waitForRegistry(read, {
  timeoutMs = 10 * 60_000,
  intervalMs = 5_000,
  now = () => performance.now(),
  pause = ms => new Promise(resolve => setTimeout(resolve, ms)),
  onPoll = () => {}
} = {}) {
  const started = now()
  const deadline = started + timeoutMs
  let attempt = 0
  while (now() < deadline) {
    let readError
    try {
      const entry = await read(Math.max(1, Math.min(30_000, deadline - now())))
      if (entry) return entry
    } catch (error) {
      if (!error.retryable) throw error
      readError = error.code
    }
    onPoll({ attempt: ++attempt, elapsedMs: Math.round(now() - started), readError })
    const remaining = deadline - now()
    if (remaining > 0) await pause(Math.min(intervalMs, remaining))
  }
  return null
}
