// viewer.js — full-screen media viewer overlay (route param ?view=<room>|<ym>|<mediaId>).
//
// Swipe left/right through the current list (provided by the screen that opened it),
// pinch / double-tap / ctrl+wheel zoom for photos, <video controls playsinline> for videos,
// swipe down to close, info sheet, ★ 중요, 공유/저장, 대화에서 보기. A video whose original
// was never downloaded (y:'video', to:true, a JPEG file — model.isVideoThumb) is shown as a
// picture with a '동영상 · 썸네일만 보관됨' badge, never in a <video>.

import { h, icon, iconButton, clear, openSheet, toast, prefersReducedMotion } from './dom.js';
import { koDateTime, koDate, koTime, bytes, duration, mediaKindLabel } from './format.js';
import { starKey, hasFullMedia, isVideoThumb } from './model.js';
import { pathOf, decodeViewParam, encodeViewParam } from './router.js';
import { shareOrSave } from './files.js';
import { stopAudio } from './audio.js';

const MAX_SCALE = 5;
const DOUBLE_TAP_SCALE = 2.5;
const rowKey = (r) => `${r.room}|${r.k}|${r.id}`;
/** A real (playable) video — not the thumbnail of one that was never downloaded. */
const isPlayable = (r) => !!r && r.y === 'video' && !isVideoThumb(r);
const VIDEO_THUMB_TEXT = '동영상의 썸네일만 보관되었어요 — 원본 동영상은 휴대폰에서 받지 않아 보관되지 않았어요.';

export class MediaViewer {
  constructor(ctx) {
    this.ctx = ctx;
    this.isOpen = false;
    this.provider = null;
    this.list = [];
    this.index = -1;
    this.chrome = true;
    this.el = h('div', { class: 'viewer', role: 'dialog', 'aria-modal': 'true', 'aria-label': '사진 보기', hidden: true });
    this.backdrop = h('div', { class: 'vw-backdrop' });
    this.track = h('div', { class: 'vw-track' });
    this.slides = [0, 1, 2].map(() => this._makeSlide());
    for (const s of this.slides) this.track.appendChild(s.el);
    this.title = h('div', { class: 'vw-title' }, h('span', { class: 'vw-sender' }), h('span', { class: 'vw-when' }));
    this.closeBtn = iconButton('close', '닫기', () => this.requestClose(), 'vw-btn');
    this.infoBtn = iconButton('info', '정보', () => this.showInfo(), 'vw-btn');
    this.top = h('div', { class: 'vw-top' }, this.closeBtn, this.title, this.infoBtn);
    this.badges = h('div', { class: 'vw-badges' });
    this.starBtn = h('button', { type: 'button', class: 'vw-action', onclick: () => this.toggleStar() }, icon('star', 24), h('span', { text: '중요' }));
    this.shareBtn = h('button', { type: 'button', class: 'vw-action', onclick: () => this.share() }, icon('share', 24), h('span', { text: '공유·저장' }));
    this.chatBtn = h('button', { type: 'button', class: 'vw-action', onclick: () => this.goChat() }, icon('chatJump', 24), h('span', { text: '대화에서 보기' }));
    this.bottom = h('div', { class: 'vw-bottom' }, this.starBtn, this.shareBtn, this.chatBtn);
    this.prevBtn = iconButton('back', '이전', () => this.go(-1), 'vw-nav vw-prev');
    this.nextBtn = iconButton('forward', '다음', () => this.go(1), 'vw-nav vw-next');
    this.el.append(this.backdrop, this.track, this.top, this.badges, this.bottom, this.prevBtn, this.nextBtn);
    document.body.appendChild(this.el);
    this._bindGestures();
    this._onKey = (ev) => this._key(ev);
    this._onResize = () => { if (this.isOpen) { for (const s of this.slides) this._layout(s); this._position(0, false); } };
    ctx.on('star', () => this._updateStar());
  }

  // -------------------------------------------------------------------------
  // Open / close (driven by the router)
  // -------------------------------------------------------------------------

  /** Show the viewer for a route ?view= value. Returns false if the param is invalid. */
  async showParam(param, provider) {
    const ref = decodeViewParam(param);
    if (!ref) return false;
    if (provider) this.provider = provider;
    let list = this.provider ? this.provider.list() : [];
    let idx = this._find(list, ref);
    if (idx < 0) {
      // Deep link / reload: list = that month of that room.
      try {
        const rows = await this.ctx.archive.mediaInMonth(ref.ym, { roomIds: [ref.room], kinds: ['photo', 'gif', 'video'] });
        list = (rows || []).filter((r) => r.y === 'photo' || r.y === 'gif' || r.y === 'video').map((r) => Object.assign({}, r, { room: r.room || ref.room, ym: r.ym || ref.ym }));
        this.provider = this._monthProvider(ref.room, list);
        idx = this._find(list, ref);
      } catch (err) {
        this.ctx.handleError(err, { quiet: true });
      }
      if (idx < 0) {
        toast('사진을 찾을 수 없어요.', { kind: 'error' });
        return false;
      }
    }
    this.list = list;
    if (!this.isOpen) this._open();
    if (idx !== this.index || !this.slides[1].row || rowKey(this.slides[1].row) !== rowKey(list[idx])) {
      this.index = idx;
      this._renderAll();
    }
    return true;
  }

  _find(list, ref) {
    let i = list.findIndex((r) => r.id === ref.id && r.room === ref.room && (!ref.k || r.k === ref.k));
    if (i < 0) i = list.findIndex((r) => r.id === ref.id && r.room === ref.room);
    return i;
  }

  /** Fallback provider: one month of one room, extendable to neighbouring months. */
  _monthProvider(roomId, rows) {
    const room = this.ctx.archive.room(roomId);
    const yms = room ? (room.months || []).filter((m) => (m.photo || 0) + (m.video || 0) > 0).map((m) => m.ym) : [];   // desc
    let list = rows.slice();
    const loaded = new Set(rows.length ? [rows[0].ym] : []);
    return {
      list: () => list,
      extend: async (row, dir) => {
        const edge = dir > 0 ? list[list.length - 1] : list[0];
        const i = yms.indexOf(edge ? edge.ym : row.ym);
        const next = yms[i + (dir > 0 ? 1 : -1)];
        if (!next || loaded.has(next)) return false;
        loaded.add(next);
        const more = ((await this.ctx.archive.mediaInMonth(next, { roomIds: [roomId], kinds: ['photo', 'gif', 'video'] })) || [])
          .filter((r) => r.y === 'photo' || r.y === 'gif' || r.y === 'video').map((r) => Object.assign({}, r, { room: r.room || roomId, ym: r.ym || next }));
        list = dir > 0 ? list.concat(more) : more.concat(list);
        return more.length > 0;
      },
    };
  }

  _open() {
    this.isOpen = true;
    this.prevFocus = document.activeElement;
    stopAudio();
    this.el.hidden = false;
    this.el.classList.remove('closing');
    requestAnimationFrame(() => this.el.classList.add('open'));
    document.documentElement.classList.add('viewer-open');
    this.setChrome(true);
    document.addEventListener('keydown', this._onKey);
    window.addEventListener('resize', this._onResize);
    setTimeout(() => { try { this.closeBtn.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }, 50);
  }

  /** Hide (called when the route loses ?view=). */
  hide() {
    if (!this.isOpen) return;
    this.isOpen = false;
    document.removeEventListener('keydown', this._onKey);
    window.removeEventListener('resize', this._onResize);
    for (const s of this.slides) this._unloadSlide(s);
    this.el.classList.remove('open');
    this.el.classList.add('closing');
    document.documentElement.classList.remove('viewer-open');
    const done = () => { if (!this.isOpen) { this.el.hidden = true; this.el.classList.remove('closing'); this.backdrop.style.opacity = ''; this.track.style.transform = ''; } };
    if (prefersReducedMotion()) done(); else setTimeout(done, 200);
    this.index = -1;
    // originals downloaded into memory (Drive without a service worker) are freed now
    if (this.ctx.archive && typeof this.ctx.archive.releaseMediaURLs === 'function') this.ctx.archive.releaseMediaURLs();
    if (this.prevFocus && document.contains(this.prevFocus)) { try { this.prevFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
  }

  /** User asked to close: pop the history entry that opened the viewer. */
  requestClose() {
    if (this.ctx.viewerPushed()) history.back();
    else this.ctx.router.setQuery({ view: null }, { replace: true });
  }

  // -------------------------------------------------------------------------
  // Slides
  // -------------------------------------------------------------------------

  _makeSlide() {
    const thumb = h('img', { class: 'vw-thumb', alt: '', draggable: 'false' });
    const full = h('img', { class: 'vw-full', alt: '', draggable: 'false' });
    const stage = h('div', { class: 'vw-stage' }, thumb, full);
    const msg = h('div', { class: 'vw-msg', hidden: true });
    const el = h('div', { class: 'vw-slide' }, stage, msg);
    return { el, stage, thumb, full, msg, row: null, video: null, z: { s: 1, tx: 0, ty: 0 }, box: null, gen: 0 };
  }

  _unloadSlide(s) {
    if (s.video) { try { s.video.pause(); s.video.removeAttribute('src'); s.video.load(); } catch (e) { /* ignore */ } s.video.remove(); s.video = null; }
    s.full.removeAttribute('src');
    s.thumb.removeAttribute('src');
    s.row = null;
  }

  _renderAll() {
    const rows = [this.list[this.index - 1] || null, this.list[this.index] || null, this.list[this.index + 1] || null];
    rows.forEach((r, i) => this._renderSlide(this.slides[i], r, i === 1));
    this._position(0, false);
    this._afterChange();
  }

  _renderSlide(s, row, current) {
    if (s.row && row && rowKey(s.row) === rowKey(row)) {
      if (current) this._activate(s); else this._deactivate(s);
      return;
    }
    this._unloadSlide(s);
    s.row = row;
    s.gen++;
    s.z = { s: 1, tx: 0, ty: 0 };
    s.el.classList.remove('loaded', 'is-video', 'is-video-thumb', 'failed');
    s.msg.hidden = true;
    s.full.style.transform = s.thumb.style.transform = '';
    if (!row) { s.el.classList.add('empty'); return; }
    s.el.classList.remove('empty');
    this._layout(s);
    const gen = s.gen;
    if (row.th) {
      Promise.resolve(this.ctx.archive.thumbURL(row)).then((u) => { if (u && s.gen === gen) { s.thumb.src = u; if (s.video) s.video.poster = u; } }).catch(() => {});
    }
    if (isPlayable(row)) {
      s.el.classList.add('is-video');
      if (current) this._activate(s);
      else s.stage.appendChild(h('span', { class: 'vw-play', 'aria-hidden': 'true' }, icon('play', 34)));
      return;
    }
    if (isVideoThumb(row)) {
      // only the JPEG thumbnail exists: a picture (zoomable), no play button, no <video>
      s.el.classList.add('is-video-thumb');
      this._message(s, VIDEO_THUMB_TEXT, 'info');
    }
    this._loadFull(s, current);
  }

  _layout(s) {
    const row = s.row;
    if (!row) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    let w = row.w || (row.th && row.th.w) || 4, hgt = row.h || (row.th && row.th.h) || 3;
    if (s.full.naturalWidth && s.full.complete) { w = s.full.naturalWidth; hgt = s.full.naturalHeight; }
    const fit = Math.min(vw / w, vh / hgt);
    const W = Math.round(w * fit), H = Math.round(hgt * fit);
    const L = Math.round((vw - W) / 2), T = Math.round((vh - H) / 2);
    s.box = { L, T, W, H, vw, vh };
    for (const img of [s.thumb, s.full]) Object.assign(img.style, { left: L + 'px', top: T + 'px', width: W + 'px', height: H + 'px' });
    this._applyZoom(s, false);
  }

  _loadFull(s, current) {
    const row = s.row;
    const gen = s.gen;
    const policy = this.ctx.originalsPolicy();
    if (!hasFullMedia(row)) {
      this._message(s, isVideoThumb(row) ? VIDEO_THUMB_TEXT
        : row.to ? '저화질 사진이에요 — 썸네일만 보관되었어요 (원본이 휴대폰에 없었어요).'
        : policy !== 'all' ? '원본은 NAS에 보관되어 있어요. 이 저장소에는 미리보기만 있어요.' : '원본이 보관되지 않았어요.', 'info');
      return;
    }
    // Preview first when there is one (HEIC / huge photos), then the original; the data
    // layer already prefers the JPEG preview for HEIC on browsers that cannot show HEIC.
    const variants = row.pv ? [true, false] : [false];
    let i = 0;
    const next = async () => {
      if (s.gen !== gen) return;
      let url = null;
      while (!url && i < variants.length) {
        url = await this.ctx.mediaSrc(row, { preferPreview: variants[i++] });
        if (s.gen !== gen) return;
        if (url && url === s.full.getAttribute('src')) url = null;
      }
      if (!url) {
        s.el.classList.add('failed');
        this._message(s, /heic|heif/i.test(row.mime || '') ? '이 브라우저는 HEIC 사진을 표시할 수 없어요. 공유·저장으로 원본을 받을 수 있어요.' : '사진을 불러오지 못했어요. 네트워크를 확인해 주세요.', 'error');
        return;
      }
      s.full.src = url;
    };
    s.full.onload = () => {
      if (s.gen !== gen) return;
      s.el.classList.add('loaded');
      this._layout(s);
    };
    s.full.onerror = () => next();
    s.full.decoding = 'async';
    next();
  }

  _message(s, text, kind) {
    clear(s.msg).append(icon(kind === 'error' ? 'alert' : 'info', 16), h('span', { text }));
    s.msg.className = 'vw-msg vw-msg-' + kind;
    s.msg.hidden = false;
  }

  _activate(s) {
    const row = s.row;
    if (!isPlayable(row) || s.video) return;
    const ov = s.stage.querySelector('.vw-play');
    if (ov) ov.remove();
    if (!hasFullMedia(row)) {
      this._message(s, this.ctx.originalsPolicy() !== 'all' ? '동영상 원본은 NAS에 보관되어 있어요.' : '동영상 원본이 보관되지 않았어요.', 'info');
      s.stage.appendChild(h('span', { class: 'vw-play off', 'aria-hidden': 'true' }, icon('play', 34)));
      return;
    }
    const v = h('video', { class: 'vw-video', controls: true, preload: 'metadata' });
    v.setAttribute('playsinline', '');
    v.setAttribute('webkit-playsinline', '');
    if (s.thumb.src) v.poster = s.thumb.src;
    v.addEventListener('error', () => {
      if (s.video !== v) return;
      const needsSW = this.ctx.sourceKind() === 'drive' && !(navigator.serviceWorker && navigator.serviceWorker.controller);
      this._message(s, needsSW ? '동영상 재생 준비가 안 됐어요. 앱을 닫았다가 다시 열어 주세요.' : '동영상을 재생할 수 없어요. 공유·저장으로 원본을 받아 보세요.', 'error');
    });
    s.video = v;
    s.stage.appendChild(v);
    const gen = s.gen;
    Promise.resolve(this.ctx.mediaSrc(row)).then((url) => {
      if (s.gen !== gen || s.video !== v) return;
      if (!url) {
        const noSW = typeof this.ctx.needsBlobMedia === 'function' && this.ctx.needsBlobMedia();
        this._message(s, noSW ? '동영상 재생 준비가 안 됐어요. 앱을 닫았다가 다시 열어 주세요.' : '동영상을 불러올 수 없어요.', 'error');
        return;
      }
      v.src = url;
    });
  }

  _deactivate(s) {
    if (s.video) { try { s.video.pause(); } catch (e) { /* ignore */ } }
    if (s.z.s !== 1) { s.z = { s: 1, tx: 0, ty: 0 }; this._applyZoom(s, false); }
  }

  _afterChange() {
    const row = this.list[this.index];
    if (!row) return;
    this.slides.forEach((s, i) => (i === 1 ? this._activate(s) : this._deactivate(s)));
    const room = this.ctx.archive.room(row.room);
    this.title.querySelector('.vw-sender').textContent = row.n || (room ? room.displayName || room.name : '');
    this.title.querySelector('.vw-when').textContent = `${koDate(row.t)} ${koTime(row.t)}`;
    this.el.setAttribute('aria-label', `${mediaKindLabel(row.y)}${isVideoThumb(row) ? ' 썸네일' : ''} 보기, ${row.n || ''}, ${koDateTime(row.t)}`);
    clear(this.badges);
    if (isVideoThumb(row)) this.badges.appendChild(h('span', { class: 'vw-badge vw-badge-vthumb' }, icon('video', 14), '동영상 · 썸네일만 보관됨'));
    else if (row.to) this.badges.appendChild(h('span', { class: 'vw-badge' }, icon('lowres', 14), '저화질 · 썸네일만 보관됨'));
    else if (row.pv && row.orig === false) this.badges.appendChild(h('span', { class: 'vw-badge' }, icon('info', 14), '미리보기 · 원본은 NAS에 보관됨'));
    this.prevBtn.hidden = this.index <= 0 && !this.provider;
    this.nextBtn.hidden = this.index >= this.list.length - 1 && !this.provider;
    this.chatBtn.disabled = !row.k;
    this.shareBtn.disabled = !hasFullMedia(row);
    this._updateStar();
    // Prefetch more rows when close to either end.
    if (this.provider && this.provider.extend) {
      if (this.index >= this.list.length - 3) this._extend(1);
      if (this.index <= 2) this._extend(-1);
    }
  }

  async _extend(dir) {
    if (this._extending) return;
    this._extending = true;
    try {
      const cur = this.list[this.index];
      const more = await this.provider.extend(cur, dir);
      if (!more || !this.isOpen) return;
      const list = this.provider.list();
      const idx = list.findIndex((r) => rowKey(r) === rowKey(cur));
      if (idx < 0) return;
      this.list = list;
      this.index = idx;
      const rows = [this.list[idx - 1] || null, this.list[idx] || null, this.list[idx + 1] || null];
      rows.forEach((r, i) => { if (i !== 1) this._renderSlide(this.slides[i], r, false); });
    } catch (err) {
      console.warn('[viewer] extend failed', err);
    } finally {
      this._extending = false;
    }
  }

  _updateStar() {
    const row = this.list[this.index];
    if (!row) return;
    const on = this.ctx.archive.isStarred(starKey(row.room, row.k, row.id));
    this.starBtn.classList.toggle('on', on);
    this.starBtn.replaceChildren(icon(on ? 'starFill' : 'star', 24), h('span', { text: on ? '중요 해제' : '중요' }));
    this.starBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  /** Move by dir (+1 next / -1 previous) with animation. */
  async go(dir) {
    if (this._animating) return;
    let target = this.index + dir;
    if (target < 0 || target >= this.list.length) {
      if (this.provider && this.provider.extend) {
        await this._extend(dir);
        target = this.index + dir;
      }
      if (target < 0 || target >= this.list.length) { this._position(0, true); toast(dir > 0 ? '마지막 항목이에요.' : '처음 항목이에요.'); return; }
    }
    this._animating = true;
    this._position(-dir * window.innerWidth, true);
    const finish = () => {
      this._animating = false;
      if (dir > 0) this.slides.push(this.slides.shift()); else this.slides.unshift(this.slides.pop());
      for (const s of this.slides) this.track.appendChild(s.el);
      this.index = target;
      this._renderAll();
      const row = this.list[this.index];
      this.ctx.router.setQuery({ view: encodeViewParam(row) }, { replace: true });
    };
    if (prefersReducedMotion()) finish(); else setTimeout(finish, 230);
  }

  _position(dx, animate) {
    this.track.style.transition = animate && !prefersReducedMotion() ? 'transform .23s cubic-bezier(.2,.8,.2,1)' : 'none';
    this.track.style.transform = `translate3d(${dx}px,0,0)`;
  }

  setChrome(on) {
    this.chrome = on;
    this.el.classList.toggle('chrome-off', !on);
  }

  // -------------------------------------------------------------------------
  // Zoom & gestures
  // -------------------------------------------------------------------------

  _applyZoom(s, animate) {
    const t = `translate3d(${s.z.tx}px, ${s.z.ty}px, 0) scale(${s.z.s})`;
    for (const img of [s.full, s.thumb]) {
      img.style.transition = animate && !prefersReducedMotion() ? 'transform .2s ease-out' : 'none';
      img.style.transform = t;
    }
    s.el.classList.toggle('zoomed', s.z.s > 1.01);
  }

  _clamp(s) {
    const b = s.box;
    if (!b) return;
    const z = s.z;
    const sw = b.W * z.s, sh = b.H * z.s;
    if (sw <= b.vw) z.tx = (b.vw - sw) / 2 - b.L;
    else z.tx = Math.min(-b.L, Math.max(b.vw - b.L - sw, z.tx));
    if (sh <= b.vh) z.ty = (b.vh - sh) / 2 - b.T;
    else z.ty = Math.min(-b.T, Math.max(b.vh - b.T - sh, z.ty));
  }

  _zoomAt(s, scale, cx, cy, animate = true) {
    const b = s.box;
    if (!b) return;
    const z = s.z;
    const ux = (cx - (b.L + z.tx)) / z.s;
    const uy = (cy - (b.T + z.ty)) / z.s;
    z.s = Math.min(MAX_SCALE, Math.max(1, scale));
    z.tx = cx - b.L - ux * z.s;
    z.ty = cy - b.T - uy * z.s;
    if (z.s <= 1.001) { z.s = 1; z.tx = 0; z.ty = 0; }
    this._clamp(s);
    this._applyZoom(s, animate);
  }

  _bindGestures() {
    const pts = new Map();
    let g = null;              // current gesture state
    let lastTap = { t: 0, x: 0, y: 0 };
    let tapTimer = null;
    const cur = () => this.slides[1];
    const canZoom = () => !!cur().row && !isPlayable(cur().row);

    this.el.addEventListener('pointerdown', (ev) => {
      if (!this.isOpen || ev.target.closest('.vw-top, .vw-bottom, .vw-nav, .vw-msg')) return;
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      const vid = ev.target.closest('video');
      // Leave the native video control strip (seek bar, buttons) to the browser.
      if (vid && ev.clientY > vid.getBoundingClientRect().bottom - 72) return;
      pts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      const s = cur();
      if (pts.size === 1) {
        g = { mode: null, x0: ev.clientX, y0: ev.clientY, t0: performance.now(), tx0: s.z.tx, ty0: s.z.ty, id: ev.pointerId, onVideo: !!ev.target.closest('video') };
      } else if (pts.size === 2 && canZoom()) {
        const [a, b] = [...pts.values()];
        g = { mode: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, s0: s.z.s, tx0: s.z.tx, ty0: s.z.ty, mx0: (a.x + b.x) / 2, my0: (a.y + b.y) / 2 };
        this._position(0, false);
      }
    });

    this.el.addEventListener('pointermove', (ev) => {
      if (!g || !pts.has(ev.pointerId)) return;
      pts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      const s = cur();
      if (g.mode === 'pinch') {
        if (pts.size < 2) return;
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        const bx = s.box;
        const ux = (g.mx0 - (bx.L + g.tx0)) / g.s0;
        const uy = (g.my0 - (bx.T + g.ty0)) / g.s0;
        s.z.s = Math.min(MAX_SCALE * 1.2, Math.max(0.6, g.s0 * d / g.d0));
        s.z.tx = mx - bx.L - ux * s.z.s;
        s.z.ty = my - bx.T - uy * s.z.s;
        this._applyZoom(s, false);
        ev.preventDefault();
        return;
      }
      const dx = ev.clientX - g.x0, dy = ev.clientY - g.y0;
      if (!g.mode) {
        if (Math.hypot(dx, dy) < 8) return;
        if (s.z.s > 1.01) g.mode = 'pan';
        else if (Math.abs(dx) > Math.abs(dy)) g.mode = 'swipe';
        else if (dy > 0 && !g.onVideo) g.mode = 'dismiss';
        else g.mode = 'none';
        if (g.mode !== 'none') { try { this.el.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ } }
      }
      if (g.mode === 'pan') {
        s.z.tx = g.tx0 + dx; s.z.ty = g.ty0 + dy;
        this._clamp(s);
        this._applyZoom(s, false);
      } else if (g.mode === 'swipe') {
        const atEdge = (dx > 0 && this.index <= 0) || (dx < 0 && this.index >= this.list.length - 1);
        this._position(atEdge ? dx * 0.3 : dx, false);
      } else if (g.mode === 'dismiss') {
        this.track.style.transition = 'none';
        this.track.style.transform = `translate3d(0, ${dy}px, 0) scale(${Math.max(0.85, 1 - dy / 2000)})`;
        this.backdrop.style.opacity = String(Math.max(0.2, 1 - dy / 400));
      }
    });

    const end = (ev) => {
      if (!pts.has(ev.pointerId)) return;
      pts.delete(ev.pointerId);
      if (!g) return;
      const s = cur();
      if (g.mode === 'pinch') {
        if (pts.size === 0) {
          if (s.z.s < 1) { s.z = { s: 1, tx: 0, ty: 0 }; }
          if (s.z.s > MAX_SCALE) this._zoomAt(s, MAX_SCALE, s.box.vw / 2, s.box.vh / 2, true);
          this._clamp(s);
          this._applyZoom(s, true);
          g = null;
        } else {
          // Continue as a pan with the remaining finger.
          const [p] = [...pts.values()];
          g = { mode: 'pan', x0: p.x, y0: p.y, tx0: s.z.tx, ty0: s.z.ty, t0: performance.now() };
        }
        return;
      }
      if (pts.size > 0) return;
      const dx = ev.clientX - g.x0, dy = ev.clientY - g.y0;
      const dt = Math.max(1, performance.now() - g.t0);
      if (g.mode === 'swipe') {
        const v = dx / dt;
        if (Math.abs(dx) > window.innerWidth * 0.18 || Math.abs(v) > 0.45) {
          const dir = dx < 0 ? 1 : -1;
          const target = this.index + dir;
          if (target >= 0 && target < this.list.length) this.go(dir);
          else { this._position(0, true); if (this.provider && this.provider.extend) this._extend(dir); }
        } else this._position(0, true);
      } else if (g.mode === 'dismiss') {
        if (dy > 110 || dy / dt > 0.6) this.requestClose();
        else {
          this.track.style.transition = 'transform .2s ease-out';
          this.track.style.transform = 'translate3d(0,0,0)';
          this.backdrop.style.opacity = '';
        }
      } else if (!g.mode && !g.onVideo) {
        // Tap: single toggles chrome, double toggles zoom.
        const now = performance.now();
        if (now - lastTap.t < 300 && Math.hypot(ev.clientX - lastTap.x, ev.clientY - lastTap.y) < 30) {
          clearTimeout(tapTimer);
          lastTap.t = 0;
          if (canZoom()) {
            if (s.z.s > 1.01) { s.z = { s: 1, tx: 0, ty: 0 }; this._applyZoom(s, true); }
            else this._zoomAt(s, DOUBLE_TAP_SCALE, ev.clientX, ev.clientY, true);
          }
        } else {
          lastTap = { t: now, x: ev.clientX, y: ev.clientY };
          clearTimeout(tapTimer);
          tapTimer = setTimeout(() => this.setChrome(!this.chrome), 280);
        }
      }
      g = null;
    };
    this.el.addEventListener('pointerup', end);
    this.el.addEventListener('pointercancel', (ev) => {
      pts.delete(ev.pointerId);
      if (g && g.mode === 'swipe') this._position(0, true);
      if (g && g.mode === 'dismiss') { this.track.style.transform = ''; this.backdrop.style.opacity = ''; }
      g = null;
    });

    this.el.addEventListener('wheel', (ev) => {
      if (!this.isOpen || !canZoom()) return;
      if (!ev.ctrlKey && !ev.metaKey) return;
      ev.preventDefault();
      const s = cur();
      this._zoomAt(s, s.z.s * Math.exp(-ev.deltaY / 200), ev.clientX, ev.clientY, false);
    }, { passive: false });

    // iOS Safari: stop the page's own pinch-zoom / bounce while the viewer is open.
    for (const type of ['gesturestart', 'gesturechange']) this.el.addEventListener(type, (ev) => ev.preventDefault());
    this.el.addEventListener('touchmove', (ev) => { if (!ev.target.closest('.vw-msg, video')) ev.preventDefault(); }, { passive: false });
  }

  _key(ev) {
    if (document.querySelector('.sheet-root')) return;
    const s = this.slides[1];
    switch (ev.key) {
      case 'Escape': ev.preventDefault(); this.requestClose(); break;
      case 'ArrowRight': ev.preventDefault(); this.go(1); break;
      case 'ArrowLeft': ev.preventDefault(); this.go(-1); break;
      case '+': case '=': if (s.box && s.row && !isPlayable(s.row)) this._zoomAt(s, s.z.s * 1.5, s.box.vw / 2, s.box.vh / 2); break;
      case '-': if (s.box) this._zoomAt(s, s.z.s / 1.5, s.box.vw / 2, s.box.vh / 2); break;
      case 'i': this.showInfo(); break;
      default: break;
    }
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  async toggleStar() {
    const row = this.list[this.index];
    if (!row) return;
    await this.ctx.toggleStar(starKey(row.room, row.k, row.id), { room: row.room, ym: row.ym, k: row.k, id: row.id, t: row.t, y: row.y, n: row.n, s: row.s });
  }

  share() {
    const row = this.list[this.index];
    if (row) shareOrSave(this.ctx, row, { title: `${row.n || ''} ${koDateTime(row.t)}`.trim() });
  }

  goChat() {
    const row = this.list[this.index];
    if (!row || !row.k) return;
    // Push: "back" from the chat returns to this photo in the viewer.
    this.ctx.router.go(pathOf('room', row.room, 'chat'), { ym: row.ym, k: row.k });
  }

  showInfo() {
    const row = this.list[this.index];
    if (!row) return;
    const room = this.ctx.archive.room(row.room);
    const policy = this.ctx.originalsPolicy();
    const vthumb = isVideoThumb(row);
    const origText = vthumb ? '동영상 썸네일만 보관됨 (원본 동영상을 휴대폰에서 받지 않았어요)'
      : row.to ? '썸네일만 보관됨 (원본이 휴대폰에 없었어요)'
      : row.orig !== false ? (row.pv ? '원본 있음 · 화면에는 미리보기(2048px)로 표시' : '원본 있음')
        : row.pv ? '미리보기만 있음 · 원본은 NAS에 보관됨'
          : policy !== 'all' ? '이 저장소에 없음 · 원본은 NAS에 보관됨' : '원본 없음';
    const rows = [
      ['보낸 사람', row.n || (row.orphan ? '알 수 없음 (대화와 연결되지 않은 파일)' : '알 수 없음')],
      ['채팅방', room ? room.displayName || room.name : row.room],
      ['날짜·시간', koDateTime(row.t)],
      row.et && Math.abs(row.et - row.t) > 60 ? ['촬영 시각', koDateTime(row.et)] : null,
      ['유형', `${mediaKindLabel(row.y)}${vthumb ? ' · 썸네일' : ''}${row.ext ? ` (${String(row.ext).toUpperCase()})` : ''}`],
      row.sz ? ['크기', bytes(row.sz)] : null,
      row.w && row.h ? ['해상도', `${row.w} × ${row.h}`] : null,
      row.d ? ['길이', duration(row.d)] : null,
      ['원본', origText],
    ].filter(Boolean);
    const list = h('dl', { class: 'info-list' });
    for (const [k, v] of rows) list.append(h('dt', { text: k }), h('dd', { text: v }));
    openSheet({ title: '정보', content: list });
  }
}
