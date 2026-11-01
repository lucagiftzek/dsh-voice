#!/usr/bin/env node
/**
 * Privacy and style check for what is about to be committed or published.
 *
 *   node scripts/privacy-check.mjs            added lines of `git diff HEAD` + untracked files
 *   node scripts/privacy-check.mjs --all      every tracked + untracked file
 *   node scripts/privacy-check.mjs --range A..B   added lines of a commit range
 *
 * Fails (exit 1) on: the private terms in PRIVACY_TERMS (comma-separated), home paths,
 * private IP ranges, key-shaped strings, and em or en dashes.
 *
 * Prints file:line and the rule, never the matched text of a secret.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const sh = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

const EM = String.fromCharCode(0x2014)
const EN = String.fromCharCode(0x2013)
const RULES = [
  // Extra private terms (your host names, people, install owners) come from
  // the environment, never from this file: PRIVACY_TERMS="alpha.example,bob".
  ...String(process.env.PRIVACY_TERMS || '').split(',').map((t) => t.trim()).filter(Boolean)
    .map((t) => ['private term', new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')]),
  ['home path', /\/home\/[a-z_][a-z0-9_-]*/i],
  ['private IP', /\b(192\.168\.\d+\.\d+|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)\b/],
  ['key-shaped string', /\b(sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xi-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,}|lm_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30,})\b/],
  ['em or en dash', new RegExp('[' + EM + EN + ']')],
]
// The 1.x history notes were scrubbed in the pre-merge review: every file now fails on a hit.
const HISTORICAL = new Set([])
const SKIP = (f) => /^(node_modules|\.git)\//.test(f) || /\.(png|jpg|ico|woff2?|map)$/.test(f) || f === 'scripts/privacy-check.mjs'

function* addedLines() {
  const args = process.argv.slice(2)
  const all = args.includes('--all')
  const ri = args.indexOf('--range')
  if (ri >= 0) {
    let file = ''
    let n = 0
    for (const line of sh(['diff', '--unified=0', args[ri + 1]]).split('\n')) {
      if (line.startsWith('+++ b/')) file = line.slice(6)
      else if (line.startsWith('@@')) n = Number(/\+(\d+)/.exec(line)[1]) - 1
      else if (line.startsWith('+') && !line.startsWith('+++')) { n += 1; if (!SKIP(file)) yield [file, n, line.slice(1)] }
    }
    return
  }
  const files = new Set(sh(['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean))
  if (all) sh(['ls-files']).split('\n').filter(Boolean).forEach((f) => files.add(f))
  else {
    let file = ''
    let n = 0
    for (const line of sh(['diff', '--unified=0', 'HEAD']).split('\n')) {
      if (line.startsWith('+++ b/')) file = line.slice(6)
      else if (line.startsWith('@@')) n = Number(/\+(\d+)/.exec(line)[1]) - 1
      else if (line.startsWith('+') && !line.startsWith('+++')) { n += 1; if (!SKIP(file)) yield [file, n, line.slice(1)] }
    }
  }
  for (const f of files) {
    if (SKIP(f)) continue
    let text
    try { text = fs.readFileSync(path.join(root, f), 'utf8') } catch (e) { continue }
    if (text.includes('\u0000')) continue
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i += 1) yield [f, i + 1, lines[i]]
  }
}

let fail = 0
let note = 0
for (const [file, n, line] of addedLines()) {
  for (const [name, re] of RULES) {
    if (!re.test(line)) continue
    const hist = HISTORICAL.has(file)
    if (hist) note += 1
    else fail += 1
    console.log((hist ? 'note ' : 'FAIL ') + file + ':' + n + ' ' + name)
  }
}
console.log('privacy-check: ' + fail + ' failure(s)' + (note ? ', ' + note + ' historical note(s) in docs/HISTORY-1.x.md (rewrite before any public push)' : ''))
process.exit(fail ? 1 : 0)
