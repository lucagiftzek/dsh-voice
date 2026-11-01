/**
 * dsh-tts-reader (retired): browser half, a deprecation stub.
 *
 * The TTS Reader tab (same id 'dsh-tts-reader:main', same title) now ships in
 * dsh-voice 2. This stub registers NOTHING and injects NOTHING: it no longer
 * requires dsh-better-sidebar, so a host that refuses the sidebar cannot take
 * this client down, and there is never a second Reader tab. Remove the
 * package from the profile when convenient.
 */
window.__ModuleLoader__.load({
  id: 'dsh-tts-reader',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    exports.name = 'dsh-tts-reader'
    exports.inject = []
    exports.retired = true
    exports.apply = function apply() {
      try {
        var v2 = typeof window !== 'undefined' && window.__DSH_VOICE_V2__
        console.info('[dsh-tts-reader] retired: the TTS Reader tab ' + (v2 ? 'comes from dsh-voice 2' : 'needs dsh-voice 2') + '; this package can be removed from the profile.')
      } catch (e) { /* console unavailable */ }
    }
    return module.exports
  },
})
