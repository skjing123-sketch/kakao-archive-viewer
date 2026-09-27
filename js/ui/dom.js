// dom.js — tiny DOM toolkit: element builder, icons, toasts, bottom sheets, dialogs.
//
// Text is always set with textContent (never innerHTML) except for the static icon SVGs,
// so archive content (message text, names) can never inject markup.

import { svg } from './icons.js';
import { initials, colorIndex } from './format.js';

/**
 * h('button', {class: 'btn', onclick: fn, 'aria-label': '닫기'}, child, 'text', …)
 * Special attrs: class (string|array), text, dataset (object), style (object|string), on<Event>.
 */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k in el && typeof v !== 'string' && k !== 'list') el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

/** <span class="ic-wrap"> containing an icon SVG. */
export function icon(name, size = 22, cls = '') {
  const s = document.createElement('span');
  s.className = 'icw' + (cls ? ' ' + cls : '');
  s.innerHTML = svg(name, size);
  return s;
}

/** Icon-only button with an accessible label. */
export function iconButton(name, label, onclick, cls = '') {
  const b = h('button', { type: 'button', class: 'iconbtn ' + cls, 'aria-label': label, title: label, onclick });
  b.appendChild(icon(name, 22));
  return b;
}

export function clear(el) { while (el && el.firstChild) el.removeChild(el.firstChild); return el; }

/** Avatar circle with initials, colour derived from `key`. */
export function avatar(name, key, size = 40, iconName = null) {
  const el = h('span', { class: `avatar av${colorIndex(key || name || '', 8)}`, 'aria-hidden': 'true', style: { width: size + 'px', height: size + 'px', fontSize: Math.round(size * 0.42) + 'px' } });
  if (iconName) el.appendChild(icon(iconName, Math.round(size * 0.55)));
  else el.textContent = initials(name);
  return el;
}

export function spinner(label = '불러오는 중…') {
  return h('div', { class: 'loading', role: 'status', 'aria-live': 'polite' }, h('span', { class: 'spin', 'aria-hidden': 'true' }), h('span', { class: 'loading-text', text: label }));
}

export function emptyState({ iconName = 'box', title, text = '', action = null }) {
  return h('div', { class: 'empty' },
    h('div', { class: 'empty-ic' }, icon(iconName, 34)),
    h('p', { class: 'empty-title', text: title }),
    text ? h('p', { class: 'empty-text', text }) : null,
    action);
}

export function errorState(err, onRetry) {
  const msg = (err && (err.userMessage || err.message)) || String(err || '알 수 없는 오류');
  return emptyState({
    iconName: 'alert', title: '불러오지 못했어요', text: msg,
    action: onRetry ? h('button', { type: 'button', class: 'btn', onclick: onRetry }, icon('refresh', 18), '다시 시도') : null,
  });
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

let toastHost = null;

/** Show a short message. opts: {action, onAction, duration(ms), kind:'error'|'ok'} */
export function toast(message, opts = {}) {
  if (!toastHost) {
    toastHost = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(toastHost);
  }
  const el = h('div', { class: 'toast' + (opts.kind ? ' toast-' + opts.kind : '') }, h('span', { text: message }));
  let timer = null;
  const close = () => {
    clearTimeout(timer);
    el.classList.add('out');
    setTimeout(() => el.remove(), 250);
  };
  if (opts.action) {
    el.appendChild(h('button', {
      type: 'button', class: 'toast-act', text: opts.action,
      onclick: () => { close(); if (opts.onAction) opts.onAction(); },
    }));
  }
  toastHost.appendChild(el);
  while (toastHost.children.length > 3) toastHost.firstChild.remove();
  timer = setTimeout(close, opts.duration || (opts.action ? 6000 : 2600));
  return close;
}

// ---------------------------------------------------------------------------
// Bottom sheet / dialog
// ---------------------------------------------------------------------------

const openLayers = [];

function trapFocus(container, ev) {
  if (ev.key !== 'Tab') return;
  const f = container.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])');
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
  else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
}

document.addEventListener('keydown', (ev) => {
  const top = openLayers[openLayers.length - 1];
  if (!top) return;
  if (ev.key === 'Escape') { ev.preventDefault(); top.close(); }
  else trapFocus(top.panel, ev);
});

/**
 * Open a bottom sheet (mobile) / centered panel (desktop).
 * opts: {title, content: Node, footer: Node|null, onClose, cls, label}
 * Returns {el, panel, body, close(result), closed: Promise}
 */
export function openSheet(opts) {
  const prevFocus = document.activeElement;
  let resolveClosed;
  const closed = new Promise((r) => { resolveClosed = r; });
  const backdrop = h('div', { class: 'sheet-backdrop' });
  const body = h('div', { class: 'sheet-body' });
  if (opts.content) body.appendChild(opts.content);
  const titleId = 'sheet-t-' + Math.random().toString(36).slice(2, 8);
  const panel = h('div', {
    class: 'sheet ' + (opts.cls || ''), role: 'dialog', 'aria-modal': 'true',
    'aria-labelledby': opts.title ? titleId : null, 'aria-label': opts.title ? null : (opts.label || '대화상자'),
  },
  h('div', { class: 'sheet-grab', 'aria-hidden': 'true' }),
  opts.title ? h('div', { class: 'sheet-head' },
    h('h2', { class: 'sheet-title', id: titleId, text: opts.title }),
    iconButton('close', '닫기', () => layer.close())) : null,
  body,
  opts.footer ? h('div', { class: 'sheet-foot' }, opts.footer) : null);
  const root = h('div', { class: 'sheet-root' }, backdrop, panel);
  let done = false;
  const layer = {
    el: root, panel, body, closed,
    close(result) {
      if (done) return;
      done = true;
      const i = openLayers.indexOf(layer);
      if (i >= 0) openLayers.splice(i, 1);
      root.classList.remove('open');
      root.classList.add('closing');
      setTimeout(() => root.remove(), 220);
      if (openLayers.length === 0) document.documentElement.classList.remove('sheet-open');
      if (opts.onClose) opts.onClose(result);
      resolveClosed(result);
      if (prevFocus && prevFocus.focus && document.contains(prevFocus)) {
        try { prevFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
      }
    },
  };
  backdrop.addEventListener('click', () => layer.close());
  enableSheetDrag(panel, () => layer.close());
  document.body.appendChild(root);
  openLayers.push(layer);
  document.documentElement.classList.add('sheet-open');
  requestAnimationFrame(() => {
    root.classList.add('open');
    const focusTarget = panel.querySelector('[data-autofocus]') || panel.querySelector('.sheet-head .iconbtn') || panel;
    if (focusTarget === panel) panel.setAttribute('tabindex', '-1');
    try { focusTarget.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  });
  return layer;
}

/** Swipe-down-to-dismiss on the sheet's grab area / header. */
function enableSheetDrag(panel, onDismiss) {
  let startY = null, dy = 0, id = null;
  const onDown = (ev) => {
    const handle = ev.target.closest('.sheet-grab, .sheet-head');
    if (!handle || ev.target.closest('button')) return;
    startY = ev.clientY; dy = 0; id = ev.pointerId;
    panel.setPointerCapture(id);
    panel.style.transition = 'none';
  };
  const onMove = (ev) => {
    if (startY === null || ev.pointerId !== id) return;
    dy = Math.max(0, ev.clientY - startY);
    panel.style.transform = `translateY(${dy}px)`;
  };
  const onUp = (ev) => {
    if (startY === null || ev.pointerId !== id) return;
    panel.style.transition = '';
    panel.style.transform = '';
    startY = null;
    if (dy > 90) onDismiss();
  };
  panel.addEventListener('pointerdown', onDown);
  panel.addEventListener('pointermove', onMove);
  panel.addEventListener('pointerup', onUp);
  panel.addEventListener('pointercancel', onUp);
}

/** Confirmation dialog. Resolves true when confirmed. */
export function confirmDialog({ title, message = '', confirmText = '확인', cancelText = '취소', danger = false }) {
  const content = h('div', { class: 'dialog-msg' }, message ? h('p', { text: message }) : null);
  let result = false;
  const footer = h('div', { class: 'btn-row' },
    h('button', { type: 'button', class: 'btn btn-ghost', text: cancelText, onclick: () => layer.close(false) }),
    h('button', { type: 'button', class: 'btn ' + (danger ? 'btn-danger' : 'btn-primary'), text: confirmText, 'data-autofocus': '', onclick: () => { result = true; layer.close(true); } }));
  const layer = openSheet({ title, content, footer, cls: 'sheet-dialog' });
  return layer.closed.then(() => result);
}

/** Action sheet: list of {label, icon, onSelect, danger}. */
export function actionSheet(title, items) {
  const list = h('div', { class: 'action-list', role: 'menu' });
  const layer = openSheet({ title, content: list, cls: 'sheet-actions' });
  for (const it of items) {
    if (!it) continue;
    list.appendChild(h('button', {
      type: 'button', role: 'menuitem', class: 'action-item' + (it.danger ? ' danger' : ''),
      onclick: () => { layer.close(); if (it.onSelect) it.onSelect(); },
    }, it.icon ? icon(it.icon, 22) : null, h('span', { text: it.label })));
  }
  return layer;
}

// ---------------------------------------------------------------------------
// Gestures & misc
// ---------------------------------------------------------------------------

/** Long-press (touch) / context-menu (mouse) handler. cb(ev, target) */
export function onLongPress(root, selector, cb, ms = 480) {
  let timer = null, sx = 0, sy = 0, target = null;
  const cancel = () => { clearTimeout(timer); timer = null; };
  root.addEventListener('pointerdown', (ev) => {
    if (ev.pointerType === 'mouse') return;
    target = ev.target.closest(selector);
    if (!target) return;
    sx = ev.clientX; sy = ev.clientY;
    timer = setTimeout(() => {
      timer = null;
      target.dataset.longpressed = '1';
      if (navigator.vibrate) { try { navigator.vibrate(10); } catch (e) { /* ignore */ } }
      cb(ev, target);
    }, ms);
  });
  root.addEventListener('pointermove', (ev) => { if (timer && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 10) cancel(); });
  root.addEventListener('pointerup', cancel);
  root.addEventListener('pointercancel', cancel);
  root.addEventListener('contextmenu', (ev) => {
    const t = ev.target.closest(selector);
    if (!t) return;
    ev.preventDefault();
    cancel();
    cb(ev, t);
  });
  // Suppress the click that follows a long press.
  root.addEventListener('click', (ev) => {
    const t = ev.target.closest(selector);
    if (t && t.dataset.longpressed) { delete t.dataset.longpressed; ev.preventDefault(); ev.stopPropagation(); }
  }, true);
}

export function debounce(fn, ms) {
  let t = null;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.cancel = () => clearTimeout(t);
  return d;
}

/** Height of the sticky app bar(s) at the top, for scroll offsets. */
export function topInset() {
  const bar = document.querySelector('.screen:not([hidden]) .appbar');
  const tabs = document.querySelector('.screen:not([hidden]) .room-tabs');
  let hgt = bar ? bar.getBoundingClientRect().height : 0;
  if (tabs) hgt += tabs.getBoundingClientRect().height;
  return hgt;
}

/** Scroll the window so `el` sits just below the sticky header. */
export function scrollToEl(el, { offset = 8, behavior = 'auto', center = false } = {}) {
  if (!el) return;
  const r = el.getBoundingClientRect();
  let y;
  if (center) y = window.scrollY + r.top - (window.innerHeight - r.height) / 2;
  else y = window.scrollY + r.top - topInset() - offset;
  window.scrollTo({ top: Math.max(0, y), behavior });
}

export function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Copy text to the clipboard with a fallback for older WebKit. */
export async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) { /* fall back */ }
  const ta = h('textarea', { style: { position: 'fixed', opacity: '0', top: '0' }, readonly: true });
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  ta.remove();
  return ok;
}

/** localStorage-backed preference helpers (never throw). */
export const prefs = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem('kb.' + key);
      return v === null ? fallback : JSON.parse(v);
    } catch (e) { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('kb.' + key, JSON.stringify(value)); } catch (e) { /* private mode */ }
  },
  remove(key) {
    try { localStorage.removeItem('kb.' + key); } catch (e) { /* ignore */ }
  },
};
