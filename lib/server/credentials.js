/**
 * dsh-voice: credential sources. A provider instance stores a POINTER, resolved
 * at call time, so a key rotated on disk is picked up without a restart and no
 * install ever needs a settings edit to keep working:
 *
 *   env:NAME              process.env.NAME
 *   file:/path#NAME       a NAME=value line of a dotenv-style file (export and quotes allowed)
 *   file:/path            the whole file, trimmed
 *   dsh-ref:NAME          refs.NAME in ~/.dsh/.credentials.yaml (the DSH credential store)
 *   a|b                   the first of several pointers that resolves
 *   anything else         a literal stored in Settings (the only form that is a secret)
 *
 * Values are never logged and never leave the host half.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const POINTER_RE = /^(env|file|dsh-ref):/

/** Is this credential string a pointer (a name, safe to show) rather than a literal secret? */
export function isPointer(cred) {
  const s = String(cred || '').trim()
  if (!s) return false
  return s.split('|').every((p) => POINTER_RE.test(p.trim()))
}

const fileCache = new Map()
function readCached(file) {
  try {
    const st = fs.statSync(file)
    const hit = fileCache.get(file)
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.text
    const text = fs.readFileSync(file, 'utf8')
    fileCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, text })
    return text
  } catch (e) {
    return null
  }
}

export function expandHome(p, home) {
  const h = home || os.homedir()
  return String(p || '').replace(/^~(?=\/|$)/, h)
}

/** NAME=value from a dotenv-style text (the v1 readMimoCred parser). */
export function dotenvValue(text, name) {
  if (!text) return ''
  for (const line of String(text).split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (m && m[1] === name) return m[2].trim().replace(/^["']|["']$/g, '')
  }
  return ''
}

/** refs.NAME from the DSH credentials YAML, with a tiny parser for that one block. */
export function dshRefValue(text, name) {
  if (!text) return ''
  let inRefs = false
  for (const line of String(text).split('\n')) {
    if (/^refs:\s*$/.test(line)) { inRefs = true; continue }
    if (inRefs && /^\S/.test(line)) inRefs = false
    if (!inRefs) continue
    const m = /^ {2}([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line)
    if (m && m[1] === name) return m[2].trim().replace(/^["']|["']$/g, '')
  }
  return ''
}

/**
 * Resolve a credential string. env and home are injectable for tests.
 * Returns '' when nothing resolves.
 */
export function resolveCredential(cred, opts) {
  const o = opts || {}
  const env = o.env || process.env
  const home = o.home || os.homedir()
  const s = String(cred || '').trim()
  if (!s) return ''
  if (!isPointer(s)) return s
  for (const part of s.split('|')) {
    const p = part.trim()
    let v = ''
    if (p.startsWith('env:')) v = env[p.slice(4)] || ''
    else if (p.startsWith('file:')) {
      const rest = expandHome(p.slice(5), home)
      const hash = rest.lastIndexOf('#')
      if (hash > 0) v = dotenvValue(readCached(rest.slice(0, hash)), rest.slice(hash + 1))
      else v = String(readCached(rest) || '').trim()
    } else if (p.startsWith('dsh-ref:')) {
      const file = env.DSH_VOICE_DSH_CREDENTIALS || path.join(home, '.dsh', '.credentials.yaml')
      v = dshRefValue(readCached(file), p.slice(8))
    }
    if (v) return v
  }
  return ''
}

/** Describe a credential for the UI without revealing it. */
export function describeCredential(cred, opts) {
  const s = String(cred || '').trim()
  if (!s) return { kind: 'none', shown: '', resolved: false }
  const resolved = Boolean(resolveCredential(s, opts))
  if (isPointer(s)) return { kind: 'pointer', shown: s, resolved }
  return { kind: 'literal', shown: 'set', resolved }
}
