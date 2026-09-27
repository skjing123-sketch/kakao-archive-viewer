// cache.js — persistent storage helpers for the viewer data layer (SPEC §9.1).
//
// * IndexedDB: ONE memoized connection (reset when the browser closes it — iOS does
//   that when the app is backgrounded), a tiny key/value store ('kv') and the LRU index
//   of the media cache ('lru'). The same database/schema is used by sw.js (which cannot
//   import modules) — keep DB_NAME / DB_VERSION / the upgrade code in sync with sw.js.
// * Cache Storage: immutable archive files (hashed chunk/pack names, reports) are cached
//   forever; catalog.json / user-state.json keep an offline copy (network-first); media
//   blobs (originals/previews) live in an LRU-capped cache (~300 MB) shared with sw.js.
//
// Every helper degrades gracefully: without Cache Storage (insecure http:// origin on the
// LAN, old browsers) or IndexedDB (some private modes) the viewer still works, just
// without offline copies.

/** Absolute URL of the viewer root (the folder that contains index.html and sw.js). */
export const APP_ROOT = new URL('../../', import.meta.url).href;

export const DB_NAME = 'kakaobackup-viewer';
export const DB_VERSION = 1;
export const KV_STORE = 'kv';
export const LRU_STORE = 'lru';

export const CACHE_PREFIX = 'kb-';
export const SHELL_CACHE_PREFIX = 'kb-shell-';   // owned by sw.js, survives clearAll()
export const DATA_CACHE = 'kb-data-v1';          // immutable: rooms/*.json.gz, thumbs/*.ktp, reports/*.json
export const META_CACHE = 'kb-meta-v1';          // offline copies of catalog.json / user-state.json
export const MEDIA_CACHE = 'kb-media-v1';        // LRU: media/*, previews/*, sw-media/<fid> (sw.js)

export const MEDIA_CACHE_MAX_BYTES = 300 * 1024 * 1024;
export const MEDIA_ITEM_MAX_BYTES = 40 * 1024 * 1024;   // bigger files are streamed, never cached

// ---------------------------------------------------------------------------
// IndexedDB
// ---------------------------------------------------------------------------

let dbPromise = null;

/** Create the object stores (identical code in sw.js). */
export function upgradeDB(db) {
  if (!db.objectStoreNames.contains(KV_STORE)) db.createObjectStore(KV_STORE);
  if (!db.objectStoreNames.contains(LRU_STORE)) {
    const s = db.createObjectStore(LRU_STORE, { keyPath: 'url' });
    s.createIndex('at', 'at');
  }
}

/** True when IndexedDB exists in this context. */
export function hasIndexedDB() {
  try { return typeof indexedDB !== 'undefined' && indexedDB !== null; } catch (e) { return false; }
}

/**
 * The memoized IndexedDB connection. Rejects (and forgets the failure, so the next call
 * retries) when IndexedDB is unavailable or does not answer within `timeoutMs`.
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<IDBDatabase>}
 */
export function openDB({ timeoutMs = 4000 } = {}) {
  if (dbPromise) return dbPromise;
  const p = new Promise((resolve, reject) => {
    if (!hasIndexedDB()) { reject(new Error('IndexedDB를 사용할 수 없습니다')); return; }
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; reject(new Error('IndexedDB가 응답하지 않습니다')); }
    }, timeoutMs);
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      settled = true; clearTimeout(timer); reject(e); return;
    }
    req.onupgradeneeded = () => upgradeDB(req.result);
    req.onsuccess = () => {
      const db = req.result;
      if (settled) { db.close(); return; }
      settled = true; clearTimeout(timer);
      const forget = () => { if (dbPromise === p) dbPromise = null; };
      db.onversionchange = () => { try { db.close(); } catch (e) { /* ignore */ } forget(); };
      db.onclose = forget;
      resolve(db);
    };
    req.onerror = () => { if (!settled) { settled = true; clearTimeout(timer); reject(req.error); } };
    req.onblocked = () => { /* another tab holds an older version; wait for the timeout */ };
  });
  dbPromise = p;
  p.catch(() => { if (dbPromise === p) dbPromise = null; });
  return p;
}

function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Run `fn(stores...)` inside one transaction and resolve with its (awaited) return value
 * once the transaction completed. Retries once when the connection was closed under us.
 * @template T
 * @param {string|string[]} storeNames
 * @param {IDBTransactionMode} mode
 * @param {(...stores: IDBObjectStore[]) => T|Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function idbTx(storeNames, mode, fn) {
  const names = Array.isArray(storeNames) ? storeNames : [storeNames];
  for (let attempt = 0; ; attempt++) {
    const db = await openDB();
    let tx;
    try {
      tx = db.transaction(names, mode);
    } catch (e) {
      // InvalidStateError: connection closing (iOS background) → reopen once
      dbPromise = null;
      if (attempt === 0) continue;
      throw e;
    }
    const done = new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('IndexedDB 트랜잭션이 취소되었습니다'));
    });
    done.catch(() => {});
    let result;
    try {
      result = await fn(...names.map((n) => tx.objectStore(n)));
    } catch (e) {
      try { tx.abort(); } catch (e2) { /* already finished */ }
      throw e;
    }
    await done;
    return result;
  }
}

/** @returns {Promise<any>} the stored value or undefined */
export async function kvGet(key) {
  return idbTx(KV_STORE, 'readonly', (s) => reqP(s.get(key)));
}

export async function kvSet(key, value) {
  await idbTx(KV_STORE, 'readwrite', (s) => { s.put(value, key); });
}

export async function kvDel(key) {
  await idbTx(KV_STORE, 'readwrite', (s) => { s.delete(key); });
}

/** Keys of the kv store starting with `prefix`. */
export async function kvKeys(prefix = '') {
  const keys = await idbTx(KV_STORE, 'readonly', (s) => reqP(s.getAllKeys()));
  return keys.filter((k) => typeof k === 'string' && k.startsWith(prefix));
}

// ---------------------------------------------------------------------------
// cache policy
// ---------------------------------------------------------------------------

/**
 * How an archive file is cached (SPEC §5.5 layout).
 * @param {string} rel archive-relative path
 * @returns {'network-first'|'immutable'|'media'|'network'}
 */
export function cachePolicy(rel) {
  const r = String(rel || '');
  if (r === 'catalog.json' || r === 'user-state.json') return 'network-first';
  if (/^rooms\/[^/]+\/\d{4}-\d{2}\.[0-9a-f]{10}\.json\.gz$/.test(r)) return 'immutable';
  if (/^thumbs\/[^/]+\/\d{4}-\d{2}(-\d+)?\.[0-9a-f]{10}\.ktp$/.test(r)) return 'immutable';
  if (/^reports\/[^/]+\.json$/.test(r)) return 'immutable';
  if (/^(media|previews)\//.test(r)) return 'media';
  return 'network';
}

/**
 * Synthetic same-origin URL used as the Cache Storage key of an archive file.
 * `ns` separates archives (e.g. 'drive:<rootId>' vs 'http:<base>').
 */
export function cacheKeyURL(ns, rel) {
  return new URL(`__kb/${encodeURIComponent(ns)}/${rel}`, APP_ROOT).href;
}

// ---------------------------------------------------------------------------
// Cache Storage
// ---------------------------------------------------------------------------

const openCaches = new Map();

export function hasCacheStorage() {
  try { return typeof caches !== 'undefined' && caches !== null && typeof caches.open === 'function'; } catch (e) { return false; }
}

function openCache(name) {
  let p = openCaches.get(name);
  if (!p) {
    p = caches.open(name);
    openCaches.set(name, p);
    p.catch(() => openCaches.delete(name));
  }
  return p;
}

/** Cached response or null (never throws). */
export async function cacheMatch(cacheName, url) {
  if (!hasCacheStorage()) return null;
  try {
    const c = await openCache(cacheName);
    return (await c.match(url)) || null;
  } catch (e) {
    return null;
  }
}

/**
 * Store a copy (Blob or Response). Never throws; returns false when it could not be
 * stored (no Cache Storage, quota exceeded even after trimming the media cache).
 */
export async function cachePut(cacheName, url, body, { contentType } = {}) {
  if (!hasCacheStorage()) return false;
  const make = () => (body instanceof Response ? body.clone()
    : new Response(body, { headers: { 'Content-Type': contentType || (body && body.type) || 'application/octet-stream' } }));
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const c = await openCache(cacheName);
      await c.put(url, make());
      return true;
    } catch (e) {
      if (attempt === 0 && e && e.name === 'QuotaExceededError') {
        await lruEvict(Math.floor(MEDIA_CACHE_MAX_BYTES / 3)).catch(() => {});
        continue;
      }
      console.warn('[kb-cache] 캐시에 저장하지 못했습니다:', e && e.message);
      return false;
    }
  }
  return false;
}

export async function cacheDelete(cacheName, url) {
  if (!hasCacheStorage()) return false;
  try { return await (await openCache(cacheName)).delete(url); } catch (e) { return false; }
}

// ---------------------------------------------------------------------------
// LRU media cache (shared with sw.js)
// ---------------------------------------------------------------------------

const touchedAt = new Map();

async function lruTouch(url, size) {
  const now = Date.now();
  const last = touchedAt.get(url);
  if (size === undefined && last && now - last < 60000) return;   // throttle access updates
  touchedAt.set(url, now);
  try {
    await idbTx(LRU_STORE, 'readwrite', async (s) => {
      if (size === undefined) {
        const cur = await reqP(s.get(url));
        if (cur) s.put({ ...cur, at: now });
      } else {
        s.put({ url, size, at: now });
      }
    });
  } catch (e) { /* IndexedDB unavailable: cache without LRU accounting */ }
}

/** Total bytes accounted in the media LRU index. */
export async function mediaCacheBytes() {
  try {
    const all = await idbTx(LRU_STORE, 'readonly', (s) => reqP(s.getAll()));
    return all.reduce((a, e) => a + (e.size || 0), 0);
  } catch (e) { return 0; }
}

/**
 * Evict least-recently-used media entries until the total is ≤ maxBytes.
 * @returns {Promise<number>} bytes freed
 */
export async function lruEvict(maxBytes = MEDIA_CACHE_MAX_BYTES) {
  let entries;
  try {
    entries = await idbTx(LRU_STORE, 'readonly', (s) => reqP(s.getAll()));
  } catch (e) { return 0; }
  let total = entries.reduce((a, e) => a + (e.size || 0), 0);
  if (total <= maxBytes) return 0;
  entries.sort((a, b) => (a.at || 0) - (b.at || 0));
  const victims = [];
  for (const e of entries) {
    if (total <= maxBytes) break;
    victims.push(e);
    total -= e.size || 0;
  }
  let freed = 0;
  for (const v of victims) {
    await cacheDelete(MEDIA_CACHE, v.url);
    touchedAt.delete(v.url);
    freed += v.size || 0;
  }
  try {
    await idbTx(LRU_STORE, 'readwrite', (s) => { for (const v of victims) s.delete(v.url); });
  } catch (e) { /* ignore */ }
  return freed;
}

/** Cached media Response (and bump its LRU time) or null. */
export async function mediaCacheMatch(url) {
  const r = await cacheMatch(MEDIA_CACHE, url);
  if (r) lruTouch(url);
  return r;
}

/**
 * Cache a media blob under the LRU cap. Blobs larger than `itemMax` are not cached.
 * @param {string} url cache key
 * @param {Blob} blob
 * @param {{maxBytes?: number, itemMax?: number}} [opts]
 */
export async function mediaCachePut(url, blob, { maxBytes = MEDIA_CACHE_MAX_BYTES, itemMax = MEDIA_ITEM_MAX_BYTES } = {}) {
  if (!blob || blob.size > itemMax || blob.size > maxBytes) return false;
  const ok = await cachePut(MEDIA_CACHE, url, blob);
  if (!ok) return false;
  await lruTouch(url, blob.size);
  await lruEvict(maxBytes);
  return true;
}

// ---------------------------------------------------------------------------
// maintenance
// ---------------------------------------------------------------------------

/**
 * Delete cached immutable files of archive `ns` that the current catalog no longer
 * references (superseded month chunks / packs). `keep` = Set of archive-relative paths.
 * @returns {Promise<number>} number of entries deleted
 */
export async function pruneDataCache(ns, keep) {
  if (!hasCacheStorage()) return 0;
  const prefix = cacheKeyURL(ns, '');
  let n = 0;
  try {
    const c = await openCache(DATA_CACHE);
    for (const req of await c.keys()) {
      if (!req.url.startsWith(prefix)) continue;
      const rel = decodeURI(req.url.slice(prefix.length));
      if (!/^(rooms|thumbs)\//.test(rel) || keep.has(rel)) continue;
      if (await c.delete(req)) n++;
    }
  } catch (e) { /* ignore */ }
  return n;
}

/**
 * Forget the cached files of archive `ns` because a DIFFERENT archive (another
 * catalog.archive_id) now sits behind the same source: every cached month chunk, KTP pack
 * and report of `ns` is deleted. Media originals/previews are content-addressed (same path
 * = same bytes) and stay; so do settings, tokens and stars.
 * @returns {Promise<number>} number of entries deleted
 */
export async function purgeArchiveData(ns) {
  if (!hasCacheStorage()) return 0;
  const prefix = cacheKeyURL(ns, '');
  let n = 0;
  try {
    const c = await openCache(DATA_CACHE);
    for (const req of await c.keys()) {
      if (req.url.startsWith(prefix) && await c.delete(req)) n++;
    }
  } catch (e) { /* ignore */ }
  return n;
}

/**
 * "캐시 비우기": delete every cached archive file (data, offline copies, media, LRU
 * index, Drive id lookups). Settings, the Google token, local stars and the app shell
 * cache are kept.
 * @returns {Promise<{caches: string[]}>}
 */
export async function clearAll() {
  const deleted = [];
  if (hasCacheStorage()) {
    try {
      for (const name of await caches.keys()) {
        if (name.startsWith(CACHE_PREFIX) && !name.startsWith(SHELL_CACHE_PREFIX)) {
          if (await caches.delete(name)) deleted.push(name);
          openCaches.delete(name);
        }
      }
    } catch (e) { console.warn('[kb-cache] 캐시를 지우지 못했습니다:', e && e.message); }
  }
  touchedAt.clear();
  try {
    await idbTx(LRU_STORE, 'readwrite', (s) => { s.clear(); });
    for (const k of await kvKeys('drive-ids:')) await kvDel(k);
  } catch (e) { /* IndexedDB unavailable */ }
  return { caches: deleted };
}

/** navigator.storage.estimate() + persisted flag (nulls when unsupported). */
export async function storageInfo() {
  const out = { usage: null, quota: null, persisted: null };
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const e = await navigator.storage.estimate();
      out.usage = e.usage ?? null;
      out.quota = e.quota ?? null;
    }
    if (navigator.storage && navigator.storage.persisted) out.persisted = await navigator.storage.persisted();
  } catch (e) { /* ignore */ }
  return out;
}

/** Ask the browser not to evict our storage (granted heuristically, e.g. home-screen apps). */
export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
  } catch (e) { /* ignore */ }
  return false;
}
