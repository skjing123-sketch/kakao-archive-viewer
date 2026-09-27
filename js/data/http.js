// http.js — HttpSource: reads the archive over plain HTTP(S) (SPEC §9.1).
//
// Used for the Mac program's server ('/archive/<target>/', LAN) and the demo archive
// ('./demo/', devserver). The base may be absolute ('https://…/'), root-relative
// ('/archive/nas/') or relative to the viewer root ('./demo/') — it is resolved against
// the viewer root, never against the current route, so it works under any sub-path.

import { APP_ROOT } from './cache.js';
import {
  AuthError, BaseSource, DataError, NetworkError, NotFoundError, abortError, fetchWithTimeout, isAbortError, sleep,
} from './source.js';

/** Resolve an archive base against the viewer root; always ends with '/'. */
export function resolveBase(base) {
  const u = new URL(base || './', APP_ROOT);
  u.search = '';
  u.hash = '';
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  return u.href;
}

export class HttpSource extends BaseSource {
  /**
   * @param {string} base archive root URL ('/archive/nas/', './demo/', 'https://host/x/')
   * @param {{fetch?: typeof fetch, retries?: number, timeoutMs?: number, staleAfterMs?: number}} [opts]
   */
  constructor(base, opts = {}) {
    const abs = resolveBase(base);
    super({ id: `http:${abs}`, fetch: opts.fetch, timeoutMs: opts.timeoutMs, staleAfterMs: opts.staleAfterMs });
    this.kind = 'http';
    this.base = abs;
    this._retries = opts.retries ?? 1;
  }

  /** Absolute URL of an archive-relative path (no '..' or absolute paths allowed). */
  url(rel) {
    const r = String(rel || '');
    if (!r || r.startsWith('/') || /(^|\/)\.\.?(\/|$)/.test(r) || /^[a-z][a-z0-9+.-]*:/i.test(r)) {
      throw new DataError(`잘못된 보관함 경로입니다: ${r}`, { code: 'bad_path', rel: r });
    }
    return new URL(r, this.base).href;
  }

  async _download(rel, { signal, mutable = false } = {}) {
    const url = this.url(rel);
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetchWithTimeout(this._fetch, url, { signal, cache: mutable ? 'no-cache' : 'default', credentials: 'same-origin' },
          { timeoutMs: this.timeoutMs, signal });
      } catch (e) {
        if (isAbortError(e) || (signal && signal.aborted)) throw abortError(signal);
        if (e instanceof NetworkError && e.code === 'timeout') {
          // a hung connection: do not wait that long twice
          throw new NetworkError('보관함 서버가 응답하지 않습니다. 네트워크 상태를 확인해 주세요.', { code: 'timeout', cause: e, rel });
        }
        if (attempt < this._retries) { await sleep(400 * (attempt + 1), signal); continue; }
        throw new NetworkError('보관함 서버에 연결할 수 없습니다. Mac이 켜져 있고 같은 네트워크에 있는지 확인해 주세요.',
          { code: 'offline', cause: e, rel });
      }
      if (res.ok) return res;
      if (res.status === 404 || res.status === 410) {
        throw new NotFoundError(`보관함에서 파일을 찾을 수 없습니다: ${rel}`, { status: res.status, rel });
      }
      if (res.status === 401 || res.status === 403) {
        // code 'server_denied': a Mac/NAS server (missing or rotated LAN key) — never a
        // Google problem, so the app must not ask for a Google setup code (see app.js).
        throw new AuthError('보관함 서버가 접근을 거부했습니다. Mac 프로그램이 알려 준 주소(접속 키 포함)로 다시 열어 주세요.',
          { code: 'server_denied', status: res.status, rel });
      }
      if (res.status >= 500 || res.status === 429 || res.status === 408) {
        if (attempt < this._retries) { await sleep(600 * (attempt + 1), signal); continue; }
        throw new NetworkError(`보관함 서버 오류입니다 (HTTP ${res.status}).`, { status: res.status, rel });
      }
      throw new DataError(`보관함 파일을 읽지 못했습니다 (HTTP ${res.status}).`, { code: 'http_error', status: res.status, rel });
    }
  }

  /**
   * Direct URL (the server supports Range, so <video> can seek).
   * @param {string} rel
   * @returns {string|null}
   */
  mediaURL(rel) {
    if (!rel) return null;
    try { return this.url(rel); } catch (e) { return null; }
  }

  /** Direct URL for a download link (<a download>); the server streams the file itself. */
  downloadURL(rel) {
    return this.mediaURL(rel);
  }

  /**
   * user-state.json, or null when there is none yet: 404/410 (plain servers), 204 No
   * Content (servers that answer a missing file without logging a console error), an empty
   * body, or unparseable JSON.
   */
  async readUserState({ signal } = {}) {
    try {
      const res = await this._download('user-state.json', { signal, mutable: true });
      if (res.status === 204 || res.status === 205) return null;
      const text = await res.text();
      if (!text.trim()) return null;
      const obj = JSON.parse(text);
      return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
    } catch (e) {
      if (e instanceof NotFoundError) return null;
      if (e instanceof SyntaxError) return null;
      throw e;
    }
  }

  async writeUserState(obj) {
    let res;
    try {
      res = await fetchWithTimeout(this._fetch, this.url('user-state.json'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(obj),
        credentials: 'same-origin',
      }, { timeoutMs: this.timeoutMs });
    } catch (e) {
      throw new NetworkError('보관함 서버에 중요 표시를 저장하지 못했습니다 (연결 실패).', { code: 'offline', cause: e });
    }
    if (res.ok) return;
    if ([403, 405, 501].includes(res.status)) {
      throw new DataError('이 보관함은 읽기 전용이라 중요 표시를 이 기기에만 저장합니다.', { code: 'read_only', status: res.status });
    }
    if (res.status === 413) {
      throw new DataError('중요 표시가 너무 많아 서버에 저장할 수 없습니다.', { code: 'too_large', status: 413 });
    }
    if (res.status === 401) throw new AuthError('보관함 서버가 저장을 거부했습니다.', { code: 'server_denied', status: 401 });
    throw new NetworkError(`중요 표시를 저장하지 못했습니다 (HTTP ${res.status}).`, { status: res.status });
  }
}
