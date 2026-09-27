// calendar.js — "날짜로 이동" sheet: year chips → month grid → day calendar.
//
// months: [{ym, count}] (desc). loadDays(ym) -> Promise<Map<'YYYY-MM-DD', count>>.
// onPick({ym, ymd|null}) is called when the user chooses a month or a day.

import { h, icon, clear, openSheet, spinner } from './dom.js';
import { WEEKDAYS_SHORT, daysInMonth, firstWeekday, koMonth, num } from './format.js';

export function openJumpSheet({ title = '날짜로 이동', months, currentYm = null, loadDays, onPick, unit = '개' }) {
  const byYm = new Map(months.map((m) => [m.ym, m.count]));
  const years = [...new Set(months.map((m) => m.ym.slice(0, 4)))].sort().reverse();
  let year = (currentYm && currentYm.slice(0, 4)) || years[0];
  const body = h('div', { class: 'jump' });
  const layer = openSheet({ title, content: body, cls: 'sheet-tall' });

  const pick = (ym, ymd = null) => { layer.close(); onPick({ ym, ymd }); };

  function renderYears() {
    clear(body);
    const chips = h('div', { class: 'chip-row jump-years', role: 'tablist', 'aria-label': '연도' });
    for (const y of years) {
      const total = months.filter((m) => m.ym.startsWith(y)).reduce((s, m) => s + m.count, 0);
      chips.appendChild(h('button', {
        type: 'button', role: 'tab', class: 'chip' + (y === year ? ' on' : ''), 'aria-selected': y === year ? 'true' : 'false',
        onclick: () => { year = y; renderYears(); },
      }, `${y}년`, h('span', { class: 'chip-count', text: num(total) })));
    }
    body.appendChild(chips);
    const grid = h('div', { class: 'jump-months' });
    for (let mo = 1; mo <= 12; mo++) {
      const ym = `${year}-${String(mo).padStart(2, '0')}`;
      const c = byYm.get(ym) || 0;
      grid.appendChild(h('button', {
        type: 'button', class: 'jump-month' + (c ? '' : ' off') + (ym === currentYm ? ' current' : ''), disabled: !c,
        'aria-label': c ? `${koMonth(ym)}, ${num(c)}${unit}` : `${koMonth(ym)}, 없음`,
        onclick: () => renderMonth(ym),
      }, h('span', { class: 'jm-name', text: `${mo}월` }), h('span', { class: 'jm-count', text: c ? num(c) : '–' })));
    }
    body.appendChild(grid);
    // Keep the selected year chip visible.
    requestAnimationFrame(() => {
      const on = chips.querySelector('.on');
      if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest', inline: 'center' });
    });
  }

  async function renderMonth(ym) {
    clear(body);
    const idx = months.findIndex((m) => m.ym === ym);
    const newer = idx > 0 ? months[idx - 1].ym : null;
    const older = idx >= 0 && idx < months.length - 1 ? months[idx + 1].ym : null;
    const head = h('div', { class: 'cal-head' },
      h('button', { type: 'button', class: 'iconbtn', 'aria-label': '이전 달', disabled: !older, onclick: () => older && renderMonth(older) }, icon('back', 20)),
      h('button', { type: 'button', class: 'cal-title', onclick: () => { year = ym.slice(0, 4); renderYears(); } }, koMonth(ym), icon('chevronDown', 16)),
      h('button', { type: 'button', class: 'iconbtn', 'aria-label': '다음 달', disabled: !newer, onclick: () => newer && renderMonth(newer) }, icon('forward', 20)));
    body.appendChild(head);
    const wd = h('div', { class: 'cal-grid cal-wd', 'aria-hidden': 'true' });
    WEEKDAYS_SHORT.forEach((d, i) => wd.appendChild(h('span', { class: i === 0 ? 'sun' : i === 6 ? 'sat' : '', text: d })));
    body.appendChild(wd);
    const holder = h('div', { class: 'cal-holder' }, spinner('날짜 확인 중…'));
    body.appendChild(holder);
    body.appendChild(h('button', { type: 'button', class: 'btn btn-primary btn-block', onclick: () => pick(ym) }, `${koMonth(ym)} 전체 보기`));
    let days;
    try {
      days = await loadDays(ym);
    } catch (e) {
      clear(holder).appendChild(h('p', { class: 'form-error', text: '날짜 정보를 불러오지 못했어요.' }));
      return;
    }
    if (!body.contains(holder)) return;
    const grid = h('div', { class: 'cal-grid', role: 'grid', 'aria-label': koMonth(ym) });
    const lead = firstWeekday(ym);
    for (let i = 0; i < lead; i++) grid.appendChild(h('span', { class: 'cal-pad' }));
    const n = daysInMonth(ym);
    for (let d = 1; d <= n; d++) {
      const ymd = `${ym}-${String(d).padStart(2, '0')}`;
      const c = days.get(ymd) || 0;
      const wdIdx = (lead + d - 1) % 7;
      grid.appendChild(h('button', {
        type: 'button', class: 'cal-day' + (c ? ' has' : '') + (wdIdx === 0 ? ' sun' : wdIdx === 6 ? ' sat' : ''), disabled: !c,
        'aria-label': c ? `${d}일, ${num(c)}${unit}` : `${d}일`,
        onclick: () => pick(ym, ymd),
      }, h('span', { class: 'cal-num', text: String(d) }), c ? h('span', { class: 'cal-dot', text: c > 99 ? '99+' : String(c) }) : null));
    }
    clear(holder).appendChild(grid);
  }

  if (currentYm && byYm.has(currentYm)) renderMonth(currentYm);
  else renderYears();
  return layer;
}
