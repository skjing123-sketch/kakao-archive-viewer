// room.js — 채팅방 (#/room/<id>/<tab>): tabs 사진·동영상 | 파일 | 링크 | 음성 | 대화.
//
// Tab panels are created lazily and kept alive while the room screen lives, each with its
// own remembered scroll position. The chat tab reacts to ?ym=&k=&day= query changes.
// refresh() (catalog reloaded) re-reads the room: counts, gallery months, chat months and
// the loaded file/link/audio rows — rows kept from a superseded month chunk would point
// at deleted thumbnail packs, and new months/photos would never appear.

import { h, icon, iconButton, avatar, prefs } from './dom.js';
import { num, roomKindLabel } from './format.js';
import { pathOf } from './router.js';
import { Gallery } from './gallery.js';
import { Scrubber } from './scrubber.js';
import { openJumpSheet } from './calendar.js';
import { ChatView } from './chat.js';
import { FilesPanel, LinksPanel, AudioPanel } from './lists.js';
import { GALLERY_FILTERS } from './model.js';
import { segmented, chipGroup } from './widgets.js';

const TABS = [
  ['media', '사진·동영상', (c) => (c.photo || 0) + (c.video || 0)],
  ['files', '파일', (c) => c.file || 0],
  ['links', '링크', (c) => c.link || 0],
  ['audio', '음성', (c) => c.audio || 0],
  ['chat', '대화', (c) => c.msg || 0],
];

function notFound(ctx) {
  return [
    h('header', { class: 'appbar' }, iconButton('back', '뒤로', () => ctx.router.back('/rooms')), h('h1', { class: 'appbar-title', text: '채팅방' })),
    h('div', { class: 'empty' }, h('div', { class: 'empty-ic' }, icon('alert', 34)), h('p', { class: 'empty-title', text: '채팅방을 찾을 수 없어요' }),
      h('p', { class: 'empty-text', text: '보관함이 갱신되었거나 주소가 잘못되었어요.' }),
      h('a', { class: 'btn', href: '#/rooms', 'data-replace': '' }, '채팅방 목록으로')),
  ];
}

export function createRoom(ctx, roomId) {
  let room = ctx.archive.room(roomId);
  const el = h('div', { class: 'screen screen-room' });
  if (!room) {
    el.append(...notFound(ctx));
    return { el, title: '채팅방', show() {}, hide() {}, destroy() {} };
  }
  let name = room.displayName || room.name;
  let c = room.counts || {};
  const members = (room.members || []).length;
  let tab = 'media';
  const panels = {};
  const scrolls = {};

  const actions = h('div', { class: 'appbar-actions' });
  const calBtn = iconButton('calendar', '날짜로 이동', () => onCalendar());
  const searchBtn = iconButton('search', '이 채팅방에서 검색', () => ctx.router.go('/search', { room: room.id }));
  actions.append(searchBtn, calBtn);
  const appbar = h('header', { class: 'appbar appbar-room' },
    iconButton('back', '뒤로', () => ctx.router.back('/rooms')),
    h('div', { class: 'appbar-room-title' },
      avatar(name, room.id, 34, room.kind === 'self' ? 'me' : null),
      h('div', { class: 'art-text' },
        h('h1', { class: 'appbar-title small', text: name }),
        h('p', { class: 'appbar-sub', text: [roomKindLabel(room.kind), members > 2 ? `${members}명` : '', room.left ? '나간 채팅방' : ''].filter(Boolean).join(' · ') }))),
    actions);

  const tabBar = h('nav', { class: 'room-tabs', role: 'tablist', 'aria-label': '채팅방 보기' });
  const tabBtns = {};
  const countEl = (n) => (n ? h('span', { class: 'rt-count', text: n > 999 ? '999+' : num(n) }) : null);
  for (const [key, label, count] of TABS) {
    const b = h('a', { class: 'room-tab', role: 'tab', href: '#' + pathOf('room', room.id, key), 'data-replace': '', 'aria-selected': 'false' },
      h('span', { class: 'rt-label', text: label }), countEl(count(c)));
    tabBtns[key] = b;
    tabBar.appendChild(b);
  }
  const host = h('div', { class: 'room-host' });
  el.append(appbar, tabBar, host);

  function makePanel(key) {
    switch (key) {
      case 'media': {
        let filter = 'all';
        const gallery = new Gallery(ctx, {
          roomIds: [room.id], filter, mode: prefs.get('gallery.mode', 'day'),
          emptyTitle: '이 채팅방에는 보관된 사진·동영상이 없어요',
        });
        gallery.el.classList.toggle('mode-month', gallery.mode === 'month');
        const scrubber = new Scrubber(gallery);
        const chips = chipGroup(Object.entries(GALLERY_FILTERS).map(([k, v]) => [k, v.label]), filter, (v) => { filter = v; gallery.setFilter({ filter: v }); }, '유형');
        const seg = segmented([['day', '일별'], ['month', '월별']], gallery.mode, (v) => {
          prefs.set('gallery.mode', v);
          gallery.el.classList.toggle('mode-month', v === 'month');
          gallery.setMode(v);
        }, '묶음 단위');
        const selectBtn = h('button', { type: 'button', class: 'chip chip-select', 'aria-pressed': 'false', onclick: () => gallery.setSelecting(!gallery.selecting) }, icon('check', 16), h('span', { text: '선택' }));
        gallery.onSelection = () => {
          selectBtn.classList.toggle('on', gallery.selecting);
          selectBtn.setAttribute('aria-pressed', gallery.selecting ? 'true' : 'false');
        };
        const panelEl = h('div', { class: 'panel panel-media' },
          h('div', { class: 'toolbar panel-toolbar' }, h('div', { class: 'toolbar-row' }, chips, selectBtn, seg)),
          gallery.el, scrubber.el, gallery.selBar);
        return {
          el: panelEl, gallery,
          show() { gallery.active = true; gallery.relayout(); scrubber.attach(); ctx.setViewerProviderFallback(gallery.viewerProvider()); },
          hide() { gallery.active = false; scrubber.detach(); },
          refresh() { gallery.roomIds = [room.id]; gallery.build(); },
          destroy() { gallery.destroy(); scrubber.detach(); },
          calendar() {
            openJumpSheet({ months: gallery.monthsList(), currentYm: gallery.currentYm(), loadDays: (ym) => gallery.daysOf(ym), onPick: ({ ym, ymd }) => gallery.jumpTo(ym, ymd) });
          },
        };
      }
      case 'chat': {
        const chat = new ChatView(ctx, room);
        let lastKey = null;
        let reopenYm = null;             // month to show again after a catalog refresh
        return {
          el: h('div', { class: 'panel panel-chat' }, chat.el), chat, noScrollRestore: true,
          show(query) {
            chat.active = true;
            ctx.setViewerProviderFallback(chat.viewerProvider());
            const key = `${query.ym || ''}|${query.k || ''}|${query.day || ''}`;
            if (key !== lastKey || !chat.loaded.size) {
              const first = lastKey === null;
              lastKey = key;
              if (first || query.ym || query.k || query.day || !chat.loaded.size) {
                const targeted = !!(query.ym || query.k || query.day);
                chat.open({ ym: targeted ? query.ym || null : reopenYm, k: query.k || null, ymd: query.day || null });
                reopenYm = null;
                return 'positioned';
              }
            }
            return null;
          },
          hide() { chat.active = false; },
          refresh(active) {
            reopenYm = chat.reset(room);
            if (active) { chat.open({ ym: reopenYm }); reopenYm = null; }
          },
          destroy() { chat.destroy(); },
          calendar() { chat.openMonthJump(); },
        };
      }
      case 'files': return listPanel(new FilesPanel(ctx, room));
      case 'links': return listPanel(new LinksPanel(ctx, room));
      case 'audio': return listPanel(new AudioPanel(ctx, room));
      default: return null;
    }
  }

  function listPanel(p) {
    return {
      el: p.el, show() { p.load(); }, hide() {}, destroy() { p.destroy(); }, calendar: null,
      refresh(active) { p.reset(room); if (active) p.load(); },
    };
  }

  function refresh() {
    const fresh = ctx.archive.room(roomId);
    if (!fresh) {
      for (const p of Object.values(panels)) if (p) p.destroy();
      for (const k of Object.keys(panels)) delete panels[k];
      el.replaceChildren(...notFound(ctx));
      return;
    }
    room = fresh;
    name = room.displayName || room.name;
    c = room.counts || {};
    appbar.querySelector('.appbar-title').textContent = name;
    for (const [key, , count] of TABS) {
      const b = tabBtns[key];
      const old = b.querySelector('.rt-count');
      const n = countEl(count(c));
      if (old) old.remove();
      if (n) b.appendChild(n);
    }
    const visible = !el.hidden && el.isConnected;
    for (const [key, p] of Object.entries(panels)) {
      if (p && p.refresh) p.refresh(visible && key === tab);
    }
  }

  function onCalendar() {
    const p = panels[tab];
    if (p && p.calendar) p.calendar();
  }

  function selectTab(key, query) {
    const prev = tab;
    if (panels[prev] && prev !== key) {
      scrolls[prev] = window.scrollY;
      panels[prev].hide();
      panels[prev].el.hidden = true;
    }
    tab = key;
    let p = panels[key];
    const fresh = !p;
    if (!p) { p = panels[key] = makePanel(key); host.appendChild(p.el); }
    p.el.hidden = false;
    for (const [k, b] of Object.entries(tabBtns)) {
      b.setAttribute('aria-selected', k === key ? 'true' : 'false');
      b.classList.toggle('on', k === key);
    }
    el.classList.toggle('is-chat', key === 'chat');
    calBtn.hidden = !p.calendar;
    const res = p.show(query || {});
    if (res !== 'positioned' && prev !== key) {
      window.scrollTo(0, fresh ? 0 : (scrolls[key] || 0));
    }
    const active = tabBtns[key];
    if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return res;
  }

  return {
    el,
    get title() { return name; },
    ownsScroll: true,
    show(route) {
      const key = (route && route.params && route.params.tab) || 'media';
      return selectTab(key, (route && route.query) || {});
    },
    hide() {
      scrolls[tab] = window.scrollY;
      if (panels[tab]) panels[tab].hide();
    },
    resumeScroll() { window.scrollTo(0, scrolls[tab] || 0); },
    refresh,
    destroy() { for (const p of Object.values(panels)) if (p) p.destroy(); },
  };
}
