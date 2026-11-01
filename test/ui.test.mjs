// The shared look (src/client/ui.jsx): token-based colours only, one idempotent <style>.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

async function loadUi() {
  const { build } = await import('esbuild')
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const r = await build({
    entryPoints: [new URL('../src/client/ui.jsx', import.meta.url).pathname], bundle: true, write: false, format: 'esm', platform: 'node',
    jsx: 'transform', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment', loader: { '.js': 'jsx', '.jsx': 'jsx' }, external: ['react'], logLevel: 'silent',
  })
  const file = join(mkdtempSync(join(tmpdir(), 'dshv-ui-')), 'ui.mjs')
  writeFileSync(file, r.outputFiles[0].text.replace(/from "react"/g, 'from ' + JSON.stringify(require.resolve('react'))))
  return import(file)
}

test('ui stylesheet: colours come from host tokens, no hard-coded surfaces, no dashes', async () => {
  const { CSS } = await loadUi()
  // every hex colour must be a var() fallback, never a bare declaration value
  const bare = CSS.split(/[;{}]/).filter((d) => /#[0-9a-f]{3,8}\b/i.test(d) && !/var\(/.test(d))
  assert.deepEqual(bare, [])
  for (const t of ['--dsw-alias-label-primary', '--dsw-alias-border-l2', '--dsw-alias-bg-layer-2', '--dsw-alias-button-primary-fill', '--tz-radius']) assert.ok(CSS.includes(t), 'uses ' + t)
  assert.ok(!/[\u2013\u2014]/.test(CSS))
  assert.ok(/:focus-visible/.test(CSS) && /:disabled/.test(CSS))
})

test('ensureStyles injects one <style> and refreshes it in place', async () => {
  const { ensureStyles, STYLE_ID, CSS } = await loadUi()
  const nodes = []
  const doc = {
    head: { appendChild: (n) => nodes.push(n) },
    getElementById: (id) => nodes.find((n) => n.id === id) || null,
    createElement: () => ({ id: '', textContent: '' }),
  }
  globalThis.document = doc
  try {
    assert.equal(ensureStyles(), true)
    nodes[0].textContent = 'stale'
    assert.equal(ensureStyles(), true)
    assert.equal(nodes.length, 1)
    assert.equal(nodes[0].id, STYLE_ID)
    assert.equal(nodes[0].textContent, CSS)
  } finally { delete globalThis.document }
  assert.equal(ensureStyles(), false)
})
