// gallery.js — date-first photo/video grid (home timeline and room 사진·동영상 tab).
//
// One <section> per month (from archive.months(), i.e. catalog counts only). A section
// starts as a skeleton sized from its count; an IntersectionObserver loads the month's
// rows (archive.mediaInMonth) when it gets near the viewport and drops the tiles again
// when it is far away (and releases the month's thumbnail packs/URLs in the data layer),
// so memory and DOM size stay flat for archives of any length. Thumbnails are requested per
// tile (archive.thumbURL) only when the tile is near view, and a tile that scrolls far away
// drops its image again (src removed → the decoded bitmap can be freed; the URL is asked
// for anew when it comes back, so an object URL revoked meanwhile is never reused) — a
// month with thousands of photos never keeps thousands of decoded thumbnails.
//
// 선택 mode (setSelecting): tapping tiles selects them (per day / month '전체 선택'), and a
// bottom bar saves or shares the originals of the selection at once (files.js shareMany).
//
// Home '전체' timeline (SPEC §13.2 L9, option dedupeAcrossRooms and more than one room in
// scope): each media id is shown once, at its newest reference. A month keeps the ids whose
// newest reference among the LOADED months is in it; when a newer month loads later and
// references the same file, the older month drops that tile. Room-scoped views keep every
// reference. Month header counts are the tiles actually shown once a month is loaded;
// before that the catalog count is shown only where it is exact (no de-duplication).

import { h, icon, clear, scrollToEl, topInset } from './dom.js';
import { koDateFromYmd, koMonth, ymdOf, duration, num } from './format.js';
import { GALLERY_FILTERS, starKey, dedupeNewest, keepShown, tileLabel, isVideoThumb } from './model.js';
import { shareMany } from './files.js';

const GAP = 2;
const DAY_HEAD = 44;
const MONTH_HEAD = 52;
const selKey = (r) => `${r.room}|${r.k}|${r.id}`;

export class Gallery {
  /**
   * @param ctx app context
   * @param opts {roomIds: string[]|null, filter: 'all'|'photo'|'video', mode: 'day'|'month',
   *              cols: number, emptyTitle, emptyText, onEmpty, dedupeAcrossRooms: boolean}
   */
  constructor(ctx, opts) {
    this.ctx = ctx;
    this.roomIds = opts.roomIds || null;
    this.filter = GALLERY_FILTERS[opts.filter] ? opts.filter : 'all';
    this.mode = opts.mode === 'month' ? 'month' : 'day';
    this.colsPref = opts.cols || 0;
    this.emptyTitle = opts.emptyTitle || '사진·동영상이 없어요';
    this.emptyText = opts.emptyText || '';
    this.dedupeAcrossRooms = !!opts.dedupeAcrossRooms;
    this._shown = new Map();              // media id → shown reference (dedupe mode)
    this.el = h('div', { class: 'gallery' });
    this.sections = [];
    this.byYm = new Map();
    this.active = false;
    this.dragging = false;
    this._gen = 0;
    this._onResize = () => this._relayout();
    this._tileIO = new IntersectionObserver((ents) => this._onTiles(ents), { rootMargin: '120% 0px' });
    this._tileFarIO = new IntersectionObserver((ents) => this._onTilesFar(ents), { rootMargin: '400% 0px' });
    this.selecting = false;
    this.selected = new Map();             // selKey → row
    this.onSelection = null;               // (count) => void
    // bottom bar of 선택 mode; the screen places it next to the gallery (build() clears this.el)
    this.selCount = h('span', { class: 'sb-count', role: 'status', 'aria-live': 'polite' });
    this.selShare = h('button', { type: 'button', class: 'btn btn-primary', onclick: () => this.shareSelected() }, icon('share', 18), '저장·공유');
    this.selBar = h('div', { class: 'sel-bar', role: 'toolbar', 'aria-label': '선택한 사진·동영상', hidden: true },
      h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => this.setSelecting(false) }, '취소'),
      this.selCount, this.selShare);
    this._nearIO = new IntersectionObserver((ents) => this._onNear(ents), { rootMargin: '160% 0px' });
    this._farIO = new IntersectionObserver((ents) => this._onFar(ents), { rootMargin: '700% 0px' });
    this.el.addEventListener('click', (ev) => this._onClick(ev));
    this.el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && ev.target.classList.contains('tile')) this._onClick(ev);
    });
    this._starHandler = () => this._refreshStars();
    ctx.on('star', this._starHandler);
    window.addEventListener('resize', this._onResize);
    this.build();
  }

  get rowKinds() { return GALLERY_FILTERS[this.filter].rowKinds; }

  /** One tile per media id (home timeline over several rooms)? Room-scoped: every reference. */
  get dedupe() { return this.dedupeAcrossRooms && !(this.roomIds && this.roomIds.length === 1); }

  /** Rebuild all sections (after a filter/mode change or catalog reload). */
  build() {
    this._gen++;
    for (const s of this.sections) { this._nearIO.unobserve(s.el); this._farIO.unobserve(s.el); }
    this._tileIO.disconnect();
    this._tileFarIO.disconnect();
    this.sections = [];
    this.byYm = new Map();
    this._shown = new Map();
    clear(this.el);
    this._measure();
    this.el.style.setProperty('--cols', this.cols);
    this.el.style.setProperty('--tile', this.tile + 'px');
    this.el.classList.toggle('mode-month', this.mode === 'month');
    const months = this.ctx.archive.months({ roomIds: this.roomIds, kinds: GALLERY_FILTERS[this.filter].monthKinds }) || [];
    if (!months.length) {
      this.el.appendChild(this._empty());
      this.ctx.emit('gallery-built', this);
      return;
    }
    for (const m of months) {
      if (!m || !m.count) continue;
      const sec = { ym: m.ym, count: m.count, el: null, state: 'idle', rows: null, near: false, height: 0 };
      sec.el = h('section', { class: 'g-month', dataset: { ym: m.ym }, 'aria-label': koMonth(m.ym) });
      this._renderSkeleton(sec);
      this.sections.push(sec);
      this.byYm.set(m.ym, sec);
      this.el.appendChild(sec.el);
      this._nearIO.observe(sec.el);
      this._farIO.observe(sec.el);
    }
    this.ctx.emit('gallery-built', this);
  }

  setFilter({ roomIds, filter }) {
    let changed = false;
    if (roomIds !== undefined && JSON.stringify(roomIds || null) !== JSON.stringify(this.roomIds)) { this.roomIds = roomIds || null; changed = true; }
    if (filter !== undefined && filter !== this.filter && GALLERY_FILTERS[filter]) { this.filter = filter; changed = true; }
    if (changed) { window.scrollTo(0, 0); this.build(); }
  }

  setMode(mode) {
    const m = mode === 'month' ? 'month' : 'day';
    if (m === this.mode) return;
    // Keep the month under the header in view — unless the user is still above the grid.
    const scrolledIn = this.el.getBoundingClientRect().top < topInset();
    const anchor = scrolledIn ? this.currentYm() : null;
    this.mode = m;
    this.el.classList.toggle('mode-month', m === 'month');
    for (const s of this.sections) {
      if (s.state === 'loaded') this._renderRows(s); else this._renderSkeleton(s);
    }
    if (anchor) this.jumpTo(anchor);
  }

  setCols(cols) {
    this.colsPref = cols || 0;
    this._relayout(true);
  }

  destroy() {
    this._gen++;
    this._tileIO.disconnect();
    this._tileFarIO.disconnect();
    this._nearIO.disconnect();
    this._farIO.disconnect();
    window.removeEventListener('resize', this._onResize);
    this.ctx.off('star', this._starHandler);
  }

  // -------------------------------------------------------------------------
  // Layout
  // -------------------------------------------------------------------------

  _measure() {
    // clientWidth includes the padding that keeps tiles out of the landscape notch/corners
    // (safe-area insets): measure the content box.
    let pad = 0;
    try {
      const cs = getComputedStyle(this.el);
      pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    } catch (e) { pad = 0; }
    const outer = this.el.clientWidth || document.documentElement.clientWidth;
    const w = Math.max(280, Math.min(outer - pad, 1400));
    let cols = this.colsPref;
    if (!cols) cols = w < 480 ? 3 : w < 720 ? 4 : w < 1000 ? 5 : 6;
    this.cols = cols;
    this.width = w;
    this.tile = (w - GAP * (cols - 1)) / cols;
  }

  _relayout(force = false) {
    const oldCols = this.cols, oldW = this.width;
    this._measure();
    if (!force && oldCols === this.cols && Math.abs(oldW - this.width) < 2) return;
    this.el.style.setProperty('--cols', this.cols);
    this.el.style.setProperty('--tile', this.tile + 'px');
    for (const s of this.sections) if (s.state !== 'loaded') this._renderSkeleton(s);
  }

  _estimateHeight(sec) {
    const rows = Math.ceil(sec.count / this.cols);
    let hgt = MONTH_HEAD + rows * (this.tile + GAP);
    if (this.mode === 'day') {
      const days = Math.min(sec.count, Math.max(1, Math.round(Math.sqrt(sec.count) * 1.6)));
      hgt += days * DAY_HEAD + Math.floor(days / 2) * (this.tile + GAP);
    }
    return Math.round(hgt);
  }

  /** Tiles of a month: exact once loaded; before that the catalog count where it is exact. */
  shownCount(sec) {
    if (sec.rows) return sec.rows.length;
    return this.dedupe ? null : sec.count;
  }

  _monthHead(sec) {
    const n = this.shownCount(sec);
    const head = h('div', { class: 'g-mhead' },
      h('h2', { class: 'g-mtitle', text: koMonth(sec.ym) }),
      h('span', { class: 'g-mcount', text: n === null ? '' : `${num(n)}개` }),
      sec.rows && sec.rows.length ? h('button', { type: 'button', class: 'g-selall', dataset: { selMonth: sec.ym }, text: '전체 선택' }) : null);
    return head;
  }

  _renderSkeleton(sec) {
    const hgt = this._estimateHeight(sec);
    clear(sec.el);
    sec.el.classList.remove('loaded');
    sec.el.appendChild(this._monthHead(sec));
    const sk = h('div', { class: 'g-skel', style: { height: (hgt - MONTH_HEAD) + 'px' } });
    if (sec.state === 'error') {
      sk.classList.add('g-skel-error');
      sk.appendChild(h('button', { type: 'button', class: 'btn btn-small', onclick: () => { sec.state = 'idle'; this._load(sec); } }, icon('refresh', 16), '다시 불러오기'));
    }
    sec.el.appendChild(sk);
    sec.height = hgt;
  }

  _renderRows(sec) {
    const rows = sec.rows || [];
    const frag = document.createDocumentFragment();
    frag.appendChild(this._monthHead(sec));
    if (!rows.length) {
      frag.appendChild(h('p', { class: 'g-none', text: sec.deduped
        ? '이 달의 사진·동영상은 모두 나중에 다시 공유되어 더 최근 날짜에 표시돼요.'
        : '이 달에는 표시할 항목이 없어요.' }));
    } else if (this.mode === 'day') {
      let cur = null, grid = null, count = 0, headCount = null;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const day = ymdOf(r.t);
        if (day !== cur) {
          if (headCount) headCount.textContent = `${count}개`;
          cur = day; count = 0;
          headCount = h('span', { class: 'g-dcount' });
          frag.appendChild(h('h3', { class: 'g-dhead', dataset: { day } }, h('span', { text: koDateFromYmd(day) }), headCount,
            h('button', { type: 'button', class: 'g-selall', dataset: { selDay: day }, text: '선택' })));
          grid = h('div', { class: 'g-grid' });
          frag.appendChild(grid);
        }
        count++;
        grid.appendChild(this._tile(r, i));
      }
      if (headCount) headCount.textContent = `${count}개`;
    } else {
      const grid = h('div', { class: 'g-grid' });
      for (let i = 0; i < rows.length; i++) grid.appendChild(this._tile(rows[i], i));
      frag.appendChild(grid);
    }
    const before = sec.el.getBoundingClientRect();
    const aboveView = before.bottom <= topInset() + 1;
    const oldH = before.height;
    this._forgetTiles(sec);
    clear(sec.el);
    sec.el.appendChild(frag);
    sec.el.classList.add('loaded');
    for (const t of sec.el.querySelectorAll('.tile')) this._tileIO.observe(t);
    const newH = sec.el.getBoundingClientRect().height;
    sec.height = newH;
    if (aboveView && Math.abs(newH - oldH) > 0.5 && !this.dragging) window.scrollBy(0, newH - oldH);
  }

  _tile(r, i) {
    const t = h('button', { type: 'button', class: 'tile', dataset: { i: String(i) }, 'aria-label': tileLabel(r) });
    if (this.selecting) {
      const on = this.selected.has(selKey(r));
      t.classList.toggle('sel', on);
      t.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    t.appendChild(h('img', { alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' }));
    // a video kept only as its thumbnail: video badge (no play icon; length only if known)
    if (isVideoThumb(r)) t.appendChild(h('span', { class: 'badge badge-video badge-vthumb', title: '동영상 · 썸네일만 보관됨' }, icon('video', 12), r.d ? duration(r.d) : ''));
    else if (r.y === 'video') t.appendChild(h('span', { class: 'badge badge-video' }, icon('play', 12), r.d ? duration(r.d) : ''));
    else if (r.y === 'gif') t.appendChild(h('span', { class: 'badge badge-gif', text: 'GIF' }));
    if (r.to) t.appendChild(h('span', { class: 'badge badge-low', title: '썸네일만 보관됨' }, icon('lowres', 12), '저화질'));
    if (this.ctx.archive.isStarred(starKey(r.room, r.k, r.id))) t.appendChild(h('span', { class: 'badge badge-star' }, icon('starFill', 14)));
    if (!r.th) t.classList.add('nothumb');
    return t;
  }

  _empty() {
    return h('div', { class: 'empty' },
      h('div', { class: 'empty-ic' }, icon('photo', 34)),
      h('p', { class: 'empty-title', text: this.emptyTitle }),
      this.emptyText ? h('p', { class: 'empty-text', text: this.emptyText }) : null);
  }

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  _onNear(entries) {
    for (const e of entries) {
      const sec = this.byYm.get(e.target.dataset.ym);
      if (!sec) continue;
      sec.near = e.isIntersecting;
      if (sec.near && sec.state !== 'loaded' && sec.state !== 'loading') {
        // While the scrubber flies past, only load sections the user stops at.
        const delay = this.dragging ? 220 : 0;
        setTimeout(() => { if (sec.near) this._load(sec); }, delay);
      }
    }
  }

  _onFar(entries) {
    for (const e of entries) {
      if (e.isIntersecting) continue;
      const sec = this.byYm.get(e.target.dataset.ym);
      if (sec && sec.state === 'loaded') this._unload(sec);
    }
  }

  _forgetTiles(sec) {
    for (const t of sec.el.querySelectorAll('.tile')) { this._tileIO.unobserve(t); this._tileFarIO.unobserve(t); }
  }

  _unload(sec) {
    const hgt = sec.el.getBoundingClientRect().height;
    this._forgetTiles(sec);
    clear(sec.el);
    sec.el.classList.remove('loaded');
    sec.el.appendChild(this._monthHead(sec));
    sec.el.appendChild(h('div', { class: 'g-skel', style: { height: Math.max(0, hgt - MONTH_HEAD) + 'px' } }));
    sec.state = 'unloaded';
    this._releaseMonth(sec.ym);
  }

  /** The month scrolled far away: free its thumbnail packs and object URLs in the data layer. */
  _releaseMonth(ym) {
    const a = this.ctx.archive;
    if (!a || typeof a.releaseMonth !== 'function') return;
    const ids = this.roomIds || a.rooms().map((r) => r.id);
    for (const id of ids) {
      try { a.releaseMonth(id, ym); } catch (e) { /* not in this room */ }
    }
  }

  /** Load one month's rows; resolves when rendered. */
  async _load(sec) {
    if (sec.state === 'loading') return sec.promise;
    if (sec.state === 'loaded') return;
    if (sec.rows && sec.state === 'unloaded') {
      sec.state = 'loaded';
      this._renderRows(sec);
      return;
    }
    const gen = this._gen;
    sec.state = 'loading';
    sec.el.classList.add('loading');
    sec.promise = (async () => {
      try {
        const kinds = this.rowKinds;
        const rows = await this.ctx.archive.mediaInMonth(sec.ym, { roomIds: this.roomIds, kinds });
        if (gen !== this._gen) return;
        let list = (rows || []).filter((r) => kinds.includes(r.y)).map((r) => (r.ym ? r : Object.assign({}, r, { ym: sec.ym })));
        let stolen = null;
        if (this.dedupe) {
          const before = list.length;
          ({ rows: list, stolen } = dedupeNewest(list, this._shown, sec.ym));
          sec.deduped = list.length < before;
        }
        sec.rows = list;
        sec.state = 'loaded';
        this._renderRows(sec);
        if (stolen && stolen.size) this._dropStolen(stolen);
        this.ctx.emit('gallery-loaded', { gallery: this, ym: sec.ym });
      } catch (err) {
        if (gen !== this._gen) return;
        console.warn('[gallery] month load failed', sec.ym, err);
        sec.state = 'error';
        this._renderSkeleton(sec);
        this.ctx.handleError(err, { quiet: true });
      } finally {
        sec.el.classList.remove('loading');
      }
    })();
    return sec.promise;
  }

  /** Older months whose tile lost to a newer reference loaded just now: drop those tiles. */
  _dropStolen(keys) {
    for (const ym of keys) {
      const s = this.byYm.get(ym);
      if (!s || !s.rows) continue;
      const kept = keepShown(s.rows, this._shown, ym);
      if (kept.length === s.rows.length) continue;
      s.rows = kept;
      s.deduped = true;
      if (s.state === 'loaded') this._renderRows(s);
      else if (s.state === 'unloaded') {
        const c = s.el.querySelector('.g-mcount');
        if (c) c.textContent = `${num(kept.length)}개`;
      }
    }
  }

  _onTiles(entries) {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const tile = e.target;
      this._tileIO.unobserve(tile);
      const month = tile.closest('.g-month');
      const sec = month ? this.byYm.get(month.dataset.ym) : null;
      const row = sec && sec.rows ? sec.rows[+tile.dataset.i] : null;
      if (!row || !row.th) continue;
      this._setThumb(tile, row, false);
    }
  }

  /** Tiles far from the viewport (or on a hidden screen) give their image up again. */
  _onTilesFar(entries) {
    for (const e of entries) {
      if (e.isIntersecting) continue;
      const tile = e.target;
      this._tileFarIO.unobserve(tile);
      const img = tile.querySelector('img');
      if (!img || !img.hasAttribute('src')) continue;
      img.onload = img.onerror = null;
      img.removeAttribute('src');
      tile.classList.remove('ready');
      if (tile.isConnected) this._tileIO.observe(tile);        // load again when it comes back
    }
  }

  /** Load a tile's thumbnail; retry once (the data layer may have revoked an old object URL). */
  _setThumb(tile, row, retry) {
    const img = tile.querySelector('img');
    const gen = this._gen;
    Promise.resolve(this.ctx.archive.thumbURL(row)).then((url) => {
      if (gen !== this._gen || !tile.isConnected) return;
      if (!url) { tile.classList.add('nothumb'); return; }
      img.onload = () => tile.classList.add('ready');
      img.onerror = () => { if (!retry) this._setThumb(tile, row, true); else tile.classList.add('nothumb'); };
      img.src = url;
      this._tileFarIO.observe(tile);
    }).catch(() => tile.classList.add('nothumb'));
  }

  /** Re-measure (call when the gallery becomes visible; its width is unknown while detached). */
  relayout() { this._relayout(); }

  _refreshStars() {
    for (const sec of this.sections) {
      if (sec.state !== 'loaded') continue;
      for (const t of sec.el.querySelectorAll('.tile')) {
        const r = sec.rows[+t.dataset.i];
        const on = this.ctx.archive.isStarred(starKey(r.room, r.k, r.id));
        const b = t.querySelector('.badge-star');
        if (on && !b) t.appendChild(h('span', { class: 'badge badge-star' }, icon('starFill', 14)));
        else if (!on && b) b.remove();
      }
    }
  }

  // -------------------------------------------------------------------------
  // Interaction
  // -------------------------------------------------------------------------

  _onClick(ev) {
    const all = ev.target.closest('.g-selall');
    if (all) {
      ev.preventDefault();
      const month = all.closest('.g-month');
      const sec = month ? this.byYm.get(month.dataset.ym) : null;
      if (!sec || !sec.rows) return;
      if (!this.selecting) this.setSelecting(true);
      const day = all.dataset.selDay;
      const rows = day ? sec.rows.filter((r) => ymdOf(r.t) === day) : sec.rows;
      const allOn = rows.every((r) => this.selected.has(selKey(r)));
      for (const r of rows) this._select(r, !allOn);
      this._paintSelection();
      return;
    }
    const tile = ev.target.closest('.tile');
    if (!tile) return;
    const sec = this.byYm.get(tile.closest('.g-month').dataset.ym);
    const row = sec && sec.rows ? sec.rows[+tile.dataset.i] : null;
    if (!row) return;
    ev.preventDefault();
    if (this.selecting) {
      this._select(row, !this.selected.has(selKey(row)));
      this._paintSelection();
      return;
    }
    this.ctx.openViewer(row, this.viewerProvider());
  }

  // -------------------------------------------------------------------------
  // 선택 (multi-select → save/share)
  // -------------------------------------------------------------------------

  /** Enter / leave selection mode (leaving clears the selection). */
  setSelecting(on) {
    this.selecting = !!on;
    if (!this.selecting) this.selected.clear();
    this.el.classList.toggle('selecting', this.selecting);
    this._paintSelection();
  }

  _select(row, on) {
    if (on) this.selected.set(selKey(row), row); else this.selected.delete(selKey(row));
  }

  _paintSelection() {
    for (const sec of this.sections) {
      if (sec.state !== 'loaded' || !sec.rows) continue;
      for (const t of sec.el.querySelectorAll('.tile')) {
        const r = sec.rows[+t.dataset.i];
        const on = this.selecting && !!r && this.selected.has(selKey(r));
        t.classList.toggle('sel', on);
        if (this.selecting) t.setAttribute('aria-pressed', on ? 'true' : 'false'); else t.removeAttribute('aria-pressed');
      }
    }
    const n = this.selected.size;
    this.selBar.hidden = !this.selecting;
    this.selCount.textContent = n ? `${num(n)}개 선택됨` : '사진·동영상을 선택하세요';
    this.selShare.disabled = n === 0;
    if (this.onSelection) { try { this.onSelection(n); } catch (e) { /* UI */ } }
  }

  /** Rows selected, newest first (display order of the loaded months). */
  selectedRows() {
    const order = [];
    for (const s of this.sections) if (s.rows) for (const r of s.rows) if (this.selected.has(selKey(r))) order.push(r);
    // selected rows of months unloaded meanwhile keep their place at the end
    const seen = new Set(order.map(selKey));
    for (const [k, r] of this.selected) if (!seen.has(k)) order.push(r);
    return order;
  }

  /** Save/share the originals of the selection, then leave selection mode. */
  async shareSelected() {
    const rows = this.selectedRows();
    if (!rows.length) return;
    const res = await shareMany(this.ctx, rows, { title: `사진·동영상 ${rows.length}개` });
    if (res !== 'cancelled') this.setSelecting(false);
  }

  /** List provider for the media viewer: the loaded rows in display order. */
  viewerProvider() {
    return {
      list: () => {
        const out = [];
        for (const s of this.sections) if (s.rows) out.push(...s.rows);
        return out;
      },
      /** Load the next (dir=+1, older) or previous (dir=-1, newer) month around `row`. */
      extend: async (row, dir) => {
        const idx = this.sections.findIndex((s) => s.ym === row.ym);
        for (let i = idx + dir; i >= 0 && i < this.sections.length; i += dir) {
          const s = this.sections[i];
          if (s.rows) continue;
          await this._load(s);
          return !!(s.rows && s.rows.length);
        }
        return false;
      },
    };
  }

  /** The month at the top of the viewport. */
  currentYm() {
    const y = topInset() + 4;
    for (const s of this.sections) {
      const r = s.el.getBoundingClientRect();
      if (r.bottom > y) return s.ym;
    }
    return this.sections.length ? this.sections[this.sections.length - 1].ym : null;
  }

  /** Scroll to a month (and optionally a day 'YYYY-MM-DD'), loading it first. */
  async jumpTo(ym, ymd = null) {
    let sec = this.byYm.get(ym);
    if (!sec) sec = this.sections.find((s) => s.ym <= ym) || this.sections[this.sections.length - 1];
    if (!sec) return;
    scrollToEl(sec.el, { offset: 0 });
    await this._load(sec);
    let target = sec.el;
    if (ymd && this.mode === 'day') target = sec.el.querySelector(`.g-dhead[data-day="${ymd}"]`) || sec.el;
    scrollToEl(target, { offset: 0 });
    // Neighbours loading above may shift layout: re-anchor a couple of times.
    for (const wait of [120, 400]) {
      await new Promise((r) => setTimeout(r, wait));
      if (!this.active) return;
      scrollToEl(target, { offset: 0 });
    }
    if (target.classList.contains('g-dhead')) {
      target.classList.add('flash');
      setTimeout(() => target.classList.remove('flash'), 1400);
    }
  }

  /** {ymd -> count} for a month (used by the calendar jump sheet). */
  async daysOf(ym) {
    const sec = this.byYm.get(ym);
    let rows = sec && sec.rows;
    if (!rows) {
      const kinds = this.rowKinds;
      rows = (await this.ctx.archive.mediaInMonth(ym, { roomIds: this.roomIds, kinds }) || []).filter((r) => kinds.includes(r.y));
      if (this.dedupe) rows = dedupeNewest(rows, new Map([...this._shown].filter(([, v]) => v.key !== ym)), ym).rows;
    }
    const out = new Map();
    for (const r of rows) { const d = ymdOf(r.t); out.set(d, (out.get(d) || 0) + 1); }
    return out;
  }

  /** Months for the scrubber / calendar: shown tiles once loaded, else the catalog count. */
  monthsList() { return this.sections.map((s) => ({ ym: s.ym, count: s.rows ? s.rows.length : s.count })); }
}
