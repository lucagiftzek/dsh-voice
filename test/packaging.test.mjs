// Packaging: what an installer receives must be loadable and must include the documentation a user needs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

test('every entry point the manifest declares exists in the tree', () => {
  const entries = [pkg.main, pkg.exports && pkg.exports['.'], pkg.exports && pkg.exports['./client'], pkg.dsh.bundle.patch]
    .filter(Boolean).map((f) => String(f).replace(/^\.\//, ''))
  assert.ok(entries.length >= 4)
  for (const f of entries) assert.ok(existsSync(join(root, f)), 'missing entry point: ' + f)
})

test('the published file list carries the documents a user reads, not only the code', () => {
  const files = pkg.files || []
  for (const required of ['lib', 'cordis.patch.yml', 'README.md', 'CHANGELOG.md', 'LICENSE', 'docs/TOOLS.md', 'docs/PROVIDERS.md', 'docs/TROUBLESHOOTING.md', 'docs/ERRORS.md', 'CONTRIBUTING.md', 'SECURITY.md', 'docs/media']) {
    assert.ok(files.includes(required), 'not published: ' + required)
    assert.ok(existsSync(join(root, required)), 'declared but absent: ' + required)
  }
})

test('the client bundle carries the identity the build declares, and both agree with the package name', () => {
  const src = readFileSync(join(root, 'scripts/build.mjs'), 'utf8')
  const bundle = readFileSync(join(root, 'lib/client.js'), 'utf8')
  const fromBuild = /export const ID = '([^']+)'/.exec(src)
  assert.ok(fromBuild, 'build.mjs declares ID')
  const id = fromBuild[1]
  // the banner writes the id inside single quotes, so compare against that form
  assert.ok(bundle.includes("id: '" + id + "'"), 'the committed bundle carries the declared identity')
  // the package name and the bundle identity must agree, or a loader cannot match them
  assert.equal(pkg.name, id, 'package name and client bundle identity must be the same string')
})
