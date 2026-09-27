// widgets.js — small reusable controls: segmented control and single-choice chip group.

import { h } from './dom.js';

/** Segmented control. items: [[value, label]] */
export function segmented(items, value, onChange, label) {
  const el = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': label });
  const btns = items.map(([v, text]) => {
    const b = h('button', { type: 'button', role: 'radio', class: 'seg-btn', 'aria-checked': v === value ? 'true' : 'false', text, onclick: () => set(v, true) });
    b.dataset.v = v;
    el.appendChild(b);
    return b;
  });
  function set(v, fire) {
    for (const b of btns) b.setAttribute('aria-checked', b.dataset.v === v ? 'true' : 'false');
    if (fire) onChange(v);
  }
  el.set = (v) => set(v, false);
  return el;
}

/** Filter chips (single choice). */
export function chipGroup(items, value, onChange, label) {
  const el = h('div', { class: 'chip-group', role: 'radiogroup', 'aria-label': label });
  const btns = items.map(([v, text]) => {
    const b = h('button', { type: 'button', role: 'radio', class: 'chip' + (v === value ? ' on' : ''), 'aria-checked': v === value ? 'true' : 'false', text, onclick: () => set(v, true) });
    b.dataset.v = v;
    el.appendChild(b);
    return b;
  });
  function set(v, fire) {
    for (const b of btns) { const on = b.dataset.v === v; b.classList.toggle('on', on); b.setAttribute('aria-checked', on ? 'true' : 'false'); }
    if (fire) onChange(v);
  }
  el.set = (v) => set(v, false);
  return el;
}
