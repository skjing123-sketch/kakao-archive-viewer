// format.js — pure formatting helpers for the viewer UI (no DOM access).
//
// All dates are shown in the archive time zone (catalog.tz, default Asia/Seoul),
// never in the phone's zone, so "2026년 9월 27일" means the same day everywhere.
// This module is also unit-tested headless with JavaScriptCore (tests/test_pwa_ui_js.py),
// so it must not use browser-only globals (URL, TextDecoder, document, ...).

const WEEKDAYS = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];
export const WEEKDAYS_SHORT = ['일', '월', '화', '수', '목', '금', '토'];
const KST_OFFSET_MIN = 540;

let TZ = 'Asia/Seoul';
let partsFmt = null;
const offsetCache = new Map();   // 15-minute UTC bucket -> offset minutes

/** Set the archive time zone (IANA name). Invalid names fall back to Asia/Seoul. */
export function setTimeZone(tz) {
  const name = tz || 'Asia/Seoul';
  try {
    partsFmt = new Intl.DateTimeFormat('en-US', {
      timeZone: name, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    TZ = name;
  } catch (e) {
    partsFmt = null;
    TZ = 'Asia/Seoul';
  }
  offsetCache.clear();
}

export function getTimeZone() { return TZ; }

function tzOffsetMinutes(ms) {
  const bucket = Math.floor(ms / 900000);
  let off = offsetCache.get(bucket);
  if (off !== undefined) return off;
  if (partsFmt === null && TZ === 'Asia/Seoul') {
    try { setTimeZone(TZ); } catch (e) { /* keep fallback */ }
  }
  off = KST_OFFSET_MIN;
  if (partsFmt) {
    try {
      const p = {};
      for (const x of partsFmt.formatToParts(new Date(bucket * 900000))) p[x.type] = x.value;
      const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
      off = Math.round((asUTC - bucket * 900000) / 60000);
    } catch (e) {
      off = KST_OFFSET_MIN;
    }
  }
  if (offsetCache.size > 5000) offsetCache.clear();
  offsetCache.set(bucket, off);
  return off;
}

/** Local wall-clock parts of an epoch-seconds timestamp in the archive zone. */
export function parts(t) {
  const ms = Math.round(Number(t) * 1000);
  const d = new Date(ms + tzOffsetMinutes(ms) * 60000);
  return {
    y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(),
    h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(), wd: d.getUTCDay(),
  };
}

const pad2 = (n) => (n < 10 ? '0' : '') + n;

/** Epoch seconds of a local wall-clock time in the archive zone. */
export function epochOfLocal(y, mo, d, h = 0, mi = 0, s = 0) {
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  let guess = wall - tzOffsetMinutes(wall) * 60000;
  guess = wall - tzOffsetMinutes(guess) * 60000;
  return guess / 1000;
}

export function ymOf(t) { const p = parts(t); return `${p.y}-${pad2(p.mo)}`; }
export function ymdOf(t) { const p = parts(t); return `${p.y}-${pad2(p.mo)}-${pad2(p.d)}`; }

/** '2026년 9월 27일 일요일' */
export function koDate(t) {
  const p = parts(t);
  return `${p.y}년 ${p.mo}월 ${p.d}일 ${WEEKDAYS[p.wd]}`;
}

/** 'YYYY-MM-DD' -> '2026년 9월 27일 일요일' (calendar arithmetic, zone independent). */
export function koDateFromYmd(ymd) {
  const [y, mo, d] = String(ymd).split('-').map(Number);
  const wd = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  return `${y}년 ${mo}월 ${d}일 ${WEEKDAYS[wd]}`;
}

/** 'YYYY-MM' -> '2026년 9월' */
export function koMonth(ym) {
  const [y, mo] = String(ym).split('-').map(Number);
  return `${y}년 ${mo}월`;
}

/** 'YYYY-MM' -> '9월' (or '2025년 9월' when another year than `refYear`). */
export function koMonthShort(ym, refYear) {
  const [y, mo] = String(ym).split('-').map(Number);
  return y === refYear ? `${mo}월` : `${y}년 ${mo}월`;
}

/** '오후 3:12' */
export function koTime(t) {
  const p = parts(t);
  const ampm = p.h < 12 ? '오전' : '오후';
  const h = p.h % 12 || 12;
  return `${ampm} ${h}:${pad2(p.mi)}`;
}

/** '2026년 9월 27일 일요일 오후 3:12' */
export function koDateTime(t) { return `${koDate(t)} ${koTime(t)}`; }

/** '2026. 9. 27.' */
export function dotDate(t) { const p = parts(t); return `${p.y}. ${p.mo}. ${p.d}.`; }

/** Compact date for lists: today -> time, yesterday -> '어제', this year -> '9월 27일', else '2025. 9. 27.' */
export function shortDate(t, nowSec = Date.now() / 1000) {
  if (t === null || t === undefined || !isFinite(t)) return '';
  const a = ymdOf(t);
  const today = ymdOf(nowSec);
  if (a === today) return koTime(t);
  if (a === ymdOf(nowSec - 86400)) return '어제';
  const p = parts(t);
  if (p.y === parts(nowSec).y) return `${p.mo}월 ${p.d}일`;
  return dotDate(t);
}

/** Whole calendar days from `t` to `nowSec` in the archive zone (0 = same day, negative = future day). */
export function daysAgo(t, nowSec = Date.now() / 1000) {
  const a = parts(t), b = parts(nowSec);
  return Math.round((Date.UTC(b.y, b.mo - 1, b.d) - Date.UTC(a.y, a.mo - 1, a.d)) / 86400000);
}

/** '오늘' / '어제' / 'N일 전' (future dates count as today). */
export function relativeDay(t, nowSec = Date.now() / 1000) {
  const n = daysAgo(t, nowSec);
  if (n <= 0) return '오늘';
  if (n === 1) return '어제';
  return `${n}일 전`;
}

/** Seconds -> '0:15', '12:03', '1:02:05'. */
export function duration(sec) {
  if (sec === null || sec === undefined || !isFinite(sec) || sec < 0) return '';
  // A clip shorter than a second still shows 0:01 (KakaoTalk does the same), not 0:00.
  const s = sec > 0 && sec < 1 ? 1 : Math.round(sec);
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return hh ? `${hh}:${pad2(mm)}:${pad2(ss)}` : `${mm}:${pad2(ss)}`;
}

/** Bytes -> '1.2 MB'. */
export function bytes(n) {
  if (n === null || n === undefined || !isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const digits = v >= 100 || (i === 0 && v >= 10) ? 0 : 1;   // 1.5 KB, 19 KB, 5.0 MB, 150 MB
  return `${v.toFixed(digits)} ${units[i]}`;
}

/** 1234 -> '1,234' */
export function num(n) {
  const v = Math.round(Number(n) || 0);
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// ---------------------------------------------------------------------------
// Month arithmetic
// ---------------------------------------------------------------------------

export function ymAdd(ym, delta) {
  const [y, mo] = String(ym).split('-').map(Number);
  const i = y * 12 + (mo - 1) + delta;
  return `${Math.floor(i / 12)}-${pad2((i % 12) + 1)}`;
}

/** Number of days in a 'YYYY-MM' month. */
export function daysInMonth(ym) {
  const [y, mo] = String(ym).split('-').map(Number);
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

/** Weekday (0=일) of the first day of 'YYYY-MM'. */
export function firstWeekday(ym) {
  const [y, mo] = String(ym).split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, 1)).getUTCDay();
}

/** [fromEpoch, toEpoch) of a local month. */
export function monthBounds(ym) {
  const [y, mo] = String(ym).split('-').map(Number);
  const n = ymAdd(ym, 1).split('-').map(Number);
  return [epochOfLocal(y, mo, 1), epochOfLocal(n[0], n[1], 1)];
}

/** 'YYYY-MM-DD' -> epoch of local midnight (start) or the last second of that day (end). */
export function ymdToEpoch(ymd, end = false) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!m) return null;
  const s = epochOfLocal(+m[1], +m[2], +m[3]);
  return end ? s + 86399 : s;
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function nfc(s) {
  try { return String(s).normalize('NFC'); } catch (e) { return String(s); }
}

/** Split `text` into [{t, hit}] segments where `q` (case-insensitive, NFC) matches. */
export function highlight(text, q) {
  const src = nfc(text || '');
  const needle = nfc(q || '').trim().toLowerCase();
  if (!needle) return [{ t: src, hit: false }];
  const terms = needle.split(/\s+/).filter(Boolean);
  const lower = src.toLowerCase();
  const marks = new Array(src.length).fill(false);
  for (const term of terms) {
    let i = lower.indexOf(term);
    while (i !== -1) {
      for (let j = i; j < i + term.length; j++) marks[j] = true;
      i = lower.indexOf(term, i + Math.max(1, term.length));
    }
  }
  const out = [];
  let cur = '', curHit = null;
  for (let i = 0; i < src.length; i++) {
    if (curHit === null) curHit = marks[i];
    if (marks[i] !== curHit) { out.push({ t: cur, hit: curHit }); cur = ''; curHit = marks[i]; }
    cur += src[i];
  }
  if (cur || !out.length) out.push({ t: cur, hit: !!curHit });
  return out;
}

/** Excerpt of `text` around the first match of `q` (whitespace collapsed). */
export function snippet(text, q, radius = 36) {
  const src = nfc(text || '').replace(/\s+/g, ' ').trim();
  const needle = nfc(q || '').trim().toLowerCase().split(/\s+/)[0] || '';
  if (!needle) return src.length > radius * 2 ? src.slice(0, radius * 2) + '…' : src;
  const i = src.toLowerCase().indexOf(needle);
  if (i < 0) return src.length > radius * 2 ? src.slice(0, radius * 2) + '…' : src;
  const a = Math.max(0, i - radius);
  const b = Math.min(src.length, i + needle.length + radius);
  return (a > 0 ? '…' : '') + src.slice(a, b) + (b < src.length ? '…' : '');
}

const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;

/** Split text into [{t}|{t, url}] segments so URLs can be rendered as links. */
export function splitLinks(text) {
  const s = String(text || '');
  const out = [];
  let last = 0;
  URL_RE.lastIndex = 0;
  let m;
  while ((m = URL_RE.exec(s)) !== null) {
    let url = m[0];
    const trimmed = url.replace(/[).,;:!?\]}>。，]+$/, '');
    url = trimmed;
    if (m.index > last) out.push({ t: s.slice(last, m.index) });
    out.push({ t: url, url });
    last = m.index + url.length;
    URL_RE.lastIndex = last;
  }
  if (last < s.length) out.push({ t: s.slice(last) });
  return out;
}

/**
 * The URL itself when it is a well-formed absolute http(s) URL, else null. Link targets
 * come from other people's messages: never let javascript:, data:, file: … reach an href
 * or window.open().
 */
export function safeHttpUrl(url) {
  const s = String(url ?? '').trim();
  // scheme://[userinfo@]host[:port][/?#…] with a real host name (no control chars/spaces).
  if (s.length > 4096 || /[\u0000-\u0020\u007f<>"'`\\]/.test(s)) return null;
  const host = /^https?:\/\/(?:[^@/?#]*@)?([^/?#]*)/i.exec(s);
  if (!host || host[1].length > 260) return null;              // 253-char name + ':65535'
  if (!HTTP_HOST_RE.test(s) && !HTTP_IPV6_RE.test(s)) return null;
  return s;
}

// Host labels are separated by a MANDATORY dot and are at most 63 characters, so a host
// splits into labels in exactly one way: linear time even for 'http://aaaa…a_' (the old
// `(label\.?)+` backtracked exponentially — one chat message froze the viewer for hours).
const HOST_LABEL = '[\\p{L}\\p{N}](?:[\\p{L}\\p{N}-]{0,61}[\\p{L}\\p{N}])?';
const HTTP_HOST_RE = new RegExp(`^https?:\\/\\/(?:[^@/?#]*@)?${HOST_LABEL}(?:\\.${HOST_LABEL})*\\.?(?::\\d{1,5})?(?:[/?#]|$)`, 'iu');
const HTTP_IPV6_RE = /^https?:\/\/(?:[^@/?#]*@)?\[[0-9a-f:.]+\](?::\d{1,5})?(?:[/?#]|$)/i;

/** Host name of a URL without 'www.' ('' when not a URL). */
export function domainOf(url) {
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?([^/?#:]+)/i.exec(String(url || '').trim());
  if (!m) return '';
  return m[1].toLowerCase().replace(/^www\./, '');
}

/** Avatar text: first Hangul syllable, or up to two Latin initials. */
export function initials(name) {
  const s = nfc(name || '').trim();
  if (!s) return '?';
  const chars = Array.from(s);
  if (/^[A-Za-z]/.test(s)) {
    const words = s.split(/\s+/).filter(Boolean);
    const two = words.length > 1 ? words[0][0] + words[1][0] : s.slice(0, 2);
    return two.toUpperCase();
  }
  return chars[0];
}

/** Stable small hash of a string -> 0..n-1 (for avatar colours). */
export function colorIndex(str, n = 8) {
  let h = 2166136261;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % n;
}

// ---------------------------------------------------------------------------
// Domain vocabulary (Talk Cloud labels)
// ---------------------------------------------------------------------------

const FILE_CATS = [
  { key: 'pdf', label: 'PDF', ext: ['pdf'] },
  { key: 'doc', label: '문서', ext: ['doc', 'docx', 'hwp', 'hwpx', 'txt', 'rtf', 'pages', 'odt', 'md', 'hwt'] },
  { key: 'sheet', label: '스프레드시트', ext: ['xls', 'xlsx', 'xlsm', 'csv', 'numbers', 'ods', 'cell', 'tsv'] },
  { key: 'slide', label: '프레젠테이션', ext: ['ppt', 'pptx', 'key', 'odp', 'show', 'pps', 'ppsx'] },
  { key: 'zip', label: '압축', ext: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'alz', 'egg', 'bz2', 'xz'] },
  { key: 'image', label: '이미지', ext: ['jpg', 'jpeg', 'png', 'gif', 'heic', 'heif', 'webp', 'bmp', 'tif', 'tiff', 'avif', 'svg'] },
  { key: 'video', label: '동영상', ext: ['mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm', '3gp', 'wmv'] },
  { key: 'audio', label: '오디오', ext: ['mp3', 'm4a', 'aac', 'wav', 'amr', 'caf', 'flac', 'ogg', 'opus'] },
];
const OTHER_CAT = { key: 'etc', label: '기타', ext: [] };

export const FILE_CATEGORIES = FILE_CATS.concat([OTHER_CAT]).map(({ key, label }) => ({ key, label }));

/** File-type folder of a file name / mime (Talk Cloud: PDF, 문서, 스프레드시트, 프레젠테이션, 압축, …, 기타). */
export function fileCategory(name, mime) {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || '').trim());
  const ext = m ? m[1].toLowerCase() : '';
  if (ext) {
    for (const c of FILE_CATS) if (c.ext.includes(ext)) return { key: c.key, label: c.label, ext };
  }
  const mt = String(mime || '').toLowerCase();
  if (mt === 'application/pdf') return { key: 'pdf', label: 'PDF', ext };
  if (mt.startsWith('image/')) return { key: 'image', label: '이미지', ext };
  if (mt.startsWith('video/')) return { key: 'video', label: '동영상', ext };
  if (mt.startsWith('audio/')) return { key: 'audio', label: '오디오', ext };
  if (/zip|compressed|x-7z|x-rar|gzip|x-tar/.test(mt)) return { key: 'zip', label: '압축', ext };
  if (/spreadsheet|excel|csv/.test(mt)) return { key: 'sheet', label: '스프레드시트', ext };
  if (/presentation|powerpoint/.test(mt)) return { key: 'slide', label: '프레젠테이션', ext };
  if (/word|text\/|hwp|document/.test(mt)) return { key: 'doc', label: '문서', ext };
  return { key: OTHER_CAT.key, label: OTHER_CAT.label, ext };
}

export function roomKindLabel(kind) {
  return ({ direct: '1:1 채팅', group: '그룹 채팅', open: '오픈채팅', self: '나와의 채팅' })[kind] || '채팅';
}

export function originalsLabel(v) {
  return ({ all: '원본 전체 보관', previews: '사진은 미리보기(2048px)만 보관', none: '썸네일·대화만 보관' })[v] || '알 수 없음';
}

export function targetTypeLabel(v) {
  return ({ gdrive: 'Google Drive', local: 'NAS·로컬 폴더' })[v] || (v || '알 수 없음');
}

export function mediaKindLabel(y) {
  return ({ photo: '사진', gif: 'GIF', video: '동영상', audio: '음성', file: '파일' })[y] || '미디어';
}

/** Is this media row something the photo/video viewer can show? */
export function isVisual(y) { return y === 'photo' || y === 'gif' || y === 'video'; }

/** Safe download file name for a media row. */
export function downloadName(row) {
  if (row && row.nm) return String(row.nm).replace(/[\\/:*?"<>|]+/g, '_');
  const p = parts(row && row.t ? row.t : Date.now() / 1000);
  const stamp = `${p.y}${pad2(p.mo)}${pad2(p.d)}_${pad2(p.h)}${pad2(p.mi)}${pad2(p.s)}`;
  const ext = (row && row.ext) || 'bin';
  return `kakao_${stamp}.${ext}`;
}

setTimeZone('Asia/Seoul');
