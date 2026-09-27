// lists.js — 파일 / 링크 / 음성 lists (archive.collect over all months): the room tabs
// (#/room/<id>/files|links|audio) and the 전체 (all rooms) screens #/files, #/links,
// #/audio — the same panels with room = null, each row showing its room's name.

import { h, icon, iconButton, avatar, clear, spinner, emptyState, errorState, actionSheet, copyText, toast, prefs } from './dom.js';
import { bytes, shortDate, koMonth, ymOf, num, duration, FILE_CATEGORIES, koDateTime, colorIndex, safeHttpUrl } from './format.js';
import { normFileRow, normLinkRows, normAudioRow, starKey } from './model.js';
import { pathOf } from './router.js';
import { fileIcon, openFileActions } from './files.js';
import { audioPlayer } from './audio.js';
import { segmented, chipGroup } from './widgets.js';

const PAGE = 150;

/** Shared scaffolding: collect rows with progress, cancel on destroy, paged rendering. */
class CollectPanel {
  /** @param room the room, or null for all rooms (전체) */
  constructor(ctx, room, kind, label) {
    this.ctx = ctx;
    this.room = room;
    this.kind = kind;
    this.label = label;
    this.rows = null;
    this.ac = null;
    this.el = h('div', { class: 'panel panel-' + kind });
    this.toolbar = h('div', { class: 'toolbar panel-toolbar' });
    this.list = h('div', { class: 'item-list', role: 'list' });
    this.more = h('div', { class: 'list-more' });
    this.el.append(this.toolbar, this.list, this.more);
    this.io = new IntersectionObserver((e) => { if (e.some((x) => x.isIntersecting)) this._page(); }, { rootMargin: '600px 0px' });
    this.io.observe(this.more);
    this.view = [];
    this.shown = 0;
  }

  async load() {
    if (this.rows || this.ac) return;
    this.ac = new AbortController();
    const prog = h('span', { class: 'loading-text' });
    const box = h('div', { class: 'loading', role: 'status', 'aria-live': 'polite' }, h('span', { class: 'spin', 'aria-hidden': 'true' }), prog);
    const rooms = this.room ? [this.room] : this.ctx.archive.rooms();
    const total = rooms.reduce((a, r) => a + (r.months || []).length, 0);
    prog.textContent = `${this.label} 모으는 중…`;
    clear(this.list).appendChild(box);
    try {
      const raw = await this.ctx.archive.collect(this.kind, {
        roomIds: this.room ? [this.room.id] : null, signal: this.ac.signal,
        onProgress: (p) => {
          const done = p && (p.done ?? p.loaded ?? 0);
          const tot = (p && (p.total ?? p.months)) || total;
          prog.textContent = `${this.label} 모으는 중… ${num(done)}/${num(tot)}개월`;
        },
      });
      this.rows = this.normalize(raw || []);
      this.rows.sort((a, b) => (b.t || 0) - (a.t || 0));
      this.ac = null;
      this.renderToolbar();
      this.apply();
    } catch (err) {
      this.ac = null;
      if (err && err.name === 'AbortError') return;
      clear(this.list).appendChild(errorState(err, () => this.load()));
      this.ctx.handleError(err, { quiet: true });
    }
  }

  destroy() {
    if (this.ac) this.ac.abort();
    this.io.disconnect();
  }

  /** Forget the collected rows (catalog reloaded); the next load() collects again. */
  reset(room = this.room) {
    if (this.ac) this.ac.abort();
    this.ac = null;
    if (this.room && room) this.room = room;
    this.rows = null;
    this.view = [];
    this.shown = 0;
    clear(this.toolbar);
    clear(this.list);
  }

  roomName(id) {
    const r = id ? this.ctx.archive.room(id) : null;
    return r ? (r.displayName || r.name) : '';
  }

  /** Re-render the filtered/sorted view from this.rows. */
  apply() {
    this.view = this.filtered();
    this.shown = 0;
    clear(this.list);
    if (!this.rows.length) { this.list.appendChild(this.empty()); return; }
    if (!this.view.length) { this.list.appendChild(emptyState({ iconName: 'filter', title: '조건에 맞는 항목이 없어요' })); return; }
    this._lastGroup = null;
    this._page();
  }

  _page() {
    if (!this.view || this.shown >= this.view.length) return;
    const frag = document.createDocumentFragment();
    const end = Math.min(this.view.length, this.shown + PAGE);
    for (let i = this.shown; i < end; i++) {
      const r = this.view[i];
      const g = this.groupOf(r);
      if (g && g !== this._lastGroup) { frag.appendChild(h('h3', { class: 'list-head', text: g })); this._lastGroup = g; }
      frag.appendChild(this.item(r));
    }
    this.shown = end;
    this.list.appendChild(frag);
  }

  groupOf(r) { return r.t ? koMonth(ymOf(r.t)) : null; }

  sub(r) {
    // 전체 (all rooms): which room the row belongs to comes first
    return [this.room ? '' : this.roomName(r.room), r.senderName, r.t ? shortDate(r.t) : ''].filter(Boolean).join(' · ');
  }

  roomOf(r) { return r.room || (this.room && this.room.id) || null; }

  chatButton(r) {
    const room = this.roomOf(r);
    if (!r.k || !room) return null;
    return h('button', {
      type: 'button', class: 'iconbtn item-chat', 'aria-label': '대화에서 보기', title: '대화에서 보기',
      onclick: (ev) => { ev.stopPropagation(); ev.preventDefault(); this.ctx.router.go(pathOf('room', room, 'chat'), { ym: r.ym, k: r.k }); },
    }, icon('chatJump', 20));
  }

  /** ★ toggle of a file/audio row (star key of its media, or of the message without one). */
  starButton(r, y) {
    const room = this.roomOf(r);
    if (!r.k || !room) return null;
    const key = starKey(room, r.k, r.media ? r.media.id : '');
    const btn = h('button', { type: 'button', class: 'iconbtn item-starbtn' });
    const paint = () => {
      const on = this.ctx.archive.isStarred(key);
      btn.replaceChildren(icon(on ? 'starFill' : 'star', 20));
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.setAttribute('aria-label', on ? '중요 표시 해제' : '중요 표시');
      btn.title = on ? '중요 표시 해제' : '중요 표시';
    };
    paint();
    btn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      await this.ctx.toggleStar(key, { room, ym: r.ym, k: r.k, id: r.media ? r.media.id : undefined, t: r.t, y, n: r.senderName, s: r.senderId, x: r.name || undefined });
      paint();
    });
    return btn;
  }
}

// ---------------------------------------------------------------------------
// 파일
// ---------------------------------------------------------------------------

const FILE_SORTS = {
  recent: ['최신순', (a, b) => (b.t || 0) - (a.t || 0)],
  name: ['이름순', (a, b) => a.name.localeCompare(b.name, 'ko')],
  size: ['용량순', (a, b) => (b.size || 0) - (a.size || 0)],
};

export class FilesPanel extends CollectPanel {
  constructor(ctx, room) {
    super(ctx, room, 'file', '파일');
    this.cat = 'all';
    this.sort = prefs.get('files.sort', 'recent');
    if (!FILE_SORTS[this.sort]) this.sort = 'recent';
  }

  normalize(raw) { return raw.map(normFileRow); }

  renderToolbar() {
    clear(this.toolbar);
    const counts = new Map();
    for (const r of this.rows) counts.set(r.cat.key, (counts.get(r.cat.key) || 0) + 1);
    const cats = [['all', `전체 ${num(this.rows.length)}`]].concat(FILE_CATEGORIES.filter((c) => counts.get(c.key)).map((c) => [c.key, `${c.label} ${num(counts.get(c.key))}`]));
    this.toolbar.append(
      h('div', { class: 'chip-row' }, chipGroup(cats, this.cat, (v) => { this.cat = v; this.apply(); }, '파일 종류')),
      h('div', { class: 'toolbar-row' },
        h('p', { class: 'summary', text: `${num(this.rows.length)}개 · ${bytes(this.rows.reduce((s, r) => s + (r.size || 0), 0))}` }),
        segmented(Object.entries(FILE_SORTS).map(([k, v]) => [k, v[0]]), this.sort, (v) => { this.sort = v; prefs.set('files.sort', v); this.apply(); }, '정렬')));
  }

  filtered() {
    const out = this.rows.filter((r) => this.cat === 'all' || r.cat.key === this.cat);
    return out.sort(FILE_SORTS[this.sort][1]);
  }

  groupOf(r) { return this.sort === 'recent' ? super.groupOf(r) : null; }

  empty() { return emptyState({ iconName: 'file', title: '주고받은 파일이 없어요' }); }

  item(r) {
    const el = h('button', { type: 'button', class: 'item' + (r.available ? '' : ' unavailable'), role: 'listitem' },
      fileIcon(r.cat),
      h('span', { class: 'item-main' },
        h('span', { class: 'item-title', text: r.name }),
        h('span', { class: 'item-sub' },
          h('span', { text: [r.size ? bytes(r.size) : '', this.sub(r)].filter(Boolean).join(' · ') }),
          r.available ? null : h('span', { class: 'tag tag-warn', text: '원본 없음' }))),
      this.starButton(r, 'file'),
      this.chatButton(r));
    el.addEventListener('click', () => openFileActions(this.ctx, {
      name: r.name, size: r.size, media: r.media, room: this.roomOf(r), ym: r.ym, k: r.k, t: r.t, n: r.senderName, s: r.senderId,
    }));
    return el;
  }
}

// ---------------------------------------------------------------------------
// 링크
// ---------------------------------------------------------------------------

export class LinksPanel extends CollectPanel {
  constructor(ctx, room) {
    super(ctx, room, 'link', '링크');
    this.domain = 'all';
  }

  normalize(raw) {
    const out = [];
    const seen = new Set();
    for (const row of raw) {
      for (const r of normLinkRows(row)) {
        const key = `${r.k}|${r.url}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(r);
      }
    }
    return out;
  }

  renderToolbar() {
    clear(this.toolbar);
    const counts = new Map();
    for (const r of this.rows) counts.set(r.domain, (counts.get(r.domain) || 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    this.toolbar.append(
      h('div', { class: 'chip-row' }, chipGroup([['all', `전체 ${num(this.rows.length)}`]].concat(top.map(([d, c]) => [d, `${d} ${num(c)}`])), this.domain, (v) => { this.domain = v; this.apply(); }, '도메인')));
  }

  filtered() { return this.rows.filter((r) => this.domain === 'all' || r.domain === this.domain); }

  empty() { return emptyState({ iconName: 'link', title: '주고받은 링크가 없어요' }); }

  item(r) {
    const text = r.text && r.text.trim() !== r.url ? r.text.replace(r.url, '').trim() : '';
    const href = safeHttpUrl(r.url);         // only http(s) links become clickable
    const a = h(href ? 'a' : 'div', { class: 'item item-link', role: 'listitem', href, target: href ? '_blank' : null, rel: href ? 'noopener noreferrer' : null },
      h('span', { class: `lc-badge big av${colorIndex(r.domain, 8)}`, 'aria-hidden': 'true', text: (r.domain[0] || '?').toUpperCase() }),
      h('span', { class: 'item-main' },
        h('span', { class: 'item-title', text: r.domain }),
        h('span', { class: 'item-url', text: r.url }),
        text ? h('span', { class: 'item-text', text }) : null,
        h('span', { class: 'item-sub' }, h('span', { text: this.sub(r) }))),
      this.chatButton(r));
    a.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      actionSheet(r.domain, [
        href ? { label: '링크 열기', icon: 'external', onSelect: () => window.open(href, '_blank', 'noopener,noreferrer') } : null,
        { label: '링크 복사', icon: 'copy', onSelect: async () => toast((await copyText(r.url)) ? '링크를 복사했어요' : '복사하지 못했어요') },
        r.k && this.roomOf(r) ? { label: '대화에서 보기', icon: 'chatJump', onSelect: () => this.ctx.router.go(pathOf('room', this.roomOf(r), 'chat'), { ym: r.ym, k: r.k }) } : null,
      ]);
    });
    return a;
  }
}

// ---------------------------------------------------------------------------
// 음성
// ---------------------------------------------------------------------------

export class AudioPanel extends CollectPanel {
  constructor(ctx, room) { super(ctx, room, 'audio', '음성메시지'); }

  normalize(raw) { return raw.map(normAudioRow); }

  renderToolbar() {
    clear(this.toolbar);
    const total = this.rows.reduce((s, r) => s + (r.duration || 0), 0);
    this.toolbar.append(h('div', { class: 'toolbar-row' }, h('p', { class: 'summary', text: `${num(this.rows.length)}개${total ? ' · 총 ' + duration(total) : ''}` })));
  }

  filtered() { return this.rows.slice(); }

  empty() { return emptyState({ iconName: 'mic', title: '음성메시지가 없어요' }); }

  item(r) {
    const media = r.media;
    return h('div', { class: 'item item-audio' + (r.available ? '' : ' unavailable'), role: 'listitem' },
      avatar(r.senderName || '?', r.senderId || r.senderName, 40),
      h('span', { class: 'item-main' },
        h('span', { class: 'item-title', text: r.senderName || (r.orphan ? '대화와 연결되지 않은 파일' : '알 수 없음') }),
        h('span', { class: 'item-sub' }, h('span', { text: [this.room ? '' : this.roomName(r.room), r.t ? koDateTime(r.t) : ''].filter(Boolean).join(' · ') })),
        r.available
          ? audioPlayer(() => this.ctx.mediaSrc(media), { duration: r.duration })
          : h('span', { class: 'tag tag-warn', text: '원본 없음' })),
      this.starButton(r, 'audio'),
      this.chatButton(r));
  }
}

// ---------------------------------------------------------------------------
// 전체 파일 / 링크 / 음성 (#/files, #/links, #/audio)
// ---------------------------------------------------------------------------

export const COLLECTIONS = {
  file: { title: '전체 파일', path: '/files', make: (ctx) => new FilesPanel(ctx, null) },
  link: { title: '전체 링크', path: '/links', make: (ctx) => new LinksPanel(ctx, null) },
  audio: { title: '전체 음성메시지', path: '/audio', make: (ctx) => new AudioPanel(ctx, null) },
};

/** Screen: one list over every room (the room's name is shown on each row). */
export function createCollection(ctx, kind) {
  const def = COLLECTIONS[kind] || COLLECTIONS.file;
  const panel = def.make(ctx);
  const el = h('div', { class: 'screen screen-collect' },
    h('header', { class: 'appbar' }, iconButton('back', '뒤로', () => ctx.router.back('/rooms')),
      h('h1', { class: 'appbar-title', text: def.title })),
    panel.el);
  return {
    el, title: def.title,
    show() { panel.load(); },
    hide() {},
    refresh() { panel.reset(); if (!el.hidden && el.isConnected) panel.load(); },
    destroy() { panel.destroy(); },
  };
}
