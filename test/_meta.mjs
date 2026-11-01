import assert from 'node:assert/strict'
export function checkMeta(a, expect) {
  assert.equal(a.group, expect.group)
  assert.equal(a.residency, expect.residency)
  assert.ok(a.desc.length < 140, 'desc length')
  const all = JSON.stringify(a)
  assert.ok(!/[\u2013\u2014]/.test(all), 'no dash characters')
  assert.match(a.docs, /^https:\/\//)
  assert.ok(['verified', 'partial', 'unverified', 'planned'].includes(a.status))
  assert.ok(a.verification && a.verification.length > 40)
  for (const p of a.presets) assert.ok(p.id)
}
