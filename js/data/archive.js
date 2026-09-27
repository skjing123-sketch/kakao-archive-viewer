// archive.js — Archive: the viewer's single entry point to a published archive (SPEC §9.1).
//
//   const archive = new Archive(await createSource(loadSettings()));
//   await archive.load();
//   archive.rooms(); archive.months({kinds:['photo','video']});
//   const rows = await archive.mediaInMonth('2026-09');
//   img.src = await archive.thumbURL(rows[0]);
//
// Loads catalog.json (network-first with offline fallback), month chunks (cached forever,
// in-flight de-duplicated, small in-memory LRU), KTP thumbnail packs (object URLs in an
// LRU that revokes on eviction), and keeps user state (stars, room aliases) locally in
// IndexedDB and synced (merged) with user-state.json on the archive.
//
// Timestamps are epoch seconds (UTC); months/days are computed in catalog.tz
// (Asia/Seoul by default) — never in the phone's time zone.

import { kvGet, kvSet, pruneDataCache, purgeArchiveData } from './cache.js';
import { KtpPack, ObjectURLCache, ktpSlice } from './ktp.js';
import {
  AuthError, DataError, DataFormatError, NetworkError, NotFoundError, abortError, decodeJSONBytes, isAbortError, joinShared,
  throwIfAborted,
} from './source.js';

export { AuthError, DataError, DataFormatError, NetworkError, NotFoundError } from './source.js';

export const DEFAULT_TZ = 'Asia/Seoul';
export const COUNT_KEYS = ['msg', 'photo', 'video', 'audio', 'file', 'link'];
const CHUNK_CACHE_MAX = 60;
const PACK_CACHE_MAX_BYTES = 48 * 1024 * 1024;
const TOMBSTONE_TTL_MS = 180 * 24 * 3600 * 1000;
const USER_STATE_MAX_BYTES = 900 * 1024;
const META_MAX_CHARS = 2000;
/** Largest original the no-service-worker fallback downloads into memory for <img>/<video>. */
export const MEDIA_BLOB_MAX = 40 * 1024 * 1024;
/** Object URLs of downloaded originals kept alive (the viewer shows current + 2 neighbours). */
const MEDIA_URL_MAX = 4;

// Passive types a page may show (same allow-list as sw.js mediaPolicy / ui/model.js).
const INLINE_IMAGE_RE = /^image\/(?:jpeg|pjpeg|png|gif|webp|heic|heif|avif|bmp|tiff)$/;
const INLINE_AV_RE = /^(?:video|audio)\/[a-z0-9][\w.+-]*$/;

/**
 * The normalized type when `mime` is passive (photo, video, audio, PDF) — safe to show as a
 * document in the viewer's origin — else null (HTML, SVG, XML, text, unknown …).
 * @param {string|null|undefined} mime
 * @returns {string|null}
 */
export function inlineMediaType(mime) {
  const s = String(mime || '').split(';')[0].trim().toLowerCase();
  return INLINE_IMAGE_RE.test(s) || INLINE_AV_RE.test(s) || s === 'application/pdf' ? s : null;
}

/**
 * Byte size of a media row's preview ('pvsz', SPEC §5.5: optional, only next to 'pv';
 * chunks published before it lack it) — a positive integer, else undefined. Passed as the
 * size of Drive preview URLs so the service worker's 206 answers carry the real total in
 * Content-Range (without it the SW falls back to Drive's Content-Length).
 * @param {object} row
 * @returns {number|undefined}
 */
export function previewSize(row) {
  const n = row && row.pv ? row.pvsz : undefined;
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

// ---------------------------------------------------------------------------
// time helpers (archive time zone)
// ---------------------------------------------------------------------------

const dtfCache = new Map();
function dtf(tz) {
  let f = dtfCache.get(tz);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
      });
    } catch (e) {
      f = dtf(DEFAULT_TZ);
    }
    dtfCache.set(tz, f);
  }
  return f;
}
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const pad2 = (n) => String(n).padStart(2, '0');

/**
 * Wall-clock parts of an epoch-seconds timestamp in `tz`.
 * @returns {{y:number, m:number, d:number, hh:number, mi:number, ss:number, wd:number}} wd: 0 = Sunday
 */
export function dateParts(ts, tz = DEFAULT_TZ) {
  const p = {};
  for (const x of dtf(tz).formatToParts(new Date(Number(ts) * 1000))) p[x.type] = x.value;
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour % 24, mi: +p.minute, ss: +p.second, wd: WD[p.weekday] ?? 0 };
}

/** 'YYYY-MM' of a timestamp in `tz`. */
export function ymOf(ts, tz = DEFAULT_TZ) {
  const p = dateParts(ts, tz);
  return `${p.y}-${pad2(p.m)}`;
}

/** 'YYYY-MM-DD' of a timestamp in `tz`. */
export function ymdOf(ts, tz = DEFAULT_TZ) {
  const p = dateParts(ts, tz);
  return `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
}

/**
 * Epoch seconds of a wall-clock time in `tz`. Ambiguous times (DST fall-back) resolve to
 * the earlier instant, skipped times (spring-forward gap) move forward like
 * Temporal's 'compatible' disambiguation.
 */
export function zonedEpoch(y, m, d, hh = 0, mi = 0, ss = 0, tz = DEFAULT_TZ) {
  const wall = Date.UTC(y, m - 1, d, hh, mi, ss) / 1000;
  const localOf = (t) => {
    const p = dateParts(t, tz);
    return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mi, p.ss) / 1000;
  };
  const before = wall - (localOf(wall - 86400) - (wall - 86400));   // offset a day earlier
  const after = wall - (localOf(wall + 86400) - (wall + 86400));    // offset a day later
  const ok = [before, after].filter((t) => localOf(t) === wall);
  if (ok.length) return Math.min(...ok);
  return Math.max(before, after);
}

/**
 * Normalize a date bound: epoch seconds / milliseconds, Date, 'YYYY-MM-DD', 'YYYY-MM' or
 * an ISO date-time string. `edge` 'end' makes day/month strings inclusive.
 * @returns {number|null} epoch seconds
 */
export function toEpochBound(v, tz = DEFAULT_TZ, edge = 'start') {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getTime() / 1000;
  if (typeof v === 'number') return Number.isFinite(v) ? (v > 1e11 ? v / 1000 : v) : null;
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) {
    const [y, mo, d] = [+m[1], +m[2], +m[3]];
    return edge === 'end' ? zonedEpoch(y, mo, d, 23, 59, 59, tz) + 0.999 : zonedEpoch(y, mo, d, 0, 0, 0, tz);
  }
  m = /^(\d{4})-(\d{2})$/.exec(s);
  if (m) {
    const [y, mo] = [+m[1], +m[2]];
    if (edge !== 'end') return zonedEpoch(y, mo, 1, 0, 0, 0, tz);
    const next = mo === 12 ? [y + 1, 1] : [y, mo + 1];
    return zonedEpoch(next[0], next[1], 1, 0, 0, 0, tz) - 0.001;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t / 1000;
}

// ---------------------------------------------------------------------------
// small public helpers
// ---------------------------------------------------------------------------

/** Star key `${roomId}|${msgKey}|${mediaId||''}`. */
export function starKey(roomId, msgKey, mediaId = '') {
  return `${roomId}|${msgKey}|${mediaId || ''}`;
}

/** Inverse of starKey. */
export function parseStarKey(key) {
  const s = String(key || '');
  const a = s.indexOf('|');
  const b = s.lastIndexOf('|');
  if (a < 0 || b === a) return { room: s, msgKey: '', mediaId: '' };
  return { room: s.slice(0, a), msgKey: s.slice(a + 1, b), mediaId: s.slice(b + 1) };
}

/** Lower-case, NFC, whitespace-collapsed text (used for search). */
export function normalizeText(s) {
  return String(s ?? '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Search terms of a query (for highlighting in the UI too). */
export function searchTerms(q) {
  const out = [];
  for (const t of normalizeText(q).split(' ')) if (t && !out.includes(t)) out.push(t);
  return out;
}

/** Whether this browser shows HEIC/HEIF in <img> (WebKit on iOS 17+/macOS Safari 17+). */
export function canDisplayHEIC() {
  try {
    const ua = navigator.userAgent || '';
    if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return true;
    return /Safari\//.test(ua) && !/Chrome|Chromium|CriOS|Edg|Android|Firefox|FxiOS/.test(ua);
  } catch (e) {
    return false;
  }
}

/** A sensible file name for saving/sharing a media row. */
export function mediaFileName(row, tz = DEFAULT_TZ) {
  if (row && row.nm) return row.nm;
  const p = dateParts(row && row.t ? row.t : 0, tz);
  const stamp = `${p.y}${pad2(p.m)}${pad2(p.d)}_${pad2(p.hh)}${pad2(p.mi)}${pad2(p.ss)}`;
  return `KakaoTalk_${stamp}_${String(row && row.id || '').slice(0, 8)}.${(row && row.ext) || 'bin'}`;
}

/** Hostname without 'www.' ('' when not a URL). */
export function linkDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
}

const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;

async function mapLimit(items, limit, fn, signal) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      throwIfAborted(signal);
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function cmpMsgAsc(a, b) {
  return (a.t - b.t) || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0);
}

function countFor(month, kinds) {
  if (!month) return 0;
  if (!kinds || !kinds.length) return Number(month.msg) || 0;
  let n = 0;
  let known = false;
  for (const k of new Set(kinds.map((x) => (x === 'gif' ? 'photo' : x)))) {
    const key = (k === 'text' || k === 'all' || k === 'msg') ? 'msg' : k;
    if (COUNT_KEYS.includes(key)) {
      known = true;
      n += Number(month[key]) || 0;
    }
  }
  return known ? n : Number(month.msg) || 0;
}

function expandMediaKinds(kinds) {
  const set = new Set(kinds && kinds.length ? kinds : ['photo', 'video']);
  if (set.has('photo')) set.add('gif');
  return set;
}

/**
 * Gallery-only item (SPEC §13.1): a media file no message references, published as a
 * message with the flag 'orphan'. It is never a chat message: chat views, search results,
 * starred messages and message counts skip it; its media rows stay in the galleries.
 */
export function isOrphanMessage(m) {
  return !!m && Array.isArray(m.fl) && m.fl.includes('orphan');
}

/** Month entry without any real message (catalog msg excludes orphan items, SPEC §13.2 L4). */
function monthHasNoMessages(m) {
  return !!m && m.msg !== undefined && m.msg !== null && Number(m.msg) === 0;
}

/** catalog.archive_id (SPEC §13.2 L7) or null for older archives. */
export function archiveIdOf(cat) {
  const id = cat && cat.archive_id;
  return typeof id === 'string' && id ? id : null;
}

// ---------------------------------------------------------------------------
// user state (stars / aliases) — merge-friendly format
// ---------------------------------------------------------------------------

/**
 * user-state.json:
 * {v:1, app:'kakaobackup-viewer', updated_at:ms,
 *  stars:{[key]:{at:ms, meta}}, unstars:{[key]:ms}, aliases:{[roomId]:{name|null, at:ms}}}
 * Unstars are tombstones so that merging two devices never resurrects an unstarred item.
 */
function emptyUserState() {
  return { v: 1, stars: {}, unstars: {}, aliases: {}, updated_at: 0 };
}

export function normalizeUserState(o) {
  const s = emptyUserState();
  if (!o || typeof o !== 'object') return s;
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  if (o.stars && typeof o.stars === 'object') {
    for (const [k, v] of Object.entries(o.stars)) {
      if (!k) continue;
      if (v && typeof v === 'object') s.stars[k] = { at: num(v.at), meta: v.meta ?? null };
      else if (v) s.stars[k] = { at: 0, meta: null };
    }
  }
  if (o.unstars && typeof o.unstars === 'object') {
    for (const [k, v] of Object.entries(o.unstars)) if (k) s.unstars[k] = num(v);
  }
  if (o.aliases && typeof o.aliases === 'object') {
    for (const [k, v] of Object.entries(o.aliases)) {
      if (typeof v === 'string') s.aliases[k] = { name: v || null, at: 0 };
      else if (v && typeof v === 'object') s.aliases[k] = { name: typeof v.name === 'string' && v.name ? v.name : null, at: num(v.at) };
    }
  }
  s.updated_at = num(o.updated_at);
  return s;
}

/** Merge two user states (newest action per key wins; old tombstones pruned). */
export function mergeUserStates(a, b, now = Date.now()) {
  const out = emptyUserState();
  const keys = new Set([...Object.keys(a.stars), ...Object.keys(b.stars), ...Object.keys(a.unstars), ...Object.keys(b.unstars)]);
  for (const k of keys) {
    const sa = a.stars[k];
    const sb = b.stars[k];
    const star = sa && sb ? (sb.at > sa.at ? sb : sa) : (sa || sb);
    const un = Math.max(a.unstars[k] ?? -Infinity, b.unstars[k] ?? -Infinity);
    if (star && star.at >= un) out.stars[k] = { at: star.at, meta: star.meta ?? null };
    else if (Number.isFinite(un) && now - un < TOMBSTONE_TTL_MS) out.unstars[k] = un;
  }
  for (const k of new Set([...Object.keys(a.aliases), ...Object.keys(b.aliases)])) {
    const x = a.aliases[k];
    const y = b.aliases[k];
    out.aliases[k] = x && y ? (y.at > x.at ? y : x) : (x || y);
  }
  out.updated_at = Math.max(a.updated_at || 0, b.updated_at || 0);
  return out;
}

function fingerprint(s) {
  const sortObj = (o) => Object.keys(o).sort().map((k) => [k, o[k]]);
  return JSON.stringify([sortObj(s.stars).map(([k, v]) => [k, v.at]), sortObj(s.unstars), sortObj(s.aliases)]);
}

function hasContent(s) {
  return Object.keys(s.stars).length > 0 || Object.keys(s.unstars).length > 0 || Object.keys(s.aliases).length > 0;
}

function sanitizeMeta(meta) {
  if (meta === undefined || meta === null) return null;
  let json;
  try { json = JSON.stringify(meta); } catch (e) { return null; }
  if (json === undefined) return null;
  if (json.length <= META_MAX_CHARS) return JSON.parse(json);
  const small = {};
  if (meta && typeof meta === 'object') {
    for (const [k, v] of Object.entries(meta)) {
      if (typeof v === 'string') small[k] = v.length > 200 ? `${v.slice(0, 200)}…` : v;
      else if (typeof v === 'number' || typeof v === 'boolean' || v === null) small[k] = v;
      else if (k === 'th' && v && typeof v === 'object') small[k] = v;
    }
  }
  const s = JSON.stringify(small);
  return s.length <= META_MAX_CHARS * 2 ? small : null;
}

function serializeUserState(s) {
  const out = { v: 1, app: 'kakaobackup-viewer', updated_at: s.updated_at, stars: s.stars, unstars: s.unstars, aliases: s.aliases };
  let json = JSON.stringify(out);
  if (json.length > USER_STATE_MAX_BYTES) {           // drop tombstones first, then star metadata
    out.unstars = {};
    json = JSON.stringify(out);
    if (json.length > USER_STATE_MAX_BYTES) {
      out.stars = Object.fromEntries(Object.entries(s.stars).map(([k, v]) => [k, { at: v.at, meta: null }]));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Archive
// ---------------------------------------------------------------------------

function emptyChunk(roomId, ym) {
  return { v: 1, room: roomId, ym, messages: [], media: [] };
}

function normalizeChunk(data, roomId, ym, rel) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.messages) || !Array.isArray(data.media)) {
    throw new DataFormatError('대화 파일 형식이 올바르지 않습니다.', { code: 'bad_chunk', rel });
  }
  data.messages = data.messages.filter((m) => m && typeof m === 'object' && typeof m.k === 'string' && Number.isFinite(m.t));
  for (let i = 1; i < data.messages.length; i++) {
    if (cmpMsgAsc(data.messages[i - 1], data.messages[i]) > 0) { data.messages.sort(cmpMsgAsc); break; }
  }
  data.media = data.media.filter((r) => r && typeof r === 'object' && typeof r.id === 'string');
  for (let i = 1; i < data.media.length; i++) {
    if (data.media[i - 1].t < data.media[i].t) { data.media.sort((a, b) => b.t - a.t); break; }
  }
  let orphanKeys = null;
  for (const m of data.messages) if (isOrphanMessage(m)) (orphanKeys || (orphanKeys = new Set())).add(m.k);
  for (const row of data.media) {                // lets thumbURL()/mediaURL() work on any row
    if (row.room === undefined) row.room = roomId;
    if (row.ym === undefined) row.ym = ym;
    if (orphanKeys && orphanKeys.has(row.k)) row.orphan = true;   // gallery-only (no message)
    // The chunk a row came from: `th` offsets are only valid for the packs of THAT chunk.
    // After a republish (new chunk + pack, the old ones deleted) rows kept by screens are
    // resolved against the current chunk again (thumbURL).
    row.crel = rel;
  }
  data.room = data.room || roomId;
  data.ym = data.ym || ym;
  return data;
}

export class Archive extends EventTarget {
  /**
   * @param {import('./source.js').BaseSource} source a DataSource from createSource()
   * @param {{chunkCacheMax?: number, urlCacheMax?: number}} [opts]
   */
  constructor(source, opts = {}) {
    super();
    if (!source) throw new TypeError('Archive: source가 필요합니다');
    this.source = source;
    this._catalog = null;
    this._loading = null;
    this._rooms = [];
    this._roomById = new Map();
    this._monthIdx = new Map();
    this._ids = {};
    this._chunks = new Map();
    this._chunkTasks = new Map();
    this._chunkIndex = new WeakMap();
    this._chunkMax = opts.chunkCacheMax || CHUNK_CACHE_MAX;
    this._packs = new Map();
    this._packBytes = 0;
    this._packTasks = new Map();
    this._urls = new ObjectURLCache({ max: opts.urlCacheMax || 2500 });
    this._mediaURLs = new ObjectURLCache({ max: opts.mediaUrlCacheMax || MEDIA_URL_MAX });
    this._hay = new WeakMap();
    this._freshToken = null;
    this._disposed = false;
    // user state
    this._state = emptyUserState();
    this._stateLoaded = false;
    this._stateLoading = null;
    this._dirty = false;
    this._remoteDisabled = false;
    this._syncTimer = null;
    this._syncChain = Promise.resolve();
    /** @type {Error|null} last user-state sync error */
    this.userStateError = null;
    this.userStateSyncedAt = 0;
    /** true when the catalog came from the offline copy */
    this.offline = false;
    /** true while a slow download of catalog.json continues after the saved copy was shown */
    this.refreshing = false;
    /**
     * true when the source refused access (revoked/expired Google connection, rotated
     * server key) and the saved catalog copy is shown read-only; `authError` is the reason.
     */
    this.authExpired = false;
    /** @type {Error|null} */
    this.authError = null;
    /** true when the last load() found a different archive_id behind this source (L7) */
    this.archiveChanged = false;
    this.loadedAt = 0;
    this._onHide = () => { if (this._dirty) this.flushUserState().catch(() => {}); };
    if (typeof addEventListener === 'function' && typeof document !== 'undefined') {
      addEventListener('pagehide', this._onHide);
      document.addEventListener('visibilitychange', this._visHandler = () => {
        if (document.visibilityState === 'hidden') this._onHide();
      });
    }
  }

  // -- catalog ------------------------------------------------------------------
  /**
   * Load catalog.json (network-first; offline → last saved copy, `archive.offline`=true).
   * A slow network shows the saved copy after STALE_AFTER_MS (`archive.refreshing`=true)
   * and adopts the download when it arrives: event 'catalogfresh' {changed, before, error}.
   * Access refused (revoked Google connection, rotated server key) with a saved copy →
   * that copy read-only, `archive.authExpired`=true (`authError` = the AuthError).
   * Concurrent calls share one request. Also loads the user state (stars).
   * @param {{force?: boolean, signal?: AbortSignal}} [opts]
   * @returns {Promise<object>} the catalog
   */
  async load({ force = false, signal } = {}) {
    if (this._catalog && !force) return this._catalog;
    if (!this._loading) {
      this._freshToken = null;                         // a newer load wins over a pending refresh
      const p = (async () => {
        const info = {};
        const cat = await this.source.getJSON('catalog.json', { mutable: true, info });
        await this._adopt(cat, info);
        return cat;
      })();
      this._loading = p;
      p.finally(() => { if (this._loading === p) this._loading = null; }).catch(() => {});
    }
    if (!signal) return this._loading;
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(abortError(signal));
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
      this._loading.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
  }

  /** Make `cat` the current catalog (`info` from BaseSource._blob). */
  async _adopt(cat, info = {}) {
    this._validateCatalog(cat);
    await this._checkIdentity(cat);
    this._setCatalog(cat);
    this.refreshing = !!info.fresh;
    this.offline = !!info.stale && !info.fresh;
    this.authExpired = !!info.authError;
    this.authError = info.authError || null;
    this.loadedAt = Date.now();
    await this._loadLocalUserState();
    if (!this.authExpired) this.syncUserState().catch(() => {});   // merge with user-state.json in the background
    this.dispatchEvent(new CustomEvent('catalog', { detail: { offline: this.offline } }));
    if (!info.stale) this._schedulePrune();
    if (info.fresh) this._awaitFresh(info.fresh);
  }

  /** The download that lost against STALE_AFTER_MS finished: adopt it (or note the failure). */
  _awaitFresh(promise) {
    const token = {};
    this._freshToken = token;
    const current = () => this._freshToken === token && !this._disposed;
    const emit = (detail) => this.dispatchEvent(new CustomEvent('catalogfresh', { detail }));
    promise.then(async (blob) => {
      if (!current()) return;
      const cat = await decodeJSONBytes(await blob.arrayBuffer(), 'catalog.json');
      if (!current() || this._loading) return;
      const before = this._catalog;
      const beforeAt = before ? before.generated_at : undefined;
      this._freshToken = null;
      if (before && before.generated_at === cat.generated_at && archiveIdOf(before) === archiveIdOf(cat)) {
        this.refreshing = false;
        this.offline = false;
        this._schedulePrune();
        emit({ changed: false, before: beforeAt });
        return;
      }
      await this._adopt(cat, {});
      emit({ changed: true, before: beforeAt });
    }).catch((e) => {
      if (!current()) return;
      this._freshToken = null;
      this.refreshing = false;
      if (e instanceof AuthError) {
        this.authExpired = true;
        this.authError = e;
      }
      this.offline = true;
      console.warn('[kb-data] catalog.json 을 새로 받지 못했습니다:', e && e.message);
      emit({ changed: false, error: e });
    });
  }

  _validateCatalog(cat) {
    if (!cat || typeof cat !== 'object' || !Array.isArray(cat.rooms)) {
      throw new DataFormatError('보관함 목록(catalog.json) 형식이 올바르지 않습니다.', { code: 'bad_catalog' });
    }
    if (cat.schema !== 1) {
      throw new DataFormatError(Number(cat.schema) > 1
        ? '더 새로운 버전의 프로그램으로 만든 보관함입니다. 뷰어를 새로 고쳐 주세요.'
        : '지원하지 않는 보관함 형식입니다.', { code: 'unsupported_schema' });
    }
  }

  get _idKey() { return `archive-id:${this.source.id}`; }

  /**
   * Archive identity guard (SPEC §13.2 L7). When the catalog just fetched carries another
   * archive_id than the catalog this source served before (this session, or the id
   * remembered in IndexedDB from an earlier one), a different archive now sits behind the
   * same address (another NAS folder behind '/archive/nas/', a re-created Drive archive):
   * forget what is cached for the old one — month chunks, KTP packs and thumbnail object
   * URLs in memory, cached chunk/pack/report files, Drive path lookups — so nothing of the
   * old archive is shown next to the new catalog. Media originals are content-addressed
   * (same path = same bytes) and stay cached; stars/aliases stay too (their keys are
   * KakaoTalk ids, still valid for a rebuilt archive of the same account).
   * The first id seen after an archive without one (made before v1.1: the same archive
   * after a program update) is not a change; an id-less catalog after one with an id is.
   */
  async _checkIdentity(cat) {
    const next = archiveIdOf(cat);
    let prev;                                        // undefined = nothing known
    if (this._catalog) prev = archiveIdOf(this._catalog);
    else {
      try {
        const rec = await kvGet(this._idKey);
        if (rec && typeof rec === 'object' && 'id' in rec) prev = typeof rec.id === 'string' && rec.id ? rec.id : null;
      } catch (e) { /* IndexedDB unavailable: only this session is compared */ }
    }
    this.archiveChanged = typeof prev === 'string' && prev !== next;
    if (this.archiveChanged) {
      console.info('[kb-data] 다른 보관함으로 바뀌었습니다 — 이전 보관함의 캐시를 지웁니다.');
      this.clearMemory();
      if (typeof this.source.forgetPaths === 'function') this.source.forgetPaths();
      await purgeArchiveData(this.source.id).catch(() => 0);
      this.dispatchEvent(new CustomEvent('archivechange', { detail: { from: prev, to: next } }));
    }
    if (prev !== next) {
      try { await kvSet(this._idKey, { id: next, at: Date.now() }); } catch (e) { /* memory only */ }
    }
  }

  /** catalog.archive_id of the loaded catalog (null for archives made before v1.1). */
  get archiveId() { return archiveIdOf(this._catalog); }

  _setCatalog(cat) {
    this._validateCatalog(cat);
    const rooms = cat.rooms.filter((r) => r && typeof r.id === 'string').map((r) => {
      const months = (Array.isArray(r.months) ? r.months : [])
        .filter((m) => m && typeof m.ym === 'string' && typeof m.chunk === 'string')
        .map((m) => ({ ...m, packs: Array.isArray(m.packs) ? m.packs : [] }))
        .sort((a, b) => (a.ym < b.ym ? 1 : a.ym > b.ym ? -1 : 0));
      return {
        ...r,
        name: r.name || r.id,
        kind: r.kind || 'unknown',
        left: !!r.left,
        members: Array.isArray(r.members) ? r.members : [],
        counts: r.counts && typeof r.counts === 'object' ? r.counts : {},
        months,
      };
    });
    rooms.sort((a, b) => ((b.last_ts || 0) - (a.last_ts || 0)) || (a.id < b.id ? -1 : 1));
    this._catalog = cat;
    this._rooms = rooms;
    this._roomById = new Map(rooms.map((r) => [r.id, r]));
    this._monthIdx = new Map(rooms.map((r) => [r.id, new Map(r.months.map((m) => [m.ym, m]))]));
    this._ids = cat.ids && typeof cat.ids === 'object' ? cat.ids : {};
  }

  _schedulePrune() {
    const keep = new Set();
    for (const r of this._rooms) for (const m of r.months) { keep.add(m.chunk); for (const p of m.packs) keep.add(p); }
    setTimeout(() => { pruneDataCache(this.source.id, keep).catch(() => {}); }, 5000);
  }

  async _ensureLoaded(signal) {
    if (!this._catalog) await this.load({ signal });
  }

  /** The loaded catalog object (null before load()). */
  get catalog() { return this._catalog; }

  /** Archive time zone (catalog.tz, default Asia/Seoul). */
  get tz() { return (this._catalog && this._catalog.tz) || DEFAULT_TZ; }

  /** catalog.target ({id, type, originals}) or null. */
  target() { return (this._catalog && this._catalog.target) || null; }

  _decorate(r) {
    const alias = this._state.aliases[r.id];
    return { ...r, displayName: (alias && alias.name) || r.name || r.id };
  }

  /** Rooms sorted by last_ts desc, each with `displayName` (alias from user state if any). */
  rooms() {
    return this._rooms.map((r) => this._decorate(r));
  }

  /** One room (with displayName) or null. */
  room(id) {
    const r = this._roomById.get(id);
    return r ? this._decorate(r) : null;
  }

  /** catalog.owner ({sid, name}) or null. */
  owner() { return (this._catalog && this._catalog.owner) || null; }

  /** catalog.last_backup ({at, report, summary}) or null. */
  lastBackup() { return (this._catalog && this._catalog.last_backup) || null; }

  /** Month entry of the catalog ({ym, msg, photo, …, chunk, packs}) or null. */
  monthEntry(roomId, ym) {
    const idx = this._monthIdx.get(roomId);
    return (idx && idx.get(ym)) || null;
  }

  /**
   * Months with content, merged across rooms, newest first (from catalog counts; months
   * whose count is 0 for `kinds` are left out).
   * @param {{roomIds?: string[]|null, kinds?: string[]|null}} [opts] kinds: photo|video|audio|file|link|msg
   * @returns {{ym:string, count:number}[]}
   */
  months({ roomIds = null, kinds = ['photo', 'video'] } = {}) {
    const set = roomIds ? new Set(roomIds) : null;
    const acc = new Map();
    for (const r of this._rooms) {
      if (set && !set.has(r.id)) continue;
      for (const m of r.months) {
        const c = countFor(m, kinds);
        if (c > 0) acc.set(m.ym, (acc.get(m.ym) || 0) + c);
      }
    }
    return [...acc].map(([ym, count]) => ({ ym, count })).sort((a, b) => (a.ym < b.ym ? 1 : -1));
  }

  // -- chunks -------------------------------------------------------------------
  /**
   * The month chunk {v, room, ym, messages (t asc), media (t desc)} — cached, and
   * concurrent calls share one download. Unknown room/month → empty chunk.
   * Treat the result as read-only (it is shared).
   * @param {string} roomId
   * @param {string} ym
   * @param {{signal?: AbortSignal}} [opts]
   */
  async chunk(roomId, ym, { signal } = {}) {
    await this._ensureLoaded(signal);
    const m = this.monthEntry(roomId, ym);
    if (!m) return emptyChunk(roomId, ym);
    const rel = m.chunk;
    const hit = this._chunks.get(rel);
    if (hit) {
      this._chunks.delete(rel);
      this._chunks.set(rel, hit);
      return hit;
    }
    return joinShared(this._chunkTasks, rel, async (sig) => {
      const data = await this.source.getJSON(rel, { fid: this._ids[rel], signal: sig });
      const chunk = normalizeChunk(data, roomId, ym, rel);
      this._chunks.set(rel, chunk);
      while (this._chunks.size > this._chunkMax) this._chunks.delete(this._chunks.keys().next().value);
      return chunk;
    }, signal);
  }

  /** Messages of a month, oldest first. */
  async messages(roomId, ym, opts = {}) {
    return (await this.chunk(roomId, ym, opts)).messages;
  }

  _index(chunk) {
    let idx = this._chunkIndex.get(chunk);
    if (!idx) {
      const byKey = new Map(chunk.messages.map((m) => [m.k, m]));
      const mediaByKey = new Map();
      for (const row of chunk.media) {
        let list = mediaByKey.get(row.k);
        if (!list) mediaByKey.set(row.k, list = []);
        list.push(row);
      }
      idx = { byKey, mediaByKey };
      this._chunkIndex.set(chunk, idx);
    }
    return idx;
  }

  /** One message by key (or null). */
  async message(roomId, ym, msgKey, opts = {}) {
    const c = await this.chunk(roomId, ym, opts);
    return this._index(c).byKey.get(msgKey) || null;
  }

  /** Media rows of one message, in message order. */
  async mediaForMessage(roomId, ym, msgKey, opts = {}) {
    const c = await this.chunk(roomId, ym, opts);
    const rows = this._index(c).mediaByKey.get(msgKey) || [];
    const msg = this._index(c).byKey.get(msgKey);
    if (!msg || !Array.isArray(msg.m)) return rows.slice();
    const order = new Map(msg.m.map((id, i) => [id, i]));
    return rows.slice().sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  }

  /**
   * Media rows of one month across rooms, newest first: [{...row, room, ym}].
   * @param {string} ym
   * @param {{roomIds?: string[]|null, kinds?: string[], signal?: AbortSignal}} [opts]
   *        kinds default ['photo','video'] ('photo' includes GIFs)
   */
  async mediaInMonth(ym, { roomIds = null, kinds = ['photo', 'video'], signal } = {}) {
    await this._ensureLoaded(signal);
    const want = expandMediaKinds(kinds);
    const set = roomIds ? new Set(roomIds) : null;
    const rooms = this._rooms.filter((r) => {
      if (set && !set.has(r.id)) return false;
      const m = this.monthEntry(r.id, ym);
      if (!m) return false;
      const c = countFor(m, [...want]);
      return c > 0 || !COUNT_KEYS.some((k) => k in m);
    });
    const chunks = await mapLimit(rooms, 4, (r) => this.chunk(r.id, ym, { signal }), signal);
    const rows = [];
    rooms.forEach((r, i) => {
      for (const row of chunks[i].media) if (want.has(row.y)) rows.push({ ...row, room: r.id, ym });
    });
    rows.sort((a, b) => b.t - a.t);               // stable: keeps room order and in-message order
    return rows;
  }

  // -- thumbnails & media ---------------------------------------------------------
  async _pack(rel, signal) {
    const hit = this._packs.get(rel);
    if (hit) {
      this._packs.delete(rel);
      this._packs.set(rel, hit);
      return hit;
    }
    return joinShared(this._packTasks, rel, async (sig) => {
      const blob = await this.source.getBlob(rel, { fid: this._ids[rel], mime: 'application/octet-stream', signal: sig });
      const pack = await KtpPack.fromBlob(blob);
      this._packs.set(rel, pack);
      this._packBytes += blob.size;
      while (this._packBytes > PACK_CACHE_MAX_BYTES && this._packs.size > 1) {
        const [k, old] = this._packs.entries().next().value;
        this._packs.delete(k);
        this._packBytes -= old.size;
      }
      return pack;
    }, signal);
  }

  _thumbKey(row, roomId, ym) {
    const m = this.monthEntry(roomId, ym);
    if (!m || !row.th) return null;
    if (row.crel && row.crel !== m.chunk) return null;   // row of a superseded chunk: offsets of a deleted pack
    const packRel = m.packs[row.th.pk];
    return packRel ? { packRel, key: `${packRel}#${row.th.o}+${row.th.l}` } : null;
  }

  /** Is `row` from an older version of its month than the loaded catalog (republished since)? */
  isStaleRow(row) {
    if (!row || !row.crel) return false;
    const m = this.monthEntry(row.room, row.ym);
    return !m || m.chunk !== row.crel;
  }

  /**
   * The current version of a row kept from an older chunk of the same month (same media id,
   * preferably the same message), or null when the month or the media is gone.
   */
  async currentRow(row, { signal, room, ym } = {}) {
    const roomId = room || row.room;
    const month = ym || row.ym;
    if (!this.monthEntry(roomId, month)) return null;
    const ch = await this.chunk(roomId, month, { signal });
    const hit = ch.media.find((r) => r.id === row.id && r.k === row.k) || ch.media.find((r) => r.id === row.id);
    return hit ? { ...hit, room: roomId, ym: month } : null;
  }

  /**
   * Object URL of a media row's thumbnail (WebP slice of the month's KTP pack), or null
   * when the row has no thumbnail. Rows from chunk()/mediaInMonth() carry room & ym.
   * @param {object} row media row
   * @param {{signal?: AbortSignal, room?: string, ym?: string}} [opts]
   * @returns {Promise<string|null>}
   */
  async thumbURL(row, { signal, room, ym } = {}) {
    if (!row || !row.th) return null;
    const roomId = room || row.room;
    const month = ym || row.ym;
    if (!roomId || !month) {
      console.warn('[kb-data] thumbURL: row.room / row.ym 이 없습니다', row && row.id);
      return null;
    }
    await this._ensureLoaded(signal);
    let r = row;
    const m = this.monthEntry(roomId, month);
    if (row.crel && m && m.chunk !== row.crel) {
      // kept by a screen across a catalog reload that republished this month
      r = await this.currentRow(row, { signal, room: roomId, ym: month });
      if (!r || !r.th) return null;
    }
    const tk = this._thumbKey(r, roomId, month);
    if (!tk) return null;
    const hit = this._urls.get(tk.key);
    if (hit) return hit;
    const pack = await this._pack(tk.packRel, signal);
    return this._urls.getOrCreate(tk.key, () => ktpSlice(pack.blob, r.th, pack.header.mime || 'image/webp'), tk.packRel);
  }

  /** Thumbnail URL if it is already created (synchronous; null otherwise). */
  cachedThumbURL(row) {
    if (!row || !row.th || !row.room || !row.ym) return null;
    const tk = this._thumbKey(row, row.room, row.ym);
    return tk ? this._urls.get(tk.key) : null;
  }

  /**
   * Revoke the thumbnail URLs of a month and drop its packs from memory (call when a
   * month section scrolled far away). Cached files stay in Cache Storage.
   */
  releaseMonth(roomId, ym) {
    const m = this.monthEntry(roomId, ym);
    if (!m) return 0;
    let n = 0;
    for (const rel of m.packs) {
      n += this._urls.deleteGroup(rel);
      const p = this._packs.get(rel);
      if (p) { this._packs.delete(rel); this._packBytes -= p.size; }
    }
    return n;
  }

  /**
   * URL for <img>/<video>: the original (if stored on this target), else the preview,
   * else null. HEIC originals prefer the JPEG preview on browsers that cannot show HEIC.
   * @param {object} row
   * @param {{preferPreview?: boolean}} [opts]
   * @returns {string|null}
   */
  mediaURL(row, { preferPreview = false } = {}) {
    if (!row) return null;
    const heic = /^image\/hei[cf]/i.test(row.mime || '') && !canDisplayHEIC();
    const order = preferPreview || heic ? ['pv', 'orig'] : ['orig', 'pv'];
    for (const which of order) {
      if (which === 'orig' && row.orig && row.p) {
        const u = this.source.mediaURL(row.p, { fid: row.fid, mime: row.mime, size: row.sz });
        if (u) return u;
      }
      if (which === 'pv' && row.pv) {
        const u = this.source.mediaURL(row.pv, { fid: row.pvfid, mime: 'image/jpeg', size: previewSize(row) });
        if (u) return u;
      }
    }
    return null;
  }

  /**
   * Original bytes as a Blob (typed with row.mime) for share/save; falls back to the
   * preview when the original is not on this target. Small files are cached (LRU).
   * @throws {NotFoundError} when neither exists (code 'no_original')
   */
  async downloadBlob(row, { signal, preferPreview = false } = {}) {
    if (!row) throw new TypeError('downloadBlob: row가 필요합니다');
    if (row.orig && row.p && !(preferPreview && row.pv)) {
      return this.source.getBlob(row.p, { fid: row.fid, mime: row.mime || 'application/octet-stream', signal });
    }
    if (row.pv) return this.source.getBlob(row.pv, { fid: row.pvfid, mime: 'image/jpeg', signal });
    throw new NotFoundError(row.to ? '썸네일만 남아 있는 사진입니다 (원본 없음).' : '이 저장소에는 원본 파일이 없습니다.',
      { code: 'no_original' });
  }

  /**
   * Object URL of the original/preview downloaded through the data layer — a fallback for
   * Drive when no service worker controls the page. Only files up to MEDIA_BLOB_MAX (a
   * video of unknown size never): the whole file sits in memory. Kept in a small LRU of its
   * own (current + neighbouring viewer slides); releaseMediaURLs() frees them all.
   * @throws {DataError} code 'too_large' for bigger files
   */
  async mediaObjectURL(row, { signal, preferPreview = false } = {}) {
    const usePv = !!(row.pv && (preferPreview || !(row.orig && row.p)));
    const key = `media#${row.id}#${usePv ? 'pv' : 'orig'}`;
    const hit = this._mediaURLs.get(key);
    if (hit) return hit;
    const size = usePv ? (previewSize(row) ?? null) : Number(row.sz);
    if ((Number.isFinite(size) && size > MEDIA_BLOB_MAX) || (!usePv && row.y === 'video' && !Number.isFinite(size))) {
      throw new DataError('파일이 커서 바로 열 수 없어요. 앱을 닫았다가 다시 열면 볼 수 있어요.', { code: 'too_large' });
    }
    const blob = await this.downloadBlob(row, { signal, preferPreview });
    // blob: URLs share the viewer's origin: a non-passive type (an .html/.svg attachment)
    // must never become a document there, so it is typed as plain bytes.
    const safe = inlineMediaType(blob.type) ? blob : blob.slice(0, blob.size, 'application/octet-stream');
    return this._mediaURLs.getOrCreate(key, () => safe, 'media');
  }

  /** Revoke the object URLs of downloaded originals (viewer closed). */
  releaseMediaURLs() {
    this._mediaURLs.clear();
  }

  /**
   * URL that downloads the original as a file without loading it into page memory (big
   * files; Content-Disposition: attachment), or null when the source cannot do that (Drive
   * without a service worker) or the original is not on this target.
   * @param {object} row
   * @param {{name?: string}} [opts]
   */
  downloadURL(row, { name = null } = {}) {
    if (!row || typeof this.source.downloadURL !== 'function') return null;
    const fileName = name || mediaFileName(row, this.tz);
    if (row.orig && row.p) return this.source.downloadURL(row.p, { fid: row.fid, mime: row.mime, name: fileName });
    if (row.pv) return this.source.downloadURL(row.pv, { fid: row.pvfid, mime: 'image/jpeg', name: fileName.replace(/\.[^.]+$/, '') + '.jpg' });
    return null;
  }

  /** A backup report JSON (e.g. lastBackup().report). */
  async report(rel, { signal } = {}) {
    return this.source.getJSON(rel, { fid: this._ids[rel], signal });
  }

  // -- search & collections -----------------------------------------------------------
  _haystack(msg) {
    let h = this._hay.get(msg);
    if (h === undefined) {
      const parts = [msg.x || ''];
      if (msg.f && msg.f.name) parts.push(msg.f.name);
      if (Array.isArray(msg.l)) parts.push(...msg.l);
      h = normalizeText(parts.join(' '));
      this._hay.set(msg, h);
    }
    return h;
  }

  /**
   * Progressive search, newest first. Yields {room, ym, message}. Gallery-only (orphan)
   * items are never results, and months without a real message are not loaded.
   * @param {string} q keywords (all must match; text, file names and links are searched)
   * @param {{roomIds?: string[]|null, senders?: string[]|null, from?: any, to?: any,
   *          kinds?: string[]|null, signal?: AbortSignal,
   *          onProgress?: (p:{done:number,total:number,ym:string|null,failed:number}) => void}} [opts]
   *   senders: sender ids (or names); from/to: epoch s | Date | 'YYYY-MM-DD' (inclusive);
   *   kinds: text | photo | video | audio | file | link | emoticon | … (null = all)
   * @throws AbortError when `signal` aborts; AuthError when access is denied.
   */
  async *search(q, { roomIds = null, senders = null, from = null, to = null, kinds = null, signal, onProgress } = {}) {
    await this._ensureLoaded(signal);
    const tz = this.tz;
    const terms = searchTerms(q);
    const fromTs = toEpochBound(from, tz, 'start');
    const toTs = toEpochBound(to, tz, 'end');
    const fromYm = fromTs !== null ? ymOf(fromTs, tz) : null;
    const toYm = toTs !== null ? ymOf(toTs, tz) : null;
    const kindSet = kinds && kinds.length && !kinds.includes('all') ? new Set(kinds) : null;
    const senderSet = senders && senders.length ? new Set(senders) : null;
    const roomSet = roomIds ? new Set(roomIds) : null;

    const plan = new Map();
    for (const r of this._rooms) {
      if (roomSet && !roomSet.has(r.id)) continue;
      for (const m of r.months) {
        if ((fromYm && m.ym < fromYm) || (toYm && m.ym > toYm)) continue;
        if (monthHasNoMessages(m)) continue;            // only gallery-only (orphan) items there
        if (kindSet && !monthMayMatch(m, kindSet)) continue;
        if (!plan.has(m.ym)) plan.set(m.ym, []);
        plan.get(m.ym).push(r.id);
      }
    }
    const yms = [...plan.keys()].sort().reverse();
    const total = yms.length;
    let failed = 0;
    const report = (done, ym) => { if (onProgress) { try { onProgress({ done, total, ym, failed }); } catch (e) { /* UI bug */ } } };
    report(0, null);

    const matches = (msg) => {
      if (isOrphanMessage(msg)) return false;            // gallery-only media, not a message
      if (senderSet && !(senderSet.has(msg.s) || senderSet.has(msg.n))) return false;
      if (fromTs !== null && msg.t < fromTs) return false;
      if (toTs !== null && msg.t > toTs) return false;
      if (kindSet && !kindMatches(msg, kindSet)) return false;
      if (!terms.length) return true;
      const h = this._haystack(msg);
      return terms.every((t) => h.includes(t));
    };
    const loadMonth = (ym) => {
      const p = Promise.all(plan.get(ym).map(async (roomId) => {
        try {
          return { roomId, chunk: await this.chunk(roomId, ym, { signal }) };
        } catch (e) {
          if (isAbortError(e) || e instanceof AuthError) throw e;
          console.warn(`[kb-data] 검색 중 ${roomId}/${ym} 을(를) 읽지 못했습니다:`, e && e.message);
          return { roomId, chunk: null, error: e };
        }
      }));
      p.catch(() => {});
      return p;
    };

    let next = yms.length ? loadMonth(yms[0]) : null;
    for (let i = 0; i < yms.length; i++) {
      throwIfAborted(signal);
      const ym = yms[i];
      const cur = next;
      next = i + 1 < yms.length ? loadMonth(yms[i + 1]) : null;     // prefetch the next month
      const loaded = await cur;
      const hits = [];
      for (const { roomId, chunk } of loaded) {
        if (!chunk) { failed++; continue; }
        for (const msg of chunk.messages) if (matches(msg)) hits.push({ room: roomId, ym, message: msg });
      }
      hits.sort((a, b) => (b.message.t - a.message.t) || (a.message.k < b.message.k ? 1 : -1));
      report(i + 1, ym);
      for (const h of hits) {
        throwIfAborted(signal);
        yield h;
      }
    }
  }

  /**
   * Rows of one kind across all months (newest first):
   *   'file'  → {room, ym, t, k, message, media|null, name, size, mime, available}
   *   'link'  → {room, ym, t, k, message, url, domain}          (one row per URL)
   *   'audio' → {room, ym, t, k, message, media|null, duration, available}
   *   'photo' | 'video' → {room, ym, t, k, message, media, available}
   * Months that failed to load are skipped (result.errors lists them); if every month
   * failed the first error is thrown.
   * @param {'file'|'link'|'audio'|'photo'|'video'} kind
   * @param {{roomIds?: string[]|null, signal?: AbortSignal, onProgress?: Function, concurrency?: number}} [opts]
   */
  async collect(kind, { roomIds = null, signal, onProgress, concurrency = 4 } = {}) {
    if (!['file', 'link', 'audio', 'photo', 'video'].includes(kind)) {
      throw new TypeError(`collect: 지원하지 않는 종류입니다 (${kind})`);
    }
    await this._ensureLoaded(signal);
    const set = roomIds ? new Set(roomIds) : null;
    const plan = [];
    for (const r of this._rooms) {
      if (set && !set.has(r.id)) continue;
      for (const m of r.months) {
        const c = Number(m[kind]);
        if (Number.isFinite(c) && c === 0) continue;
        plan.push({ roomId: r.id, ym: m.ym });
      }
    }
    const out = [];
    const errors = [];
    let done = 0;
    await mapLimit(plan, concurrency, async ({ roomId, ym }) => {
      let chunk;
      try {
        chunk = await this.chunk(roomId, ym, { signal });
      } catch (e) {
        if (isAbortError(e)) throw e;
        errors.push({ room: roomId, ym, error: e });
        chunk = null;
      }
      if (chunk) out.push(...extractRows(kind, chunk, roomId, ym, this._index(chunk)));
      done++;
      if (onProgress) { try { onProgress({ done, total: plan.length, room: roomId, ym }); } catch (e) { /* UI bug */ } }
    }, signal);
    if (plan.length && errors.length === plan.length) throw errors[0].error;
    out.sort((a, b) => (b.t - a.t) || (a.k < b.k ? 1 : a.k > b.k ? -1 : 0));
    Object.defineProperty(out, 'errors', { value: errors, enumerable: false });
    return out;
  }

  // -- user state: stars & aliases -------------------------------------------------------
  get _stateKey() { return `userstate:${this.source.id}`; }

  async _loadLocalUserState() {
    if (this._stateLoaded) return;
    if (!this._stateLoading) {
      this._stateLoading = (async () => {
        try {
          const rec = await kvGet(this._stateKey);
          if (rec && rec.state) {
            this._state = mergeUserStates(this._state, normalizeUserState(rec.state));
            this._dirty = this._dirty || !!rec.dirty;
          }
        } catch (e) { /* IndexedDB unavailable: memory only */ }
        this._stateLoaded = true;
      })();
    }
    await this._stateLoading;
  }

  async _saveLocal() {
    try { await kvSet(this._stateKey, { state: this._state, dirty: this._dirty }); } catch (e) { /* memory only */ }
  }

  _emitUserState(origin) {
    this.dispatchEvent(new CustomEvent('userstate', { detail: { origin } }));
  }

  /** Current user-state sync status (for a small indicator in 더보기). */
  get userStateStatus() {
    return {
      loaded: this._stateLoaded,
      pending: this._dirty,
      remote: !this._remoteDisabled,
      error: this.userStateError ? this.userStateError.message : null,
      syncedAt: this.userStateSyncedAt,
    };
  }

  /**
   * Pull user-state.json, merge, and push when something changed. Serialized; never
   * throws (errors land in `userStateError`). Resolves true when in sync.
   */
  syncUserState({ pull = true } = {}) {
    const run = () => this._doSync(pull);
    const p = this._syncChain.then(run, run);
    this._syncChain = p.catch(() => {});
    return p;
  }

  async _doSync(pull) {
    await this._loadLocalUserState();
    if (this._remoteDisabled) return false;
    let remote = null;
    let pulled = false;
    if (pull) {
      try {
        const r = await this.source.readUserState();
        remote = r ? normalizeUserState(r) : null;
        pulled = true;
      } catch (e) {
        this.userStateError = e;
        console.warn('[kb-data] user-state.json 을 읽지 못했습니다:', e && e.message);
        return false;
      }
    }
    const before = fingerprint(this._state);
    const merged = remote ? mergeUserStates(this._state, remote) : this._state;
    if (fingerprint(merged) !== before) {
      this._state = merged;
      await this._saveLocal();
      this._emitUserState('remote');
    }
    const needPush = this._dirty
      || (remote && fingerprint(merged) !== fingerprint(remote))
      || (pulled && !remote && hasContent(merged));
    if (needPush) {
      try {
        await this.source.writeUserState(serializeUserState(merged));
        this._dirty = false;
        this.userStateError = null;
        await this._saveLocal();
      } catch (e) {
        this.userStateError = e;
        if (e && e.code === 'read_only') this._remoteDisabled = true;
        console.warn('[kb-data] 중요 표시를 보관함에 저장하지 못했습니다 (이 기기에는 저장됨):', e && e.message);
        return false;
      }
    }
    this.userStateSyncedAt = Date.now();
    return true;
  }

  _scheduleSync(delay = 1200) {
    if (this._syncTimer) clearTimeout(this._syncTimer);
    this._syncTimer = setTimeout(() => { this._syncTimer = null; this.syncUserState().catch(() => {}); }, delay);
  }

  /** Push pending changes now (e.g. before the app is hidden). */
  async flushUserState() {
    if (this._syncTimer) { clearTimeout(this._syncTimer); this._syncTimer = null; }
    return this.syncUserState({ pull: false });
  }

  /** @param {string} key star key (see starKey()) */
  isStarred(key) {
    return !!this._state.stars[key];
  }

  /**
   * Star / unstar. Saved on this device immediately and synced to user-state.json shortly
   * after. `meta` = small object the UI wants back from starred() (room, ym, t, y, x…).
   * @returns {Promise<boolean>} the new starred state
   */
  async toggleStar(key, meta = null) {
    await this._loadLocalUserState();
    return this.setStar(key, !this.isStarred(key), meta);
  }

  /** Set a star explicitly (idempotent). @returns {Promise<boolean>} */
  async setStar(key, starred, meta = null) {
    if (!key || typeof key !== 'string') throw new TypeError('별표 키가 올바르지 않습니다');
    await this._loadLocalUserState();
    const now = Math.max(Date.now(), (this._state.updated_at || 0) + 1);
    const s = this._state;
    if (starred) {
      s.stars[key] = { at: now, meta: sanitizeMeta(meta) };
      delete s.unstars[key];
    } else {
      if (!s.stars[key] && s.unstars[key]) return false;
      delete s.stars[key];
      s.unstars[key] = now;
    }
    s.updated_at = now;
    this._dirty = true;
    await this._saveLocal();
    this._emitUserState('local');
    this._scheduleSync();
    return !!starred;
  }

  /** Starred items, most recent first: [{key, meta, at}] (at = epoch ms). */
  starred() {
    return Object.entries(this._state.stars)
      .map(([key, v]) => ({ key, meta: v.meta ?? null, at: v.at }))
      .sort((a, b) => b.at - a.at);
  }

  /** Room display-name override stored in user state ('' / null removes it). */
  async setAlias(roomId, name) {
    await this._loadLocalUserState();
    const now = Math.max(Date.now(), (this._state.updated_at || 0) + 1);
    this._state.aliases[roomId] = { name: name ? String(name).trim() || null : null, at: now };
    this._state.updated_at = now;
    this._dirty = true;
    await this._saveLocal();
    this._emitUserState('local');
    this._scheduleSync();
  }

  alias(roomId) {
    const a = this._state.aliases[roomId];
    return (a && a.name) || null;
  }

  // -- lifecycle ------------------------------------------------------------------------
  /** Drop in-memory caches and revoke every object URL (cached files stay). */
  clearMemory() {
    this._chunks.clear();
    this._packs.clear();
    this._packBytes = 0;
    this._urls.clear();
    this._mediaURLs.clear();
  }

  /** Stop listeners/timers and free memory (the archive must not be used afterwards). */
  dispose() {
    this._disposed = true;
    this._freshToken = null;
    if (this._syncTimer) clearTimeout(this._syncTimer);
    if (typeof removeEventListener === 'function') removeEventListener('pagehide', this._onHide);
    if (this._visHandler && typeof document !== 'undefined') document.removeEventListener('visibilitychange', this._visHandler);
    this.clearMemory();
  }
}

// ---------------------------------------------------------------------------
// search / collect helpers
// ---------------------------------------------------------------------------

function monthMayMatch(m, kindSet) {
  for (const k of kindSet) {
    const key = { text: 'msg', reply: 'msg', emoticon: 'msg', photo: 'photo', gif: 'photo', video: 'video', audio: 'audio', file: 'file', link: 'link' }[k] || 'msg';
    const v = Number(m[key]);
    if (!Number.isFinite(v) || v > 0) return true;
  }
  return false;
}

function kindMatches(msg, kindSet) {
  const y = msg.y;
  if (kindSet.has(y)) return true;
  if (kindSet.has('text') && y === 'reply') return true;
  if (kindSet.has('link') && Array.isArray(msg.l) && msg.l.length) return true;
  if (kindSet.has('photo') && y === 'gif') return true;
  return false;
}

function extractRows(kind, chunk, roomId, ym, idx) {
  const rows = [];
  const withCtx = (row) => ({ ...row, room: roomId, ym });
  if (kind === 'link') {
    for (const msg of chunk.messages) {
      let urls = Array.isArray(msg.l) ? msg.l : [];
      if (!urls.length && msg.y === 'link' && msg.x) urls = msg.x.match(URL_RE) || [];
      for (const url of urls) rows.push({ room: roomId, ym, t: msg.t, k: msg.k, message: msg, url, domain: linkDomain(url) });
    }
    return rows;
  }
  const mediaKinds = kind === 'photo' ? new Set(['photo', 'gif']) : new Set([kind]);
  const covered = new Set();
  for (const row of chunk.media) {
    if (!mediaKinds.has(row.y)) continue;
    const msg = idx.byKey.get(row.k) || null;
    covered.add(row.k);
    const base = { room: roomId, ym, t: row.t, k: row.k, message: msg, media: withCtx(row), available: !!(row.orig || row.pv) };
    if (kind === 'file') {
      Object.assign(base, {
        name: row.nm || (msg && msg.f && msg.f.name) || `${row.id}.${row.ext}`,
        size: row.sz ?? (msg && msg.f && msg.f.size) ?? null,
        mime: row.mime || 'application/octet-stream',
      });
    } else if (kind === 'audio' || kind === 'video') {
      base.duration = row.d ?? null;
    }
    rows.push(base);
  }
  if (kind === 'file' || kind === 'audio' || kind === 'video' || kind === 'photo') {
    // messages whose media never reached the archive (expired / not downloaded)
    for (const msg of chunk.messages) {
      if (covered.has(msg.k)) continue;
      const isKind = kind === 'photo' ? msg.y === 'photo' : msg.y === kind;
      if (!isKind) continue;
      const base = { room: roomId, ym, t: msg.t, k: msg.k, message: msg, media: null, available: false };
      if (kind === 'file') {
        Object.assign(base, { name: (msg.f && msg.f.name) || '(파일)', size: (msg.f && msg.f.size) ?? null, mime: null });
      } else if (kind === 'audio' || kind === 'video') {
        base.duration = null;
      }
      rows.push(base);
    }
  }
  return rows;
}
