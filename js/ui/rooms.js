// rooms.js — 채팅방 목록 (#/rooms): search, sort, room cards, 나간 채팅방 section, and the
// entries of the 전체 (all rooms) 파일 / 링크 / 음성 lists (#/files, #/links, #/audio).

import { h, icon, avatar, clear, emptyState, prefs } from './dom.js';
import { num, shortDate, bytes, roomKindLabel, dotDate } from './format.js';
import { pathOf } from './router.js';
import { segmented } from './widgets.js';

const KIND_ICON = { direct: 'user', group: 'users', open: 'globe', self: 'me' };

const SORTS = {
  recent: { label: '최근순', fn: (a, b) => (b.last_ts || 0) - (a.last_ts || 0) },
  name: { label: '이름순', fn: (a, b) => (a.displayName || a.name).localeCompare(b.displayName || b.name, 'ko') },
  size: { label: '용량순', fn: (a, b) => (b.bytes || 0) - (a.bytes || 0) },
};

function countsLine(c) {
  const out = [];
  if (c.photo) out.push(`사진 ${num(c.photo)}`);
  if (c.video) out.push(`동영상 ${num(c.video)}`);
  if (c.file) out.push(`파일 ${num(c.file)}`);
  if (c.audio) out.push(`음성 ${num(c.audio)}`);
  if (!out.length) out.push(`메시지 ${num(c.msg)}`);
  return out.join(' · ');
}

export function roomCard(ctx, r) {
  const name = r.displayName || r.name || '이름 없는 채팅방';
  const members = (r.members || []).length;
  const c = r.counts || {};
  const kindIcon = KIND_ICON[r.kind] || 'chats';
  return h('a', { class: 'room-card' + (r.left ? ' left' : ''), href: '#' + pathOf('room', r.id, 'media'), 'aria-label': `${name}, ${roomKindLabel(r.kind)}${members > 2 ? `, ${members}명` : ''}` },
    avatar(name, r.id, 50, r.kind === 'self' ? 'me' : null),
    h('span', { class: 'rc-main' },
      h('span', { class: 'rc-top' },
        h('span', { class: 'rc-name', text: name }),
        members > 2 ? h('span', { class: 'rc-members', text: String(members) }) : null,
        h('span', { class: 'rc-date', text: r.left ? '나감' : shortDate(r.last_ts) })),
      h('span', { class: 'rc-sub' },
        icon(kindIcon, 14, 'rc-kind'),
        r.kind === 'self' ? null : h('span', { text: roomKindLabel(r.kind) }),
        r.kind === 'self' ? null : h('span', { class: 'dot-sep', 'aria-hidden': 'true' }),
        h('span', { text: countsLine(c) })),
      r.left ? h('span', { class: 'rc-note', text: `${dotDate(r.first_ts)} ~ ${dotDate(r.last_ts)} 대화 보관됨` }) : null),
    h('span', { class: 'rc-size', text: r.bytes ? bytes(r.bytes) : '' }));
}

export function createRooms(ctx) {
  let sort = prefs.get('rooms.sort', 'recent');
  if (!SORTS[sort]) sort = 'recent';
  let query = '';
  const el = h('div', { class: 'screen screen-rooms' });
  const search = h('input', { type: 'search', class: 'input input-search', placeholder: '채팅방 이름, 참여자 검색', 'aria-label': '채팅방 검색', enterkeyhint: 'search', autocomplete: 'off' });
  const list = h('div', { class: 'room-list' });
  const sortSeg = segmented(Object.entries(SORTS).map(([k, v]) => [k, v.label]), sort, (v) => { sort = v; prefs.set('rooms.sort', v); render(); }, '정렬');
  const countEl = h('p', { class: 'summary' });
  const allLists = h('nav', { class: 'chip-row all-lists', 'aria-label': '모든 채팅방에서 모아 보기' });
  el.append(
    h('header', { class: 'appbar' }, h('h1', { class: 'appbar-title', text: '채팅방' })),
    h('div', { class: 'toolbar' },
      h('div', { class: 'search-wrap' }, icon('search', 18, 'search-ic'), search),
      allLists,
      h('div', { class: 'toolbar-row' }, countEl, sortSeg)),
    list);

  function renderAllLists() {
    clear(allLists);
    const rooms = ctx.archive.rooms();
    const sum = (k) => rooms.reduce((a, r) => a + ((r.counts && r.counts[k]) || 0), 0);
    allLists.appendChild(h('span', { class: 'all-lists-label', text: '모아 보기' }));
    for (const [href, label, k, ic] of [['#/files', '파일', 'file', 'file'], ['#/links', '링크', 'link', 'link'], ['#/audio', '음성', 'audio', 'mic']]) {
      allLists.appendChild(h('a', { class: 'chip', href, 'aria-label': `모든 채팅방의 ${label} ${num(sum(k))}개` }, icon(ic, 16),
        h('span', { class: 'chip-label', text: label }), h('span', { class: 'chip-count', text: num(sum(k)) })));
    }
  }

  search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); render(); });

  function matches(r) {
    if (!query) return true;
    const hay = [r.displayName, r.name, ...(r.members || []).map((m) => m.name)].filter(Boolean).join(' ').toLowerCase();
    return query.split(/\s+/).every((w) => hay.includes(w));
  }

  function render() {
    clear(list);
    const all = ctx.archive.rooms();
    const rooms = all.filter(matches).sort(SORTS[sort].fn);
    const active = rooms.filter((r) => !r.left);
    const left = rooms.filter((r) => r.left);
    countEl.textContent = query ? `검색 결과 ${rooms.length}개` : `채팅방 ${all.length}개`;
    if (!all.length) {
      list.appendChild(emptyState({ iconName: 'chats', title: '보관된 채팅방이 없어요', text: 'Mac 프로그램에서 백업할 채팅방을 고르고 보관함에 저장하세요.' }));
      return;
    }
    if (!rooms.length) {
      list.appendChild(emptyState({ iconName: 'search', title: '일치하는 채팅방이 없어요', text: `'${search.value.trim()}'` }));
      return;
    }
    for (const r of active) list.appendChild(roomCard(ctx, r));
    if (left.length) {
      const openLeft = prefs.get('rooms.leftOpen', true);
      const body = h('div', { class: 'left-body', hidden: !openLeft });
      const toggle = h('button', {
        type: 'button', class: 'section-toggle', 'aria-expanded': openLeft ? 'true' : 'false',
        onclick: () => {
          const now = body.hidden;
          body.hidden = !now;
          toggle.setAttribute('aria-expanded', now ? 'true' : 'false');
          prefs.set('rooms.leftOpen', now);
        },
      }, icon('exit', 18), h('span', { class: 'st-label', text: `나간 채팅방 ${left.length}` }), h('span', { class: 'st-hint', text: '나가도 보관함에는 그대로 남아요' }), icon('chevronDown', 16, 'st-chev'));
      for (const r of left) body.appendChild(roomCard(ctx, r));
      list.append(toggle, body);
    }
  }

  render();
  renderAllLists();
  return {
    el, title: '채팅방',
    show() {},
    hide() {},
    refresh() { render(); renderAllLists(); },
    destroy() {},
  };
}
