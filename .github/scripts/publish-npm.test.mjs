import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const mock = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const args = process.argv.slice(2)
const cwd = process.cwd()
const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json')))
const data = Buffer.from('deterministic-package-bytes')
const integrity = 'sha512-' + crypto.createHash('sha512').update(data).digest('base64')
fs.appendFileSync(path.join(cwd, 'calls.jsonl'), JSON.stringify(args) + '\\n')
if (args[0] === 'pack') {
  const dir = args[args.indexOf('--pack-destination') + 1]
  fs.writeFileSync(path.join(dir, 'fixture.tgz'), data)
  console.log(JSON.stringify([{name: pkg.name, version: pkg.version, filename: 'fixture.tgz', integrity: process.env.MODE === 'bad-pack' ? 'wrong' : integrity}]))
} else if (args[0] === 'view') {
  if (process.env.MODE === 'registry-error') {
    console.log(JSON.stringify({error: {code: 'E401'}}))
    process.exit(1)
  }
  if (['same', 'collision'].includes(process.env.MODE) || fs.existsSync(path.join(cwd, 'published'))) {
    console.log(JSON.stringify({name: pkg.name, version: pkg.version, 'dist.integrity': process.env.MODE === 'collision' ? 'different' : integrity}))
  } else {
    console.log(JSON.stringify({error: {code: 'E404'}}))
    process.exit(1)
  }
} else if (args[0] === 'publish') {
  if (process.env.MODE === 'uncertain-write') process.exit(1)
  if (!args.includes('--dry-run')) fs.writeFileSync(path.join(cwd, 'published'), '')
} else process.exit(2)
`

async function run(t, { mode = 'absent', dryRun = true, env = {}, repository = 'https://github.com/owner/project' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'upstream-publisher-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const scripts = join(dir, '.github/scripts')
  const bin = join(dir, 'bin')
  await mkdir(scripts, { recursive: true })
  await mkdir(bin)
  await copyFile(fileURLToPath(new URL('./publish-npm.mjs', import.meta.url)), join(scripts, 'publish-npm.mjs'))
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: '@owner/fixture', version: '0.1.0', repository: { type: 'git', url: repository }
  }))
  await writeFile(join(bin, 'npm'), mock, { mode: 0o755 })
  const result = spawnSync(process.execPath, [join(scripts, 'publish-npm.mjs'), ...(dryRun ? ['--dry-run'] : [])], {
    cwd: dir, encoding: 'utf8', timeout: 20_000,
    env: {
      PATH: [bin, dirname(process.execPath)].join(':'),
      RELEASE_TAG: 'v0.1.0', GITHUB_REPOSITORY: 'owner/project',
      GITHUB_ACTIONS: 'true', RUNNER_TEMP: dir, MODE: mode, ...env
    }
  })
  let calls = []
  try { calls = (await readFile(join(dir, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse) } catch {}
  return { ...result, calls, output: result.stdout + result.stderr }
}

for (const [label, options, message] of [
  ['rejects a tag/version mismatch', { env: { RELEASE_TAG: 'v0.2.0' } }, /tag\/version mismatch/],
  ['rejects repository mismatch before any npm operation', { repository: 'https://github.com/other/project' }, /repository must match/],
  ['rejects real local publishing', { dryRun: false, env: { GITHUB_ACTIONS: '' } }, /requires GitHub Actions/]
]) test(label, async t => {
  const result = await run(t, options)
  assert.notEqual(result.status, 0)
  assert.match(result.output, message)
  assert.equal(result.calls.length, 0)
})

test('dry run checks the actual packed integrity and never performs a real publish', async t => {
  const result = await run(t)
  assert.equal(result.status, 0, result.output)
  const writes = result.calls.filter(args => args[0] === 'publish')
  assert.equal(writes.length, 1)
  assert(writes[0].includes('--dry-run'))
  assert(result.calls.every(args => args.includes('https://registry.npmjs.org/')))
})

test('accepts an identical existing package without publishing again', async t => {
  const result = await run(t, { mode: 'same', dryRun: false })
  assert.equal(result.status, 0, result.output)
  assert(!result.calls.some(args => args[0] === 'publish'))
})

for (const mode of ['collision', 'registry-error', 'bad-pack']) test('fails closed on ' + mode, async t => {
  const result = await run(t, { mode, dryRun: false })
  assert.notEqual(result.status, 0)
  assert(!result.calls.some(args => args[0] === 'publish'))
})

test('publishes once with provenance and reads back the same integrity', async t => {
  const result = await run(t, { dryRun: false })
  assert.equal(result.status, 0, result.output)
  const writes = result.calls.filter(args => args[0] === 'publish')
  assert.equal(writes.length, 1)
  assert(writes[0].includes('--provenance'))
  assert(writes[0].includes('--ignore-scripts'))
  assert.equal(result.calls.at(-1)[0], 'view')
})

test('does not retry an uncertain write', async t => {
  const result = await run(t, { mode: 'uncertain-write', dryRun: false })
  assert.notEqual(result.status, 0)
  assert.equal(result.calls.filter(args => args[0] === 'publish').length, 1)
})
