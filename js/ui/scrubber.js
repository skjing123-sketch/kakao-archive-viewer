// scrubber.js — fast-scroll handle on the right edge of the gallery.
//
// Drag the handle to fly through years of photos; a bubble shows the month under the
// handle and year ticks appear along the track. The handle fades out when idle.

import { h, icon, topInset } from './dom.js';
import { koMonth } from './format.js';

export class Scrubber {
  /** @param gallery Gallery instance (sections provide month labels) */
  constructor(gallery) {
    this.g = gallery;
    this.el = h('div', { class: 'scrubber', 'aria-hidden': 'true' });
    this.track = h('div', { class: 'scrub-track' });
    this.thumb = h('div', { class: 'scrub-thumb', role: 'slider', 'aria-label': '날짜 빠르게 이동', 'aria-valuemin': '0', 'aria-valuemax': '100', tabindex: '-1' }, icon('chevronUp', 14), icon('chevronDown', 14));
    this.bubble = h('div', { class: 'scrub-bubble' });
    this.ticks = h('div', { class: 'scrub-ticks' });
    this.el.append(this.track, this.ticks, this.bubble, this.thumb);
    this.active = false;
    this._hideTimer = null;
    this._raf = 0;
    this._onScroll = () => this._schedule();
    this._onResize = () => this._schedule();
    this._bindDrag();
  }

  attach() {
    if (this.active) return;
    this.active = true;
    window.addEventListener('scroll', this._onScroll, { passive: true });
    window.addEventListener('resize', this._onResize);
    this._schedule();
  }

  detach() {
    this.active = false;
    window.removeEventListener('scroll', this._onScroll);
    window.removeEventListener('resize', this._onResize);
    this.el.classList.remove('show', 'dragging');
  }

  _bounds() {
    const top = topInset() + 8;
    const tabbar = document.querySelector('.tabbar');
    const bottomPad = (tabbar && !tabbar.hidden ? tabbar.getBoundingClientRect().height : 0) + 12;
    const height = Math.max(80, window.innerHeight - top - bottomPad);
    return { top, height };
  }

  _schedule() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this._update(); });
  }

  _update() {
    if (!this.active) return;
    const doc = document.documentElement;
    const max = doc.scrollHeight - window.innerHeight;
    // Only worth it for long pages (more than ~4 screens).
    if (max < window.innerHeight * 3 || this.g.sections.length < 2) { this.el.classList.remove('show'); return; }
    const { top, height } = this._bounds();
    this.el.style.top = top + 'px';
    this.el.style.height = height + 'px';
    const ratio = Math.min(1, Math.max(0, window.scrollY / max));
    const thumbH = 36;
    this.thumb.style.transform = `translateY(${ratio * (height - thumbH)}px)`;
    this.bubble.style.transform = `translateY(${ratio * (height - thumbH)}px)`;
    this.thumb.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
    if (this.dragging) this.bubble.textContent = this._labelAt();
    this.el.classList.add('show');
    clearTimeout(this._hideTimer);
    if (!this.dragging) this._hideTimer = setTimeout(() => this.el.classList.remove('show'), 1500);
  }

  _labelAt() {
    const ym = this.g.currentYm();
    return ym ? koMonth(ym) : '';
  }

  _renderTicks() {
    this.ticks.textContent = '';
    const doc = document.documentElement;
    const max = doc.scrollHeight - window.innerHeight;
    if (max <= 0) return;
    const { height } = this._bounds();
    let lastYear = null, lastY = -100;
    for (const s of this.g.sections) {
      const year = s.ym.slice(0, 4);
      if (year === lastYear) continue;
      lastYear = year;
      const absTop = s.el.getBoundingClientRect().top + window.scrollY - topInset();
      const y = Math.min(1, Math.max(0, absTop / max)) * (height - 36) + 10;
      if (y - lastY < 22) continue;
      lastY = y;
      this.ticks.appendChild(h('span', { class: 'scrub-tick', style: { transform: `translateY(${y}px)` }, text: year }));
    }
  }

  _bindDrag() {
    let pid = null, grabOffset = 0;
    const move = (clientY) => {
      const { top, height } = this._bounds();
      const thumbH = 36;
      const ratio = Math.min(1, Math.max(0, (clientY - top - grabOffset) / (height - thumbH)));
      const max = document.documentElement.scrollHeight - window.innerHeight;
      window.scrollTo(0, ratio * max);
      this._schedule();
    };
    this.thumb.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      pid = ev.pointerId;
      this.thumb.setPointerCapture(pid);
      const r = this.thumb.getBoundingClientRect();
      grabOffset = ev.clientY - r.top;
      this.dragging = true;
      this.g.dragging = true;
      this.el.classList.add('dragging', 'show');
      this._renderTicks();
      this.bubble.textContent = this._labelAt();
    });
    this.thumb.addEventListener('pointermove', (ev) => {
      if (ev.pointerId !== pid) return;
      move(ev.clientY);
    });
    const end = (ev) => {
      if (ev.pointerId !== pid) return;
      pid = null;
      this.dragging = false;
      this.g.dragging = false;
      this.el.classList.remove('dragging');
      this._schedule();
      // Sections we stopped at: make sure they load.
      window.dispatchEvent(new Event('scroll'));
    };
    this.thumb.addEventListener('pointerup', end);
    this.thumb.addEventListener('pointercancel', end);
  }
}
