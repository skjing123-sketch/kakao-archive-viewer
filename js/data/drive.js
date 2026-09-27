// drive.js — DriveSource: reads the archive from Google Drive with the REST API (SPEC §9.1).
//
// Auth: the setup code (client id + secret + refresh token, made on the Mac) is exchanged
// for 1-hour access tokens with a plain CORS fetch to https://oauth2.googleapis.com/token.
// The token is cached in memory and in IndexedDB (kv 'drive-token', shared with sw.js so
// the media proxy can use it); at most one refresh runs at a time per context.
//
// Requests: files.list (root children once, name lookups for paths without ids) and
// files.get?alt=media with a Bearer header. URLs are kept stable (no cache busters) because
// every distinct URL costs a CORS preflight that Safari caches for only 600 s. 401 →
// refresh once and retry; 403 rate limit / 429 → exponential backoff; invalid_grant →
// AuthError (UI offers a new setup code). Other 403s are classified by their reason (see
// classify403): project/daily quota → NetworkError('quota'), a problem of ONE file
// (download quota, flagged as abusive, not downloadable) → DataError(<reason>) so only that
// item fails, missing permissions → AuthError(<reason>). Waiting for response headers is
// bounded (fetchWithTimeout) so a hung connection ends with NetworkError('timeout').

import { APP_ROOT, kvDel, kvGet, kvSet } from './cache.js';
import {
  AuthError, BaseSource, DataError, NetworkError, NotFoundError, abortError, fetchWithTimeout, isAbortError, sleep,
  throwIfAborted,
} from './source.js';

export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const DRIVE_API = 'https://www.googleapis.com/drive/v3';
export const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
export const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const TOKEN_KEY = 'drive-token';
export const ROOT_NAME = 'KakaoArchive';
const TOKEN_SKEW_MS = 2 * 60 * 1000;         // refresh when < 2 min left
const MAX_RATE_RETRIES = 5;
const MAX_NET_RETRIES = 2;

/** FNV-1a 32-bit hex — tags a cached token with the setup it belongs to (same code in sw.js). */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function tokenTag(setup) {
  return fnv1a(`${setup.cid}|${setup.rt}`);
}

/** Escape a value for a Drive `q` string literal. */
export function driveQuote(s) {
  return `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** Default token store: IndexedDB kv (shared with sw.js). */
export const idbTokenStore = {
  get: () => kvGet(TOKEN_KEY),
  set: (tok) => kvSet(TOKEN_KEY, tok),
  del: () => kvDel(TOKEN_KEY),
};

/** In-memory token store (tests, or when IndexedDB is unavailable). */
export function memoryTokenStore() {
  let v;
  return { get: async () => v, set: async (t) => { v = t; }, del: async () => { v = undefined; } };
}

/** 403 reasons that are rate limits (retried with exponential backoff). */
const RATE_403 = new Set(['userRateLimitExceeded', 'rateLimitExceeded', 'RESOURCE_EXHAUSTED']);
/** 403 reasons meaning a project/daily quota is used up (retrying now does not help). */
const QUOTA_403 = new Set(['dailyLimitExceeded', 'dailyLimitExceededUnreg', 'quotaExceeded', 'limitExceeded']);
/** 403 reasons about ONE file: only that item fails, the session stays valid. */
const FILE_403 = {
  downloadQuotaExceeded: '이 파일은 Google Drive의 다운로드 한도를 넘어 지금은 받을 수 없어요. 나중에 다시 시도해 주세요.',
  cannotDownloadAbusiveFile: 'Google Drive가 이 파일을 위험한 파일로 분류해 받을 수 없어요.',
  fileNotDownloadable: '이 파일은 Google Drive에서 내려받을 수 없는 형식이에요.',
  cannotDownloadFile: '이 파일은 Google Drive에서 내려받을 수 없어요.',
};

/**
 * Error for a Drive 403 that is not a rate limit (see the header comment).
 * @param {string} reason errors[0].reason (or error.status)
 * @returns {DataError}
 */
export function classify403(reason) {
  if (QUOTA_403.has(reason)) {
    return new NetworkError('Google Drive 사용 한도를 넘었습니다. 잠시 후(늦어도 내일) 다시 시도해 주세요.', { code: 'quota', status: 403 });
  }
  if (Object.prototype.hasOwnProperty.call(FILE_403, reason)) {
    return new DataError(FILE_403[reason], { code: reason, status: 403 });
  }
  return new AuthError('Google Drive 파일에 접근할 권한이 없습니다. Mac 프로그램에서 만든 설정 코드인지 확인해 주세요.',
    { code: reason || 'forbidden', status: 403 });
}

async function readDriveError(res) {
  try {
    const j = await res.clone().json();
    const e = j && j.error;
    if (!e) return { reason: '', message: '' };
    if (typeof e === 'string') return { reason: e, message: j.error_description || '' };
    const reason = (e.errors && e.errors[0] && e.errors[0].reason) || e.status || '';
    return { reason: String(reason), message: String(e.message || '') };
  } catch (err) {
    return { reason: '', message: '' };
  }
}

export class DriveSource extends BaseSource {
  /**
   * @param {{cid:string, cs:string, rt:string, root?:string|null}} setup
   * @param {{fetch?: typeof fetch, tokenStore?: {get:Function,set:Function,del:Function},
   *          now?: () => number, sleep?: (ms:number, signal?:AbortSignal) => Promise<void>,
   *          idCache?: boolean, timeoutMs?: number, staleAfterMs?: number}} [opts]
   */
  constructor(setup, opts = {}) {
    if (!setup || !setup.cid || !setup.cs || !setup.rt) {
      throw new AuthError('Google Drive 설정 코드가 올바르지 않습니다. 설정 코드를 다시 붙여넣어 주세요.', { code: 'no_setup' });
    }
    super({ id: `drive:${setup.root || ROOT_NAME}`, fetch: opts.fetch, timeoutMs: opts.timeoutMs, staleAfterMs: opts.staleAfterMs });
    this.kind = 'drive';
    this.setup = { ...setup };
    this.root = setup.root || null;
    this._tokens = opts.tokenStore || idbTokenStore;
    this._now = opts.now || (() => Date.now());
    this._sleep = opts.sleep || sleep;
    this._useIdCache = opts.idCache !== false;
    this._tag = tokenTag(setup);
    this._tok = null;
    this._refreshing = null;
    this._rootFiles = null;           // Promise<Map<name, file>>
    this._pathIds = new Map();        // rel → fileId
    this._writeChain = Promise.resolve();
    this.stats = { tokenRequests: 0, apiRequests: 0 };
  }

  // -- tokens -------------------------------------------------------------------
  /**
   * A valid access token (memory → IndexedDB → refresh).
   * @param {{force?: boolean, signal?: AbortSignal}} [opts]
   */
  async getAccessToken({ force = false, signal } = {}) {
    throwIfAborted(signal);
    const now = this._now();
    if (!force) {
      if (this._tok && this._tok.exp - now > TOKEN_SKEW_MS) return this._tok.at;
      let stored = null;
      try { stored = await this._tokens.get(); } catch (e) { stored = null; }
      if (stored && stored.tag === this._tag && stored.at && stored.exp - now > TOKEN_SKEW_MS) {
        this._tok = stored;
        return stored.at;
      }
    }
    if (!this._refreshing) {
      this._refreshing = this._refresh().finally(() => { this._refreshing = null; });
    }
    return this._refreshing;
  }

  async _refresh() {
    const body = new URLSearchParams({
      client_id: this.setup.cid,
      client_secret: this.setup.cs,
      refresh_token: this.setup.rt,
      grant_type: 'refresh_token',
    });
    for (let attempt = 0; ; attempt++) {
      let res;
      this.stats.tokenRequests++;
      try {
        res = await fetchWithTimeout(this._fetch, TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
        }, { timeoutMs: this.timeoutMs });
      } catch (e) {
        if (e instanceof NetworkError && e.code === 'timeout') {
          throw new NetworkError('Google 인증 서버가 응답하지 않습니다. 인터넷 연결을 확인해 주세요.', { code: 'timeout', cause: e });
        }
        if (attempt < MAX_NET_RETRIES) { await this._sleep(500 * 2 ** attempt); continue; }
        throw new NetworkError('Google 인증 서버에 연결할 수 없습니다. 인터넷 연결을 확인해 주세요.', { code: 'offline', cause: e });
      }
      let j = null;
      try { j = await res.json(); } catch (e) { j = null; }
      if (res.ok && j && j.access_token) {
        const tok = { at: j.access_token, exp: this._now() + (Number(j.expires_in) || 3600) * 1000, tag: this._tag };
        this._tok = tok;
        try { await this._tokens.set(tok); } catch (e) { /* memory only */ }
        return tok.at;
      }
      const err = (j && j.error) || '';
      if (err === 'invalid_grant') {
        try { await this._tokens.del(); } catch (e) { /* ignore */ }
        throw new AuthError('Google 연결이 만료되었거나 취소되었습니다. Mac 프로그램에서 설정 코드를 새로 만들어 붙여넣어 주세요.',
          { code: 'invalid_grant', status: res.status });
      }
      if (err === 'invalid_client' || err === 'unauthorized_client' || res.status === 401) {
        throw new AuthError('설정 코드의 Google 앱 정보가 올바르지 않습니다. 설정 코드를 다시 붙여넣어 주세요.',
          { code: err || 'invalid_client', status: res.status });
      }
      if ((res.status >= 500 || res.status === 429) && attempt < MAX_NET_RETRIES) {
        await this._sleep(1000 * 2 ** attempt);
        continue;
      }
      if (res.status >= 500 || res.status === 429) {
        throw new NetworkError('Google 인증 서버가 잠시 응답하지 않습니다. 잠시 후 다시 시도해 주세요.', { status: res.status });
      }
      throw new AuthError(`Google 인증에 실패했습니다 (${err || `HTTP ${res.status}`}).`, { code: err || 'auth_failed', status: res.status });
    }
  }

  // -- API calls -------------------------------------------------------------
  /**
   * fetch() with Bearer auth, 401 → refresh once, rate limit / 5xx → backoff.
   * @returns {Promise<Response>} an ok (2xx) response
   */
  async _api(url, init = {}, { signal } = {}) {
    let retried401 = false;
    let usedToken = null;
    let rateTries = 0;
    let netTries = 0;
    for (;;) {
      throwIfAborted(signal);
      let at = await this.getAccessToken({ signal });
      if (retried401 && at === usedToken) at = await this.getAccessToken({ force: true, signal });
      usedToken = at;
      const headers = new Headers(init.headers || {});
      headers.set('Authorization', `Bearer ${at}`);
      let res;
      this.stats.apiRequests++;
      try {
        res = await fetchWithTimeout(this._fetch, url, { ...init, headers, signal }, { timeoutMs: this.timeoutMs, signal });
      } catch (e) {
        if (isAbortError(e) || (signal && signal.aborted)) throw abortError(signal);
        if (e instanceof NetworkError && e.code === 'timeout') {
          throw new NetworkError('Google Drive가 응답하지 않습니다. 인터넷 연결을 확인해 주세요.', { code: 'timeout', cause: e });
        }
        if (netTries++ < MAX_NET_RETRIES) { await this._sleep(700 * 2 ** netTries, signal); continue; }
        throw new NetworkError('Google Drive에 연결할 수 없습니다. 인터넷 연결을 확인해 주세요.', { code: 'offline', cause: e });
      }
      if (res.ok) return res;
      if (res.status === 401) {
        if (!retried401) {
          retried401 = true;                       // token revoked/expired early: refresh once
          if (this._tok && this._tok.at === usedToken) this._tok = null;
          try {
            const stored = await this._tokens.get();
            if (stored && stored.at === usedToken) await this._tokens.del();
          } catch (e) { /* ignore */ }
          continue;
        }
        throw new AuthError('Google Drive 인증에 실패했습니다. 설정 코드를 다시 붙여넣어 주세요.', { code: 'unauthorized', status: 401 });
      }
      const { reason, message } = await readDriveError(res);
      const known403 = QUOTA_403.has(reason) || Object.prototype.hasOwnProperty.call(FILE_403, reason);
      const rateLimited = res.status === 429
        || (res.status === 403 && (RATE_403.has(reason) || (!known403 && /rate ?limit|RESOURCE_EXHAUSTED/i.test(`${reason} ${message}`))));
      if (rateLimited) {
        if (rateTries < MAX_RATE_RETRIES) {
          const wait = Math.min(32000, 1000 * 2 ** rateTries) + Math.floor(Math.random() * 1000);
          rateTries++;
          await this._sleep(wait, signal);
          continue;
        }
        throw new NetworkError('Google Drive 요청 한도를 넘었습니다. 잠시 후 다시 시도해 주세요.', { code: 'rate_limited', status: res.status });
      }
      if (res.status === 404) throw new NotFoundError('Google Drive에서 파일을 찾을 수 없습니다.', { status: 404 });
      if (res.status === 403) throw classify403(reason);
      if (res.status >= 500) {
        if (netTries++ < MAX_NET_RETRIES) { await this._sleep(1000 * 2 ** netTries, signal); continue; }
        throw new NetworkError(`Google Drive 서버 오류입니다 (HTTP ${res.status}). 잠시 후 다시 시도해 주세요.`, { status: res.status });
      }
      throw new DataError(`Google Drive 요청이 실패했습니다 (HTTP ${res.status}).`, { code: reason || 'http_error', status: res.status });
    }
  }

  /** files.list with pagination. */
  async _list(q, { fields = 'id,name,mimeType,size,modifiedTime', orderBy = 'modifiedTime desc', pageSize = 1000, signal, max = Infinity } = {}) {
    const out = [];
    let pageToken = '';
    do {
      const p = new URLSearchParams({ q, pageSize: String(pageSize), spaces: 'drive', orderBy, fields: `nextPageToken,files(${fields})` });
      if (pageToken) p.set('pageToken', pageToken);
      const j = await (await this._api(`${DRIVE_API}/files?${p}`, {}, { signal })).json();
      out.push(...(j.files || []));
      pageToken = j.nextPageToken || '';
    } while (pageToken && out.length < max);
    return out;
  }

  /** Archive root folder id (setup.root, or a lookup of 'KakaoArchive' in My Drive). */
  async rootId({ signal } = {}) {
    if (this.root) return this.root;
    const found = await this._list(
      `name = ${driveQuote(ROOT_NAME)} and mimeType = ${driveQuote(FOLDER_MIME)} and 'root' in parents and trashed = false`,
      { fields: 'id,name', signal, max: 1 });
    if (!found.length) throw new NotFoundError('Google Drive에서 KakaoArchive 폴더를 찾을 수 없습니다.', { code: 'no_root' });
    this.root = found[0].id;
    return this.root;
  }

  get _idCacheKey() { return `drive-ids:${this.root || ROOT_NAME}`; }

  /** A different archive sits in the root folder now: look every path up again. */
  forgetPaths() {
    this._pathIds.clear();
    this._rootFiles = null;
    if (this._useIdCache) kvDel(this._idCacheKey).catch(() => {});
  }

  /** Map name → newest file among the root's children (listed once per session). */
  async rootFiles({ signal, refresh = false } = {}) {
    if (refresh) this._rootFiles = null;
    if (!this._rootFiles) {
      const p = (async () => {
        const root = await this.rootId({ signal });
        const files = await this._list(`${driveQuote(root)} in parents and trashed = false`, { signal });
        const map = new Map();
        for (const f of files) if (!map.has(f.name)) map.set(f.name, f);      // newest first
        if (this._useIdCache) {
          const ids = {};
          for (const [name, f] of map) ids[name] = f.id;
          kvSet(this._idCacheKey, ids).catch(() => {});
        }
        return map;
      })();
      this._rootFiles = p;
      p.catch(() => { if (this._rootFiles === p) this._rootFiles = null; });
    }
    return this._rootFiles;
  }

  async _cachedRootId(name) {
    if (!this._useIdCache) return null;
    try {
      const ids = await kvGet(this._idCacheKey);
      return (ids && ids[name]) || null;
    } catch (e) { return null; }
  }

  /**
   * Drive file id of an archive-relative path (walks folders by name; cached).
   * @returns {Promise<string>}
   */
  async resolvePath(rel, { signal } = {}) {
    const known = this._pathIds.get(rel);
    if (known) return known;
    const parts = rel.split('/').filter(Boolean);
    if (!parts.length) throw new NotFoundError('파일 경로가 비어 있습니다.', { rel });
    const top = (await this.rootFiles({ signal })).get(parts[0]);
    if (!top) throw new NotFoundError(`보관함에서 파일을 찾을 수 없습니다: ${rel}`, { rel });
    let parent = top.id;
    for (let i = 1; i < parts.length; i++) {
      const sub = parts.slice(0, i + 1).join('/');
      const cached = this._pathIds.get(sub);
      if (cached) { parent = cached; continue; }
      const found = await this._list(`name = ${driveQuote(parts[i])} and ${driveQuote(parent)} in parents and trashed = false`,
        { fields: 'id,name,mimeType', pageSize: 10, signal, max: 1 });
      if (!found.length) throw new NotFoundError(`보관함에서 파일을 찾을 수 없습니다: ${rel}`, { rel });
      parent = found[0].id;
      this._pathIds.set(sub, parent);
    }
    this._pathIds.set(rel, parent);
    return parent;
  }

  /** files.get?alt=media URL (kept stable: one preflight cache entry per file). */
  static mediaApiURL(fileId) {
    return `${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`;
  }

  async _download(rel, { fid, signal, mutable = false } = {}) {
    const init = mutable ? { cache: 'no-store' } : {};
    if (fid) return this._api(DriveSource.mediaApiURL(fid), init, { signal });
    const parts = rel.split('/');
    // Root files (catalog.json, user-state.json): try the id remembered from last session first.
    if (parts.length === 1 && !this._pathIds.has(rel)) {
      const cached = await this._cachedRootId(rel);
      if (cached) {
        try {
          const res = await this._api(DriveSource.mediaApiURL(cached), init, { signal });
          this._pathIds.set(rel, cached);
          return res;
        } catch (e) {
          if (!(e instanceof NotFoundError)) throw e;
          this._rootFiles = null;                 // stale id → list again
        }
      }
    }
    let id = await this.resolvePath(rel, { signal });
    try {
      return await this._api(DriveSource.mediaApiURL(id), init, { signal });
    } catch (e) {
      if (!(e instanceof NotFoundError)) throw e;
      // the file was replaced (new id): forget cached ids and look it up once more
      this._pathIds.delete(rel);
      this._rootFiles = null;
      id = await this.resolvePath(rel, { signal });
      return this._api(DriveSource.mediaApiURL(id), init, { signal });
    }
  }

  /**
   * Same-origin URL served by sw.js (Range-capable proxy to files.get?alt=media).
   * @param {string} rel
   * @param {{fid?: string, mime?: string, size?: number}} [opts]
   * @returns {string|null} null when the file has no Drive id (not on this target)
   */
  mediaURL(rel, { fid, mime, size } = {}) {
    if (!fid) return null;
    const u = new URL(`sw-media/${encodeURIComponent(fid)}`, APP_ROOT);
    if (size) u.searchParams.set('s', String(size));
    if (mime) u.searchParams.set('t', mime);
    return u.href;
  }

  /**
   * Same-origin URL that makes sw.js stream the file as a download (Content-Disposition:
   * attachment) — for big originals that must not be loaded into page memory. Null
   * without a service worker controlling the page or without a Drive id.
   * @param {string} rel
   * @param {{fid?: string, mime?: string, name?: string}} [opts]
   */
  downloadURL(rel, { fid, mime, name } = {}) {
    if (!fid) return null;
    try { if (!(navigator.serviceWorker && navigator.serviceWorker.controller)) return null; } catch (e) { return null; }
    const u = new URL(`sw-media/${encodeURIComponent(fid)}`, APP_ROOT);
    u.searchParams.set('dl', '1');
    if (mime) u.searchParams.set('t', mime);
    if (name) u.searchParams.set('n', String(name).slice(0, 200));
    return u.href;
  }

  // -- user state ----------------------------------------------------------------
  async _userStateFile({ signal } = {}) {
    const f = (await this.rootFiles({ signal })).get('user-state.json');
    return f ? f.id : null;
  }

  async readUserState({ signal } = {}) {
    let id = this._pathIds.get('user-state.json') || await this._userStateFile({ signal });
    if (!id) return null;
    try {
      const res = await this._api(DriveSource.mediaApiURL(id), { cache: 'no-store' }, { signal });
      this._pathIds.set('user-state.json', id);
      return JSON.parse(await res.text());
    } catch (e) {
      if (e instanceof NotFoundError) {
        this._pathIds.delete('user-state.json');
        this._rootFiles = null;
        id = await this._userStateFile({ signal });
        if (!id) return null;
        return JSON.parse(await (await this._api(DriveSource.mediaApiURL(id), { cache: 'no-store' }, { signal })).text());
      }
      if (e instanceof SyntaxError) return null;
      throw e;
    }
  }

  /**
   * Create or update user-state.json in the archive root (drive.file scope: the app may
   * write files it created itself).
   */
  async writeUserState(obj) {
    const run = async () => {
      const body = JSON.stringify(obj);
      let id = this._pathIds.get('user-state.json') || await this._userStateFile();
      if (id) {
        try {
          await this._api(`${DRIVE_UPLOAD_API}/files/${encodeURIComponent(id)}?uploadType=media&fields=id`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body,
          });
          this._pathIds.set('user-state.json', id);
          return;
        } catch (e) {
          if (!(e instanceof NotFoundError)) throw e;
          id = null;
        }
      }
      const root = await this.rootId();
      const boundary = `kb${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
      const meta = { name: 'user-state.json', parents: [root], mimeType: 'application/json' };
      const multipart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`
        + `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${body}\r\n--${boundary}--`;
      const res = await this._api(`${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id`, {
        method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipart,
      });
      const j = await res.json();
      if (j && j.id) {
        this._pathIds.set('user-state.json', j.id);
        this._rootFiles = null;
      }
    };
    const p = this._writeChain.then(run, run);
    this._writeChain = p.catch(() => {});
    return p;
  }
}
