// chat.js — 대화 view of a room: month chunks rendered as KakaoTalk-like bubbles.
//
// Loads the newest month first (or the month of ?ym=), scrolling up loads older months
// (keeping the scroll position), scrolling down loads newer ones after a jump.
// ?k=<msgKey> scrolls to and highlights that message.
//
// The log is windowed: every rendered range of a month is one '.chat-slice' element, and
// when more than MAX_MOUNTED messages are mounted, slices (then whole months) far away at
// the other end are removed again (scroll position kept) — reading back through a busy
// group chat keeps DOM size and memory flat. Removed slices render again from the month
// data when the user scrolls back. A tapped reply quote is located in the month DATA
// (chunks, newest to oldest), then the view re-opens around it.
//
// Gallery-only (orphan) items are never rendered: months whose catalog msg count is 0 (they
// hold only such items, SPEC §13.2 L4) are skipped, and inside a month an orphan is only an
// invisible anchor so 대화에서 보기 from the gallery still lands at the right time.

import { h, icon, avatar, clear, spinner, toast, actionSheet, onLongPress, copyText, scrollToEl } from './dom.js';
import { koDateFromYmd, koTime, ymdOf, duration, bytes, splitLinks, domainOf, koMonth, fileCategory, colorIndex, safeHttpUrl } from './format.js';
import { starKey, messagePreview, hasFullMedia, isOrphan, mediaCaption, isVideoThumb } from './model.js';
import { audioPlayer } from './audio.js';
import { openJumpSheet } from './calendar.js';
import { fileIcon, openFileActions } from './files.js';

const LONG_TEXT_CHARS = 700;
const SLICE = 250;                // messages rendered per slice of a month
const SLICE_BEFORE = 60;          // messages above a jump target in its first slice
const LONG_TEXT_LINES = 18;
export const MAX_MOUNTED = 1500;  // messages kept in the DOM (≈ 6 slices)
const TRIM_TO = MAX_MOUNTED - SLICE;
const FAR_PX = 1600;              // never remove a slice closer than this to the viewport

/** Compare two message keys by time order when both are 'b:<logId>' (null otherwise). */
function cmpLogKeys(a, b) {
  const ma = /^b:(\d+)$/.exec(a || '');
  const mb = /^b:(\d+)$/.exec(b || '');
  if (!ma || !mb) return null;
  const x = ma[1].replace(/^0+(?=\d)/, '');
  const y = mb[1].replace(/^0+(?=\d)/, '');
  if (x.length !== y.length) return x.length < y.length ? -1 : 1;
  return x < y ? -1 : x > y ? 1 : 0;
}

function cssEscape(s) {
  if (window.CSS && CSS.escape) return CSS.escape(s);
  return String(s).replace(/["\\]/g, '\\$&');
}

export class ChatView {
  constructor(ctx, room) {
    this.ctx = ctx;
    this._setRoom(room);
    this.loaded = new Map();                                        // ym -> {el, messages, media}
    this.lo = -1; this.hi = -1;                                     // loaded index range in this.yms
    this.busy = { older: false, newer: false };
    this.gen = 0;
    // role=log is implicitly aria-live=polite: history prepended while scrolling must not be
    // read out, so the log is silent; jump targets are announced through `this.live`.
    this.el = h('div', { class: 'chat', role: 'log', 'aria-live': 'off', 'aria-label': `${room.displayName || room.name} 대화` });
    this.live = h('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
    this.topSentinel = h('div', { class: 'chat-sentinel top', 'aria-hidden': 'true' }, h('span', { class: 'spin' }));
    this.bottomSentinel = h('div', { class: 'chat-sentinel bottom', 'aria-hidden': 'true' }, h('span', { class: 'spin' }));
    this.body = h('div', { class: 'chat-body' });
    this.el.append(this.live, this.topSentinel, this.body, this.bottomSentinel);
    this.io = new IntersectionObserver((ents) => this._onSentinel(ents), { rootMargin: '700px 0px' });
    this.io.observe(this.topSentinel);
    this.io.observe(this.bottomSentinel);
    this.el.addEventListener('click', (ev) => this._onClick(ev));
    onLongPress(this.el, '.bubble', (ev, bubble) => this._onLongPress(bubble));
    this._starHandler = (key) => this._onStar(key);
    ctx.on('star', this._starHandler);
    this.active = false;
  }

  _setRoom(room) {
    this.room = room;
    this.me = room.me || (this.ctx.archive.owner() && this.ctx.archive.owner().sid) || null;
    // Months with real messages (catalog msg excludes gallery-only items; unknown = keep).
    const chatMonths = (room.months || []).filter((m) => !(m.msg !== undefined && m.msg !== null && Number(m.msg) === 0));
    this.yms = chatMonths.map((m) => m.ym).sort();                  // ascending
    this.mediaOnlyYms = new Set((room.months || []).filter((m) => !chatMonths.includes(m)).map((m) => m.ym));
    this.msgCounts = new Map(chatMonths.map((m) => [m.ym, m.msg || 0]));
  }

  /**
   * The catalog was reloaded: take the room's new months and forget what is rendered (it
   * may come from superseded month chunks). Returns the month to re-open at.
   */
  reset(room) {
    const ym = this.loaded.size ? this._currentYm() : null;
    this.gen++;
    this._setRoom(room);
    this.loaded.clear();
    this.lo = this.hi = -1;
    this.busy.older = this.busy.newer = false;
    clear(this.body);
    return ym;
  }

  destroy() {
    this.gen++;
    this.io.disconnect();
    this.ctx.off('star', this._starHandler);
  }

  /** Messages currently mounted (sum of the rendered ranges). */
  mountedCount() {
    let n = 0;
    for (const p of this.loaded.values()) n += Math.max(0, p.hi - p.lo);
    return n;
  }

  _slices(part) {
    return [...part.el.children].filter((c) => c.classList.contains('chat-slice'));
  }

  /** One rendered range [a, b) of a month, as a removable unit. */
  _slice(part, a, b) {
    const el = h('div', { class: 'chat-slice', dataset: { a: String(a), b: String(b) } });
    el.appendChild(this._renderRange(part, a, b));
    return el;
  }

  /**
   * Remove slices (then whole months) at the far end until at most TRIM_TO messages are
   * mounted — only when more than MAX_MOUNTED are, and never closer than FAR_PX to the
   * viewport. fromBottom: after loading older content; else after loading newer content.
   * @returns {boolean} whether anything was removed
   */
  _trim(fromBottom) {
    if (this.mountedCount() <= MAX_MOUNTED) return false;
    const vh = window.innerHeight || 800;
    const far = Math.max(FAR_PX, vh * 2);
    let removed = false;
    for (let guard = 0; guard < 200 && this.mountedCount() > TRIM_TO; guard++) {
      const idx = fromBottom ? this.hi : this.lo;
      const part = idx >= 0 ? this.loaded.get(this.yms[idx]) : null;
      if (!part) break;
      const slices = this._slices(part);
      const slice = fromBottom ? slices[slices.length - 1] : slices[0];
      if (!slice) break;
      const r = slice.getBoundingClientRect();
      if (fromBottom ? r.top < vh + far : r.bottom > -far) break;
      if (slices.length === 1) {
        if (this.lo === this.hi) break;                  // the only month: keep its last slice
        part.el.remove();
        this.loaded.delete(part.ym);
        if (fromBottom) this.hi -= 1; else this.lo += 1;
      } else {
        slice.remove();
        if (fromBottom) part.hi = +slice.dataset.a; else part.lo = +slice.dataset.b;
      }
      removed = true;
    }
    return removed;
  }

  _trimBottom() {
    if (this._trim(true)) this._updateEdges();
  }

  /** Remove far content above the viewport, keeping the visible messages in place. */
  _trimTop() {
    const doc = document.documentElement;
    const prevH = doc.scrollHeight;
    const prevY = window.scrollY;
    if (!this._trim(false)) return;
    this._updateEdges();
    window.scrollTo(0, prevY + (doc.scrollHeight - prevH));
  }

  /** (Re)open at month `ym` (default newest), optionally scrolling to message `k` or day `ymd`. */
  async open({ ym = null, k = null, ymd = null } = {}) {
    if (!this.yms.length) {
      clear(this.body);
      const mediaOnly = this.mediaOnlyYms.size > 0;
      this.body.appendChild(h('div', { class: 'empty' },
        h('p', { class: 'empty-title', text: '보관된 대화가 없어요' }),
        mediaOnly ? h('p', { class: 'empty-text', text: '이 채팅방에는 대화 없이 사진·동영상 파일만 보관되어 있어요. 사진·동영상 탭에서 볼 수 있어요.' }) : null));
      return;
    }
    let idx = ym ? this.yms.indexOf(ym) : this.yms.length - 1;
    // A month that holds only gallery-only items has no conversation: show the nearest one.
    const noChatMonth = !!(ym && idx < 0 && this.mediaOnlyYms.has(ym));
    const beforeAll = noChatMonth && ym < this.yms[0];
    if (idx < 0) {
      // Month not in this room: nearest older month, else the oldest.
      idx = this.yms.findIndex((x) => x > ym) - 1;
      if (idx < 0) idx = ym < this.yms[0] ? 0 : this.yms.length - 1;
    }
    const gen = ++this.gen;
    this.loaded.clear();
    this.lo = this.hi = -1;
    clear(this.body);
    this.body.appendChild(spinner('대화를 불러오는 중…'));
    this.busy.older = this.busy.newer = true;
    let part;
    try {
      part = await this._fetch(this.yms[idx], beforeAll ? 'start' : (k || ymd) ? { k, ymd } : 'end');
    } catch (err) {
      if (gen !== this.gen) return;
      this.busy.older = this.busy.newer = false;
      clear(this.body);
      this.body.appendChild(h('div', { class: 'empty' },
        h('p', { class: 'empty-title', text: '대화를 불러오지 못했어요' }),
        h('p', { class: 'empty-text', text: (err && err.message) || '' }),
        h('button', { type: 'button', class: 'btn', onclick: () => this.open({ ym, k, ymd }) }, icon('refresh', 18), '다시 시도')));
      this.ctx.handleError(err, { quiet: true });
      return;
    }
    if (gen !== this.gen) return;
    clear(this.body);
    this.lo = this.hi = idx;
    this.body.appendChild(part.el);
    this._updateEdges();
    // Position: target message, a day, or the newest message.
    let target = null;
    if (k) target = this.body.querySelector(`.msg[data-k="${cssEscape(k)}"], .msg-system[data-k="${cssEscape(k)}"], .msg-anchor[data-k="${cssEscape(k)}"]`);
    if (!target && ymd) target = this.body.querySelector(`.chat-date[data-day="${ymd}"]`) || this._firstOfDay(ymd);
    if (target) {
      await this._settle();
      scrollToEl(target, { center: !!k });
      if (k) {
        this._highlight(target);
        this.live.textContent = `${koMonth(this.yms[idx])} 메시지로 이동했어요.`;
      }
    } else {
      if (noChatMonth) toast('이 달에는 대화가 없어요. 가까운 대화를 보여드려요.');
      else if (k) toast('해당 메시지를 찾지 못했어요. 이 달의 대화를 보여드려요.');
      await this._settle();
      window.scrollTo(0, beforeAll ? 0 : document.documentElement.scrollHeight);
    }
    this.busy.older = this.busy.newer = false;
    // Let the sentinels trigger neighbour slices/months after positioning.
    requestAnimationFrame(() => this._recheckSentinels());
  }

  _settle() { return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); }

  /** First rendered message of a day (when the day starts inside an already rendered run). */
  _firstOfDay(ymd) {
    for (const el of this.body.querySelectorAll('.msg[data-k], .msg-system[data-k]')) {
      const month = el.closest('.chat-month');
      const part = month && this.loaded.get(month.dataset.ym);
      const m = part && this._msgOf(part, el.dataset.k);
      if (m && ymdOf(m.t) >= ymd) return el;
    }
    return null;
  }

  /**
   * Load a month and render the slice to show first: 'end' (newest messages — opening or
   * scrolling up), 'start' (oldest — scrolling down) or {k, ymd} (around a target).
   * Months render in slices of SLICE messages; a 5 000-message month is never laid out at
   * once (that took ~1 s of style/layout on a throttled phone).
   */
  async _fetch(ym, where = 'end') {
    const ch = await this.ctx.archive.chunk(this.room.id, ym);
    const all = ((ch && ch.messages) || []).slice().sort((a, b) => (a.t - b.t) || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
    const media = (ch && ch.media) || [];
    const byK = new Map();
    for (const r of media) {
      const row = Object.assign({}, r, { room: this.room.id, ym });
      if (!byK.has(r.k)) byK.set(r.k, []);
      byK.get(r.k).push(row);
    }
    // Keep bundle photos in message order (msg.m lists media ids in order).
    for (const m of all) {
      const rows = byK.get(m.k);
      if (rows && rows.length > 1 && Array.isArray(m.m)) {
        const order = new Map(m.m.map((id, i) => [id, i]));
        rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
      }
    }
    // Orphan media (no message of their own) are gallery-only: no bubble, just an invisible
    // anchor so 대화에서 보기 can still scroll to the right place in the conversation.
    const messages = all.filter((m) => !isOrphan(m));
    const orphans = all.filter(isOrphan);
    const n = messages.length;
    let lo, hi;
    if (where === 'start') { lo = 0; hi = Math.min(n, SLICE); }
    else if (where && typeof where === 'object') {
      let i = -1;
      if (where.k) {
        i = messages.findIndex((m) => m.k === where.k);
        const o = i < 0 ? orphans.find((m) => m.k === where.k) : null;
        if (o) i = messages.findIndex((m) => m.t >= o.t);
        if (o && i < 0) i = n - 1;
      }
      if (i < 0 && where.ymd) i = messages.findIndex((m) => ymdOf(m.t) >= where.ymd);
      if (i < 0) { lo = Math.max(0, n - SLICE); hi = n; }
      else { lo = Math.max(0, i - SLICE_BEFORE); hi = Math.min(n, Math.max(i + 1, lo + SLICE)); }
    } else { lo = Math.max(0, n - SLICE); hi = n; }
    const part = { ym, messages, orphans, byK, el: h('div', { class: 'chat-month', dataset: { ym } }), lo, hi };
    part.el.appendChild(this._slice(part, lo, hi));
    if (!n && orphans.length) {
      // e.g. a chat known only from its media folder: say why the conversation is empty.
      part.el.prepend(h('div', { class: 'msg-system chat-note' }, h('span', { text: `${koMonth(ym)}에는 대화 없이 사진·동영상 ${orphans.length}개만 보관되어 있어요. 사진·동영상 탭에서 볼 수 있어요.` })));
    }
    this.loaded.set(ym, part);
    return part;
  }

  _updateEdges() {
    const top = this.body.querySelector('.chat-start');
    if (top) top.remove();
    const topPart = this.lo >= 0 ? this.loaded.get(this.yms[this.lo]) : null;
    const botPart = this.hi >= 0 ? this.loaded.get(this.yms[this.hi]) : null;
    if (this.lo === 0 && topPart && topPart.lo === 0) {
      const t0 = topPart.messages.length ? topPart.messages[0].t : this.room.first_ts;
      this.body.prepend(h('div', { class: 'chat-start' }, icon('box', 18), h('span', { text: t0 ? `${koDateFromYmd(ymdOf(t0))}부터 보관된 대화입니다.` : '보관된 대화의 처음입니다.' })));
    }
    this.el.classList.toggle('has-older', this.lo > 0 || !!(topPart && topPart.lo > 0));
    this.el.classList.toggle('has-newer', (this.hi >= 0 && this.hi < this.yms.length - 1) || !!(botPart && botPart.hi < botPart.messages.length));
  }

  _onSentinel(entries) {
    for (const e of entries) {
      if (!e.isIntersecting || !this.active) continue;
      if (e.target === this.topSentinel) this.loadOlder();
      else this.loadNewer();
    }
  }

  _recheckSentinels() {
    if (!this.active) return;
    const vh = window.innerHeight;
    if (this.topSentinel.getBoundingClientRect().bottom > -700) this.loadOlder();
    if (this.bottomSentinel.getBoundingClientRect().top < vh + 700) this.loadNewer();
  }

  /** Prepend content while keeping the visible messages in place (no scroll anchoring in Safari). */
  _prependKeepingScroll(fn) {
    const doc = document.documentElement;
    const prevH = doc.scrollHeight;
    const prevY = window.scrollY;
    const startMarker = this.body.querySelector('.chat-start');
    if (startMarker) startMarker.remove();
    fn();
    this._updateEdges();
    window.scrollTo(0, prevY + (doc.scrollHeight - prevH));
  }

  async loadOlder() {
    if (this.busy.older || this.lo < 0) return false;
    const topPart = this.loaded.get(this.yms[this.lo]);
    if (topPart && topPart.lo > 0) {
      // Older slice of the month already in memory: render it synchronously.
      const a = Math.max(0, topPart.lo - SLICE);
      const slice = this._slice(topPart, a, topPart.lo);
      this._prependKeepingScroll(() => { topPart.el.insertBefore(slice, this._slices(topPart)[0] || null); topPart.lo = a; });
      this._trimBottom();
      setTimeout(() => this._recheckSentinels(), 50);
      return true;
    }
    if (this.lo <= 0) return false;
    this.busy.older = true;
    const gen = this.gen;
    const ym = this.yms[this.lo - 1];
    this.topSentinel.classList.add('loading');
    this.el.setAttribute('aria-busy', 'true');
    try {
      const part = await this._fetch(ym, 'end');
      if (gen !== this.gen) return false;
      this._prependKeepingScroll(() => { this.body.prepend(part.el); this.lo -= 1; });
      this._trimBottom();
      return true;
    } catch (err) {
      if (gen === this.gen) {
        toast(`${koMonth(ym)} 대화를 불러오지 못했어요.`, { kind: 'error', action: '다시 시도', onAction: () => this.loadOlder() });
        this.ctx.handleError(err, { quiet: true });
      }
      return false;
    } finally {
      this.topSentinel.classList.remove('loading');
      this.el.removeAttribute('aria-busy');
      if (gen === this.gen) {
        this.busy.older = false;
        setTimeout(() => this._recheckSentinels(), 50);
      }
    }
  }

  async loadNewer() {
    if (this.busy.newer || this.hi < 0) return false;
    const botPart = this.loaded.get(this.yms[this.hi]);
    if (botPart && botPart.hi < botPart.messages.length) {
      const b = Math.min(botPart.messages.length, botPart.hi + SLICE);
      botPart.el.appendChild(this._slice(botPart, botPart.hi, b));
      botPart.hi = b;
      this._updateEdges();
      this._trimTop();
      return true;
    }
    if (this.hi >= this.yms.length - 1) return false;
    this.busy.newer = true;
    const gen = this.gen;
    const ym = this.yms[this.hi + 1];
    this.bottomSentinel.classList.add('loading');
    this.el.setAttribute('aria-busy', 'true');
    try {
      const part = await this._fetch(ym, 'start');
      if (gen !== this.gen) return false;
      this.body.appendChild(part.el);
      this.hi += 1;
      this._updateEdges();
      this._trimTop();
      return true;
    } catch (err) {
      if (gen === this.gen) {
        toast(`${koMonth(ym)} 대화를 불러오지 못했어요.`, { kind: 'error' });
        this.ctx.handleError(err, { quiet: true });
      }
      return false;
    } finally {
      this.bottomSentinel.classList.remove('loading');
      this.el.removeAttribute('aria-busy');
      if (gen === this.gen) this.busy.newer = false;
    }
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  /**
   * Rows for messages [a, b) of a month part. Grouping (date separators, avatar/name once
   * per sender run, time once per minute) looks at the neighbours outside the range, so
   * slices rendered separately join up exactly as if the month had been rendered at once.
   */
  _renderRange(part, a, b) {
    const frag = document.createDocumentFragment();
    const msgs = part.messages;
    const n = msgs.length;
    // Orphan anchors belonging to this range (by time; the first/last range take the rest).
    const tFrom = a > 0 ? msgs[a - 1].t : -Infinity;
    const tTo = b < n ? msgs[b - 1].t : Infinity;
    const orphans = (part.orphans || []).filter((o) => o.t > tFrom && o.t <= tTo);
    let oi = 0;
    const anchorsUpTo = (t) => {
      while (oi < orphans.length && (t === null || orphans[oi].t <= t)) {
        frag.appendChild(h('div', { class: 'msg-anchor', 'aria-hidden': 'true', dataset: { k: orphans[oi].k } }));
        oi++;
      }
    };
    const groupKey = (m) => (m && !isSystem(m) ? `${m.s || ''}|${Math.floor(m.t / 60)}` : null);
    let lastDay = a > 0 ? ymdOf(msgs[a - 1].t) : null;
    for (let i = a; i < b; i++) {
      const m = msgs[i];
      anchorsUpTo(m.t);
      const day = ymdOf(m.t);
      let newDay = false;
      if (day !== lastDay) {
        frag.appendChild(h('div', { class: 'chat-date', dataset: { day } }, h('span', { text: koDateFromYmd(day) })));
        lastDay = day;
        newDay = true;
      }
      if (isSystem(m)) { frag.appendChild(this._system(m)); continue; }
      // KakaoTalk style: name/avatar once per run of the same sender, time once per minute.
      const prev = !newDay ? msgs[i - 1] : null;
      const next = msgs[i + 1] && ymdOf(msgs[i + 1].t) === day ? msgs[i + 1] : null;
      const gk = groupKey(m);
      const first = !prev || isSystem(prev) || prev.s !== m.s;
      const last = !next || groupKey(next) !== gk;
      frag.appendChild(this._message(m, part.byK.get(m.k) || [], first, last));
    }
    if (b >= n) anchorsUpTo(null);
    return frag;
  }

  _system(m) {
    if (m.y !== 'system') {
      const hidden = (m.fl || []).includes('hidden');
      return h('div', { class: 'msg-system msg-gone', dataset: { k: m.k } }, h('span', { text: hidden ? '관리자가 가린 메시지입니다.' : '삭제된 메시지입니다.' }));
    }
    return h('div', { class: 'msg-system', dataset: { k: m.k } }, h('span', { text: m.x || '알림' }));
  }

  _message(m, rows, first, last) {
    const mine = this.me && m.s === this.me;
    const row = h('div', { class: ['msg', mine ? 'me' : 'other', first ? 'first' : '', last ? 'last' : ''].join(' '), dataset: { k: m.k } });
    if (!mine) {
      row.appendChild(first ? avatar(m.n || '?', m.s || m.n, 38) : h('span', { class: 'avatar-gap', 'aria-hidden': 'true' }));
    }
    const col = h('div', { class: 'msg-col' });
    if (!mine && first) col.appendChild(h('div', { class: 'msg-name', text: m.n || '알 수 없음' }));
    const line = h('div', { class: 'msg-line' });
    line.appendChild(this._bubble(m, rows));
    const meta = h('div', { class: 'msg-meta' });
    const fl = m.fl || [];
    if (this.ctx.archive.isStarred(starKey(this.room.id, m.k, ''))) meta.appendChild(h('span', { class: 'meta-star', 'aria-label': '중요' }, icon('starFill', 12)));
    if (fl.includes('edited')) meta.appendChild(h('span', { class: 'meta-tag', text: '수정됨' }));
    if (fl.includes('deleted_everyone') && (m.x || rows.length)) meta.appendChild(h('span', { class: 'meta-tag warn', text: '모두에게서 삭제됨' }));
    if (fl.includes('hidden') && !hiddenOnly(m, rows) && m.y !== 'deleted') meta.appendChild(h('span', { class: 'meta-tag warn', text: '관리자가 가림' }));
    if (last) meta.appendChild(h('time', { class: 'msg-time', text: koTime(m.t) }));
    line.appendChild(meta);
    col.appendChild(line);
    row.appendChild(col);
    return row;
  }

  _bubble(m, rows) {
    const fl = m.fl || [];
    const b = h('div', { class: 'bubble' });
    if (hiddenOnly(m, rows)) {
      b.classList.add('b-deleted');
      b.append(icon('alert', 14), h('span', { text: '관리자가 가린 메시지입니다.' }));
      return b;
    }
    if (m.y === 'deleted' || fl.includes('local_deleted') || (fl.includes('deleted_everyone') && !m.x && !rows.length)) {
      b.classList.add('b-deleted');
      b.append(icon('alert', 14), h('span', { text: fl.includes('local_deleted') && m.y !== 'deleted' ? '나에게서 삭제된 메시지입니다.' : '삭제된 메시지입니다.' }));
      return b;
    }
    if (m.r) b.appendChild(this._quote(m.r));
    const visual = rows.filter((r) => r.y === 'photo' || r.y === 'gif' || r.y === 'video');
    switch (m.y) {
      case 'photo':
      case 'video': {
        b.classList.add('b-media');
        if (visual.length) b.appendChild(this._mediaGrid(visual));
        const missing = (m.mm || 0) || Math.max(0, (m.em || 0) - visual.length);
        const caption = mediaCaption(m);          // '사진' / '사진 3장' placeholders are not captions
        if (missing || fl.includes('not_exported') || (!visual.length && !caption)) {
          b.appendChild(h('div', { class: 'media-missing' }, icon('imageOff', 18),
            h('span', { text: missingText(m.y, Math.max(1, missing), fl.includes('not_exported')) })));
        }
        if (caption) b.appendChild(this._text(caption));
        break;
      }
      case 'audio': {
        b.classList.add('b-audio');
        const r = rows.find((x) => x.y === 'audio') || rows[0];
        if (r && hasFullMedia(r)) b.appendChild(audioPlayer(() => this.ctx.mediaSrc(r), { duration: r.d, compact: true }));
        else b.appendChild(h('div', { class: 'media-missing' }, icon('mic', 18), h('span', { text: '음성메시지를 받지 못했어요' })));
        break;
      }
      case 'file': {
        b.classList.add('b-file');
        const r = rows.find((x) => x.y === 'file') || rows[0] || null;
        const name = (m.f && m.f.name) || (r && r.nm) || '파일';
        const size = (m.f && m.f.size) || (r && r.sz);
        const ok = r && hasFullMedia(r);
        const cat = fileCategory(name, r && r.mime);
        b.appendChild(h('button', { type: 'button', class: 'file-card' + (ok ? '' : ' unavailable'), dataset: { k: m.k } },
          fileIcon(cat),
          h('span', { class: 'fc-main' }, h('span', { class: 'fc-name', text: name }),
            h('span', { class: 'fc-sub', text: [size ? bytes(size) : '', ok ? '' : '원본 없음'].filter(Boolean).join(' · ') }))));
        const caption = mediaCaption(m);
        if (caption && caption !== name) b.appendChild(this._text(caption));
        break;
      }
      case 'emoticon':
        b.classList.add('b-emoticon');
        b.append(icon('smile', 22), h('span', { text: (m.x || '(이모티콘)').replace(/^\(이모티콘\)\s*/, '') || '이모티콘' }));
        break;
      case 'call':
        b.classList.add('b-call');
        b.append(icon('phone', 16), h('span', { text: m.x || '통화' }));
        break;
      case 'location':
        b.classList.add('b-icon');
        b.append(icon('pin', 16), h('span', { text: m.x || '위치' }));
        break;
      case 'contact':
        b.classList.add('b-icon');
        b.append(icon('contact', 16), h('span', { text: m.x || '연락처' }));
        break;
      default: {
        if (visual.length) b.appendChild(this._mediaGrid(visual));
        const txt = m.x || messagePreview(m) || '';
        if (txt) b.appendChild(this._text(txt));
        else if (!visual.length && !(m.l && m.l.length) && !m.r) {
          // e.g. kind 'other' (카카오페이, 투표, 일정 …) without any text: say so instead of an empty bubble.
          b.classList.add('b-unsupported');
          b.append(icon('info', 14), h('span', { text: '이 뷰어에서 표시할 수 없는 메시지예요' }));
        }
      }
    }
    const links = (m.l || []).slice(0, 3);
    if (links.length && (m.y === 'link' || m.y === 'text' || m.y === 'reply' || m.y === 'other')) {
      for (const url of links) b.appendChild(linkCard(url));
    }
    return b;
  }

  _quote(r) {
    const q = h('button', { type: 'button', class: 'quote', dataset: { target: r.k || '' } },
      h('span', { class: 'q-name' }, icon('reply', 12), `${r.n || '알 수 없음'}에게 답장`),
      h('span', { class: 'q-text', text: r.x || '(원본 메시지)' }));
    if (!r.k) q.disabled = true;
    return q;
  }

  _text(text) {
    const wrap = h('div', { class: 'b-text' });
    for (const seg of splitLinks(text)) {
      const href = seg.url ? safeHttpUrl(seg.url) : null;
      if (href) wrap.appendChild(h('a', { href, target: '_blank', rel: 'noopener noreferrer', text: seg.t }));
      else wrap.appendChild(document.createTextNode(seg.t));
    }
    const lines = text.split('\n').length;
    if (text.length > LONG_TEXT_CHARS || lines > LONG_TEXT_LINES) {
      wrap.classList.add('clamped');
      const more = h('button', { type: 'button', class: 'more-text', text: '전체보기' });
      return h('div', { class: 'b-long' }, wrap, more);
    }
    return wrap;
  }

  _mediaGrid(rows) {
    const n = rows.length;
    const grid = h('div', { class: `media-grid n${Math.min(n, 4)}${n > 4 ? ' many' : ''}` });
    const shown = n > 30 ? rows.slice(0, 30) : rows;
    shown.forEach((r, i) => {
      const single = n === 1;
      const tw = r.th ? r.th.w : (r.w || 4);
      const th = r.th ? r.th.h : (r.h || 3);
      const vthumb = isVideoThumb(r);
      const cell = h('button', { type: 'button', class: 'media-thumb' + (single ? ' single' : ''), dataset: { k: r.k, i: String(i) }, 'aria-label': vthumb ? '동영상 썸네일 보기' : r.y === 'video' ? '동영상 보기' : '사진 보기' });
      if (single) cell.style.aspectRatio = `${Math.max(0.5, Math.min(2, tw / th))}`;
      const img = h('img', { alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' });
      cell.appendChild(img);
      if (vthumb) cell.appendChild(h('span', { class: 'badge badge-video badge-vthumb', title: '동영상 · 썸네일만 보관됨' }, icon('video', 11), r.d ? duration(r.d) : ''));
      else if (r.y === 'video') cell.appendChild(h('span', { class: 'play-ov' }, icon('play', 20), r.d ? h('span', { text: duration(r.d) }) : null));
      if (r.y === 'gif') cell.appendChild(h('span', { class: 'badge badge-gif', text: 'GIF' }));
      if (r.to) cell.appendChild(h('span', { class: 'badge badge-low' }, icon('lowres', 11), '저화질'));
      if (r.th) this._thumb(cell, img, r, false);
      else cell.classList.add('nothumb');
      grid.appendChild(cell);
    });
    if (n > shown.length) grid.appendChild(h('span', { class: 'media-more', text: `+${n - shown.length}` }));
    return grid;
  }

  /** Thumbnail of a bubble image; one retry (the gallery may have released the month's URLs). */
  _thumb(cell, img, r, retry) {
    Promise.resolve(this.ctx.archive.thumbURL(r)).then((url) => {
      if (!url) { cell.classList.add('nothumb'); return; }
      img.onload = () => cell.classList.add('ready');
      img.onerror = () => { if (!retry) this._thumb(cell, img, r, true); else cell.classList.add('nothumb'); };
      img.src = url;
    }).catch(() => cell.classList.add('nothumb'));
  }

  // -------------------------------------------------------------------------
  // Interaction
  // -------------------------------------------------------------------------

  _msgOf(part, k) {
    if (!part.byMsgK) part.byMsgK = new Map(part.messages.map((m) => [m.k, m]));
    return part.byMsgK.get(k) || null;
  }

  _rowFor(el) {
    const msg = el.closest('.msg');
    const month = el.closest('.chat-month');
    if (!msg || !month) return null;
    const part = this.loaded.get(month.dataset.ym);
    const rows = part ? (part.byK.get(msg.dataset.k) || []) : [];
    return { part, rows, k: msg.dataset.k, message: part ? this._msgOf(part, msg.dataset.k) : null };
  }

  _onClick(ev) {
    const thumb = ev.target.closest('.media-thumb');
    if (thumb) {
      const info = this._rowFor(thumb);
      const visual = info ? info.rows.filter((r) => r.y === 'photo' || r.y === 'gif' || r.y === 'video') : [];
      const row = visual[+thumb.dataset.i];
      if (row) this.ctx.openViewer(row, this.viewerProvider());
      return;
    }
    const quote = ev.target.closest('.quote');
    if (quote && quote.dataset.target) { this.jumpToMessage(quote.dataset.target); return; }
    const more = ev.target.closest('.more-text');
    if (more) {
      const txt = more.previousElementSibling;
      const open = txt.classList.toggle('clamped');
      more.textContent = open ? '전체보기' : '접기';
      return;
    }
    const fc = ev.target.closest('.file-card');
    if (fc) {
      const info = this._rowFor(fc);
      if (!info || !info.message) return;
      const r = info.rows.find((x) => x.y === 'file') || info.rows[0] || null;
      openFileActions(this.ctx, {
        name: (info.message.f && info.message.f.name) || (r && r.nm) || '파일',
        size: (info.message.f && info.message.f.size) || (r && r.sz),
        media: r, room: this.room.id, ym: info.part.ym, k: info.k, t: info.message.t, inChat: true,
      });
    }
  }

  _onLongPress(bubble) {
    const info = this._rowFor(bubble);
    if (!info || !info.message) return;
    const m = info.message;
    const key = starKey(this.room.id, m.k, '');
    const starred = this.ctx.archive.isStarred(key);
    const text = m.x || '';
    actionSheet(null, [
      {
        label: starred ? '중요 표시 해제' : '중요 표시', icon: starred ? 'star' : 'starFill',
        onSelect: () => this.ctx.toggleStar(key, { room: this.room.id, ym: info.part.ym, k: m.k, t: m.t, y: m.y, n: m.n, s: m.s, x: messagePreview(m).slice(0, 200) }),
      },
      text ? { label: '텍스트 복사', icon: 'copy', onSelect: async () => toast((await copyText(text)) ? '복사했어요' : '복사하지 못했어요') } : null,
      ...(m.l || []).map(safeHttpUrl).filter(Boolean).slice(0, 2).map((url) => ({ label: `링크 열기 · ${domainOf(url)}`, icon: 'external', onSelect: () => window.open(url, '_blank', 'noopener,noreferrer') })),
    ]);
  }

  _onStar(key) {
    let msgs;
    if (key) {
      const [room, k, id] = key.split('|');
      if (room !== this.room.id || id) return;
      msgs = this.body.querySelectorAll(`.msg[data-k="${cssEscape(k)}"]`);
    } else {
      msgs = this.body.querySelectorAll('.msg');            // remote merge: re-check everything
    }
    for (const msg of msgs) {
      const meta = msg.querySelector('.msg-meta');
      if (!meta) continue;
      const on = this.ctx.archive.isStarred(starKey(this.room.id, msg.dataset.k, ''));
      const cur = meta.querySelector('.meta-star');
      if (on && !cur) meta.prepend(h('span', { class: 'meta-star', 'aria-label': '중요' }, icon('starFill', 12)));
      else if (!on && cur) cur.remove();
    }
  }

  _highlight(el) {
    el.classList.remove('hl');
    void el.offsetWidth;
    el.classList.add('hl');
    setTimeout(() => el.classList.remove('hl'), 2600);
  }

  /**
   * Scroll to a message key (a tapped reply quote). Already rendered → scroll there;
   * otherwise the month holding it is found in the month DATA (newest to oldest from the
   * lowest rendered month; 'b:<logId>' keys grow with time, so the search stops once it is
   * past the target) and the view re-opens around it. Nothing is rendered on the way.
   * @returns {Promise<boolean>} found
   */
  async jumpToMessage(k) {
    const find = () => this.body.querySelector(`.msg[data-k="${cssEscape(k)}"], .msg-system[data-k="${cssEscape(k)}"], .msg-anchor[data-k="${cssEscape(k)}"]`);
    const el = find();
    if (el) {
      scrollToEl(el, { center: true, behavior: 'smooth' });
      this._highlight(el);
      return true;
    }
    const gen = this.gen;
    const start = this.hi >= 0 ? this.hi : this.yms.length - 1;
    let closeToast = null;
    const slow = setTimeout(() => { closeToast = toast('원본 메시지를 찾는 중…', { duration: 60000 }); }, 600);
    let found = null;
    try {
      for (let i = start; i >= 0 && !found; i--) {
        const ym = this.yms[i];
        const ch = await this.ctx.archive.chunk(this.room.id, ym);
        if (gen !== this.gen) return false;
        const msgs = (ch && ch.messages) || [];
        if (msgs.some((m) => m.k === k)) { found = ym; break; }
        // Keys that order by time: stop once this month is entirely older than the target.
        const last = msgs.length ? msgs[msgs.length - 1].k : null;
        if (last && cmpLogKeys(last, k) !== null && cmpLogKeys(last, k) < 0) break;
      }
    } catch (err) {
      this.ctx.handleError(err, { quiet: true });
    } finally {
      clearTimeout(slow);
      if (closeToast) closeToast();
    }
    if (gen !== this.gen) return false;
    if (!found) { toast('원본 메시지를 찾지 못했어요.'); return false; }
    await this.open({ ym: found, k });
    return true;
  }

  /**
   * Viewer list: photos/videos of the loaded months in chronological order. The bubbles
   * keep each message's own thumbnail; the viewer shows the better copy of a low-quality
   * duplicate (chunk field lq) in its place (`upgrade`).
   */
  viewerProvider() {
    return {
      upgrade: true,
      list: () => {
        const out = [];
        for (let i = this.lo; i <= this.hi && i >= 0; i++) {
          const part = this.loaded.get(this.yms[i]);
          if (!part) continue;
          const msgs = part.messages.slice().sort((a, b) => a.t - b.t);
          for (const m of msgs) for (const r of (part.byK.get(m.k) || [])) if (r.y === 'photo' || r.y === 'gif' || r.y === 'video') out.push(r);
        }
        return out;
      },
      extend: async (row, dir) => (dir > 0 ? this.loadNewer() : this.loadOlder()),
    };
  }

  openMonthJump() {
    const months = this.yms.slice().reverse().map((ym) => ({ ym, count: this.msgCounts.get(ym) || 0 }));
    const cur = this._currentYm();
    openJumpSheet({
      title: '대화 날짜로 이동', months, currentYm: cur, unit: '개 메시지',
      loadDays: async (ym) => {
        const part = this.loaded.get(ym);
        // days with real messages (gallery-only items are not messages, SPEC §13.2 L4)
        const msgs = part ? part.messages : (((await this.ctx.archive.chunk(this.room.id, ym)) || {}).messages || []).filter((m) => !isOrphan(m));
        const out = new Map();
        for (const m of msgs) { const d = ymdOf(m.t); out.set(d, (out.get(d) || 0) + 1); }
        return out;
      },
      onPick: ({ ym, ymd }) => {
        this.ctx.router.setQuery({ ym, k: null, day: ymd || null }, { replace: true });
      },
    });
  }

  _currentYm() {
    for (const m of this.body.querySelectorAll('.chat-month')) {
      if (m.getBoundingClientRect().bottom > 120) return m.dataset.ym;
    }
    return this.yms[this.yms.length - 1] || null;
  }
}

/**
 * System line, or a deleted/hidden line an export wrote without any sender (the bare
 * '메시지가 삭제되었습니다.' lines): both render as a centred note, not as a bubble of
 * an unknown person.
 */
function isSystem(m) {
  if (m.y === 'system') return true;
  return !m.s && !m.n && (m.y === 'deleted' || (m.fl || []).includes('hidden') || (m.fl || []).includes('deleted_everyone'));
}

/** Hidden by an admin with nothing of the original left to show. */
function hiddenOnly(m, rows) {
  const fl = m.fl || [];
  return fl.includes('hidden') && (m.y === 'deleted' || (!m.x && !(rows && rows.length)));
}

/** '사진 3장을 받지 못했어요 (만료)' with correct particles. */
export function missingText(y, n, notExported = false) {
  const video = y === 'video';
  if (notExported) return video ? '내보내기에 포함되지 않은 동영상이에요' : '내보내기에 포함되지 않은 사진이에요';
  if (video) return n > 1 ? `동영상 ${n}개를 받지 못했어요 (만료)` : '동영상을 받지 못했어요 (만료)';
  return n > 1 ? `사진 ${n}장을 받지 못했어요 (만료)` : '사진을 받지 못했어요 (만료)';
}

export function linkCard(url) {
  const dom = domainOf(url) || url;
  const href = safeHttpUrl(url);
  // Not an http(s) URL (javascript:, data:, …): show it as plain text, never as a link.
  return h(href ? 'a' : 'span', { class: 'link-card' + (href ? '' : ' no-link'), href, target: href ? '_blank' : null, rel: href ? 'noopener noreferrer' : null },
    h('span', { class: `lc-badge av${colorIndex(dom, 8)}`, 'aria-hidden': 'true', text: (dom[0] || '?').toUpperCase() }),
    h('span', { class: 'lc-main' }, h('span', { class: 'lc-domain', text: dom }), h('span', { class: 'lc-url', text: url })),
    icon('external', 14, 'lc-ext'));
}

