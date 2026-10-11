import assert from 'node:assert/strict'
import test from 'node:test'
import { waitForRegistry } from './registry-propagation.mjs'

function clock() {
  let elapsed = 0
  return { now: () => elapsed, pause: async ms => { elapsed += ms } }
}

test('accepts visibility after the former two-minute deadline without another write', async () => {
  const time = clock()
  let reads = 0
  const value = { integrity: 'expected-package-bytes' }
  const result = await waitForRegistry(() => {
    reads++
    return time.now() >= 180_000 ? value : null
  }, time)
  assert.equal(result, value)
  assert.equal(time.now(), 180_000)
  assert.equal(reads, 37)
})

test('stops at the deadline and bounds each registry request by the remaining time', async () => {
  const time = clock()
  const requestLimits = []
  const result = await waitForRegistry(limit => {
    requestLimits.push(limit)
    return null
  }, { ...time, timeoutMs: 12_000, intervalMs: 5_000 })
  assert.equal(result, null)
  assert.equal(time.now(), 12_000)
  assert.deepEqual(requestLimits, [12_000, 7_000, 2_000])
})

test('retries temporary read failures but rejects an integrity collision immediately', async () => {
  const time = clock()
  let reads = 0
  const collision = new Error('Existing version contains different bytes')
  await assert.rejects(waitForRegistry(() => {
    if (++reads === 1) throw Object.assign(new Error('Network timeout'), { code: 'ETIMEDOUT', retryable: true })
    throw collision
  }, time), error => error === collision)
  assert.equal(reads, 2)
  assert.equal(time.now(), 5_000)
})

test('rejects authentication failures without waiting or another read', async () => {
  const time = clock()
  let reads = 0
  await assert.rejects(waitForRegistry(() => {
    reads++
    throw Object.assign(new Error('Authentication failed'), { code: 'E401' })
  }, time), /Authentication failed/)
  assert.equal(reads, 1)
  assert.equal(time.now(), 0)
})
