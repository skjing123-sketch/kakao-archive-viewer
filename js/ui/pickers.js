// pickers.js — bottom-sheet pickers: rooms (multi-select), senders (multi-select), period.

import { h, icon, avatar, openSheet } from './dom.js';
import { num, roomKindLabel, ymdOf, epochOfLocal, parts } from './format.js';

const KIND_ICON = { direct: 'user', group: 'users', open: 'globe', self: 'me' };

function checkRow({ checked, title, sub, lead, onToggle }) {
  const row = h('button', { type: 'button', class: 'pick-row', role: 'checkbox', 'aria-checked': checked ? 'true' : 'false' },
    lead || null,
    h('span', { class: 'pick-main' }, h('span', { class: 'pick-title', text: title }), sub ? h('span', { class: 'pick-sub', text: sub }) : null),
    h('span', { class: 'check-box', 'aria-hidden': 'true' }, icon('check', 16)));
  row.addEventListener('click', () => {
    const now = row.getAttribute('aria-checked') !== 'true';
    row.setAttribute('aria-checked', now ? 'true' : 'false');
    onToggle(now);
  });
  row.setChecked = (v) => { row.setAttribute('aria-checked', v ? 'true' : 'false'); };
  return row;
}

/**
 * Pick rooms. `selected`: array of room ids, or null for 전체.
 * Resolves to an array (subset), null (전체) or undefined (cancelled).
 */
export function pickRooms(ctx, selected, { title = '채팅방 선택' } = {}) {
  const rooms = ctx.archive.rooms();
  const sel = new Set(selected || []);
  const all = !selected || !selected.length;
  let result;
  const search = h('input', { type: 'search', class: 'input', placeholder: '채팅방 이름 검색', 'aria-label': '채팅방 이름 검색', enterkeyhint: 'search' });
  const list = h('div', { class: 'pick-list' });
  const rows = [];
  const allRow = checkRow({
    checked: all, title: '전체 채팅방', sub: `${rooms.length}개 채팅방`, lead: avatar('', 'all', 36, 'chats'),
    onToggle: (v) => { if (v) { sel.clear(); for (const r of rows) r.el.setChecked(false); } else allRow.setChecked(true); update(); },
  });
  list.appendChild(allRow);
  const groups = [['', rooms.filter((r) => !r.left)], ['나간 채팅방', rooms.filter((r) => r.left)]];
  for (const [label, items] of groups) {
    if (!items.length) continue;
    if (label) list.appendChild(h('div', { class: 'pick-group', text: label }));
    for (const r of items) {
      const counts = r.counts || {};
      const el = checkRow({
        checked: sel.has(r.id), title: r.displayName || r.name,
        sub: `${roomKindLabel(r.kind)} · 사진 ${num(counts.photo)} · 동영상 ${num(counts.video)}`,
        lead: avatar(r.displayName || r.name, r.id, 36, r.kind === 'self' ? 'me' : null),
        onToggle: (v) => { if (v) sel.add(r.id); else sel.delete(r.id); allRow.setChecked(sel.size === 0); update(); },
      });
      el.dataset.name = (r.displayName || r.name || '').toLowerCase();
      rows.push({ el, room: r });
      list.appendChild(el);
    }
  }
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    for (const r of rows) r.el.hidden = q && !r.el.dataset.name.includes(q);
  });
  const apply = h('button', { type: 'button', class: 'btn btn-primary btn-block' });
  const update = () => { apply.textContent = sel.size ? `${sel.size}개 채팅방 보기` : '전체 채팅방 보기'; };
  update();
  apply.addEventListener('click', () => { result = sel.size ? [...sel] : null; layer.close(); });
  const content = h('div', { class: 'picker' }, rooms.length > 6 ? h('div', { class: 'pick-search' }, search) : null, list);
  const layer = openSheet({ title, content, footer: apply, cls: 'sheet-tall' });
  return layer.closed.then(() => result);
}

/** Pick senders (members). `members`: [{sid, name, rooms?}] Resolves array|null|undefined. */
export function pickSenders(ctx, members, selected, { title = '보낸 사람' } = {}) {
  const sel = new Set(selected || []);
  let result;
  const list = h('div', { class: 'pick-list' });
  const search = h('input', { type: 'search', class: 'input', placeholder: '이름 검색', 'aria-label': '이름 검색' });
  const rows = [];
  const allRow = checkRow({
    checked: sel.size === 0, title: '모든 사람', lead: avatar('', 'everyone', 36, 'users'),
    onToggle: (v) => { if (v) { sel.clear(); for (const r of rows) r.setChecked(false); } else allRow.setChecked(true); update(); },
  });
  list.appendChild(allRow);
  for (const m of members) {
    const el = checkRow({
      checked: sel.has(m.sid), title: m.name + (m.me && m.name !== '나' ? ' (나)' : ''), sub: m.sub || '',
      lead: avatar(m.name, m.sid, 36),
      onToggle: (v) => { if (v) sel.add(m.sid); else sel.delete(m.sid); allRow.setChecked(sel.size === 0); update(); },
    });
    el.dataset.name = (m.name || '').toLowerCase();
    rows.push(el);
    list.appendChild(el);
  }
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    for (const r of rows) r.hidden = q && !r.dataset.name.includes(q);
  });
  const apply = h('button', { type: 'button', class: 'btn btn-primary btn-block' });
  const update = () => { apply.textContent = sel.size ? `${sel.size}명 선택` : '모든 사람'; };
  update();
  apply.addEventListener('click', () => { result = sel.size ? [...sel] : null; layer.close(); });
  const layer = openSheet({ title, content: h('div', { class: 'picker' }, members.length > 8 ? h('div', { class: 'pick-search' }, search) : null, list), footer: apply, cls: 'sheet-tall' });
  return layer.closed.then(() => result);
}

/**
 * Pick a period. value: {from:'YYYY-MM-DD'|null, to:'YYYY-MM-DD'|null}
 * Resolves {from, to} (both may be null = 전체 기간) or undefined when cancelled.
 */
export function pickPeriod(value, { title = '기간', min = null, max = null } = {}) {
  let result;
  const now = Date.now() / 1000;
  const from = h('input', { type: 'date', class: 'input', 'aria-label': '시작 날짜', value: (value && value.from) || '' });
  const to = h('input', { type: 'date', class: 'input', 'aria-label': '끝 날짜', value: (value && value.to) || '' });
  if (min) { from.min = min; to.min = min; }
  if (max) { from.max = max; to.max = max; }
  const preset = (label, days) => h('button', {
    type: 'button', class: 'chip', text: label,
    onclick: () => {
      if (days === null) { from.value = ''; to.value = ''; return; }
      const p = parts(now);
      const start = epochOfLocal(p.y, p.mo, p.d) - days * 86400;
      from.value = ymdOf(start); to.value = ymdOf(now);
    },
  });
  const err = h('p', { class: 'form-error', role: 'alert' });
  const content = h('div', { class: 'period' },
    h('div', { class: 'chip-row wrap' }, preset('전체 기간', null), preset('최근 1주', 7), preset('최근 1개월', 30), preset('최근 3개월', 91), preset('최근 1년', 365)),
    h('div', { class: 'period-fields' },
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: '시작' }), from),
      h('span', { class: 'period-sep', text: '~' }),
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: '끝' }), to)),
    err);
  const apply = h('button', {
    type: 'button', class: 'btn btn-primary btn-block', text: '적용',
    onclick: () => {
      if (from.value && to.value && from.value > to.value) { err.textContent = '시작 날짜가 끝 날짜보다 늦어요.'; return; }
      result = { from: from.value || null, to: to.value || null };
      layer.close();
    },
  });
  const layer = openSheet({ title, content, footer: apply });
  return layer.closed.then(() => result);
}

export { KIND_ICON };
