/**
 * dsh-voice client: the shared look (one stylesheet + line icons) for the
 * reader tab, Settings > Voice and the in-chat controls.
 *
 * Everything reads the host's design tokens (--dsw-alias-*, and the --tz-*
 * theme tokens where a theme defines them), so the UI follows the host theme,
 * light or dark, square or rounded. The fallbacks are neutral (currentColor,
 * translucent greys), never a hard-coded light or dark surface.
 *
 * Scopes: .dv (the reader tab), .dv-set (Settings > Voice), .dv-inline (the
 * speaker on a reply and the composer mic row). The stylesheet is injected
 * once into document.head as <style id="dsh-voice-ui-css">; a reload of the
 * bundle replaces its text, so a new build never stacks a second copy.
 */
import * as React from 'react'

export const STYLE_ID = 'dsh-voice-ui-css'

const VARS = [
  '--dv-ink:var(--dsw-alias-label-primary,currentColor)',
  '--dv-ink2:var(--dsw-alias-label-secondary,currentColor)',
  '--dv-ink3:var(--dsw-alias-label-tertiary,rgba(128,128,128,.95))',
  '--dv-line:var(--dsw-alias-border-l2,rgba(128,128,128,.32))',
  '--dv-line1:var(--dsw-alias-border-l1,rgba(128,128,128,.18))',
  '--dv-line3:var(--dsw-alias-border-l3,rgba(128,128,128,.5))',
  '--dv-l1:var(--dsw-alias-bg-layer-1,transparent)',
  '--dv-l2:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.08))',
  '--dv-l3:var(--dsw-alias-bg-layer-3,rgba(128,128,128,.14))',
  '--dv-hov:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))',
  '--dv-act:var(--dsw-alias-interactive-bg-active,rgba(128,128,128,.2))',
  '--dv-elev:var(--dsw-alias-button-elevated-fill,var(--dsw-alias-bg-layer-3,rgba(128,128,128,.18)))',
  '--dv-acc:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#4d6bfe))',
  '--dv-acc-h:var(--dsw-alias-button-primary-hover,var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#4d6bfe)))',
  '--dv-on-acc:var(--tz-on-accent,var(--dsw-alias-label-primary-foreground,#fff))',
  '--dv-bad:var(--dsw-alias-state-error-primary,#cf3b3b)',
  '--dv-warn:var(--dsw-alias-state-warn-label,#c98a14)',
  '--dv-ok:var(--dsw-alias-state-success-primary,#2e9e5b)',
  '--dv-info:var(--dsw-alias-state-business-primary,#5e9bd6)',
  '--dv-link:var(--dsw-alias-link,inherit)',
  '--dv-r:var(--tz-radius,6px)',
  '--dv-pill:calc(var(--tz-radius,6px) * 99)',
  '--dv-mono:var(--tz-font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace)',
  '--dv-display:var(--tz-font-display,inherit)',
].join(';')

// A select chevron drawn with two gradients, so it takes the token colour (an SVG data URI cannot).
const CHEVRON = 'background-image:linear-gradient(45deg,transparent 50%,var(--dv-ink3) 50%),linear-gradient(135deg,var(--dv-ink3) 50%,transparent 50%);'
  + 'background-position:calc(100% - 14px) 52%,calc(100% - 10px) 52%;background-size:4px 4px,4px 4px;background-repeat:no-repeat'

export const CSS = [
  '.dv,.dv-set,.dv-inline{' + VARS + '}',
  '@keyframes dv-spin{to{transform:rotate(360deg)}}',
  '.dv-spin{animation:dv-spin .9s linear infinite;transform-origin:50% 50%}',
  '.dv svg,.dv-set svg,.dv-inline svg{flex:0 0 auto;display:block}',

  // ---- the reader tab
  '.dv{display:flex;flex-direction:column;height:100%;min-height:0;min-width:0;overflow:hidden;font-size:13px;line-height:1.4;color:var(--dv-ink)}',
  '.dv *{box-sizing:border-box}',
  '.dv-bar{display:flex;align-items:center;gap:8px;padding:0 12px;height:36px;border-bottom:1px solid var(--dv-line1);flex:0 0 auto;min-width:0}',
  '.dv-title{font-family:var(--dv-display);font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--dv-ink2);white-space:nowrap}',
  '.dv-dot{width:7px;height:7px;border-radius:var(--dv-pill);background:var(--dv-ink3);flex:0 0 auto;opacity:.6}',
  '.dv-dot.on{background:var(--dv-acc);opacity:1}',
  '.dv-dot.bad{background:var(--dv-bad);opacity:1}',
  '.dv-bar .dv-meta{margin-left:auto;font-family:var(--dv-mono);font-size:11px;color:var(--dv-ink3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}',
  '.dv-body{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding:12px 12px 20px;display:flex;flex-direction:column;gap:16px}',
  '.dv-sec{display:flex;flex-direction:column;gap:7px;min-width:0}',
  '.dv-lab{display:flex;align-items:center;gap:8px;min-height:16px;color:var(--dv-ink3);font-family:var(--dv-mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase}',
  '.dv-lab .dv-aside{margin-left:auto;letter-spacing:0;text-transform:none;font-size:11px;display:inline-flex;align-items:center;gap:6px}',

  // segmented control
  '.dv-seg{display:flex;gap:2px;padding:2px;border:1px solid var(--dv-line);border-radius:var(--dv-r);background:var(--dv-l2);min-width:0}',
  '.dv-seg>button{flex:1 1 auto;min-width:0;height:28px;display:inline-flex;align-items:center;justify-content:center;gap:5px;padding:0 6px;font:inherit;font-size:12px;border:0;border-radius:calc(var(--dv-r) - 2px);background:transparent;color:var(--dv-ink2);cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:background-color .12s,color .12s}',
  '.dv-seg>button>span{overflow:hidden;text-overflow:ellipsis}',
  '.dv-seg>button:hover:not(:disabled){background:var(--dv-hov);color:var(--dv-ink)}',
  '.dv-seg>button[aria-pressed=true]{background:var(--dv-elev);color:var(--dv-ink);font-weight:600;box-shadow:inset 0 0 0 1px var(--dv-line)}',
  '.dv-seg>button:disabled{opacity:.4;cursor:not-allowed}',
  '.dv-seg.sm>button{height:24px;font-size:11.5px;flex:0 0 auto;padding:0 10px}',

  // fields
  '.dv-ta{display:block;width:100%;min-height:128px;max-height:55vh;resize:vertical;font:inherit;font-size:13.5px;line-height:1.55;color:var(--dv-ink);background:var(--dv-l2);border:1px solid var(--dv-line);border-radius:var(--dv-r);padding:9px 11px;outline:none;transition:border-color .12s,box-shadow .12s}',
  '.dv-ta::placeholder{color:var(--dv-ink3)}',
  '.dv-ta:hover{border-color:var(--dv-line3)}',
  '.dv-ta:focus{border-color:var(--dv-acc);box-shadow:0 0 0 1px var(--dv-acc)}',
  '.dv-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:8px}',
  '.dv-field{display:flex;flex-direction:column;gap:4px;min-width:0}',
  '.dv-field.wide{grid-column:1/-1}',
  '.dv-field>span{font-size:11px;color:var(--dv-ink3)}',
  '.dv-sel{appearance:none;-webkit-appearance:none;display:block;width:100%;min-width:0;height:32px;font:inherit;font-size:12.5px;color:var(--dv-ink);background-color:var(--dv-l2);border:1px solid var(--dv-line);border-radius:var(--dv-r);padding:0 28px 0 10px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;outline:none;' + CHEVRON + '}',
  '.dv-sel:hover:not(:disabled){border-color:var(--dv-line3)}',
  '.dv-sel:focus-visible{border-color:var(--dv-acc);box-shadow:0 0 0 1px var(--dv-acc)}',
  '.dv-sel:disabled{opacity:.45;cursor:not-allowed}',
  '.dv-sel.sm{height:26px;width:auto;font-size:12px}',
  '.dv-sel option,.dv-sel optgroup,.dv-set select option,.dv-set select optgroup,.dv-inline select option,.dv-inline select optgroup{background-color:var(--dsw-alias-bg-layer-2,Canvas);color:var(--dsw-alias-label-primary,CanvasText)}',

  // marker chips
  '.dv-chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center;min-width:0}',
  '.dv-chip{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 8px;font-family:var(--dv-mono);font-size:11px;border:1px solid var(--dv-line);border-radius:var(--dv-r);background:transparent;color:var(--dv-ink2);cursor:pointer;white-space:nowrap;transition:background-color .12s,border-color .12s,color .12s}',
  '.dv-chip:hover:not(:disabled){background:var(--dv-hov);border-color:var(--dv-line3);color:var(--dv-ink)}',
  '.dv-chip:disabled{opacity:.4;cursor:not-allowed}',
  '.dv-chips .dv-sel{flex:1 1 140px;width:auto;height:24px;font-size:11.5px;font-family:inherit}',

  // buttons
  '.dv-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 12px;font:inherit;font-size:12.5px;font-weight:500;border:1px solid var(--dv-line);border-radius:var(--dv-r);background:transparent;color:var(--dv-ink);cursor:pointer;white-space:nowrap;transition:background-color .12s,border-color .12s,color .12s}',
  '.dv-btn:hover:not(:disabled){background:var(--dv-hov);border-color:var(--dv-line3)}',
  '.dv-btn:active:not(:disabled){background:var(--dv-act)}',
  '.dv-btn:disabled{opacity:.38;cursor:not-allowed}',
  '.dv-btn.p{min-width:96px;background:var(--dv-acc);border-color:var(--dv-acc);color:var(--dv-on-acc);font-weight:600;box-shadow:var(--tz-shadow-btn,none)}',
  '.dv-btn.p:hover:not(:disabled){background:var(--dv-acc-h);border-color:var(--dv-acc-h)}',
  '.dv-btn.p:active:not(:disabled){transform:translateY(1px);box-shadow:none}',
  '.dv-btn.p.stop{background:var(--dv-elev);border-color:var(--dv-line3);color:var(--dv-ink);box-shadow:none}',
  '.dv-btn.i{width:32px;padding:0}',
  '.dv-btn.g{border-color:transparent;color:var(--dv-ink2)}',
  '.dv-btn.g:hover:not(:disabled){color:var(--dv-ink);border-color:transparent}',
  '.dv-btn.sm{height:24px;padding:0 8px;font-size:11.5px}',
  '.dv-btn.sm.i{width:24px;padding:0}',
  '.dv-btn[aria-pressed=true]{background:var(--dv-act)}',
  '.dv-transport{display:flex;align-items:center;gap:6px;min-width:0}',
  '.dv-transport .dv-sp{flex:1}',
  '.dv-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}',

  // status and notes
  '.dv-status{font-size:12px;color:var(--dv-ink3);overflow-wrap:anywhere}',
  '.dv-status:empty{margin-top:-7px}',
  '.dv-status.live{color:var(--dv-ink2)}',
  '.dv-note{border:1px solid var(--dv-line1);border-left:3px solid var(--dv-bad);border-radius:var(--dv-r);background:var(--dv-l2);padding:8px 10px;font-size:12px;color:var(--dv-ink2);overflow-wrap:anywhere}',
  '.dv-hint{font-size:11.5px;color:var(--dv-ink3);line-height:1.45}',

  // the reading view and its language badges
  '.dv-view{border:1px solid var(--dv-line1);border-radius:var(--dv-r);background:var(--dv-l1);padding:12px 14px;font-size:14px;line-height:1.75;color:var(--dv-ink);overflow-wrap:anywhere}',
  '.dv-view.empty{border-style:dashed;color:var(--dv-ink3);font-size:12.5px;line-height:1.5;text-align:center;padding:20px 14px}',
  '.dv-lang{display:inline-block;margin:0 6px 0 1px;padding:2px 4px;vertical-align:2px;font-family:var(--dv-mono);font-size:9.5px;font-weight:600;line-height:1;letter-spacing:.06em;border:1px solid var(--dv-line3);border-radius:var(--dv-r);color:var(--dv-ink2);background:var(--dv-l2);user-select:none;-webkit-user-select:none}',
  '.dv-lang[data-l=en]{color:var(--dv-info);border-color:color-mix(in srgb,var(--dv-info) 45%,transparent)}',
  '.dv-lang[data-l=it]{color:var(--dv-ok);border-color:color-mix(in srgb,var(--dv-ok) 45%,transparent)}',
  '.dv-lang[data-l=el]{color:var(--dv-warn);border-color:color-mix(in srgb,var(--dv-warn) 45%,transparent)}',
  '.dv-view [lang]+[lang]{margin-left:2px}',

  // focus rings (keyboard only)
  '.dv :focus-visible,.dv-set :focus-visible,.dv-inline :focus-visible{outline:2px solid var(--dv-acc);outline-offset:1px}',
  '.dv .dv-ta:focus-visible,.dv .dv-sel:focus-visible,.dv-set input:focus-visible,.dv-set select:focus-visible,.dv-set textarea:focus-visible{outline:none}',

  // ---- Settings > Voice: the host renders the section, these rules style our controls inside it
  '.dv-set{color:var(--dv-ink);font-size:13px}',
  '.dv-set *{box-sizing:border-box}',
  '.dv-set a{color:var(--dv-link)}',
  '.dv-set button{display:inline-flex;align-items:center;justify-content:center;gap:5px;height:28px;padding:0 10px;font:inherit;font-size:12px;font-weight:500;border:1px solid var(--dv-line);border-radius:var(--dv-r);background:transparent;color:var(--dv-ink);cursor:pointer;white-space:nowrap;transition:background-color .12s,border-color .12s}',
  '.dv-set button:hover:not(:disabled){background:var(--dv-hov);border-color:var(--dv-line3)}',
  '.dv-set button:active:not(:disabled){background:var(--dv-act)}',
  '.dv-set button:disabled{opacity:.38;cursor:not-allowed}',
  '.dv-set button[aria-pressed=true]{background:var(--dv-act)}',
  '.dv-set button.p{background:var(--dv-acc);border-color:var(--dv-acc);color:var(--dv-on-acc);font-weight:600;box-shadow:var(--tz-shadow-btn,none)}',
  '.dv-set button.p:hover:not(:disabled){background:var(--dv-acc-h);border-color:var(--dv-acc-h)}',
  '.dv-set input:not([type=checkbox]):not([type=radio]),.dv-set select,.dv-set textarea{font:inherit;font-size:12.5px;min-width:0;max-width:100%;height:30px;color:var(--dv-ink);background-color:var(--dv-l2);border:1px solid var(--dv-line);border-radius:var(--dv-r);padding:0 9px;outline:none;transition:border-color .12s,box-shadow .12s}',
  '.dv-set textarea{height:auto;padding:7px 9px;line-height:1.5;resize:vertical}',
  '.dv-set select{appearance:none;-webkit-appearance:none;padding-right:28px;cursor:pointer;text-overflow:ellipsis;' + CHEVRON + '}',
  '.dv-set input::placeholder,.dv-set textarea::placeholder{color:var(--dv-ink3)}',
  '.dv-set input:not([type=checkbox]):not([type=radio]):hover,.dv-set select:hover,.dv-set textarea:hover{border-color:var(--dv-line3)}',
  '.dv-set input:not([type=checkbox]):not([type=radio]):focus,.dv-set select:focus,.dv-set textarea:focus{border-color:var(--dv-acc);box-shadow:0 0 0 1px var(--dv-acc)}',
  '.dv-set input[type=checkbox],.dv-set input[type=radio]{accent-color:var(--dv-acc);width:14px;height:14px;margin:0;cursor:pointer}',
  '.dv-set .dv-card{border:1px solid var(--dv-line1);border-radius:var(--dv-r);background:var(--dv-l1);padding:10px 12px;margin:8px 0}',
  '.dv-set .dv-badge{display:inline-flex;align-items:center;height:18px;padding:0 6px;font-size:10.5px;border:1px solid var(--dv-line);border-radius:var(--dv-pill);color:var(--dv-ink2);white-space:nowrap}',
  '.dv-set .dv-badge[data-tone=ok]{color:var(--dv-ok);border-color:color-mix(in srgb,var(--dv-ok) 50%,transparent)}',
  '.dv-set .dv-badge[data-tone=info]{color:var(--dv-info);border-color:color-mix(in srgb,var(--dv-info) 50%,transparent)}',
  '.dv-set .dv-badge[data-tone=warn]{color:var(--dv-warn);border-color:color-mix(in srgb,var(--dv-warn) 50%,transparent)}',
  '.dv-set .dv-badge[data-tone=self]{color:var(--dv-ink);border-color:var(--dv-line3)}',
  '.dv-set .dv-lgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px;margin-top:6px}',
  '.dv-set .dv-lgrid>*{width:100%}',
  '.dv-set .dv-ltitle{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
  '.dv-set .dv-lsub{margin-top:10px;font-family:var(--dv-mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--dv-ink3)}',
  '.dv-set table{border-collapse:collapse;width:100%}',
  '.dv-set code{font-family:var(--dv-mono);font-size:11.5px;font-variant-ligatures:none;color:var(--dv-ink2)}',

  // ---- in-chat controls: the speaker row and the composer mic row
  '.dv-inline button{color:inherit;border-radius:var(--dv-r);transition:background-color .12s,opacity .12s}',
  '.dv-inline button:hover:not(:disabled){background:var(--dv-hov);opacity:1!important}',
  '.dv-inline button:disabled{cursor:not-allowed}',
  '.dv-inline select{border-radius:var(--dv-r)}',
  '.dv-inline select:hover{opacity:.9!important}',
  '.dv-inline .dv-lang{display:inline-block;margin-left:2px;padding:2px 4px;font-family:var(--dv-mono);font-size:9.5px;font-weight:600;line-height:1;letter-spacing:.06em;border:1px solid var(--dv-line3);border-radius:var(--dv-r);color:var(--dv-ink2)}',
].join('\n')

/** Inject (or refresh) the stylesheet. Safe without a document (server render, tests). */
export function ensureStyles() {
  if (typeof document === 'undefined' || !document || !document.head) return false
  let st = document.getElementById(STYLE_ID)
  if (!st) {
    st = document.createElement('style')
    st.id = STYLE_ID
    document.head.appendChild(st)
  }
  if (st.textContent !== CSS) st.textContent = CSS
  return true
}

const PATHS = {
  play: [['path', { d: 'M5 3.2v9.6L12.6 8z', fill: 'currentColor', stroke: 'none' }]],
  pause: [['rect', { x: 4, y: 3.2, width: 2.6, height: 9.6, fill: 'currentColor', stroke: 'none' }], ['rect', { x: 9.4, y: 3.2, width: 2.6, height: 9.6, fill: 'currentColor', stroke: 'none' }]],
  stop: [['rect', { x: 4, y: 4, width: 8, height: 8, fill: 'currentColor', stroke: 'none' }]],
  prev: [['path', { d: 'M4 3.5v9' }], ['path', { d: 'M12.5 3.5 6 8l6.5 4.5z', fill: 'currentColor', stroke: 'none' }]],
  next: [['path', { d: 'M12 3.5v9' }], ['path', { d: 'M3.5 3.5 10 8l-6.5 4.5z', fill: 'currentColor', stroke: 'none' }]],
  rewind: [['path', { d: 'M7.6 4 3 8l4.6 4zM13.4 4 8.8 8l4.6 4z', fill: 'currentColor', stroke: 'none' }]],
  speaker: [['path', { d: 'M2.5 6v4h2.6L8.6 13V3L5.1 6z' }], ['path', { d: 'M11 5.6a3.4 3.4 0 0 1 0 4.8M12.8 3.9a5.8 5.8 0 0 1 0 8.2' }]],
  speakerCode: [['path', { d: 'M2 6.2v3.6h2.2L7.2 12.4V3.6L4.2 6.2z' }], ['path', { d: 'M10.6 5.2 9 8l1.6 2.8M13 5.2 14.6 8 13 10.8' }]],
  mic: [['path', { d: 'M8 1.8a2.1 2.1 0 0 0-2.1 2.1v4a2.1 2.1 0 0 0 4.2 0v-4A2.1 2.1 0 0 0 8 1.8z' }], ['path', { d: 'M3.8 7.6a4.2 4.2 0 0 0 8.4 0M8 11.9v2.3' }]],
  rec: [['circle', { cx: 8, cy: 8, r: 4.2, fill: 'currentColor', stroke: 'none' }]],
  download: [['path', { d: 'M8 2.5v8M4.6 7.2 8 10.6l3.4-3.4M3 13.5h10' }]],
  close: [['path', { d: 'M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6' }]],
  warn: [['path', { d: 'M8 2.4 14.2 13H1.8z' }], ['path', { d: 'M8 6.6v3M8 11.3v.2' }]],
  file: [['path', { d: 'M4 1.8h5.2L12 4.6v9.6H4z' }], ['path', { d: 'M9 1.8v3h3' }]],
  spinner: [['path', { d: 'M8 2.2a5.8 5.8 0 1 1-5.8 5.8' }]],
}

/** A 16px line icon in the host's style (currentColor, 1.4 stroke). */
export function Icon(props) {
  const size = props.size || 16
  const parts = PATHS[props.name] || []
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={props.stroke || 1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" className={props.name === 'spinner' ? 'dv-spin' : undefined}>
      {parts.map((p, i) => React.createElement(p[0], Object.assign({ key: i }, p[1])))}
    </svg>
  )
}
