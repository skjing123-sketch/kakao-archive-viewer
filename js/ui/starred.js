// starred.js — 중요 (#/starred): starred photos/videos grid + starred messages/files list.
//
// Stars live in user-state (archive.starred()). Keys are `${room}|${msgKey}|${mediaId}`;
// rows are resolved against the current month chunks so thumbnails always use fresh
// pack offsets (packs are rebuilt when a month is republished). A message star that
// resolves to a gallery-only (orphan) item is not a message and is never listed.

import { h, icon, clear, spinner, emptyState, avatar, actionSheet } from './dom.js';
import { dotDate, koTime, ymOf, duration, num } from './format.js';
import { parseStarKey, messagePreview, isOrphan, tileLabel, isVideoThumb } from './model.js';
import { pathOf } from './router.js';
import { openFileActions } from './files.js';

export function createStarred(ctx) {
  const el = h('div', { class: 'screen screen-starred' });
  const body = h('div', { class: 'starred-body' });
  el.append(h('header', { class: 'appbar' }, h('h1', { class: 'appbar-title', text: '중요' })), body);
  let gen = 0;
  let dirty = true;
  let mediaRows = [];

  const onStar = () => { dirty = true; if (!el.hidden && el.isConnected) render(); };
  ctx.on('star', onStar);

  async function resolve(entries) {
    const groups = new Map();            // room|ym -> entries
    const out = [];
    for (const e of entries) {
      const key = parseStarKey(e.key);
      if (!key) continue;
      const meta = e.meta || {};
      const ym = meta.ym || (meta.t ? ymOf(meta.t) : null);
      const item = { entry: e, key, meta, ym, row: null, message: null, missing: false };
      out.push(item);
      if (!ym || !ctx.archive.room(key.room)) { item.missing = true; continue; }
      const g = `${key.room}|${ym}`;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(item);
    }
    await Promise.all([...groups.entries()].map(async ([g, items]) => {
      const [room, ym] = g.split('|');
      try {
        const ch = await ctx.archive.chunk(room, ym);
        for (const it of items) {
          it.message = ((ch && ch.messages) || []).find((m) => m.k === it.key.k) || null;
          if (it.key.id) {
            const r = ((ch && ch.media) || []).find((x) => x.id === it.key.id && x.k === it.key.k) || ((ch && ch.media) || []).find((x) => x.id === it.key.id);
            it.row = r ? Object.assign({}, r, { room, ym }) : null;
            if (!it.row) it.missing = true;
          } else if (!it.message) it.missing = true;
        }
      } catch (err) {
        for (const it of items) it.missing = true;
      }
    }));
    return out;
  }

  async function render() {
    dirty = false;
    const my = ++gen;
    const entries = ctx.archive.starred() || [];
    if (!entries.length) {
      clear(body).appendChild(emptyState({
        iconName: 'star', title: '중요 표시한 항목이 없어요',
        text: '사진을 열어 ★ 버튼을 누르거나, 대화에서 말풍선을 길게 눌러 중요 표시를 할 수 있어요.',
      }));
      return;
    }
    if (!body.firstChild || body.querySelector('.empty')) clear(body).appendChild(spinner('중요 항목을 불러오는 중…'));
    // Gallery-only items are not messages: a (legacy) message star on one is not listed.
    const items = (await resolve(entries)).filter((it) => it.key.id || !(it.message && isOrphan(it.message)));
    if (my !== gen) return;
    clear(body);
    if (!items.length) {
      body.appendChild(emptyState({ iconName: 'star', title: '중요 표시한 항목이 없어요', text: '사진을 열어 ★ 버튼을 누르거나, 대화에서 말풍선을 길게 눌러 중요 표시를 할 수 있어요.' }));
      return;
    }
    const media = items.filter((it) => it.key.id && it.row && (it.row.y === 'photo' || it.row.y === 'gif' || it.row.y === 'video'));
    const others = items.filter((it) => !media.includes(it));
    mediaRows = media.map((it) => it.row);
    if (media.length) {
      body.appendChild(h('h2', { class: 'section-title', text: `사진·동영상 ${num(media.length)}` }));
      const grid = h('div', { class: 'g-grid starred-grid' });
      media.forEach((it, i) => {
        const r = it.row;
        const tile = h('button', { type: 'button', class: 'tile', 'aria-label': tileLabel(r), onclick: () => ctx.openViewer(r, provider()) },
          h('img', { alt: '', loading: 'lazy', decoding: 'async' }),
          isVideoThumb(r) ? h('span', { class: 'badge badge-video badge-vthumb', title: '동영상 · 썸네일만 보관됨' }, icon('video', 12), r.d ? duration(r.d) : '')
            : r.y === 'video' ? h('span', { class: 'badge badge-video' }, icon('play', 12), r.d ? duration(r.d) : '') : null,
          h('span', { class: 'badge badge-star' }, icon('starFill', 14)));
        grid.appendChild(tile);
        if (r.th) setThumb(tile, r, false);
        else tile.classList.add('nothumb');
        tile.dataset.i = String(i);
      });
      body.appendChild(grid);
    }
    if (others.length) {
      body.appendChild(h('h2', { class: 'section-title', text: `메시지·파일 ${num(others.length)}` }));
      const list = h('div', { class: 'item-list', role: 'list' });
      for (const it of others) list.appendChild(messageItem(it));
      body.appendChild(list);
    }
  }

  /** Thumbnail of a tile; one retry (an object URL may have been revoked by the data layer). */
  function setThumb(tile, r, retry) {
    Promise.resolve(ctx.archive.thumbURL(r)).then((u) => {
      if (!u) { tile.classList.add('nothumb'); return; }
      const img = tile.querySelector('img');
      img.onload = () => tile.classList.add('ready');
      img.onerror = () => { if (!retry) setThumb(tile, r, true); else tile.classList.add('nothumb'); };
      img.src = u;
    }).catch(() => tile.classList.add('nothumb'));
  }

  function provider() {
    return { list: () => mediaRows.slice(), extend: async () => false };
  }

  function messageItem(it) {
    const room = ctx.archive.room(it.key.room);
    const roomName = room ? (room.displayName || room.name) : '알 수 없는 채팅방';
    const m = it.message;
    const meta = it.meta;
    const t = (m && m.t) || meta.t;
    const text = m ? (it.row && it.row.nm) || messagePreview(m) : (meta.x || '(내용 없음)');
    const sender = (m && m.n) || meta.n || '';
    const go = () => {
      if (it.missing && !m) {
        actionSheet('찾을 수 없는 항목', [{ label: '중요 표시 해제', icon: 'star', danger: true, onSelect: () => ctx.toggleStar(it.entry.key, meta) }]);
        return;
      }
      if (it.row && it.row.y === 'file') {
        // a starred file (파일 tab / 파일 sheet): open / save / 대화에서 보기
        openFileActions(ctx, {
          name: it.row.nm || (m && m.f && m.f.name) || meta.x || '파일', size: it.row.sz || (m && m.f && m.f.size),
          media: it.row, room: it.key.room, ym: it.ym, k: it.key.k, t, n: sender, s: (m && m.s) || meta.s,
        });
        return;
      }
      ctx.router.go(pathOf('room', it.key.room, 'chat'), { ym: it.ym, k: it.key.k });
    };
    return h('div', { class: 'item item-star' + (it.missing ? ' unavailable' : ''), role: 'listitem' },
      h('button', { type: 'button', class: 'item-hit', onclick: go, 'aria-label': `${roomName}, ${text}` }),
      avatar(sender || roomName, (m && m.s) || meta.s || roomName, 40),
      h('span', { class: 'item-main' },
        h('span', { class: 'item-title' }, h('span', { class: 'is-sender', text: sender || roomName }), sender ? h('span', { class: 'is-room', text: roomName }) : null),
        h('span', { class: 'item-text', text: text }),
        h('span', { class: 'item-sub' }, t ? h('span', { text: `${dotDate(t)} ${koTime(t)}` }) : null, it.missing ? h('span', { class: 'tag tag-warn', text: '보관함에서 찾을 수 없음' }) : null)),
      h('button', {
        type: 'button', class: 'iconbtn star-on', 'aria-label': '중요 표시 해제', title: '중요 표시 해제',
        onclick: (ev) => { ev.stopPropagation(); ctx.toggleStar(it.entry.key, meta); },
      }, icon('starFill', 20)));
  }

  return {
    el, title: '중요',
    show() {
      ctx.setViewerProviderFallback(provider());
      if (dirty) render();
    },
    hide() {},
    refresh() { dirty = true; render(); },
    destroy() { ctx.off('star', onStar); },
  };
}

