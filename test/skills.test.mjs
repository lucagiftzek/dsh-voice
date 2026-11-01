// The packaged voice-doctor skill is discoverable and registered through ctx.inject(['skills']).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { registerPluginSkills, createSkillProvider } from '../lib/plugin-skills.js'

const DIR = new URL('../skills/', import.meta.url)

test('voice-doctor skill is found, named after its folder, and under 200 lines', async () => {
  const p = createSkillProvider('dsh-voice', DIR)
  const list = await p.list()
  assert.deepEqual(list.map((x) => x.name), ['voice-doctor'])
  assert.ok(list[0].description.length > 40)
  const got = await p.get(list[0])
  assert.match(got.content, /# dsh-voice doctor/)
  assert.ok(fs.readFileSync(new URL('voice-doctor/SKILL.md', DIR), 'utf8').split('\n').length < 200)
})

test('registerPluginSkills registers one provider and never throws without a skills service', () => {
  let provider = null
  const ctx = { inject: (names, cb) => { assert.deepEqual(names, ['skills']); cb({ skills: { registerProvider: (f) => { provider = f() } } }) } }
  assert.equal(registerPluginSkills(ctx, { plugin: 'dsh-voice', dir: DIR }), 1)
  assert.equal(provider.name, 'plugin-dsh-voice')
  assert.equal(registerPluginSkills({}, { plugin: 'dsh-voice', dir: DIR }), 0)
  assert.equal(registerPluginSkills(null, { plugin: 'dsh-voice', dir: DIR }), 0)
})

test('every doctor check id and code named in the skill and the troubleshooting guide exists', async () => {
  const { E } = await import('../lib/errors.js')
  for (const f of ['../skills/voice-doctor/SKILL.md', '../docs/TROUBLESHOOTING.md']) {
    const text = fs.readFileSync(new URL(f, import.meta.url), 'utf8')
    for (const m of text.matchAll(/\bVOICE_[A-Z_]+\b/g)) assert.ok(E.has(m[0]), f + ' names an unknown code ' + m[0])
  }
})
