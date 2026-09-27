// source.js — DataSource interface, shared error classes, createSource() (SPEC §9.1).
//
// A DataSource reads files of one published archive (SPEC §5.5) by archive-relative
// path ('catalog.json', 'rooms/c1/2026-09.0a1b2c3d4e.json.gz', ...):
//
//   kind: 'drive' | 'http'
//   id:   stable namespace used for cache keys ('drive:<rootId>' | 'http:<base URL>')
//   async getJSON(rel, {fid, mutable, signal, info})  → parsed JSON (gzip handled)
//   async getBytes(rel, {fid, signal})                → ArrayBuffer
//   async getBlob(rel, {fid, mime, signal})           → Blob
//   mediaURL(rel, {fid, mime, size})                  → URL for <img>/<video> (or null)
//   downloadURL(rel, {fid, mime, name})               → URL that saves the file (or null)
//   async readUserState()                             → object | null
//   async writeUserState(obj)
//
// BaseSource implements caching (cache.js policy), in-flight de-duplication and
// AbortSignal handling on top of one primitive that subclasses provide:
//   async _download(rel, {fid, mutable, signal}) → Response (ok)  or throws a DataError.

import {
  APP_ROOT, DATA_CACHE, META_CACHE, cacheKeyURL, cacheMatch, cachePolicy, cachePut,
  mediaCacheMatch, mediaCachePut,
} from './cache.js';

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

/** Base class of data-layer errors. `code` is a stable machine-readable reason. */
export class DataError extends Error {
  /**
   * @param {string} message Korean, shown to the user
   * @param {{code?: string, status?: number, rel?: string, cause?: any}} [opts]
   */
  constructor(message, { code = 'data_error', status = 0, rel = undefined, cause = undefined } = {}) {
    super(message);
    this.name = 'DataError';
    this.code = code;
    this.status = status;
    if (rel !== undefined) this.rel = rel;
    if (cause !== undefined) this.cause = cause;
  }
}

/** Authentication/authorization problem — the UI should offer to paste a new setup code. */
export class AuthError extends DataError {
  constructor(message, opts = {}) { super(message, { code: 'auth', ...opts }); this.name = 'AuthError'; }
}

/** The file does not exist in the archive (HTTP 404 / Drive file not found). */
export class NotFoundError extends DataError {
  constructor(message, opts = {}) { super(message, { code: 'not_found', ...opts }); this.name = 'NotFoundError'; }
}

/** Network unreachable, server error or rate limit — usually temporary (retry later). */
export class NetworkError extends DataError {
  constructor(message, opts = {}) { super(message, { code: 'network', ...opts }); this.name = 'NetworkError'; }
}

/** The data is corrupt or in an unsupported format. */
export class DataFormatError extends DataError {
  constructor(message, opts = {}) { super(message, { code: 'format', ...opts }); this.name = 'DataFormatError'; }
}

export function isAbortError(e) {
  return !!e && (e.name === 'AbortError' || e.code === 20);
}

/** The error to throw when `signal` is aborted. */
export function abortError(signal) {
  const r = signal && signal.reason;
  if (r instanceof Error && isAbortError(r)) return r;
  try {
    return new DOMException('작업이 취소되었습니다', 'AbortError');
  } catch (e) {
    const err = new Error('작업이 취소되었습니다');
    err.name = 'AbortError';
    return err;
  }
}

export function throwIfAborted(signal) {
  if (signal && signal.aborted) throw abortError(signal);
}

/** Default bound for waiting on a server's response headers (a hung connection must end). */
export const FETCH_TIMEOUT_MS = 25000;

/**
 * fetch() whose wait for the response HEADERS is bounded by `timeoutMs` (the body may take
 * longer: big media downloads stream for minutes). A timeout rejects with
 * NetworkError(code 'timeout'); an abort of `signal` rejects with the AbortError as usual.
 * @param {typeof fetch} fetchFn
 * @param {string} url
 * @param {RequestInit} [init]
 * @param {{timeoutMs?: number, signal?: AbortSignal, message?: string}} [opts]
 * @returns {Promise<Response>}
 */
export function fetchWithTimeout(fetchFn, url, init = {}, { timeoutMs = FETCH_TIMEOUT_MS, signal = init.signal, message } = {}) {
  if (signal && signal.aborted) return Promise.reject(abortError(signal));
  if (!timeoutMs || timeoutMs <= 0 || !Number.isFinite(timeoutMs)) return fetchFn(url, init);
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(signal && signal.reason);
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
      // settle now even if the fetch implementation ignores the abort
      reject(new NetworkError(message || '서버가 응답하지 않습니다. 인터넷 연결을 확인해 주세요.', { code: 'timeout' }));
    }, timeoutMs);
    const done = () => { clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); };
    Promise.resolve().then(() => fetchFn(url, { ...init, signal: ctrl.signal })).then((res) => {
      done();
      if (timedOut) { try { if (res && res.body) res.body.cancel().catch(() => {}); } catch (e) { /* ignore */ } return; }
      resolve(res);
    }, (e) => { done(); if (!timedOut) reject(e); });
  });
}

/** Promise that resolves after `ms` or rejects with AbortError when `signal` aborts. */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(abortError(signal)); return; }
    const t = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    function onAbort() { clearTimeout(t); reject(abortError(signal)); }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export function isGzip(u8) {
  return u8.length >= 2 && u8[0] === 0x1f && u8[1] === 0x8b;
}

/**
 * Decode JSON bytes, gunzipping when they start with the gzip magic (the server may or
 * may not have sent Content-Encoding: gzip, so the bytes decide).
 * @param {ArrayBuffer|Uint8Array} buf
 * @param {string} [rel] for error messages
 */
export async function decodeJSONBytes(buf, rel = '') {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let text;
  if (isGzip(u8)) {
    if (typeof DecompressionStream !== 'function') {
      throw new DataFormatError('이 브라우저는 압축된 대화 파일을 열 수 없습니다 (iOS 16.4 이상이 필요합니다).',
        { code: 'no_decompression', rel });
    }
    try {
      const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'));
      text = await new Response(stream).text();
    } catch (e) {
      throw new DataFormatError('압축된 대화 파일이 손상되었습니다.', { code: 'bad_gzip', rel, cause: e });
    }
  } else {
    text = new TextDecoder('utf-8').decode(u8);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new DataFormatError('보관함 파일(JSON)을 읽을 수 없습니다.', { code: 'bad_json', rel, cause: e });
  }
}

/**
 * Join (or start) a shared in-flight task. Each caller may abort independently; the
 * underlying task is aborted only when every waiter has gone.
 * @template T
 * @param {Map<string, any>} map
 * @param {string} key
 * @param {(signal: AbortSignal) => Promise<T>} factory
 * @param {AbortSignal} [signal]
 * @returns {Promise<T>}
 */
export function joinShared(map, key, factory, signal) {
  if (signal && signal.aborted) return Promise.reject(abortError(signal));
  let e = map.get(key);
  if (!e) {
    const ctrl = new AbortController();
    e = { ctrl, waiters: 0, promise: null };
    const entry = e;
    entry.promise = Promise.resolve().then(() => factory(ctrl.signal));
    entry.promise.catch(() => {}).finally(() => { if (map.get(key) === entry) map.delete(key); });
    map.set(key, entry);
  }
  const entry = e;
  entry.waiters++;
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = () => {
      done = true;
      entry.waiters--;
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    function onAbort() {
      if (done) return;
      finish();
      if (entry.waiters <= 0) {
        if (map.get(key) === entry) map.delete(key);
        entry.ctrl.abort();
      }
      reject(abortError(signal));
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    entry.promise.then((v) => { if (!done) { finish(); resolve(v); } },
      (err) => { if (!done) { finish(); reject(err); } });
  });
}

// ---------------------------------------------------------------------------
// BaseSource
// ---------------------------------------------------------------------------

/**
 * How long a network-first file (catalog.json) may take before the saved copy is shown
 * instead while the download continues in the background (slow LTE, captive portals).
 */
export const STALE_AFTER_MS = 2000;

export class BaseSource {
  /**
   * @param {{id: string, fetch?: typeof fetch, timeoutMs?: number, staleAfterMs?: number}} opts
   *   timeoutMs: bound on waiting for response headers (0 = none);
   *   staleAfterMs: see STALE_AFTER_MS (0 = always wait for the network)
   */
  constructor({ id, fetch: fetchFn, timeoutMs = FETCH_TIMEOUT_MS, staleAfterMs = STALE_AFTER_MS } = {}) {
    /** @type {string} */
    this.id = id;
    this._fetch = fetchFn || ((...a) => fetch(...a));
    this._inflight = new Map();
    this.timeoutMs = timeoutMs;
    this.staleAfterMs = staleAfterMs;
    /** @type {'drive'|'http'} */
    this.kind = 'http';
  }

  /* eslint-disable class-methods-use-this, no-unused-vars */
  /** @abstract @returns {Promise<Response>} */
  async _download(rel, opts) { throw new DataError('구현되지 않았습니다', { code: 'not_implemented' }); }
  /** @abstract */
  mediaURL(rel, opts) { return null; }
  /** URL that downloads the file without loading it into page memory, or null. */
  downloadURL(rel, opts) { return null; }
  /** @abstract */
  async readUserState() { return null; }
  /** @abstract */
  async writeUserState(obj) { throw new DataError('이 보관함에는 저장할 수 없습니다', { code: 'read_only' }); }
  /** Forget remembered path → file lookups (a different archive now sits behind this source). */
  forgetPaths() {}
  /* eslint-enable */

  /**
   * Blob of an archive file, cached according to cachePolicy(rel) (or network-first when
   * `mutable`). `info` (optional object) receives
   *   {fromCache, stale, fresh, authError}:
   *   stale     — the saved copy was returned (offline, slow network or access denied);
   *   fresh     — Promise<Blob> of the download still running when the saved copy was
   *               returned because the network was slow (null otherwise);
   *   authError — the AuthError that made the saved copy necessary (null otherwise).
   * @param {string} rel
   * @param {{fid?: string, mutable?: boolean, signal?: AbortSignal, info?: object}} [opts]
   * @returns {Promise<Blob>}
   */
  async _blob(rel, { fid, mutable = false, signal, info } = {}) {
    const policy = mutable ? 'network-first' : cachePolicy(rel);
    const key = `${policy}|${rel}`;
    const res = await joinShared(this._inflight, key, (sig) => this._load(rel, policy, fid, sig), signal);
    if (info && typeof info === 'object') {
      Object.assign(info, { fromCache: res.fromCache, stale: res.stale, fresh: res.fresh || null, authError: res.authError || null });
    }
    return res.blob;
  }

  /**
   * network-first with a saved copy: the download wins when it answers within
   * `staleAfterMs`; otherwise the saved copy is returned right away and the download keeps
   * running (`fresh`). Offline (NetworkError) or access denied (AuthError: revoked Google
   * connection, rotated server key) → the saved copy, read-only, with `authError` set.
   */
  async _loadNetworkFirst(rel, url, fid, signal) {
    const download = (async () => {
      const blob = await (await this._download(rel, { fid, signal, mutable: true })).blob();
      await cachePut(META_CACHE, url, blob);
      return blob;
    })();
    download.catch(() => {});
    const saved = async (e) => {
      const denied = e instanceof AuthError;
      if (e instanceof NetworkError || denied) {
        const hit = await cacheMatch(META_CACHE, url);
        if (hit) {
          console.info(`[kb-data] ${denied ? '접근 거부' : '오프라인'}: 저장된 ${rel} 사용`);
          return { blob: await hit.blob(), fromCache: true, stale: true, authError: denied ? e : null };
        }
      }
      throw e;
    };
    const wait = Number(this.staleAfterMs) || 0;
    if (wait <= 0) {
      try { return { blob: await download, fromCache: false, stale: false }; } catch (e) { return saved(e); }
    }
    const SLOW = {};
    let timer = null;
    const first = await Promise.race([
      download.then((blob) => ({ blob }), (error) => ({ error })),
      new Promise((resolve) => { timer = setTimeout(() => resolve(SLOW), wait); }),
    ]);
    clearTimeout(timer);
    if (first !== SLOW) {
      if (first.error) return saved(first.error);
      return { blob: first.blob, fromCache: false, stale: false };
    }
    const hit = await cacheMatch(META_CACHE, url);
    if (!hit) {
      try { return { blob: await download, fromCache: false, stale: false }; } catch (e) { return saved(e); }
    }
    console.info(`[kb-data] 네트워크가 느려 저장된 ${rel} 을(를) 먼저 보여 줍니다`);
    return { blob: await hit.blob(), fromCache: true, stale: true, fresh: download };
  }

  async _load(rel, policy, fid, signal) {
    const url = cacheKeyURL(this.id, rel);
    if (policy === 'immutable') {
      const hit = await cacheMatch(DATA_CACHE, url);
      if (hit) return { blob: await hit.blob(), fromCache: true, stale: false };
      const blob = await (await this._download(rel, { fid, signal })).blob();
      await cachePut(DATA_CACHE, url, blob);
      return { blob, fromCache: false, stale: false };
    }
    if (policy === 'media') {
      const hit = await mediaCacheMatch(url);
      if (hit) return { blob: await hit.blob(), fromCache: true, stale: false };
      const blob = await (await this._download(rel, { fid, signal })).blob();
      mediaCachePut(url, blob).catch(() => {});
      return { blob, fromCache: false, stale: false };
    }
    if (policy === 'network-first') return this._loadNetworkFirst(rel, url, fid, signal);
    const blob = await (await this._download(rel, { fid, signal })).blob();
    return { blob, fromCache: false, stale: false };
  }

  /**
   * Parsed JSON of an archive file ('.json' or gzip '.json.gz').
   * @param {string} rel
   * @param {{fid?: string, mutable?: boolean, signal?: AbortSignal, info?: object}} [opts]
   */
  async getJSON(rel, opts = {}) {
    const blob = await this._blob(rel, opts);
    return decodeJSONBytes(await blob.arrayBuffer(), rel);
  }

  /** @returns {Promise<ArrayBuffer>} */
  async getBytes(rel, opts = {}) {
    const blob = await this._blob(rel, opts);
    return blob.arrayBuffer();
  }

  /** @returns {Promise<Blob>} typed with `mime` when given */
  async getBlob(rel, opts = {}) {
    const blob = await this._blob(rel, opts);
    const mime = opts.mime;
    return mime && blob.type !== mime ? blob.slice(0, blob.size, mime) : blob;
  }
}

// ---------------------------------------------------------------------------
// factory + service worker registration
// ---------------------------------------------------------------------------

/**
 * Create the DataSource for the saved settings.
 * @param {{mode:'drive'|'http'|'demo'|null, setup?:object|null, httpBase?:string|null}} settings
 * @param {object} [opts] passed to the source constructor (e.g. {fetch} for tests)
 * @returns {Promise<import('./drive.js').DriveSource|import('./http.js').HttpSource>}
 */
export async function createSource(settings, opts = {}) {
  const s = settings || {};
  switch (s.mode) {
    case 'drive': {
      if (!s.setup) {
        throw new AuthError('Google Drive 설정 코드가 없습니다. Mac 프로그램의 설정 코드를 붙여넣어 주세요.',
          { code: 'no_setup' });
      }
      const { DriveSource } = await import('./drive.js');
      return new DriveSource(s.setup, opts);
    }
    case 'http': {
      if (!s.httpBase) throw new DataError('보관함 서버 주소가 설정되지 않았습니다.', { code: 'no_base' });
      const { HttpSource } = await import('./http.js');
      return new HttpSource(s.httpBase, opts);
    }
    case 'demo': {
      const { HttpSource } = await import('./http.js');
      return new HttpSource(s.httpBase || './demo/', opts);
    }
    default:
      throw new DataError('데이터 소스가 설정되지 않았습니다.', { code: 'no_source' });
  }
}

/** True when a service worker controls this page (needed for Drive media URLs). */
export function swControlled() {
  try { return !!(navigator.serviceWorker && navigator.serviceWorker.controller); } catch (e) { return false; }
}

/**
 * Register ./sw.js (viewer root, classic script, updateViaCache 'none') and wait until
 * it controls the page (or `timeoutMs` passed). Never throws.
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<{supported: boolean, controlled: boolean, registration: ServiceWorkerRegistration|null, error?: any}>}
 */
export async function registerServiceWorker({ timeoutMs = 6000 } = {}) {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) {
    return { supported: false, controlled: false, registration: null };
  }
  let registration = null;
  try {
    const hadController = !!navigator.serviceWorker.controller;
    registration = await navigator.serviceWorker.register(new URL('sw.js', APP_ROOT).href,
      { scope: APP_ROOT, updateViaCache: 'none' });
    if (hadController) registration.update().catch(() => {});
  } catch (error) {
    console.warn('[kb-data] 서비스 워커 등록 실패:', error && error.message);
    return { supported: true, controlled: false, registration: null, error };
  }
  if (!navigator.serviceWorker.controller) {
    await new Promise((resolve) => {
      const t = setTimeout(resolve, timeoutMs);
      navigator.serviceWorker.addEventListener('controllerchange', () => { clearTimeout(t); resolve(); }, { once: true });
    });
  }
  const controller = navigator.serviceWorker.controller;
  if (controller) {
    // files loaded before the worker took control (first visit) → app shell cache, for offline use
    try {
      const urls = [location.href.split('#')[0], ...performance.getEntriesByType('resource').map((e) => e.name)]
        .filter((u) => u.startsWith(APP_ROOT));
      controller.postMessage({ type: 'CACHE_URLS', urls });
    } catch (e) { /* optional */ }
  }
  return { supported: true, controlled: !!controller, registration };
}
