// The whole tree (bundle and 1.x history notes included) passes the privacy
// and style check: no private hosts, machine or install names, home paths,
// private IPs, key-shaped strings or dashes. Skipped outside a git checkout.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const root = new URL('..', import.meta.url).pathname

test('privacy-check --all is clean', { skip: !existsSync(root + '.git') }, () => {
  let out = ''
  let code = 0
  try { out = execFileSync(process.execPath, ['scripts/privacy-check.mjs', '--all'], { cwd: root, encoding: 'utf8' }) } catch (e) { code = e.status; out = String(e.stdout || '') }
  assert.equal(code, 0, out.split('\n').filter((l) => /^FAIL/.test(l)).slice(0, 10).join('\n'))
})
