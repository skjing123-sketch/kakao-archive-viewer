// search.js — 검색 (#/search?q=&room=): keyword + 채팅방/보낸 사람/기간/유형 filters,
// progressive results (archive.search async generator), "N/M개월 검색 중" + 취소.

import { h, icon, clear, emptyState, prefs, avatar } from './dom.js';
import { highlight, snippet, dotDate, koTime, ymOf, ymdOf, num, koDateFromYmd } from './format.js';
import { SEARCH_KINDS, normSearchHit, messagePreview, isOrphan } from './model.js';
import { pathOf } from './router.js';
import { pickRooms, pickSenders, pickPeriod } from './pickers.js';
import { roomChipLabel } from './home.js';
import { chipGroup } from './widgets.js';

const BATCH = 60;

/** 'YYYY-MM-DD' -> '9.27' (this year) or '25.9.27'. */
function shortYmd(ymd, fallback) {
  if (!ymd) return fallback;
  const [y, m, d] = ymd.split('-').map(Number);
  return y === new Date().getFullYear() ? `${m}.${d}` : `${String(y).slice(2)}.${m}.${d}`;
}

function marked(text, q) {
  const span = h('span', { class: 'r-text' });
  for (const seg of highlight(text, q)) {
    span.appendChild(seg.hit ? h('mark', { text: seg.t }) : document.createTextNode(seg.t));
  }
  return span;
}

export function createSearch(ctx) {
  const st = {
    q: '', roomIds: null, senders: null, period: { from: null, to: null }, type: 'all',
    running: false, ac: null, gen: 0, count: 0, limit: BATCH, resume: null,
    progress: { done: 0, total: 0, reported: false },
  };
  const el = h('div', { class: 'screen screen-search' });
  const input = h('input', { type: 'search', class: 'input input-search', placeholder: '키워드, 파일 이름, 링크 검색', 'aria-label': '검색어', enterkeyhint: 'search', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
  const form = h('form', { class: 'search-form', role: 'search' },
    h('div', { class: 'search-wrap' }, icon('search', 18, 'search-ic'), input),
    h('button', { type: 'submit', class: 'btn btn-primary', text: '검색' }));
  form.addEventListener('submit', (ev) => { ev.preventDefault(); input.blur(); submit(); });

  const roomChip = h('button', { type: 'button', class: 'chip chip-drop', onclick: () => chooseRooms() }, icon('chats', 16), h('span', { class: 'chip-label' }), icon('chevronDown', 14));
  const senderChip = h('button', { type: 'button', class: 'chip chip-drop', onclick: () => chooseSenders() }, icon('user', 16), h('span', { class: 'chip-label' }), icon('chevronDown', 14));
  const periodChip = h('button', { type: 'button', class: 'chip chip-drop', onclick: () => choosePeriod() }, icon('calendar', 16), h('span', { class: 'chip-label' }), icon('chevronDown', 14));
  const typeChips = chipGroup(Object.entries(SEARCH_KINDS).map(([k, v]) => [k, v.label]), st.type, (v) => { st.type = v; if (st.q || hasFilters()) submit(); }, '유형');
  const status = h('div', { class: 'search-status', role: 'status', 'aria-live': 'polite' });
  const results = h('div', { class: 'results', role: 'list' });
  const moreBtn = h('button', { type: 'button', class: 'btn btn-block btn-ghost', hidden: true, text: '결과 더 보기', onclick: () => { if (st.resume) { st.limit += BATCH * 2; const r = st.resume; st.resume = null; moreBtn.hidden = true; r(); } } });
  const recent = h('div', { class: 'recent' });
  el.append(
    h('header', { class: 'appbar' }, h('h1', { class: 'appbar-title', text: '검색' })),
    h('div', { class: 'toolbar search-toolbar' }, form,
      h('div', { class: 'chip-row' }, roomChip, senderChip, periodChip),
      h('div', { class: 'chip-row' }, typeChips)),
    status, recent, results, moreBtn);

  function hasFilters() { return !!(st.roomIds || st.senders || st.period.from || st.period.to || st.type !== 'all'); }

  function updateChips() {
    roomChip.querySelector('.chip-label').textContent = roomChipLabel(ctx, st.roomIds);
    roomChip.classList.toggle('on', !!st.roomIds);
    const names = allMembers().filter((m) => st.senders && st.senders.includes(m.sid)).map((m) => m.name);
    senderChip.querySelector('.chip-label').textContent = !st.senders ? '보낸 사람' : names.length > 1 ? `${names[0]} 외 ${names.length - 1}` : (names[0] || '보낸 사람');
    senderChip.classList.toggle('on', !!st.senders);
    const { from, to } = st.period;
    periodChip.querySelector('.chip-label').textContent = !from && !to ? '기간' : `${shortYmd(from, '처음')}~${shortYmd(to, '지금')}`;
    periodChip.classList.toggle('on', !!(from || to));
  }

  function allMembers() {
    const rooms = st.roomIds ? st.roomIds.map((id) => ctx.archive.room(id)).filter(Boolean) : ctx.archive.rooms();
    const map = new Map();
    const mine = new Set(rooms.map((r) => r.me).filter(Boolean));
    const owner = ctx.archive.owner();
    if (owner && owner.sid) mine.add(owner.sid);
    for (const r of rooms) {
      for (const m of r.members || []) {
        if (!m || !m.sid) continue;
        const cur = map.get(m.sid);
        if (cur) cur.rooms++;
        else map.set(m.sid, { sid: m.sid, name: m.name || '알 수 없음', me: mine.has(m.sid), rooms: 1 });
      }
    }
    const out = [...map.values()];
    out.sort((a, b) => (b.me - a.me) || (b.rooms - a.rooms) || a.name.localeCompare(b.name, 'ko'));
    for (const m of out) m.sub = m.rooms > 1 ? `${m.rooms}개 채팅방` : '';
    return out;
  }

  async function chooseRooms() {
    const res = await pickRooms(ctx, st.roomIds, { title: '검색할 채팅방' });
    if (res === undefined) return;
    st.roomIds = res;
    if (st.senders) {
      const valid = new Set(allMembers().map((m) => m.sid));
      st.senders = st.senders.filter((s) => valid.has(s));
      if (!st.senders.length) st.senders = null;
    }
    updateChips();
    if (st.q || hasFilters()) submit();
  }

  async function chooseSenders() {
    const res = await pickSenders(ctx, allMembers(), st.senders, { title: '보낸 사람으로 찾기' });
    if (res === undefined) return;
    st.senders = res;
    updateChips();
    if (st.q || hasFilters()) submit();
  }

  async function choosePeriod() {
    const res = await pickPeriod(st.period, { title: '기간' });
    if (res === undefined) return;
    st.period = res;
    updateChips();
    if (st.q || hasFilters()) submit();
  }

  function renderRecent() {
    clear(recent);
    const list = prefs.get('search.recent', []);
    if (st.running || st.count || !list.length) { recent.hidden = true; return; }
    recent.hidden = false;
    recent.append(
      h('div', { class: 'recent-head' }, h('h2', { class: 'section-title', text: '최근 검색' }),
        h('button', { type: 'button', class: 'link-btn', text: '지우기', onclick: () => { prefs.set('search.recent', []); renderRecent(); } })),
      h('div', { class: 'chip-row wrap' }, list.map((q) => h('button', { type: 'button', class: 'chip', onclick: () => { input.value = q; submit(); } }, icon('clock', 14), q))));
  }

  function remember(q) {
    if (!q) return;
    const list = prefs.get('search.recent', []).filter((x) => x !== q);
    list.unshift(q);
    prefs.set('search.recent', list.slice(0, 8));
  }

  /** Months (room×month) the search will scan, for "N/M개월". */
  function plannedJobs() {
    const rooms = st.roomIds ? st.roomIds.map((id) => ctx.archive.room(id)).filter(Boolean) : ctx.archive.rooms();
    const fromYm = st.period.from ? st.period.from.slice(0, 7) : null;
    const toYm = st.period.to ? st.period.to.slice(0, 7) : null;
    const jobs = new Set();
    for (const r of rooms) for (const m of r.months || []) {
      if (fromYm && m.ym < fromYm) continue;
      if (toYm && m.ym > toYm) continue;
      jobs.add(m.ym);
    }
    return [...jobs];
  }

  function setStatus() {
    clear(status);
    if (st.running && st.resume) {
      const p = st.progress;
      status.append(h('span', { class: 'ss-text', text: `결과 ${num(st.count)}건 표시 중` }),
        p.total ? h('span', { class: 'ss-count', text: `${num(Math.min(p.done, p.total))}/${num(p.total)}개월` }) : null,
        h('button', { type: 'button', class: 'link-btn', text: '그만 찾기', onclick: () => cancel(true) }));
      status.hidden = false;
    } else if (st.running) {
      const p = st.progress;
      const txt = p.total ? `${num(Math.min(p.done, p.total))}/${num(p.total)}개월 검색 중…` : '검색 중…';
      status.append(h('span', { class: 'spin', 'aria-hidden': 'true' }), h('span', { class: 'ss-text', text: txt }),
        st.count ? h('span', { class: 'ss-count', text: `${num(st.count)}건` }) : null,
        h('button', { type: 'button', class: 'link-btn', text: '취소', onclick: () => cancel(true) }));
      status.hidden = false;
    } else if (st.done) {
      status.append(h('span', { class: 'ss-text', text: st.cancelled ? `검색을 멈췄어요 · ${num(st.count)}건` : `결과 ${num(st.count)}건${st.resume ? '+' : ''}` }));
      if (st.progress.failed) status.append(h('span', { class: 'ss-warn', text: `${num(st.progress.failed)}개 대화 파일을 읽지 못했어요` }));
      status.hidden = false;
    } else {
      status.hidden = true;
    }
  }

  function cancel(user = false) {
    if (st.ac) st.ac.abort();
    st.ac = null;
    if (st.running) { st.running = false; st.done = true; st.cancelled = user; }
    if (st.resume) { st.resume = null; moreBtn.hidden = true; }
    st.gen++;
    setStatus();
  }

  function submit() {
    st.q = input.value.trim();
    const cur = ctx.router.current;
    if (cur && (cur.query.q || '') !== st.q && ctx.router.current.path === '/search') {
      ctx.router.setQuery({ q: st.q || null }, { replace: true });
    }
    run();
  }

  async function run() {
    cancel();
    clear(results);
    moreBtn.hidden = true;
    st.count = 0;
    st.limit = BATCH;
    st.done = false;
    st.cancelled = false;
    if (!st.q && !hasFilters()) { setStatus(); renderRecent(); results.appendChild(hint()); return; }
    remember(st.q);
    const gen = st.gen;
    const ac = new AbortController();
    st.ac = ac;
    st.running = true;
    const jobs = plannedJobs();
    st.progress = { done: 0, total: jobs.length, reported: false };
    recent.hidden = true;
    setStatus();
    const opts = {
      roomIds: st.roomIds, senders: st.senders,
      // 'YYYY-MM-DD' bounds are inclusive and interpreted in the archive time zone.
      from: st.period.from || null,
      to: st.period.to || null,
      kinds: SEARCH_KINDS[st.type].kinds, signal: ac.signal,
      // onProgress({done, total, ym, failed}) is PWA-DATA's extension of SPEC §9.1; without it
      // the UI estimates progress from the month of the latest hit.
      onProgress: (p) => {
        if (gen !== st.gen || !p) return;
        st.progress.reported = true;
        if (typeof p.total === 'number') st.progress.total = p.total;
        st.progress.done = p.done ?? st.progress.done;
        st.progress.failed = p.failed || 0;
        setStatus();
      },
    };
    let it;
    try {
      it = ctx.archive.search(st.q, opts);
    } catch (err) {
      finish(gen, err);
      return;
    }
    let pending = [];
    let flushQueued = false;
    const flush = () => {
      flushQueued = false;
      if (gen !== st.gen) return;
      const frag = document.createDocumentFragment();
      for (const hit of pending) frag.appendChild(resultItem(hit));
      pending = [];
      results.appendChild(frag);
      setStatus();
    };
    try {
      for (;;) {
        const { value, done } = await it.next();
        if (gen !== st.gen) { if (it.return) it.return(); return; }
        if (done) break;
        const hit = normSearchHit(value);
        if (!hit.message || isOrphan(hit.message)) continue;     // gallery-only media, no message to show
        st.count++;
        if (!st.progress.reported && hit.ym) {
          // Estimate: months newer than this hit's month are done.
          st.progress.done = jobs.filter((ym) => ym > hit.ym).length;
        }
        pending.push(hit);
        if (!flushQueued) { flushQueued = true; requestAnimationFrame(flush); }
        if (st.count >= st.limit) {
          flush();
          moreBtn.hidden = false;
          await new Promise((resolve) => { st.resume = resolve; setStatus(); });
          if (gen !== st.gen) { if (it.return) it.return(); return; }
        }
      }
      flush();
      finish(gen, null);
    } catch (err) {
      flush();
      finish(gen, err);
    }
  }

  function finish(gen, err) {
    if (gen !== st.gen) return;
    st.running = false;
    st.done = true;
    st.ac = null;
    if (err && err.name !== 'AbortError') {
      results.appendChild(emptyState({ iconName: 'alert', title: '검색 중 문제가 생겼어요', text: err.message || String(err) }));
      ctx.handleError(err, { quiet: true });
    } else if (!st.count) {
      results.appendChild(emptyState({ iconName: 'search', title: '검색 결과가 없어요', text: st.q ? `'${st.q}'에 맞는 메시지를 찾지 못했어요. 필터를 바꿔 보세요.` : '조건에 맞는 메시지가 없어요.' }));
    }
    setStatus();
  }

  function resultItem({ room, ym, message: m }) {
    const r = ctx.archive.room(room);
    const roomName = r ? (r.displayName || r.name) : room;
    const text = m.x || messagePreview(m);
    const body = h('span', { class: 'r-body' });
    if (m.y === 'photo' || m.y === 'video') {
      const th = h('span', { class: 'r-thumb' + (m.y === 'video' ? ' video' : '') }, icon(m.y === 'video' ? 'video' : 'photo', 18));
      body.appendChild(th);
      loadThumb(room, ym || ymOf(m.t), m.k, th);
    } else if (m.y === 'file') body.appendChild(h('span', { class: 'r-kind' }, icon('file', 16)));
    else if (m.y === 'link' || (m.l && m.l.length)) body.appendChild(h('span', { class: 'r-kind' }, icon('link', 16)));
    body.appendChild(h('span', { class: 'r-lines' },
      h('span', { class: 'r-sender', text: m.n || '시스템' }),
      marked(snippet(text, st.q, 42) || messagePreview(m), st.q)));
    return h('a', { class: 'result', role: 'listitem', href: '#' + pathOf('room', room, 'chat') + `?k=${encodeURIComponent(m.k)}&ym=${encodeURIComponent(ym || ymOf(m.t))}` },
      h('span', { class: 'r-head' }, avatar(roomName, room, 22), h('span', { class: 'r-room', text: roomName }), h('span', { class: 'r-date', text: `${dotDate(m.t)} ${koTime(m.t)}` })),
      body);
  }

  async function loadThumb(room, ym, k, holder) {
    try {
      const ch = await ctx.archive.chunk(room, ym);
      const row = ((ch && ch.media) || []).find((x) => x.k === k && x.th);
      if (!row) return;
      const url = await ctx.archive.thumbURL(Object.assign({}, row, { room, ym }));
      if (!url) return;
      clear(holder).appendChild(h('img', { src: url, alt: '', loading: 'lazy', decoding: 'async' }));
    } catch (e) { /* keep the icon */ }
  }

  function hint() {
    const firsts = ctx.archive.rooms().map((r) => r.first_ts).filter((t) => t);
    const first = firsts.length ? Math.min(...firsts) : null;
    return emptyState({
      iconName: 'search', title: '대화 내용을 검색해 보세요',
      text: `메시지, 파일 이름, 링크 주소에서 찾아요. 보낸 사람·기간·유형으로 좁힐 수 있어요.${first ? ` (${koDateFromYmd(ymdOf(first))}부터 보관됨)` : ''}`,
    });
  }

  updateChips();
  renderRecent();
  results.appendChild(hint());

  return {
    el, title: '검색',
    show(route) {
      const q = (route && route.query) || {};
      let changed = false;
      if (q.room !== undefined) {
        const ids = String(q.room).split(',').filter((id) => ctx.archive.room(id));
        const next = ids.length ? ids : null;
        if (JSON.stringify(next) !== JSON.stringify(st.roomIds)) { st.roomIds = next; changed = true; updateChips(); }
      }
      if (q.q !== undefined && q.q !== st.q) { input.value = q.q; changed = true; }
      // Coming from a room (?room=) only presets the filter; searching starts with a keyword.
      if (changed && input.value.trim()) { st.q = input.value.trim(); run(); }
      else if (changed) { cancel(); clear(results); st.count = 0; st.done = false; setStatus(); renderRecent(); results.appendChild(hint()); }
      if (!input.value) requestAnimationFrame(() => { if (window.matchMedia('(pointer: fine)').matches) input.focus({ preventScroll: true }); });
    },
    hide() {},
    refresh() { updateChips(); },
    destroy() { cancel(); },
  };
}
