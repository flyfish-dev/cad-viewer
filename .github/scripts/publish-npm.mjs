import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { waitForRegistry } from './registry-propagation.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const dryRun = process.argv.slice(2).includes('--dry-run')
const verifyOnly = process.argv.slice(2).includes('--verify-only') ||
  (!dryRun && Number(process.env.GITHUB_RUN_ATTEMPT || 1) > 1)
assert(process.argv.slice(2).every(arg => ['--dry-run', '--verify-only'].includes(arg)), 'Unknown publish argument')
assert(!(dryRun && verifyOnly), 'Choose dry run or verification only')
assert(/^v\d+\.\d+\.\d+$/.test(process.env.RELEASE_TAG || ''), 'A stable release tag is required')
assert.equal(process.env.RELEASE_TAG, `v${pkg.version}`, 'Release tag/version mismatch')
assert.equal(pkg.private === true, false, 'Cannot publish a private package')
assert.equal(pkg.repository?.type, 'git', 'Git repository metadata is required')
assert.equal(
  String(pkg.repository?.url).replace(/^git\+/, '').replace(/\.git$/, ''),
  `https://github.com/${process.env.GITHUB_REPOSITORY}`,
  'Package repository must match the publishing workflow'
)
assert(dryRun || verifyOnly || process.env.GITHUB_ACTIONS === 'true', 'Real publishing requires GitHub Actions')
const registry = 'https://registry.npmjs.org/'
const output = resolve(process.env.RUNNER_TEMP || tmpdir(), `npm-release-${pkg.name.replace(/[^a-z0-9.-]/gi, '-')}-${pkg.version}`)
await mkdir(output, { recursive: true })

function npm(args, allowFailure = false, timeout = 180_000) {
  const result = spawnSync('npm', [...args, '--registry', registry], {
    cwd: root, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024
  })
  if (result.error) throw result.error
  if (result.status !== 0 && !allowFailure) throw new Error(result.stderr || result.stdout)
  return result
}

const packed = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', output]).stdout)
assert.equal(packed.length, 1, 'Exactly one package must be packed')
const [entry] = packed
assert.equal(entry.name, pkg.name)
assert.equal(entry.version, pkg.version)
assert.equal(basename(entry.filename), entry.filename, 'Invalid tarball filename')
const tarball = resolve(output, entry.filename)
const integrity = `sha512-${createHash('sha512').update(await readFile(tarball)).digest('base64')}`
assert.equal(entry.integrity, integrity, 'Packed tarball integrity mismatch')

const receipt = { name: pkg.name, version: pkg.version, integrity, filename: entry.filename }
async function record(status, details = {}) {
  const value = { ...receipt, status, ...details }
  await writeFile(resolve(output, 'receipt.json'), JSON.stringify(value, null, 2) + '\n')
  console.log('NPM_RELEASE ' + JSON.stringify(value))
}
await record('packed')

function registryEntry(timeout) {
  let result
  try {
    result = npm(['view', `${pkg.name}@${pkg.version}`, 'name', 'version', 'dist.integrity', '--json'], true, timeout)
  } catch (error) {
    if (error.code === 'ETIMEDOUT') error.retryable = true
    throw error
  }
  if (result.status !== 0) {
    let error
    try { error = JSON.parse(result.stdout).error } catch {}
    if (error?.code === 'E404') return null
    const failure = new Error(`Registry read failed: ${result.stderr || result.stdout}`)
    failure.code = error?.code
    failure.retryable = ['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ENOTFOUND', 'E500', 'E502', 'E503', 'E504'].includes(error?.code)
    throw failure
  }
  const value = JSON.parse(result.stdout)
  assert.equal(value.name, pkg.name)
  assert.equal(value.version, pkg.version)
  assert.equal(value['dist.integrity'], integrity, 'Existing version contains different bytes; refusing to overwrite')
  return value
}

if (registryEntry()) {
  await record('verified-existing')
  console.log(`Verified existing ${pkg.name}@${pkg.version}: ${integrity}`)
} else if (dryRun) {
  npm(['publish', tarball, '--access', 'public', '--ignore-scripts', '--dry-run'])
  await record('dry-run-verified')
  console.log(`Dry run verified ${pkg.name}@${pkg.version}: ${integrity}`)
} else {
  if (verifyOnly) {
    await record('verification-only')
  } else {
    // Never retry an uncertain write. Workflow retries take the read-only path above.
    await record('publish-started')
    try {
      npm(['publish', tarball, '--access', 'public', '--tag', 'latest', '--ignore-scripts', '--provenance'])
    } catch (error) {
      await record('publish-result-uncertain')
      throw error
    }
    await record('publish-accepted')
  }
  const visible = await waitForRegistry(registryEntry, {
    onPoll: details => console.log('NPM_REGISTRY_WAIT ' + JSON.stringify(details))
  })
  if (!visible) {
    await record(verifyOnly ? 'verification-pending' : 'publish-accepted-verification-pending')
    throw new Error('Registry visibility deadline reached; check the recorded integrity with --verify-only. Do not publish again.')
  }
  await record(verifyOnly ? 'verified-existing' : 'published-and-verified')
  console.log(`Verified ${pkg.name}@${pkg.version}: ${integrity}`)
}
