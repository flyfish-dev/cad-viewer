import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const dryRun = process.argv.slice(2).includes('--dry-run')
assert(process.argv.slice(2).every(arg => arg === '--dry-run'), 'Unknown publish argument')
assert(/^v\d+\.\d+\.\d+$/.test(process.env.RELEASE_TAG || ''), 'A stable release tag is required')
assert.equal(process.env.RELEASE_TAG, `v${pkg.version}`, 'Release tag/version mismatch')
assert.equal(pkg.private === true, false, 'Cannot publish a private package')
assert.equal(pkg.repository?.type, 'git', 'Git repository metadata is required')
assert.equal(
  String(pkg.repository?.url).replace(/^git\+/, '').replace(/\.git$/, ''),
  `https://github.com/${process.env.GITHUB_REPOSITORY}`,
  'Package repository must match the publishing workflow'
)
assert(dryRun || process.env.GITHUB_ACTIONS === 'true', 'Real publishing requires GitHub Actions')
const registry = 'https://registry.npmjs.org/'
const output = resolve(process.env.RUNNER_TEMP || tmpdir(), `npm-release-${pkg.name.replace(/[^a-z0-9.-]/gi, '-')}-${pkg.version}`)
await mkdir(output, { recursive: true })

function npm(args, allowFailure = false) {
  const result = spawnSync('npm', [...args, '--registry', registry], {
    cwd: root, encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024
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

function registryEntry() {
  const result = npm(['view', `${pkg.name}@${pkg.version}`, 'name', 'version', 'dist.integrity', '--json'], true)
  if (result.status !== 0) {
    let error
    try { error = JSON.parse(result.stdout).error } catch {}
    if (error?.code === 'E404') return null
    throw new Error(`Registry read failed: ${result.stderr || result.stdout}`)
  }
  const value = JSON.parse(result.stdout)
  assert.equal(value.name, pkg.name)
  assert.equal(value.version, pkg.version)
  assert.equal(value['dist.integrity'], integrity, 'Existing version contains different bytes; refusing to overwrite')
  return value
}

if (registryEntry()) {
  console.log(`Verified existing ${pkg.name}@${pkg.version}: ${integrity}`)
} else if (dryRun) {
  npm(['publish', tarball, '--access', 'public', '--ignore-scripts', '--dry-run'])
  console.log(`Dry run verified ${pkg.name}@${pkg.version}: ${integrity}`)
} else {
  // Do not retry an uncertain write. A rerun must verify the same package bytes first.
  npm(['publish', tarball, '--access', 'public', '--tag', 'latest', '--ignore-scripts', '--provenance'])
  let verified = false
  for (let attempt = 0; attempt < 24; attempt += 1) {
    if (registryEntry()) { verified = true; break }
    await new Promise(resolve => setTimeout(resolve, 5000))
  }
  assert(verified, 'Published version is not visible yet; rerun the same release')
  console.log(`Published and verified ${pkg.name}@${pkg.version}: ${integrity}`)
}
