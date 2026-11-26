/**
 * dsh-voice client: the reader tab's helpers for speech annotations and language
 * markers. Pure; tested in node.
 *
 * Annotations ([tone=happy], [pace=slow], [laugh]) are written in ONE syntax and
 * adapted per model ON THE SERVER (lib/shared/annotations.js), which owns the
 * vocabulary, the per-family rules and the offset maps. The client only needs
 * to know what the selected model can take (for the menu) and to remove the
 * annotations a caller strips itself.
 */
import { tagMenu, adaptationFor, listAnnotations, SYNTAX } from '../../lib/shared/annotations.js'

export { SYNTAX, listAnnotations }

/** The annotation groups the selected provider/model can take, from its family (cached per key). */
const menuCache = new Map()
export function tagsFor(engine, model, family) {
  // the engine itself decides when no published family is given (the engine IS the provider id there,
  // which would otherwise resolve the wrong family: "openrouter" is not a model)
  const key = String(family || '') + '|' + String(engine || '') + '|' + String(model || '')
  if (!menuCache.has(key)) {
    let a
    if (family && family.length > 2) {
      // the server published the family of this instance (cfg.engines[id].v2.annotation.family)
      a = adaptationFamily(family)
    } else {
      a = adaptationFor(null, model, engine)
    }
    menuCache.set(key, { menu: tagMenu(a), family: a.family, label: a.label })
  }
  return menuCache.get(key)
}
const ADAPTATION_FAMILIES = (familyName) => familyName
function adaptationFamily(name) {
  return annotationInfoFor(name)
}
import { annotationInfo } from '../../lib/shared/annotations.js'
import { ADAPTATION } from '../../lib/shared/annotations.js'
function annotationInfoFor(name) {
  const a = ADAPTATION[name]
  if (!a) return { family: 'mute', label: 'No annotations', channels: {}, tags: null, instructions: false, ssml: false }
  return { family: name, label: a.label, tags: a.tags, instructions: a.instructions, ssml: a.ssml, channels: Object.assign({}, a.channels), verification: a.verification, capsStress: name === 'gemini' || name === 'openai' }
}

/** Is this engine/model a family that takes native annotations (so the menu is worth showing)? */
export function takesTags(engine, model, family) {
  const t = tagsFor(engine, model, family)
  return t.menu.groups.length > 0
}

/** Remove every annotation from a text (the words only), for a caller that speaks through a path without the server layer. */
export function stripTags(text) {
  const src = String(text || '')
  // remove from the END: every offset then still refers to the original string
  let out = src
  for (const a of listAnnotations(src).reverse()) out = out.slice(0, a.from) + out.slice(a.to)
  return out.replace(/[ \t]{2,}/g, ' ').replace(/^ /, '')
}

/** Carry the active emotion and pace into chunks that do not start with their own. */
export function carryTags(chunks) {
  let emotion = ''
  let pace = ''
  return chunks.map((c) => {
    const head = (/^\s*\[(?:emotion|pace)=/.test(c)) ? '' : (emotion + pace)
    let m
    const re = /\[(emotion|pace)=([a-z-]+)\]/g
    while ((m = re.exec(c))) { if (m[1] === 'emotion') emotion = m[0]; else pace = m[0] }
    return head + c
  })
}

/**
 * Insert a language marker at the cursor. With a selection, wrap it:
 * "[[it]]selection[[/]]"; without one, insert the sticky switch "[[it]]".
 * Returns { text, start, end } with the new cursor/selection.
 */
export function insertMarker(text, selStart, selEnd, lang) {
  const t = String(text || '')
  const a = Math.max(0, Math.min(t.length, Number(selStart) || 0))
  const b = Math.max(a, Math.min(t.length, Number(selEnd) || a))
  const open = lang === '/' ? '[[/]]' : '[[' + lang + ']]'
  if (b > a && lang !== '/') {
    const out = t.slice(0, a) + open + t.slice(a, b) + '[[/]]' + t.slice(b)
    return { text: out, start: a + open.length, end: b + open.length }
  }
  const out = t.slice(0, a) + open + t.slice(b)
  return { text: out, start: a + open.length, end: a + open.length }
}

/** Insert any snippet at the cursor (Voxtral tag menu). */
export function insertSnippet(text, selStart, selEnd, snippet) {
  const t = String(text || '')
  const a = Math.max(0, Math.min(t.length, Number(selStart) || 0))
  const b = Math.max(a, Math.min(t.length, Number(selEnd) || a))
  const pad = a > 0 && !/\s$/.test(t.slice(0, a)) ? ' ' : ''
  const out = t.slice(0, a) + pad + snippet + ' ' + t.slice(b)
  const at = a + pad.length + snippet.length + 1
  return { text: out, start: at, end: at }
}

/** Plain text of an opened file: .md and .txt as is, .html without its markup. */
export function fileText(name, content, parseHtml) {
  const n = String(name || '').toLowerCase()
  if (/\.(html?|xhtml)$/.test(n)) {
    if (typeof parseHtml === 'function') return parseHtml(content)
    return String(content || '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/[ \t]+/g, ' ').trim()
  }
  return String(content || '')
}
