/**
 * dsh-voice client: auto-read of new replies (reading.autoRead, default 'off').
 *
 *   'new-replies'                read each finished reply of the chat in view
 *   'new-replies-when-dictated'  only the reply to a prompt that was dictated (hands-free loop)
 *
 * A reply is NEW when it was not among the finished replies the first time this
 * chat was observed on this page: opening a chat or reloading the page never
 * reads its history. Chats are told apart by their message ids (a snapshot
 * that shares no id with the previous one is another chat). The chat snapshot
 * keeps finished replies in legacy.nodes and the one being written in
 * legacy.partial, so only finished text is ever read.
 *
 * Pure state machine (no DOM), driven by the components; tested in
 * test/client.test.mjs.
 */

export function createAutoRead(opts) {
  const o = opts || {}
  const now = o.now || (() => Date.now())
  const DICTATION_WINDOW_MS = o.dictationWindowMs || 10 * 60 * 1000
  let seen = new Set()
  let baseline = new Set()
  let order = []
  const done = new Set()
  let dictatedAt = null
  let freshChat = false

  const idsOf = (snapshot) => {
    const nodes = (snapshot && snapshot.legacy && snapshot.legacy.nodes) || []
    const out = []
    for (const n of nodes) if (n && n.kind === 'assistant' && n.messageId && out.indexOf(n.messageId) < 0) out.push(n.messageId)
    return out
  }

  return {
    /** Feed every snapshot a component sees. */
    observe(snapshot) {
      const ids = idsOf(snapshot)
      const overlap = ids.some((id) => seen.has(id))
      if (!ids.length) {
        // An empty chat: whatever arrives next is a new reply, not history.
        freshChat = true
        baseline = new Set()
        seen = new Set()
      } else if (freshChat && !seen.size && ids.length === 1) {
        // (More than one reply right after an empty view is a switch to an
        // older chat, which falls through to the history branch.)
        freshChat = false
        ids.forEach((id) => seen.add(id))
      } else if (!seen.size || !overlap) {
        // First look at this chat (page load or a chat switch): its replies are history.
        freshChat = false
        baseline = new Set(ids)
        seen = new Set(ids)
      } else ids.forEach((id) => seen.add(id))
      order = ids
      return ids
    },
    /** Finished reply ids of the chat in view, in order. */
    lastIds() { return order.slice() },
    markDictated() { dictatedAt = now() },
    dictatedRecently() { return dictatedAt !== null && now() - dictatedAt < DICTATION_WINDOW_MS },
    /** Should this message be read automatically now? Marks it handled when true. */
    take(messageId, mode) {
      if (!mode || mode === 'off') return false
      if (done.has(messageId) || baseline.has(messageId)) return false
      if (order[order.length - 1] !== messageId) return false
      if (mode === 'new-replies-when-dictated') {
        if (!this.dictatedRecently()) return false
        dictatedAt = null
      } else if (mode !== 'new-replies') return false
      done.add(messageId)
      return true
    },
  }
}

/** The page-wide instance. */
export const autoRead = createAutoRead()
