// router.js — hash router ('#/path?query'), works under any sub-path.
//
// parseHash/buildHash/matchRoute are pure (unit-tested with JavaScriptCore). The Router
// class keeps a navigation depth in history.state so in-app "back" buttons know whether
// there is an in-app page to go back to (otherwise they navigate to a parent route).

function dec(s) {
  try { return decodeURIComponent(String(s).replace(/\+/g, ' ')); } catch (e) { return String(s); }
}

/** '#/room/c1/chat?ym=2026-09&k=b%3A1' -> {path:'/room/c1/chat', segs:['room','c1','chat'], query:{ym,k}} */
export function parseHash(hash) {
  let h = String(hash || '');
  if (h.startsWith('#')) h = h.slice(1);
  if (!h.startsWith('/')) h = '/' + h;
  const qi = h.indexOf('?');
  const rawPath = qi >= 0 ? h.slice(0, qi) : h;
  const rawQuery = qi >= 0 ? h.slice(qi + 1) : '';
  const segs = rawPath.split('/').filter(Boolean).map(dec);
  const query = {};
  if (rawQuery) {
    for (const pair of rawQuery.split('&')) {
      if (!pair) continue;
      const ei = pair.indexOf('=');
      const k = dec(ei >= 0 ? pair.slice(0, ei) : pair);
      const v = ei >= 0 ? dec(pair.slice(ei + 1)) : '';
      if (k) query[k] = v;
    }
  }
  return { path: '/' + segs.map(encodeURIComponent).join('/'), segs, query };
}

/** Build '#/path?query' (null/undefined/'' query values are dropped; keys sorted for stable URLs). */
export function buildHash(path, query = {}) {
  let p = String(path || '/');
  if (!p.startsWith('/')) p = '/' + p;
  const keys = Object.keys(query || {}).filter((k) => query[k] !== null && query[k] !== undefined && query[k] !== '');
  keys.sort();
  const qs = keys.map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(query[k]))}`).join('&');
  return '#' + p + (qs ? '?' + qs : '');
}

/** Path from segments (each segment URI-encoded). */
export function pathOf(...segs) {
  return '/' + segs.filter((s) => s !== null && s !== undefined && s !== '').map((s) => encodeURIComponent(String(s))).join('/');
}

export const ROOM_TABS = ['media', 'files', 'links', 'audio', 'chat'];

/** 전체 (all rooms) list screens: route segment → collect() kind. */
export const COLLECT_ROUTES = { files: 'file', links: 'link', audio: 'audio' };

/**
 * Route table. Returns {name, key, top, params} or null.
 * key identifies a keep-alive screen instance; top is the highlighted bottom tab.
 */
export function matchRoute(segs) {
  const s = segs || [];
  if (s.length === 0) return { name: 'home', key: 'home', top: 'home', params: {} };
  switch (s[0]) {
    case 'rooms':
      return s.length === 1 ? { name: 'rooms', key: 'rooms', top: 'rooms', params: {} } : null;
    case 'room': {
      if (s.length < 2 || s.length > 3) return null;
      const tab = s[2] || 'media';
      if (!ROOM_TABS.includes(tab)) return null;
      return { name: 'room', key: 'room:' + s[1], top: 'rooms', params: { id: s[1], tab } };
    }
    case 'search':
      return s.length === 1 ? { name: 'search', key: 'search', top: 'search', params: {} } : null;
    case 'starred':
      return s.length === 1 ? { name: 'starred', key: 'starred', top: 'starred', params: {} } : null;
    case 'more':
      return s.length === 1 ? { name: 'more', key: 'more', top: 'more', params: {} } : null;
    case 'files':
    case 'links':
    case 'audio':
      return s.length === 1 ? { name: 'collect', key: 'collect:' + s[0], top: 'rooms', params: { kind: COLLECT_ROUTES[s[0]] } } : null;
    case 'setup':
      return s.length === 1 ? { name: 'setup', key: 'setup', top: null, params: {} } : null;
    default:
      return null;
  }
}

/** Viewer overlay parameter: '<room>|<ym>|<mediaId>' (optionally '|<msgKey>'). */
export function encodeViewParam(row) {
  const parts = [row.room, row.ym, row.id];
  if (row.k) parts.push(row.k);
  return parts.join('|');
}

export function decodeViewParam(v) {
  const p = String(v || '').split('|');
  if (p.length < 3 || !p[0] || !/^\d{4}-\d{2}$/.test(p[1]) || !p[2]) return null;
  return { room: p[0], ym: p[1], id: p[2], k: p.length > 3 ? p.slice(3).join('|') : null };
}

/** Browser router. `onChange(route)` is called with {path, segs, query, hash}. */
export class Router {
  constructor(onChange) {
    this.onChange = onChange;
    this.current = null;
    this._last = null;
    this._onPop = () => this._emit();
  }

  start() {
    const st = history.state;
    if (!st || !st.kb) history.replaceState({ kb: 1, depth: 0 }, '', location.href);
    window.addEventListener('popstate', this._onPop);
    window.addEventListener('hashchange', this._onPop);
    document.addEventListener('click', (ev) => this._interceptClick(ev));
    this._emit();
  }

  get depth() { return (history.state && history.state.depth) || 0; }

  /** Navigate to path+query. opts.replace replaces the current history entry. */
  go(path, query = {}, opts = {}) {
    const hash = buildHash(path, query);
    this.goHash(hash, opts);
  }

  goHash(hash, opts = {}) {
    if (hash === location.hash && !opts.force) return;
    const url = location.pathname + location.search + hash;
    if (opts.replace) history.replaceState({ kb: 1, depth: this.depth }, '', url);
    else history.pushState({ kb: 1, depth: this.depth + 1 }, '', url);
    this._emit();
  }

  /** Merge `patch` into the current query (null removes a key). */
  setQuery(patch, opts = {}) {
    const cur = parseHash(location.hash);
    const q = Object.assign({}, cur.query);
    for (const k of Object.keys(patch)) {
      if (patch[k] === null || patch[k] === undefined) delete q[k];
      else q[k] = patch[k];
    }
    this.go(cur.path, q, opts);
  }

  /** In-app back: history.back() when there is an in-app entry, else go to `fallback`. */
  back(fallback = '/') {
    if (this.depth > 0) history.back();
    else this.go(fallback, {}, { replace: true });
  }

  _interceptClick(ev) {
    if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    const a = ev.target && ev.target.closest ? ev.target.closest('a[href^="#/"]') : null;
    if (!a || a.target === '_blank') return;
    ev.preventDefault();
    this.goHash(a.getAttribute('href'), { replace: a.hasAttribute('data-replace') });
  }

  _emit() {
    const hash = location.hash || '#/';
    if (!history.state || !history.state.kb) {
      // Plain hash navigation (typed URL / external link): count it as one level deeper.
      const prevDepth = this._last ? this._last.depth : 0;
      history.replaceState({ kb: 1, depth: prevDepth + 1 }, '', location.href);
    }
    if (this._last && this._last.hash === hash) return;
    const r = parseHash(hash);
    this.current = Object.assign(r, { hash });
    this._last = { hash, depth: this.depth };
    this.onChange(this.current);
  }
}
