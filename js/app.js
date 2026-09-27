// app.js — bootstrap of the 카톡 보관함 PWA: data source, hash router, screens, tab bar.
//
// Data access goes exclusively through the data layer of SPEC §9.1 (js/data/settings.js,
// source.js, archive.js — owned by agent PWA-DATA). Those modules are imported
// dynamically so a missing/broken module shows a helpful screen instead of a blank page.

import { h, icon, clear, toast, prefs } from './ui/dom.js';
import { setTimeZone } from './ui/format.js';
import { Router, matchRoute, encodeViewParam } from './ui/router.js';
import { MediaViewer } from './ui/viewer.js';
import { createHome } from './ui/home.js';
import { createRooms } from './ui/rooms.js';
import { createRoom } from './ui/room.js';
import { createSearch } from './ui/search.js';
import { createStarred } from './ui/starred.js';
import { createMore } from './ui/more.js';
import { createSetup, isDevHost } from './ui/setup.js';
import { createCollection } from './ui/lists.js';

const MAX_ROOM_SCREENS = 3;
const TOP_TABS = [
  ['home', '#/', 'photo', '사진'],
  ['rooms', '#/rooms', 'chats', '채팅방'],
  ['search', '#/search', 'search', '검색'],
  ['starred', '#/starred', 'star', '중요'],
  ['more', '#/more', 'more', '더보기'],
];
const DEV_FAKE_KEY = 'kb.dev.fake';

// ---------------------------------------------------------------------------
// Context shared by all screens
// ---------------------------------------------------------------------------

const listeners = new Map();
let data = null;                 // {settings, source, archive} modules
let viewer = null;
let viewerPushed = false;
let pendingProvider = null;
let fallbackProvider = null;
let authNoticeShown = false;
let authProblem = null;          // AuthError that switched the app to read-only (saved data only)
let staleCheckAt = 0;

/**
 * Codes of AuthErrors that mean the whole Google connection is unusable (revoked/expired
 * refresh token, wrong client, token without the Drive scope). Other AuthErrors concern
 * one file (e.g. insufficientFilePermissions) and only fail that item.
 */
const SESSION_AUTH_CODES = new Set(['invalid_grant', 'invalid_client', 'unauthorized_client', 'unauthorized', 'auth_failed',
  'no_setup', 'insufficientScopes', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT', 'authError']);

/**
 * An archive file that is gone (typically a hashed month chunk) means the catalog in memory
 * may be stale: the Mac republished (superseded files are deleted) or another archive now
 * sits behind the same address (SPEC §13.2 L7). Re-read catalog.json then (at most once a
 * minute; a broken archive cannot make this loop).
 */
function isStaleFileError(err) {
  return !!err && (err.name === 'NotFoundError' || err.code === 'not_found');
}

const ctx = {
  archive: null,
  source: null,
  settings: null,
  router: null,

  on(evt, fn) { if (!listeners.has(evt)) listeners.set(evt, new Set()); listeners.get(evt).add(fn); },
  off(evt, fn) { const s = listeners.get(evt); if (s) s.delete(fn); },
  emit(evt, ...args) {
    const s = listeners.get(evt);
    if (!s) return;
    for (const fn of [...s]) { try { fn(...args); } catch (err) { console.error('[app] listener failed', evt, err); } }
  },

  sourceKind() {
    if (ctx.archive && ctx.archive.isFake) return 'fake';
    return (ctx.settings && ctx.settings.mode) || (ctx.source && ctx.source.kind) || null;
  },
  originalsPolicy() {
    const c = ctx.archive && ctx.archive.catalog;
    return (c && c.target && c.target.originals) || 'all';
  },

  /** Open the media viewer on `row`; `provider` supplies the swipe list. */
  openViewer(row, provider) {
    pendingProvider = provider || null;
    viewerPushed = true;
    ctx.router.setQuery({ view: encodeViewParam(row) });
  },
  setViewerProviderFallback(p) { fallbackProvider = p; },
  viewerPushed() { return viewerPushed; },

  async toggleStar(key, meta) {
    const was = ctx.archive.isStarred(key);
    try {
      await ctx.archive.toggleStar(key, meta);
      toast(was ? '중요 표시를 해제했어요' : '중요 표시했어요', { duration: 1600 });
    } catch (err) {
      toast('중요 표시를 저장하지 못했어요. ' + ((err && err.message) || ''), { kind: 'error' });
      console.warn('[app] toggleStar failed', err);
    }
    ctx.emit('star', key);
  },

  handleError(err, { quiet = false } = {}) {
    console.warn('[app]', err);
    const ak = authKind(err);
    if (ak === 'session' || ak === 'server') {
      // The connection (Google token / Mac server key) is gone: keep every screen and the
      // saved data readable, and offer a new setup code / the right address in a banner.
      setAuthProblem(err);
      return;
    }
    if (isStaleFileError(err) && ctx.archive && Date.now() - staleCheckAt > 60000) {
      staleCheckAt = Date.now();
      ctx.reloadCatalog().catch(() => {});
    }
    if (!quiet) toast((err && (err.userMessage || err.message)) || '문제가 생겼어요.', { kind: 'error' });
  },

  async readJSON(rel) {
    if (ctx.archive && ctx.archive.isFake) return fakeReport();
    if (ctx.archive && typeof ctx.archive.report === 'function') return ctx.archive.report(rel);
    if (!ctx.source || !ctx.source.getJSON) throw new Error('데이터 소스가 없습니다');
    const ids = (ctx.archive.catalog && ctx.archive.catalog.ids) || {};
    return ctx.source.getJSON(rel, { fid: ids[rel], mutable: false });
  },

  /**
   * URL for <img>/<video>/<audio> of a media row. Drive media is streamed through the
   * service worker (./sw-media/…); when no service worker controls the page (first visit,
   * private mode) fall back to an object URL downloaded by the data layer.
   */
  // Returns a string/null synchronously whenever possible (iOS only lets media start playing
  // inside the tap handler) and a Promise only for the Drive blob fallback.
  mediaSrc(row, { preferPreview = false } = {}) {
    if (!row || !ctx.archive) return null;
    if (ctx.needsBlobMedia()) {
      return ctx.archive.mediaObjectURL(row, { preferPreview }).catch((err) => { ctx.handleError(err, { quiet: true }); return null; });
    }
    return ctx.archive.mediaURL(row, { preferPreview });
  },

  /** Drive media without a controlling service worker: only in-memory blob URLs work. */
  needsBlobMedia() {
    return !!ctx.archive && ctx.sourceKind() === 'drive' && !(navigator.serviceWorker && navigator.serviceWorker.controller)
      && typeof ctx.archive.mediaObjectURL === 'function';
  },

  /** The AuthError that made the app read-only (saved data only), or null. */
  authProblem() { return authProblem; },

  /** Reload catalog.json. @returns {Promise<'archive'|'updated'|'same'|undefined>} what changed */
  async reloadCatalog() {
    if (!ctx.archive) return undefined;
    const before = ctx.archive.catalog && ctx.archive.catalog.generated_at;
    await ctx.archive.load({ force: true });
    syncAuthState();
    return applyCatalogChange(before);
  },

  async clearCache() {
    if (ctx.archive && ctx.archive.isFake) return;
    const m = await import('./data/cache.js');
    if (m && m.clearAll) await m.clearAll();
    if (ctx.archive && typeof ctx.archive.clearMemory === 'function') {
      ctx.archive.clearMemory();            // revokes thumbnail URLs → rebuild hidden screens lazily
      dropHiddenScreens();
    }
  },

  async resetSettings() {
    try { localStorage.removeItem(DEV_FAKE_KEY); } catch (e) { /* ignore */ }
    try {
      if (ctx.archive && typeof ctx.archive.flushUserState === 'function') await ctx.archive.flushUserState().catch(() => {});
      if (data && data.settings) {
        if (typeof data.settings.resetSettings === 'function') await data.settings.resetSettings({ clearCaches: true });
        else {
          try { await ctx.clearCache(); } catch (err) { console.warn('[app] cache clear failed', err); }
          await data.settings.saveSettings({ mode: null, setup: null, httpBase: null });
        }
      }
    } catch (err) {
      toast('설정을 지우지 못했어요.', { kind: 'error' });
      console.error(err);
      return;
    }
    location.replace(location.pathname + location.search + '#/setup');
    location.reload();
  },

  parseSetupCode(code) {
    if (!data || !data.settings) throw new Error('앱 구성 요소를 불러오지 못했어요. 새로고침해 주세요.');
    return data.settings.parseSetupCode(code);
  },
  async detectLocalConfig() {
    if (!data || !data.settings || !data.settings.detectLocalConfig) return null;
    return data.settings.detectLocalConfig();
  },

  /** Try a data source (from the setup screen); saves settings only when the catalog loads. */
  async connect(patch) {
    if (!data || !data.source || !data.archive) throw new Error('앱 구성 요소를 불러오지 못했어요. 새로고침해 주세요.');
    const settings = Object.assign({ mode: null, setup: null, httpBase: null }, patch);
    let source, archive;
    try {
      source = await data.source.createSource(settings);
      archive = new data.archive.Archive(source);
      await archive.load();
    } catch (err) {
      throw friendlyError(err, settings);
    }
    await data.settings.saveSettings(settings);
    try { localStorage.removeItem(DEV_FAKE_KEY); } catch (e) { /* ignore */ }
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    adopt(archive, source, settings);
  },

  async connectFake() {
    const m = await import('./data/fake.js');
    const archive = await m.createFakeArchive();
    try { localStorage.setItem(DEV_FAKE_KEY, '1'); } catch (e) { /* ignore */ }
    adopt(archive, archive.source, { mode: 'demo', setup: null, httpBase: null });
  },

  applyTheme,
};

function isAuthError(err) {
  return !!err && (err.name === 'AuthError' || err.code === 'invalid_grant' || /invalid_grant/.test(String(err.message || '')));
}

/**
 * What an AuthError means for the app: 'server' — a Mac/NAS server refused (missing or
 * rotated LAN key; never a Google matter), 'session' — the Google connection itself is
 * unusable, 'item' — one file refused (only that action fails), null — not an AuthError.
 */
function authKind(err, mode = ctx.sourceKind()) {
  if (!isAuthError(err)) return null;
  if (err.code === 'server_denied' || mode === 'http' || mode === 'demo') return 'server';
  if (SESSION_AUTH_CODES.has(err.code) || /invalid_grant/.test(String(err.message || ''))) return 'session';
  return 'item';
}

function authMessage(err) {
  return authKind(err) === 'server'
    ? '보관함 서버가 접근을 거부했어요. Mac 프로그램이 알려 준 주소(접속 키 포함)로 다시 열어 주세요.'
    : 'Google 연결이 만료되었거나 취소되었어요. Mac 프로그램에서 새 설정 코드를 받아 다시 붙여넣어 주세요.';
}

/** Read-only mode: persistent banner with the fix, one toast; screens stay usable. */
function setAuthProblem(err) {
  if (!ctx.archive) {
    if (authKind(err) === 'session' && !authNoticeShown) { authNoticeShown = true; showSetup(authMessage(err)); }
    return;
  }
  authProblem = err;
  if (ctx.archive && !ctx.archive.isFake) {
    ctx.archive.authExpired = true;
    ctx.archive.authError = err;
  }
  updateAuthBanner();
  if (!authNoticeShown) {
    authNoticeShown = true;
    toast(authMessage(err), { kind: 'error', duration: 8000 });
  }
}

/** Mirror the data layer's read-only state (saved catalog shown after an AuthError). */
function syncAuthState() {
  const a = ctx.archive;
  if (a && a.authExpired && a.authError) setAuthProblem(a.authError);
  else if (a && !a.authExpired && authProblem) { authProblem = null; authNoticeShown = false; updateAuthBanner(); }
}

function updateAuthBanner() {
  document.body.classList.toggle('has-auth-banner', !!authProblem);
  if (!authProblem) { authBanner.hidden = true; return; }
  const server = authKind(authProblem) === 'server';
  authBannerText.textContent = server
    ? '보관함 서버 접속이 거부됐어요 — 저장된 데이터만 볼 수 있어요'
    : 'Google 연결 만료 — 저장된 데이터만 볼 수 있어요';
  authBannerBtn.textContent = server ? '다시 연결' : '설정 코드 다시 넣기';
  authBanner.hidden = false;
}

/**
 * The catalog in memory changed (reload, or a slow download adopted in the background):
 * rebuild or refresh the screens. `before` = generated_at of the previous catalog.
 * @returns {'archive'|'updated'|'same'}
 */
function applyCatalogChange(before) {
  const cat = (ctx.archive && ctx.archive.catalog) || {};
  setTimeZone(cat.tz);
  if (ctx.archive.archiveChanged) {
    // A different archive (catalog.archive_id) behind the same address: the data layer
    // dropped the old archive's caches; rebuild every screen from the new catalog.
    if (viewer) viewer.hide();
    destroyAllScreens();
    const r = ctx.router.current;
    ctx.router._last = null;
    if (r) onRoute(r); else ctx.router.go('/', {}, { replace: true });
    ctx.emit('catalog');
    toast('보관함이 바뀌어 새로 불러왔어요.');
    return 'archive';
  }
  if (cat.generated_at !== before) {
    // Every kept-alive screen re-reads the catalog (room screens included: their months,
    // counts and loaded rows may belong to superseded month chunks).
    for (const e of screens.values()) {
      if (e.screen.refresh) { try { e.screen.refresh(); } catch (err) { console.warn('[app] refresh failed', err); } }
    }
    ctx.emit('catalog');
    return 'updated';
  }
  return 'same';
}

function friendlyError(err, settings) {
  if (isAuthError(err)) {
    if (settings && settings.mode === 'drive') return new Error('Google 인증에 실패했어요. Mac 프로그램에서 설정 코드를 새로 만들어 붙여넣어 주세요.');
    return new Error((err && err.message) || '보관함 서버가 접근을 거부했어요. Mac 프로그램이 알려 준 주소(접속 키 포함)로 다시 열어 주세요.');
  }
  if (!navigator.onLine) return new Error('인터넷에 연결되어 있지 않아요. 연결을 확인한 뒤 다시 시도해 주세요.');
  const msg = (err && (err.userMessage || err.message)) || String(err);
  if (settings.mode === 'http' && /fetch|network|load failed|404|not found/i.test(msg)) {
    return new Error(`보관함에 연결하지 못했어요 (${settings.httpBase}). 주소와 Mac 서버가 켜져 있는지 확인해 주세요.`);
  }
  return err instanceof Error ? err : new Error(msg);
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

const root = document.getElementById('app');
const main = h('main', { id: 'main', class: 'screens', tabindex: '-1' });
const tabbar = h('nav', { class: 'tabbar', 'aria-label': '주 메뉴', hidden: true });
const tabLinks = {};
for (const [key, href, ic, label] of TOP_TABS) {
  const a = h('a', { class: 'tab', href, dataset: { tab: key } }, icon(ic, 24), h('span', { class: 'tab-label', text: label }));
  a.addEventListener('click', (ev) => {
    // Re-tapping the active tab scrolls to the top (iOS convention).
    if (a.getAttribute('aria-current') === 'page' && ctx.router && ctx.router.current && ctx.router.current.hash === href) {
      ev.preventDefault();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  });
  tabLinks[key] = a;
  tabbar.appendChild(a);
}
const offline = h('div', { class: 'offline-banner', role: 'status', hidden: navigator.onLine }, icon('wifiOff', 16), h('span', { text: '오프라인 — 저장된 데이터만 볼 수 있어요' }));
const authBannerText = h('span', { class: 'ab-text' });
const authBannerBtn = h('button', { type: 'button', class: 'ab-btn', onclick: () => ctx.router.go('/setup', { force: '1' }) });
const authBanner = h('div', { class: 'auth-banner', role: 'alert', hidden: true }, icon('alert', 16), authBannerText, authBannerBtn);
const skip = h('a', { class: 'skip-link', href: '#main', onclick: (ev) => { ev.preventDefault(); main.focus(); } }, '본문으로 건너뛰기');

const screens = new Map();       // key -> {key, name, screen, scroll}
let current = null;

function createScreen(m) {
  switch (m.name) {
    case 'home': return createHome(ctx);
    case 'rooms': return createRooms(ctx);
    case 'room': return createRoom(ctx, m.params.id);
    case 'search': return createSearch(ctx);
    case 'starred': return createStarred(ctx);
    case 'more': return createMore(ctx);
    case 'collect': return createCollection(ctx, m.params.kind);
    case 'setup': return createSetup(ctx, authProblem ? { notice: authMessage(authProblem) } : {});
    default: return null;
  }
}

function destroyAllScreens() {
  for (const e of screens.values()) { try { e.screen.destroy(); } catch (err) { console.warn(err); } e.screen.el.remove(); }
  screens.clear();
  current = null;
}

function dropHiddenScreens() {
  for (const e of [...screens.values()]) {
    if (e === current) continue;
    try { e.screen.destroy(); } catch (err) { console.warn(err); }
    e.screen.el.remove();
    screens.delete(e.key);
  }
}

function evictRooms() {
  const rooms = [...screens.values()].filter((e) => e.name === 'room' && e !== current);
  while (rooms.length > MAX_ROOM_SCREENS - 1) {
    const e = rooms.shift();
    try { e.screen.destroy(); } catch (err) { console.warn(err); }
    e.screen.el.remove();
    screens.delete(e.key);
  }
}

function showScreen(m, route) {
  const routeInfo = Object.assign({}, m, { query: route.query });
  fallbackProvider = null;          // media screens register their list again in show()
  if (current && current.key === m.key) {
    current.screen.show(routeInfo);
    return;
  }
  if (current) {
    current.scroll = window.scrollY;
    try { current.screen.hide(); } catch (err) { console.warn(err); }
    current.screen.el.hidden = true;
  }
  let entry = screens.get(m.key);
  const fresh = !entry;
  if (!entry) {
    const screen = createScreen(m);
    entry = { key: m.key, name: m.name, screen, scroll: 0 };
    screens.set(m.key, entry);
    main.appendChild(screen.el);
  } else {
    screens.delete(m.key);
    screens.set(m.key, entry);
  }
  current = entry;
  entry.screen.el.hidden = false;
  if (m.name === 'room') evictRooms();
  for (const [key, a] of Object.entries(tabLinks)) {
    if (key === m.top) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  tabbar.hidden = m.name === 'setup';
  document.body.classList.toggle('no-tabbar', m.name === 'setup');
  const res = entry.screen.show(routeInfo);
  if (res !== 'positioned') {
    if (fresh) window.scrollTo(0, 0);
    else if (entry.screen.resumeScroll) entry.screen.resumeScroll();
    else window.scrollTo(0, entry.scroll || 0);
  }
  const title = typeof entry.screen.title === 'string' ? entry.screen.title : '';
  document.title = title ? `${title} · 카톡 보관함` : '카톡 보관함';
}

function onRoute(route) {
  const m = matchRoute(route.segs);
  if (!m) { ctx.router.go('/', {}, { replace: true }); return; }
  if (!ctx.archive && m.name !== 'setup') { ctx.router.go('/setup', {}, { replace: true }); return; }
  if (ctx.archive && m.name === 'setup' && !route.query.force) {
    // Already connected: the setup screen is only reachable through 설정 초기화.
    ctx.router.go('/', {}, { replace: true });
    return;
  }
  showScreen(m, route);
  const view = route.query.view;
  if (view && ctx.archive) {
    // A new open brings its own list; swipes (replace navigations) keep the open viewer's
    // list; deep links / history fall back to the list of the screen underneath.
    const provider = pendingProvider || (viewer.isOpen ? null : fallbackProvider);
    pendingProvider = null;
    viewer.showParam(view, provider).then((ok) => {
      if (!ok) { viewerPushed = false; ctx.router.setQuery({ view: null }, { replace: true }); }
    });
  } else {
    viewerPushed = false;
    if (viewer) viewer.hide();
  }
}

function watchArchive(archive) {
  if (!archive || typeof archive.addEventListener !== 'function') return;
  // Stars merged from another device (user-state.json) → refresh star badges.
  archive.addEventListener('userstate', (ev) => {
    if (ev && ev.detail && ev.detail.origin === 'remote') ctx.emit('star', null);
  });
  // Slow network at start: the saved catalog was shown first; the download arrived later.
  archive.addEventListener('catalogfresh', (ev) => {
    if (ctx.archive !== archive) return;
    const d = (ev && ev.detail) || {};
    syncAuthState();
    if (d.changed) applyCatalogChange(d.before);
    ctx.emit('catalog-status');
  });
}

function adopt(archive, source, settings) {
  destroyAllScreens();
  if (ctx.archive && ctx.archive !== archive && typeof ctx.archive.dispose === 'function') ctx.archive.dispose();
  watchArchive(archive);
  ctx.archive = archive;
  ctx.source = source;
  ctx.settings = settings;
  authNoticeShown = false;
  authProblem = null;
  updateAuthBanner();
  const cat = archive.catalog || {};
  setTimeZone(cat.tz);
  if (!viewer) viewer = new MediaViewer(ctx);
  if (!ctx.router.current || matchRoute(ctx.router.current.segs)?.name === 'setup') ctx.router.go('/', {}, { replace: true });
  else { const r = ctx.router.current; ctx.router._last = null; onRoute(r); }
}

function showSetup(notice) {
  authProblem = null;
  updateAuthBanner();
  destroyAllScreens();
  if (ctx.archive && typeof ctx.archive.dispose === 'function') ctx.archive.dispose();
  ctx.archive = null;
  if (viewer) viewer.hide();
  const entry = { key: 'setup', name: 'setup', screen: createSetup(ctx, { notice }), scroll: 0 };
  screens.set('setup', entry);
  main.appendChild(entry.screen.el);
  current = entry;
  tabbar.hidden = true;
  document.body.classList.add('no-tabbar');
  document.title = '시작하기 · 카톡 보관함';
  if (location.hash !== '#/setup') history.replaceState({ kb: 1, depth: 0 }, '', location.pathname + location.search + '#/setup');
  ctx.router._last = { hash: '#/setup', depth: 0 };
  ctx.router.current = { path: '/setup', segs: ['setup'], query: {}, hash: '#/setup' };
}

function fatal(title, detail, actions = []) {
  clear(main);
  tabbar.hidden = true;
  main.appendChild(h('div', { class: 'screen screen-fatal' },
    h('div', { class: 'empty' },
      h('div', { class: 'empty-ic' }, icon('alert', 34)),
      h('p', { class: 'empty-title', text: title }),
      detail ? h('p', { class: 'empty-text', text: detail }) : null,
      h('div', { class: 'btn-col' }, ...actions))));
}

// ---------------------------------------------------------------------------
// Theme, connectivity, service worker
// ---------------------------------------------------------------------------

function applyTheme() {
  const t = prefs.get('theme', 'system');
  const el = document.documentElement;
  if (t === 'light' || t === 'dark') el.dataset.theme = t; else delete el.dataset.theme;
  const dark = t === 'dark' || (t === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    if (t === 'system') meta.content = meta.media && meta.media.includes('dark') ? '#16171a' : '#f7f5f0';
    else meta.content = dark ? '#16171a' : '#f7f5f0';
  }
}

function watchConnectivity() {
  const update = () => {
    offline.hidden = navigator.onLine;
    document.body.classList.toggle('is-offline', !navigator.onLine);
  };
  window.addEventListener('online', () => { update(); toast('다시 온라인이에요.', { duration: 1500 }); });
  window.addEventListener('offline', update);
  update();
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  if (/(^|[?&])nosw=1(&|$)/.test(location.search)) return;
  const viaData = data && data.source && typeof data.source.registerServiceWorker === 'function'
    ? data.source.registerServiceWorker().then((r) => { if (!r.registration) throw (r.error || new Error('등록 실패')); return r.registration; })
    : navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' });
  viaData.then((reg) => {
    if (!reg) return;
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      if (!w) return;
      w.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) {
          toast('새 버전이 준비됐어요.', {
            action: '새로고침', duration: 15000,
            onAction: () => { try { w.postMessage({ type: 'SKIP_WAITING' }); } catch (e) { /* ignore */ } setTimeout(() => location.reload(), 300); },
          });
        }
      });
    });
  }).catch((err) => console.info('[app] service worker not registered:', err && err.message));
}

let hiddenAt = 0;
function watchVisibility() {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (ctx.archive && !ctx.archive.isFake && hiddenAt && Date.now() - hiddenAt > 10 * 60 * 1000 && navigator.onLine) {
      ctx.reloadCatalog().catch((err) => ctx.handleError(err, { quiet: true }));
    }
  });
}

function fakeReport() {
  return {
    v: 1, ok: true, cancelled: false, started_at: 1790500000, finished_at: 1790500321,
    sources: [{ label: 'iPhone (데모) USB 백업' }],
    totals: { new_msgs: 132, new_photos: 35, new_videos: 6, missing_media: 3, thumb_only: 2 },
    rooms: [
      { room_id: 'c1001', name: '우리 가족 👨‍👩‍👧', new_msgs: 88, new_photos: 30, new_videos: 5, thumb_only: 2, missing_media: 1, errors: [] },
      { room_id: 'c1002', name: '엄마', new_msgs: 44, new_photos: 5, new_videos: 1, missing_media: 2, errors: [] },
    ],
    publish: { targets: [{ target_id: 'gdrive', label: 'Google Drive', ok: true, uploaded_files: 45, uploaded_bytes: 123456789 }] },
    errors: [],
  };
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function loadDataLayer() {
  const [settings, source, archive] = await Promise.all([
    import('./data/settings.js'), import('./data/source.js'), import('./data/archive.js'),
  ]);
  return { settings, source, archive };
}

async function boot() {
  applyTheme();
  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (mq.addEventListener) mq.addEventListener('change', applyTheme);
  }
  const splash = document.getElementById('splash');
  root.append(skip, offline, authBanner, main, tabbar);
  watchConnectivity();
  watchVisibility();
  ctx.router = new Router(onRoute);
  if (isDevHost()) window.__kb = ctx;            // dev hosts only: handle for debugging in the console

  let useFake = false;
  try { useFake = localStorage.getItem(DEV_FAKE_KEY) === '1' && isDevHost(); } catch (e) { useFake = false; }

  try {
    data = await loadDataLayer();
    registerServiceWorker();
  } catch (err) {
    console.error('[app] data layer failed to load', err);
    data = null;
    if (!useFake && !isDevHost()) {
      if (splash) splash.remove();
      fatal('앱을 시작하지 못했어요', '앱 구성 파일을 불러오지 못했어요. 인터넷 연결을 확인하고 다시 열어 주세요.',
        [h('button', { type: 'button', class: 'btn btn-primary', onclick: () => location.reload() }, icon('refresh', 18), '다시 시도')]);
      return;
    }
  }

  if (useFake) {
    try {
      const m = await import('./data/fake.js');
      ctx.archive = await m.createFakeArchive();
      ctx.source = ctx.archive.source;
      ctx.settings = { mode: 'demo', setup: null, httpBase: null };
      setTimeZone(ctx.archive.catalog.tz);
    } catch (err) {
      console.error(err);
    }
  } else if (data) {
    let settings = null;
    try { settings = await data.settings.loadSettings(); } catch (err) { console.warn('[app] loadSettings failed', err); }
    if (settings && settings.mode) {
      try {
        const source = await data.source.createSource(settings);
        const archive = new data.archive.Archive(source);
        await archive.load();
        ctx.archive = archive;
        ctx.source = source;
        ctx.settings = settings;
        watchArchive(archive);
        setTimeZone(archive.catalog && archive.catalog.tz);
        syncAuthState();                 // access refused but a saved catalog exists → read-only
      } catch (err) {
        console.error('[app] archive load failed', err);
        if (splash) splash.remove();
        if (authKind(err, settings.mode) === 'server') {
          // Mac/NAS server refused (LAN key): nothing Google about it
          fatal('보관함 서버가 접근을 거부했어요', err.message || authMessage(err),
            [h('button', { type: 'button', class: 'btn btn-primary', onclick: () => location.reload() }, icon('refresh', 18), '다시 시도'),
              h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => ctx.resetSettings() }, '데이터 소스 변경 (설정 초기화)')]);
          return;
        }
        if (isAuthError(err)) {
          ctx.router.start();
          showSetup('Google 인증이 만료되었거나 취소되었어요. Mac 프로그램에서 새 설정 코드를 받아 다시 붙여넣어 주세요.');
          return;
        }
        fatal('보관함을 불러오지 못했어요', `${friendlyError(err, settings).message}`,
          [h('button', { type: 'button', class: 'btn btn-primary', onclick: () => location.reload() }, icon('refresh', 18), '다시 시도'),
            h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => ctx.resetSettings() }, '데이터 소스 변경 (설정 초기화)')]);
        return;
      }
    }
  }

  if (ctx.archive) viewer = new MediaViewer(ctx);
  if (splash) { splash.classList.add('done'); setTimeout(() => splash.remove(), 300); }
  ctx.router.start();
}

boot().catch((err) => {
  console.error('[app] boot failed', err);
  fatal('앱을 시작하지 못했어요', (err && err.message) || String(err),
    [h('button', { type: 'button', class: 'btn btn-primary', onclick: () => location.reload() }, '다시 시도')]);
});
