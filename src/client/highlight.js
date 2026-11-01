/**
 * dsh-voice client: sentence and word highlight while reading.
 *
 * Uses the CSS Custom Highlight API (CSS.highlights + ::highlight()), so the
 * chat DOM is never mutated: React keeps owning it. Ranges are found by
 * matching the spoken chunk to the container's text (lib/shared/highlight/
 * domkey.js). Browsers without the API simply get no highlight.
 *
 * createHighlighter({ container }) is container-agnostic: the chat message
 * today, the reader tab's reading view in phase 3.
 *
 * Accessibility: the word highlight is an underline as well as a colour (not
 * colour only); prefers-reduced-motion turns smooth scrolling off; auto-scroll
 * pauses for 5 s after the person scrolls.
 */
import { buildKeyIndex, findKey, subKeyRange, keyRangeToNodes, keyOf } from '../../lib/shared/highlight/domkey.js'

const STYLE_ID = 'dsh-voice-highlight-style'
export const HL_SENTENCE = 'dsh-voice-sentence'
export const HL_WORD = 'dsh-voice-word'

export function highlightSupported() {
  return typeof window !== 'undefined' && typeof window.CSS !== 'undefined' && window.CSS && window.CSS.highlights && typeof window.Highlight === 'function'
}

function ensureStyle() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return
  const st = document.createElement('style')
  st.id = STYLE_ID
  // The host accent (a theme accent when set, the brand blue on stock DSH); amber when no token resolves.
  st.textContent = '::highlight(' + HL_SENTENCE + '){background-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#ffc400) 24%,transparent)}'
    + '::highlight(' + HL_WORD + '){background-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#ffa000) 55%,transparent);text-decoration:underline;text-decoration-thickness:2px}'
  document.head.appendChild(st)
}

export function reducedMotion() {
  try { return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) } catch (e) { return false }
}

let userScrollAt = 0
let scrollHooked = false
function hookUserScroll() {
  if (scrollHooked || typeof window === 'undefined') return
  scrollHooked = true
  const mark = () => { userScrollAt = Date.now() }
  window.addEventListener('wheel', mark, { passive: true, capture: true })
  window.addEventListener('touchmove', mark, { passive: true, capture: true })
  window.addEventListener('keydown', (e) => { if (/^(PageUp|PageDown|ArrowUp|ArrowDown|Home|End)$/.test(e.key)) mark() }, { capture: true })
}

/** Text nodes worth matching: skip code blocks (they are not read) and our own controls. */
function textNodes(container) {
  const out = []
  if (!container || typeof document === 'undefined') return out
  const walker = document.createTreeWalker(container, 4 /* NodeFilter.SHOW_TEXT */, {
    acceptNode(n) {
      let p = n.parentElement
      while (p && p !== container) {
        const tag = p.tagName
        if (tag === 'PRE' || tag === 'BUTTON' || tag === 'SELECT' || tag === 'SCRIPT' || tag === 'STYLE' || (p.hasAttribute && p.hasAttribute('data-dsh-voice-ui'))) return 2 /* REJECT */
        p = p.parentElement
      }
      return 1 /* ACCEPT */
    },
  })
  let n
  while ((n = walker.nextNode())) out.push(n)
  return out
}

/**
 * Find the rendered message around an element of our action row: the smallest
 * ancestor whose text contains the start of what will be read.
 */
export function findMessageContainer(fromEl, probeText) {
  if (!fromEl) return null
  const probe = keyOf(String(probeText || '').slice(0, 80)).key.slice(0, 40)
  if (!probe) return null
  let el = fromEl.parentElement
  for (let depth = 0; el && depth < 12; depth += 1, el = el.parentElement) {
    const k = keyOf(el.textContent || '').key
    if (k.indexOf(probe) >= 0) return el
  }
  return null
}

export function createHighlighter({ container }) {
  const supported = highlightSupported() && Boolean(container)
  let nodes = []
  let index = { key: '', map: [] }
  let cursor = 0
  let chunk = null   // { text, k0, k1 }
  let lastSentenceKey = ''
  const reindex = () => {
    nodes = textNodes(container)
    index = buildKeyIndex(nodes.map((n) => n.nodeValue || ''))
  }
  if (supported) { ensureStyle(); hookUserScroll(); reindex() }

  /** extendPunct: a sentence range also covers its closing punctuation in the same text node. */
  const rangeOf = (k0, k1, extendPunct) => {
    const nn = keyRangeToNodes(index, k0, k1)
    if (!nn) return null
    try {
      const r = document.createRange()
      const endNode = nodes[nn[1][0]]
      const v = endNode.nodeValue || ''
      let end = Math.min(nn[1][1], v.length)
      if (extendPunct) while (end < v.length && /[.,;:!?\u2026\u037E)"'\u201d\u2019\u00bb\]]/.test(v[end])) end += 1
      r.setStart(nodes[nn[0][0]], nn[0][1])
      r.setEnd(endNode, end)
      return r
    } catch (e) { return null }
  }

  const scrollTo = (range) => {
    if (Date.now() - userScrollAt < 5000) return
    try {
      const rect = range.getBoundingClientRect()
      const vh = window.innerHeight || document.documentElement.clientHeight
      if (rect.top >= 60 && rect.bottom <= vh - 60) return
      const el = range.startContainer && range.startContainer.parentElement
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' })
    } catch (e) { /* layout not ready */ }
  }

  return {
    supported,
    /** A new chunk starts: locate it in the rendered text. */
    startChunk(text) {
      if (!supported) return false
      if (!container.isConnected) return false
      let hit = findKey(index, text, cursor)
      if (!hit) { reindex(); hit = findKey(index, text, 0) }
      chunk = hit ? { text, k0: hit.k0, k1: hit.k1 } : null
      if (hit) cursor = hit.k1
      lastSentenceKey = ''
      return Boolean(hit)
    },
    /** Show a position: sentence and word spans in chunk offsets (either may be null). */
    show(sentence, word, opts) {
      if (!supported || !chunk) return
      const o = opts || {}
      try {
        const hs = window.CSS.highlights
        if (sentence) {
          const kr = subKeyRange(chunk.text, chunk.k0, sentence.c0, sentence.c1)
          const r = kr && rangeOf(kr.k0, kr.k1, true)
          if (r) {
            hs.set(HL_SENTENCE, new window.Highlight(r))
            const sk = sentence.c0 + ':' + sentence.c1
            if (sk !== lastSentenceKey) { lastSentenceKey = sk; if (o.scroll !== false) scrollTo(r) }
          }
        }
        if (word && o.words !== false) {
          const kr = subKeyRange(chunk.text, chunk.k0, word.c0, word.c1)
          const r = kr && rangeOf(kr.k0, kr.k1)
          if (r) hs.set(HL_WORD, new window.Highlight(r))
        } else hs.delete(HL_WORD)
      } catch (e) { /* a highlight must never stop a read */ }
    },
    clear() {
      if (!supported) return
      try { window.CSS.highlights.delete(HL_SENTENCE); window.CSS.highlights.delete(HL_WORD) } catch (e) { /* gone */ }
      chunk = null
    },
  }
}
