// home.js — 홈 = 사진·동영상 타임라인 (#/): all rooms, filters, 일별/월별, scrubber, 달력.

import { h, icon, iconButton, prefs } from './dom.js';
import { num } from './format.js';
import { Gallery } from './gallery.js';
import { Scrubber } from './scrubber.js';
import { openJumpSheet } from './calendar.js';
import { pickRooms } from './pickers.js';
import { GALLERY_FILTERS } from './model.js';
import { segmented, chipGroup } from './widgets.js';

export function roomChipLabel(ctx, roomIds) {
  if (!roomIds || !roomIds.length) return '전체 채팅방';
  const first = ctx.archive.room(roomIds[0]);
  const name = first ? (first.displayName || first.name) : '채팅방';
  return roomIds.length > 1 ? `${name} 외 ${roomIds.length - 1}` : name;
}

export function createHome(ctx) {
  const validRooms = (ids) => (ids || []).filter((id) => ctx.archive.room(id));
  let roomIds = validRooms(prefs.get('home.rooms', null));
  if (!roomIds.length) roomIds = null;
  let filter = prefs.get('home.filter', 'all');
  if (!GALLERY_FILTERS[filter]) filter = 'all';
  let mode = prefs.get('gallery.mode', 'day');
  let dense = prefs.get('gallery.dense', false);

  const el = h('div', { class: 'screen screen-home' });
  const densityBtn = iconButton(dense ? 'photo' : 'grid', dense ? '크게 보기' : '작게 보기', () => toggleDensity());
  const appbar = h('header', { class: 'appbar' },
    h('h1', { class: 'appbar-title', text: '사진' }),
    h('div', { class: 'appbar-actions' },
      iconButton('calendar', '날짜로 이동', () => openCalendar()),
      densityBtn));

  const roomChip = h('button', { type: 'button', class: 'chip chip-drop' + (roomIds ? ' on' : ''), 'aria-haspopup': 'dialog', onclick: () => chooseRooms() },
    icon('chats', 16), h('span', { class: 'chip-label', text: roomChipLabel(ctx, roomIds) }), icon('chevronDown', 14));
  const typeChips = chipGroup(Object.entries(GALLERY_FILTERS).map(([k, v]) => [k, v.label]), filter, (v) => {
    filter = v; prefs.set('home.filter', v); gallery.setFilter({ filter: v }); updateSummary();
  }, '유형');
  const modeSeg = segmented([['day', '일별'], ['month', '월별']], mode, (v) => {
    mode = v; prefs.set('gallery.mode', v); gallery.setMode(v);
  }, '묶음 단위');
  const summary = h('p', { class: 'summary' });
  const selectBtn = h('button', { type: 'button', class: 'chip chip-select', 'aria-pressed': 'false', onclick: () => gallery.setSelecting(!gallery.selecting) }, icon('check', 16), h('span', { text: '선택' }));
  const toolbar = h('div', { class: 'toolbar' },
    h('div', { class: 'chip-row' }, roomChip, h('span', { class: 'chip-sep', 'aria-hidden': 'true' }), typeChips),
    h('div', { class: 'toolbar-row' }, summary, h('div', { class: 'toolbar-end' }, selectBtn, modeSeg)));

  const gallery = new Gallery(ctx, {
    roomIds, filter, mode, cols: dense ? 0 : 0,
    // one tile per photo/video file when several rooms are shown (forwards, the same photo
    // in two exports): the newest reference wins (SPEC §13.2 L9)
    dedupeAcrossRooms: true,
    emptyTitle: '보관된 사진·동영상이 없어요',
    emptyText: 'Mac의 카톡 보관함 프로그램에서 백업을 실행하면 여기에 날짜별로 모입니다.',
  });
  gallery.el.classList.toggle('mode-month', mode === 'month');
  gallery.el.classList.toggle('dense', dense);
  const scrubber = new Scrubber(gallery);
  gallery.onSelection = () => {
    selectBtn.classList.toggle('on', gallery.selecting);
    selectBtn.setAttribute('aria-pressed', gallery.selecting ? 'true' : 'false');
  };
  el.append(appbar, toolbar, gallery.el, scrubber.el, gallery.selBar);

  function applyDensity() {
    const w = document.documentElement.clientWidth;
    const base = w < 480 ? 3 : w < 720 ? 4 : w < 1000 ? 5 : 6;
    gallery.setCols(dense ? base + 2 : 0);
    gallery.el.classList.toggle('dense', dense);
    densityBtn.replaceChildren(icon(dense ? 'photo' : 'grid', 22));
    densityBtn.setAttribute('aria-label', dense ? '크게 보기' : '작게 보기');
    densityBtn.title = dense ? '크게 보기' : '작게 보기';
  }

  function toggleDensity() {
    dense = !dense;
    prefs.set('gallery.dense', dense);
    applyDensity();
  }

  function updateSummary() {
    const rooms = roomIds ? roomIds.map((id) => ctx.archive.room(id)).filter(Boolean) : ctx.archive.rooms();
    let photo = 0, video = 0;
    for (const r of rooms) { photo += (r.counts && r.counts.photo) || 0; video += (r.counts && r.counts.video) || 0; }
    const parts = [];
    if (filter !== 'video') parts.push(`사진 ${num(photo)}`);
    if (filter !== 'photo') parts.push(`동영상 ${num(video)}`);
    summary.textContent = parts.join(' · ');
  }

  async function chooseRooms() {
    const res = await pickRooms(ctx, roomIds, { title: '사진을 볼 채팅방' });
    if (res === undefined) return;
    roomIds = res;
    prefs.set('home.rooms', roomIds);
    roomChip.querySelector('.chip-label').textContent = roomChipLabel(ctx, roomIds);
    roomChip.classList.toggle('on', !!roomIds);
    gallery.setFilter({ roomIds });
    updateSummary();
  }

  function openCalendar() {
    const months = gallery.monthsList();
    if (!months.length) return;
    openJumpSheet({
      months, currentYm: gallery.currentYm(),
      loadDays: (ym) => gallery.daysOf(ym),
      onPick: ({ ym, ymd }) => gallery.jumpTo(ym, ymd),
    });
  }

  updateSummary();
  if (dense) applyDensity();

  return {
    el, title: '사진',
    show() {
      gallery.active = true;
      gallery.relayout();
      scrubber.attach();
      ctx.setViewerProviderFallback(gallery.viewerProvider());
    },
    hide() { gallery.active = false; scrubber.detach(); },
    refresh() {
      roomIds = roomIds ? validRooms(roomIds) : null;
      if (roomIds && !roomIds.length) roomIds = null;
      roomChip.querySelector('.chip-label').textContent = roomChipLabel(ctx, roomIds);
      gallery.roomIds = roomIds;
      gallery.build();
      updateSummary();
    },
    destroy() { gallery.destroy(); scrubber.detach(); },
  };
}
