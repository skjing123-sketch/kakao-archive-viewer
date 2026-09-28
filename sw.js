/* KakaoBackup viewer — service worker (SPEC §9.1).
 *
 * Classic script without imports/exports, so it works whether the page registers it as
 * a classic or a module worker. Loaded in a normal page (<script src="sw.js">) it only
 * exposes its pure helpers as `self.KBSW` (used by viewer/dev/datatest.html).
 *
 * 1. App shell: every file the app needs to start offline (SHELL_FILES: index.html and
 *    everything it references, all js/app.js imports incl. js/ui/*.js and js/data/*.js,
 *    the manifest icons) is precached into a versioned cache
 *    ('kb-shell-<VERSION>-<SHELL_HASH>') and served CACHE-FIRST (the start of the app
 *    never waits for a slow network: the cache is versioned by this file's bytes, see
 *    below). Navigations to the app (./, index.html) get the cached index.html, except
 *    '?key=' links of the Mac server (they must reach it to set the key cookie). Other
 *    same-origin files are network-first (4 s timeout → cache). Precaching is all or
 *    nothing: if any shell file fails to download, the install fails and the previous
 *    (complete) version stays in control; the browser retries on its next update check.
 *    Dev-only files (dev/, js/data/fake.js) are never precached, cached or intercepted
 *    (BYPASS_RE; tests/test_pwa_int.py checks SHELL_FILES has none of them) and are not
 *    published by tools/deploy_pages.sh nor served by the Mac server. dev/datatest.html,
 *    which clears settings and caches, also refuses to run anywhere but on
 *    tools/devserver.py with its demo archive (its /__dev/ping marker + local-config.json).
 *
 *    Version bump strategy (GitHub Pages sends max-age=600 and allows no custom headers;
 *    the page registers with updateViaCache:'none' so sw.js itself is always revalidated):
 *    browsers only install a new worker — and so only re-precache the shell — when the
 *    bytes of sw.js change. Therefore:
 *      - SHELL_HASH is a fingerprint of the precached files. tests/test_pwa_int.py
 *        recomputes it and fails (printing the new value) whenever a shell file changes,
 *        so a changed app can never ship with an unchanged sw.js.
 *      - VERSION ('YYYY.MM.DD-N') is the human-facing release name, shown by the VERSION
 *        message; bump it together with SHELL_HASH when releasing. tools/deploy_pages.sh
 *        additionally suffixes VERSION with a hash of the published files ('-p<hash>') in
 *        the copy it uploads, so every GitHub Pages deploy of changed files gets a new sw.js.
 *    Both are part of the cache name, and 'activate' deletes older 'kb-shell-*' caches.
 *    The update toast in js/app.js ('새 버전이 준비됐어요') then offers the reload.
 * 2. Drive media proxy: './sw-media/<fileId>?s=<size>&t=<mime>' → files.get?alt=media
 *    (s = the row's 'sz' for originals, its 'pvsz' for previews when the chunk has it)
 *    with the Bearer token from IndexedDB (same DB/schema as js/data/cache.js + drive.js;
 *    refreshed here when expired). Range requests are forwarded and answered with a
 *    synthetic 206 whose Content-Range is computed from the known size (WebKit's media
 *    loader accepts service-worker-made 206 responses; open-ended ranges are capped).
 *    Full (non-range) responses ≤ 40 MB — size from ?s= or else the upstream
 *    Content-Length (previews of older chunks carry no size) — are kept in an LRU cache
 *    (300 MB, shared with the page) so photos work offline. '&dl=1&n=<name>' answers with
 *    Content-Disposition: attachment (the page saves big originals through this stream
 *    instead of loading them into memory). The answers are same-origin with the viewer
 *    (whose IndexedDB holds the setup code) while ?t= is whatever type the sender's file
 *    sniffed as, so only passive types (photos, video, audio, PDF) are served inline;
 *    everything else (HTML, SVG, XML, text, unknown) becomes application/octet-stream +
 *    attachment, and every answer carries nosniff + a CSP that forbids scripts
 *    (mediaPolicy).
 * Only same-origin requests inside the scope are intercepted; archive files, the demo
 * archive, dev pages and local-config.json always go to the network untouched.
 */
(function (g) {
  'use strict';

  var VERSION = '2026.09.28-2-p4640867fca';
  // Fingerprint of SHELL_FILES (see the header comment; tests/test_pwa_int.py keeps it honest).
  var SHELL_HASH = 'a4a2ae7229182b96';
  var SHELL_PREFIX = 'kb-shell-';
  var SHELL_CACHE = SHELL_PREFIX + VERSION + '-' + SHELL_HASH;
  var MEDIA_CACHE = 'kb-media-v1';
  var DB_NAME = 'kakaobackup-viewer';
  var DB_VERSION = 1;
  var SETTINGS_KEY = 'settings';
  var TOKEN_KEY = 'drive-token';
  var TOKEN_URL = 'https://oauth2.googleapis.com/token';
  var DRIVE_API = 'https://www.googleapis.com/drive/v3';
  var OPEN_RANGE_CAP = 4 * 1024 * 1024;
  var MEDIA_CACHE_MAX = 300 * 1024 * 1024;
  var MEDIA_ITEM_MAX = 40 * 1024 * 1024;
  var NET_TIMEOUT_MS = 4000;
  var TOKEN_SKEW_MS = 2 * 60 * 1000;
  // Everything needed to start offline. Must list every file index.html references and
  // every module reachable from js/app.js (tests/test_pwa_int.py derives that set from the
  // file system and fails when this list drifts).
  var SHELL_FILES = [
    './', 'index.html', 'manifest.webmanifest', 'css/app.css', 'js/app.js',
    'js/data/settings.js', 'js/data/source.js', 'js/data/drive.js', 'js/data/http.js',
    'js/data/cache.js', 'js/data/ktp.js', 'js/data/archive.js',
    'js/ui/audio.js', 'js/ui/calendar.js', 'js/ui/chat.js', 'js/ui/dom.js', 'js/ui/files.js',
    'js/ui/format.js', 'js/ui/gallery.js', 'js/ui/home.js', 'js/ui/icons.js', 'js/ui/lists.js',
    'js/ui/model.js', 'js/ui/more.js', 'js/ui/pickers.js', 'js/ui/room.js', 'js/ui/rooms.js',
    'js/ui/router.js', 'js/ui/scrubber.js', 'js/ui/search.js', 'js/ui/setup.js',
    'js/ui/starred.js', 'js/ui/viewer.js', 'js/ui/widgets.js',
    'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-192.png', 'icons/maskable-512.png',
    'icons/apple-touch-icon.png', 'icons/favicon-32.png',
  ];
  // Never intercepted/cached: archive data, dev-only pages and the dev-only fake data layer.
  var BYPASS_RE = /^(?:archive|demo|dev|__kb|rooms|thumbs|media|previews|reports|index)\/|^(?:local-config\.json|catalog\.json|user-state\.json|js\/data\/fake\.js)$/;
  var FILE_ID_RE = /^[A-Za-z0-9_-]{8,256}$/;

  // -------------------------------------------------------------------------
  // pure helpers (tested in viewer/dev/datatest.js)
  // -------------------------------------------------------------------------

  /**
   * Parse a Range header for a resource of `size` bytes (null = unknown).
   * @returns {null | {invalid:true} | {unsatisfiable:true} | {suffix:number} | {start:number, end:number}}
   *   null: no Range; invalid: malformed or multi-range (serve the whole file);
   *   suffix: 'bytes=-N' with unknown size; start/end inclusive (open-ended ranges capped).
   */
  function parseRange(header, size, cap) {
    if (header === null || header === undefined) return null;
    var h = String(header).trim();
    if (!h) return null;
    var m = /^bytes\s*=\s*(\d*)\s*-\s*(\d*)$/i.exec(h);
    if (!m || (m[1] === '' && m[2] === '')) return { invalid: true };
    var known = typeof size === 'number' && isFinite(size) && size >= 0;
    var limit = cap || OPEN_RANGE_CAP;
    if (m[1] === '') {
      var n = parseInt(m[2], 10);
      if (!known) return n > 0 ? { suffix: n } : { unsatisfiable: true };
      if (n === 0 || size === 0) return { unsatisfiable: true };
      return { start: Math.max(0, size - n), end: size - 1 };
    }
    var start = parseInt(m[1], 10);
    var end = m[2] === '' ? null : parseInt(m[2], 10);
    if (end !== null && end < start) return { invalid: true };
    if (known) {
      if (start >= size) return { unsatisfiable: true };
      end = end === null ? Math.min(size - 1, start + limit - 1) : Math.min(end, size - 1);
    } else if (end === null) {
      end = start + limit - 1;
    }
    return { start: start, end: end };
  }

  /** 'bytes a-b/size' ('*' when the size is unknown). */
  function buildContentRange(start, end, size) {
    var total = typeof size === 'number' && isFinite(size) ? String(size) : '*';
    return 'bytes ' + start + '-' + end + '/' + total;
  }

  /** Bytes [start, start+length) of a ReadableStream<Uint8Array> (cancels the rest). */
  function sliceStream(stream, start, length) {
    var reader = stream.getReader();
    var pos = 0;
    var endPos = start + length;
    return new ReadableStream({
      pull: function (ctrl) {
        function step() {
          if (pos >= endPos) {
            ctrl.close();
            reader.cancel().catch(function () {});
            return undefined;
          }
          return reader.read().then(function (r) {
            if (r.done) { ctrl.close(); return undefined; }
            var chunk = r.value;
            var cs = pos;
            var ce = pos + chunk.byteLength;
            pos = ce;
            var a = Math.max(start, cs);
            var b = Math.min(endPos, ce);
            if (b > a) { ctrl.enqueue(chunk.subarray(a - cs, b - cs)); return undefined; }
            return step();
          });
        }
        return step();
      },
      cancel: function (reason) { return reader.cancel(reason); },
    });
  }

  /** FNV-1a 32-bit (identical to js/data/drive.js fnv1a) — tags tokens with their setup. */
  function fnv1a(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8);
  }

  function isBypass(rel) {
    return BYPASS_RE.test(rel);
  }

  // Media answers are same-origin with the viewer, whose IndexedDB holds the setup code
  // (client secret + refresh token). The type comes from the chunk (?t=, the sniffed type of
  // whatever a chat participant sent), so only passive types are ever shown inline, and
  // every answer forbids scripts: an .html/.svg/.xml attachment opened with 열기 or a
  // crafted link must never run in the viewer's origin.
  var INLINE_IMAGE_RE = /^image\/(?:jpeg|pjpeg|png|gif|webp|heic|heif|avif|bmp|tiff)$/;
  var INLINE_AV_RE = /^(?:video|audio)\/[a-z0-9][\w.+-]*$/;
  // images: sandboxed (opaque origin) + no scripts
  var CSP_SANDBOX = "sandbox; default-src 'none'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'unsafe-inline'";
  // video/audio (a sandboxed media document cannot load its own source) and PDF (plugin
  // documents): not sandboxed, but no script can run either
  var CSP_PASSIVE = "default-src 'none'; img-src 'self' data: blob:; media-src 'self' blob:; object-src 'self'; style-src 'unsafe-inline'";

  /**
   * How a media answer of declared type `t` may be delivered.
   * @returns {{type: string, inline: boolean, csp: string}} inline=false → served as
   *   application/octet-stream with Content-Disposition: attachment (a download, never a page)
   */
  function mediaPolicy(t) {
    var s = String(t || '').split(';')[0].trim().toLowerCase();
    if (INLINE_IMAGE_RE.test(s)) return { type: s, inline: true, csp: CSP_SANDBOX };
    if (INLINE_AV_RE.test(s) || s === 'application/pdf') return { type: s, inline: true, csp: CSP_PASSIVE };
    return { type: 'application/octet-stream', inline: false, csp: CSP_SANDBOX };
  }

  function SwError(status, message) {
    var e = new Error(message);
    e.status = status;
    return e;
  }

  function textResponse(status, message) {
    return new Response(message, {
      status: status,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-KB-SW': VERSION,
        'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': CSP_SANDBOX,
      },
    });
  }

  function wait(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  // -------------------------------------------------------------------------
  // IndexedDB (same schema as js/data/cache.js)
  // -------------------------------------------------------------------------

  var dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    var p = new Promise(function (resolve, reject) {
      var req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { reject(e); return; }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('lru')) db.createObjectStore('lru', { keyPath: 'url' }).createIndex('at', 'at');
      };
      req.onsuccess = function () {
        var db = req.result;
        db.onversionchange = function () { try { db.close(); } catch (e) { /* ignore */ } dbPromise = null; };
        db.onclose = function () { dbPromise = null; };
        resolve(db);
      };
      req.onerror = function () { reject(req.error); };
    });
    dbPromise = p;
    p.catch(function () { if (dbPromise === p) dbPromise = null; });
    return p;
  }

  function tx(store, mode, fn) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(store, mode);
        var result;
        t.oncomplete = function () { resolve(result); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error); };
        var r = fn(t.objectStore(store));
        if (r && 'onsuccess' in r) r.onsuccess = function () { result = r.result; };
      });
    });
  }

  var kv = {
    get: function (k) { return tx('kv', 'readonly', function (s) { return s.get(k); }); },
    set: function (k, v) { return tx('kv', 'readwrite', function (s) { s.put(v, k); }); },
    del: function (k) { return tx('kv', 'readwrite', function (s) { s.delete(k); }); },
  };

  function lruPut(url, size) {
    return tx('lru', 'readwrite', function (s) { s.put({ url: url, size: size, at: Date.now() }); }).catch(function () {});
  }

  function lruEvict(maxBytes) {
    return tx('lru', 'readonly', function (s) { return s.getAll(); }).then(function (all) {
      all = all || [];
      var total = all.reduce(function (a, e) { return a + (e.size || 0); }, 0);
      if (total <= maxBytes) return undefined;
      all.sort(function (a, b) { return (a.at || 0) - (b.at || 0); });
      var victims = [];
      for (var i = 0; i < all.length && total > maxBytes; i++) { victims.push(all[i]); total -= all[i].size || 0; }
      return caches.open(MEDIA_CACHE).then(function (c) {
        return Promise.all(victims.map(function (v) { return c.delete(v.url); }));
      }).then(function () {
        return tx('lru', 'readwrite', function (s) { victims.forEach(function (v) { s.delete(v.url); }); });
      });
    }).catch(function () {});
  }

  function mediaCacheMatch(key) {
    return caches.open(MEDIA_CACHE).then(function (c) { return c.match(key); }).then(function (r) {
      return r || null;
    }).catch(function () { return null; });
  }

  var touched = {};
  /** Refresh the LRU time of a cached entry (at most once a minute per entry). */
  function mediaCacheTouch(key, size) {
    var now = Date.now();
    if (touched[key] && now - touched[key] < 60000) return;
    touched[key] = now;
    lruPut(key, size);
  }

  function mediaCachePut(key, response, size) {
    return caches.open(MEDIA_CACHE).then(function (c) { return c.put(key, response); })
      .then(function () { return lruPut(key, size); })
      .then(function () { return lruEvict(MEDIA_CACHE_MAX); })
      .catch(function () {});
  }

  // -------------------------------------------------------------------------
  // tokens + Drive fetch
  // -------------------------------------------------------------------------

  /**
   * Access-token provider reading the setup + cached token from IndexedDB (kv
   * 'settings'.setup and 'drive-token'), refreshing with one in-flight request.
   * @param {{fetch: Function, kv: {get:Function,set:Function}, now?: Function}} deps
   * @returns {(force?: boolean) => Promise<string>}
   */
  function makeTokenProvider(deps) {
    var inflight = null;
    var now = deps.now || Date.now;
    return function getToken(force) {
      return Promise.resolve(deps.kv.get(SETTINGS_KEY)).then(function (settings) {
        var setup = settings && settings.setup;
        if (!setup || !setup.cid || !setup.cs || !setup.rt) throw SwError(401, 'Google Drive 설정이 없습니다. 뷰어에서 설정 코드를 붙여넣어 주세요.');
        var tag = fnv1a(setup.cid + '|' + setup.rt);
        return Promise.resolve(force ? null : deps.kv.get(TOKEN_KEY)).then(function (tok) {
          if (tok && tok.tag === tag && tok.at && tok.exp - now() > TOKEN_SKEW_MS) return tok.at;
          if (!inflight) {
            var body = 'client_id=' + encodeURIComponent(setup.cid) + '&client_secret=' + encodeURIComponent(setup.cs)
              + '&refresh_token=' + encodeURIComponent(setup.rt) + '&grant_type=refresh_token';
            inflight = deps.fetch(TOKEN_URL, {
              method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body,
            }).then(function (res) {
              return res.json().catch(function () { return null; }).then(function (j) {
                if (res.ok && j && j.access_token) {
                  var t = { at: j.access_token, exp: now() + (Number(j.expires_in) || 3600) * 1000, tag: tag };
                  return Promise.resolve(deps.kv.set(TOKEN_KEY, t)).catch(function () {}).then(function () { return t.at; });
                }
                if (j && (j.error === 'invalid_grant' || j.error === 'invalid_client' || j.error === 'unauthorized_client')) {
                  throw SwError(401, 'Google 연결이 만료되었습니다. 설정 코드를 다시 붙여넣어 주세요.');
                }
                throw SwError(res.status >= 500 ? 503 : 401, 'Google 인증 실패 (HTTP ' + res.status + ')');
              });
            }, function () {
              throw SwError(504, 'Google 인증 서버에 연결할 수 없습니다.');
            });
            inflight.then(function () { inflight = null; }, function () { inflight = null; });
          }
          return inflight;
        });
      });
    };
  }

  /** fetch with Bearer auth; 401 → refresh once; 429/403 rate limit → short backoff. */
  function driveFetch(deps, url, init) {
    var tries = 0;
    var retried401 = false;
    var used = null;
    function handle(res) {
      if (res.status === 401 && !retried401) { retried401 = true; return attempt(); }
      if ((res.status === 429 || res.status === 403) && tries < 3) {
        return res.clone().text().then(function (txt) {
          if (res.status === 429 || /rate ?limit|userRateLimitExceeded|RESOURCE_EXHAUSTED/i.test(txt)) {
            tries++;
            return wait(800 * Math.pow(2, tries)).then(attempt);
          }
          return res;
        });
      }
      return res;
    }
    function attempt() {
      return deps.getToken(false).then(function (at) {
        return retried401 && at === used ? deps.getToken(true) : at;
      }).then(function (at) {
        used = at;
        var headers = new Headers((init && init.headers) || {});
        headers.set('Authorization', 'Bearer ' + at);
        return deps.fetch(url, { method: 'GET', headers: headers }).then(handle, function () {
          if (tries++ < 1) return wait(500).then(attempt);
          throw SwError(504, 'Google Drive에 연결할 수 없습니다.');
        });
      });
    }
    return attempt();
  }

  /** Content-Disposition for a download of `name` (RFC 6266 / 5987, ASCII fallback). */
  function contentDisposition(name) {
    var n = String(name || 'download').replace(/[\u0000-\u001f\u007f\/\\]/g, '_').slice(0, 200) || 'download';
    var ascii = n.replace(/[^\x20-\x7e]/g, '_').replace(/["%;]/g, '_');
    var ext = encodeURIComponent(n).replace(/['()*]/g, function (c) { return '%' + c.charCodeAt(0).toString(16).toUpperCase(); });
    return 'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + ext;
  }

  /**
   * Headers of every media answer (200/206/416, network or cache) for a mediaPolicy();
   * `disp` = Content-Disposition (downloads, and every type that is not shown inline).
   */
  function mediaHeaders(policy, disp) {
    var h = new Headers({
      'Content-Type': policy.type, 'Accept-Ranges': 'bytes', 'X-KB-SW': VERSION,
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': policy.csp,
    });
    if (disp) h.set('Content-Disposition', disp);
    return h;
  }

  function upstreamError(res) {
    var status = res.status === 404 ? 404 : (res.status === 401 || res.status === 403) ? res.status : 502;
    var msg = status === 404 ? 'Google Drive에서 파일을 찾을 수 없습니다.'
      : status === 502 ? 'Google Drive 오류 (HTTP ' + res.status + ')' : 'Google Drive 접근이 거부되었습니다.';
    return textResponse(status, msg);
  }

  function fromBlob(blob, range, policy, disp) {
    var total = blob.size;
    var h = mediaHeaders(policy, disp);
    h.set('Cache-Control', 'no-store');
    if (!range || range.invalid) {
      h.set('Content-Length', String(total));
      return new Response(blob, { status: 200, headers: h });
    }
    var r = range.suffix !== undefined ? parseRange('bytes=-' + range.suffix, total) : parseRange('bytes=' + range.start + '-' + range.end, total);
    if (!r || r.unsatisfiable || r.invalid) {
      h.set('Content-Range', 'bytes */' + total);
      return new Response(null, { status: 416, headers: h });
    }
    h.set('Content-Range', buildContentRange(r.start, r.end, total));
    h.set('Content-Length', String(r.end - r.start + 1));
    return new Response(blob.slice(r.start, r.end + 1), { status: 206, statusText: 'Partial Content', headers: h });
  }

  /**
   * Answer a './sw-media/<fileId>?s=<size>&t=<mime>' request. Only passive types
   * (mediaPolicy) are answered inline; anything else is a download (octet-stream +
   * attachment), and no answer may run scripts (CSP, nosniff) — see mediaPolicy.
   * @param {Request} request
   * @param {{fetch:Function, getToken:Function, scope:string, cacheMatch?:Function,
   *          cachePut?:Function, waitUntil?:Function}} deps
   * @returns {Promise<Response>}
   */
  function handleMedia(request, deps) {
    var url = new URL(request.url);
    var m = /\/sw-media\/([^/?#]+)$/.exec(url.pathname);
    var fid = '';
    try { fid = m ? decodeURIComponent(m[1]) : ''; } catch (e) { fid = ''; }
    if (!FILE_ID_RE.test(fid)) return Promise.resolve(textResponse(400, '잘못된 미디어 요청입니다.'));
    var sRaw = url.searchParams.get('s');
    var size = sRaw && /^\d+$/.test(sRaw) ? Number(sRaw) : null;
    var policy = mediaPolicy(url.searchParams.get('t'));
    var disp = url.searchParams.get('dl') === '1' || !policy.inline ? contentDisposition(url.searchParams.get('n') || fid) : null;
    var range = parseRange(request.headers.get('range'), size, OPEN_RANGE_CAP);
    var key = new URL('sw-media/' + encodeURIComponent(fid), deps.scope).href;
    var apiURL = DRIVE_API + '/files/' + encodeURIComponent(fid) + '?alt=media';
    if (range && range.unsatisfiable) {
      var h416 = mediaHeaders(policy, disp);
      h416.set('Content-Range', 'bytes */' + (size === null ? '*' : size));
      return Promise.resolve(new Response(null, { status: 416, headers: h416 }));
    }
    var useRange = !!(range && !range.invalid);
    var cached = deps.cacheMatch ? Promise.resolve(deps.cacheMatch(key)) : Promise.resolve(null);
    return cached.then(function (hit) {
      if (hit) {
        return hit.blob().then(function (b) {
          if (deps.touch) deps.touch(key, b.size);
          return fromBlob(b, useRange ? range : null, policy, disp);
        });
      }
      if (!useRange) {
        return driveFetch(deps, apiURL, {}).then(function (up) {
          if (!up.ok) return upstreamError(up);
          var h = mediaHeaders(policy, disp);
          var upLen = up.headers.get('content-length');
          var known = size !== null ? size : (upLen && /^\d+$/.test(upLen) ? Number(upLen) : null);
          if (known !== null) h.set('Content-Length', String(known));
          h.set('Cache-Control', 'private, max-age=31536000, immutable');
          var body = up.body;
          // no ?s= (previews of chunks without pvsz): the upstream Content-Length (CORS-safelisted) decides
          if (body && deps.cachePut && known !== null && known <= MEDIA_ITEM_MAX) {
            var branches = body.tee();
            body = branches[0];
            var p = deps.cachePut(key, new Response(branches[1], { headers: { 'Content-Type': policy.type } }), known);
            if (deps.waitUntil) deps.waitUntil(Promise.resolve(p).catch(function () {}));
          }
          return new Response(body, { status: 200, headers: h });
        });
      }
      var rangeHdr = range.suffix !== undefined ? 'bytes=-' + range.suffix : 'bytes=' + range.start + '-' + range.end;
      return driveFetch(deps, apiURL, { headers: { Range: rangeHdr } }).then(function (up) {
        var h = mediaHeaders(policy, disp);
        h.set('Cache-Control', 'no-store');
        if (up.status === 416) {
          h.set('Content-Range', 'bytes */' + (size === null ? '*' : size));
          return new Response(null, { status: 416, headers: h });
        }
        if (!up.ok) return upstreamError(up);
        if (range.suffix !== undefined || size === null) {
          // size unknown: pass Drive's own range through (only possible if it is exposed)
          var cr = up.headers.get('content-range');
          if (up.status === 206 && cr) {
            h.set('Content-Range', cr);
            var cl = up.headers.get('content-length');
            if (cl) h.set('Content-Length', cl);
            return new Response(up.body, { status: 206, statusText: 'Partial Content', headers: h });
          }
          if (up.status === 200 && range.suffix === undefined) {
            h.set('Content-Range', buildContentRange(range.start, range.end, null));
            return new Response(sliceStream(up.body, range.start, range.end - range.start + 1), { status: 206, headers: h });
          }
          return new Response(up.body, { status: up.status, headers: h });
        }
        var body = up.status === 206 ? up.body : sliceStream(up.body, range.start, range.end - range.start + 1);
        h.set('Content-Range', buildContentRange(range.start, range.end, size));
        h.set('Content-Length', String(range.end - range.start + 1));
        return new Response(body, { status: 206, statusText: 'Partial Content', headers: h });
      });
    }).catch(function (e) {
      return textResponse(e && e.status ? e.status : 502, (e && e.message) || '미디어를 불러오지 못했습니다.');
    });
  }

  /**
   * Download every shell file into `cache` — all or nothing (like cache.addAll): resolves
   * when each file answered 200 and was stored, rejects on the first failure so the
   * install fails and the previous complete version keeps control.
   * @param {Cache} cache
   * @param {string[]} files SHELL_FILES
   * @param {string} base scope URL
   * @param {Function} fetchFn
   */
  function precacheInto(cache, files, base, fetchFn) {
    return Promise.all(files.map(function (f) {
      var u = new URL(f, base).href;
      return fetchFn(new Request(u, { cache: 'reload' })).then(function (res) {
        if (!res || !res.ok) throw new Error('precache ' + f + ': HTTP ' + (res ? res.status : '?'));
        return cache.put(u, res);
      });
    }));
  }

  /** Is a same-origin request (path `rel` inside the scope) served cache-first? */
  function isCacheFirst(rel, mode, search) {
    if (/(?:^|[?&])key=/.test(search || '')) return false;          // Mac server key links set a cookie
    if (mode === 'navigate') return rel === '' || rel === 'index.html';
    return rel !== '' && SHELL_FILES.indexOf(rel) >= 0;
  }

  var api = {
    VERSION: VERSION, SHELL_HASH: SHELL_HASH, SHELL_CACHE: SHELL_CACHE, SHELL_FILES: SHELL_FILES, OPEN_RANGE_CAP: OPEN_RANGE_CAP,
    parseRange: parseRange, buildContentRange: buildContentRange, sliceStream: sliceStream, fnv1a: fnv1a,
    isBypass: isBypass, makeTokenProvider: makeTokenProvider, driveFetch: driveFetch, handleMedia: handleMedia,
    precacheInto: precacheInto, isCacheFirst: isCacheFirst, contentDisposition: contentDisposition,
    mediaPolicy: mediaPolicy,
  };

  var isSW = typeof ServiceWorkerGlobalScope !== 'undefined' && g instanceof ServiceWorkerGlobalScope;
  if (!isSW) {
    g.KBSW = api;
    return;
  }

  // -------------------------------------------------------------------------
  // service worker wiring
  // -------------------------------------------------------------------------

  var scope = g.registration.scope;
  var scopePath = new URL(scope).pathname;
  var getToken = makeTokenProvider({ fetch: function (u, i) { return fetch(u, i); }, kv: kv });

  function precache() {
    return caches.open(SHELL_CACHE).then(function (cache) {
      return precacheInto(cache, SHELL_FILES, scope, function (r) { return fetch(r); });
    }).catch(function (e) {
      // incomplete: drop the partial cache and fail the install (the old worker stays)
      return caches.delete(SHELL_CACHE).catch(function () {}).then(function () { throw e; });
    });
  }

  g.addEventListener('install', function (event) {
    // activate only a complete shell (cache-first serving depends on it)
    event.waitUntil(precache().then(function () { return g.skipWaiting(); }));
  });

  g.addEventListener('activate', function (event) {
    event.waitUntil(caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k.indexOf(SHELL_PREFIX) === 0 && k !== SHELL_CACHE ? caches.delete(k) : undefined;
      }));
    }).then(function () { return g.clients.claim(); }));
  });

  /** Cache app files the page loaded before this worker controlled it (first visit). */
  function cacheUrls(urls) {
    var list = (Array.isArray(urls) ? urls : []).filter(function (u) {
      try {
        var x = new URL(u, scope);
        if (x.origin !== g.location.origin || x.pathname.indexOf(scopePath) !== 0) return false;
        var rel = x.pathname.slice(scopePath.length);
        return !isBypass(rel) && rel.indexOf('sw-media/') !== 0;
      } catch (e) { return false; }
    }).slice(0, 300);
    return caches.open(SHELL_CACHE).then(function (c) {
      return Promise.all(list.map(function (u) {
        return c.match(u).then(function (hit) {
          if (hit) return undefined;
          return fetch(u).then(function (res) { return res.ok && res.type === 'basic' ? c.put(u, res) : undefined; });
        }).catch(function () {});
      }));
    });
  }

  g.addEventListener('message', function (event) {
    var d = event.data || {};
    if (d.type === 'SKIP_WAITING') g.skipWaiting();
    if (d.type === 'VERSION' && event.ports && event.ports[0]) event.ports[0].postMessage({ version: VERSION });
    if (d.type === 'CACHE_URLS') event.waitUntil(cacheUrls(d.urls));
  });

  /** The cached copy of a shell file (navigations: index.html). */
  function matchShellFirst(req, rel) {
    return caches.open(SHELL_CACHE).then(function (c) {
      if (req.mode !== 'navigate') return c.match(new URL(rel, scope).href, { ignoreVary: true });
      return c.match(new URL('index.html', scope).href).then(function (h) { return h || c.match(scope); });
    }).then(function (hit) { return hit || null; }).catch(function () { return null; });
  }

  function matchShell(req) {
    return caches.open(SHELL_CACHE).then(function (c) {
      return c.match(req, { ignoreVary: true }).then(function (hit) {
        if (hit || req.mode !== 'navigate') return hit || null;
        return c.match(new URL('index.html', scope).href).then(function (h2) {
          return h2 || c.match(scope);
        });
      });
    }).catch(function () { return null; });
  }

  function offlineResponse(req) {
    if (req.mode === 'navigate') {
      return new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">'
        + '<p style="font:16px system-ui;padding:24px">오프라인입니다. 인터넷에 연결한 뒤 다시 열어 주세요.</p>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-KB-SW': VERSION } });
    }
    return textResponse(503, '오프라인입니다.');
  }

  function respondShell(req, net) {
    var TIMEOUT = {};
    var FAIL = {};
    var timer = new Promise(function (r) { setTimeout(function () { r(TIMEOUT); }, NET_TIMEOUT_MS); });
    return Promise.race([net.then(null, function () { return FAIL; }), timer]).then(function (first) {
      if (first !== TIMEOUT && first !== FAIL && first.status < 500) return first;
      return matchShell(req).then(function (hit) {
        if (hit) return hit;
        if (first === TIMEOUT) return net.then(null, function () { return offlineResponse(req); });
        if (first !== FAIL) return first;
        return offlineResponse(req);
      });
    });
  }

  g.addEventListener('fetch', function (event) {
    var req = event.request;
    if (req.method !== 'GET') return;
    var url;
    try { url = new URL(req.url); } catch (e) { return; }
    if (url.origin !== g.location.origin || url.pathname.indexOf(scopePath) !== 0) return;
    var rel = url.pathname.slice(scopePath.length);
    if (rel.indexOf('sw-media/') === 0) {
      event.respondWith(handleMedia(req, {
        fetch: function (u, i) { return fetch(u, i); }, getToken: getToken, scope: scope,
        cacheMatch: mediaCacheMatch, cachePut: mediaCachePut, touch: mediaCacheTouch,
        waitUntil: function (p) { try { event.waitUntil(p); } catch (e) { /* too late */ } },
      }));
      return;
    }
    if (isBypass(rel) || req.headers.has('range')) return;
    function network() {
      var storeP = null;
      var net = fetch(req).then(function (res) {
        if (res && res.ok && res.type === 'basic') {
          var copy = res.clone();
          storeP = caches.open(SHELL_CACHE).then(function (c) { return c.put(req, copy); }).catch(function () {});
        }
        return res;
      });
      return { net: net, stored: net.then(function () { return storeP; }, function () {}) };
    }
    if (isCacheFirst(rel, req.mode, url.search)) {
      var release;
      event.waitUntil(new Promise(function (r) { release = r; }));
      event.respondWith(matchShellFirst(req, rel).then(function (hit) {
        if (hit) { release(); return hit; }
        var n = network();
        n.stored.then(release, release);
        return respondShell(req, n.net);
      }, function (e) { release(); throw e; }));
      return;
    }
    var n2 = network();
    event.respondWith(respondShell(req, n2.net));
    event.waitUntil(n2.stored);
  });
})(self);
