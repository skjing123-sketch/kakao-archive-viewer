// model.js — UI-side helpers around the data-layer rows (SPEC §5.5 chunk rows, §9.1 Archive).
//
// The Archive contract fixes method names but leaves the exact shape of collect()/search()
// rows open. These normalizers accept the plausible shapes (a media row with room/ym,
// {room, ym, message, media}, {room, ym, message, url}) so the screens stay simple.
// Pure functions: unit-tested with JavaScriptCore.

import { ymOf, domainOf, fileCategory, koDateTime, mediaKindLabel } from './format.js';

/** Star key as defined by SPEC §9.1: `${roomId}|${msgKey}|${mediaId||''}` */
export function starKey(room, k, mediaId) {
  return `${room}|${k}|${mediaId || ''}`;
}

export function parseStarKey(key) {
  const s = String(key || '');
  const first = s.indexOf('|');
  const last = s.lastIndexOf('|');
  if (first < 0 || last === first) return null;
  return { room: s.slice(0, first), k: s.slice(first + 1, last), id: s.slice(last + 1) || null };
}

/** Media kinds of the gallery type chips. */
export const GALLERY_FILTERS = {
  all: { label: '전체', rowKinds: ['photo', 'gif', 'video'], monthKinds: ['photo', 'video'] },
  photo: { label: '사진', rowKinds: ['photo', 'gif'], monthKinds: ['photo'] },
  video: { label: '동영상', rowKinds: ['video'], monthKinds: ['video'] },
};

/** Search type filter -> message kinds passed to archive.search({kinds}). */
export const SEARCH_KINDS = {
  all: { label: '전체', kinds: null },
  text: { label: '텍스트', kinds: ['text', 'reply', 'emoticon', 'system', 'call', 'location', 'contact', 'other'] },
  photo: { label: '사진', kinds: ['photo'] },
  video: { label: '동영상', kinds: ['video'] },
  file: { label: '파일', kinds: ['file'] },
  link: { label: '링크', kinds: ['link'] },
  audio: { label: '음성', kinds: ['audio'] },
};

function msgOf(row) {
  if (row && row.message && typeof row.message === 'object') return row.message;
  if (row && row.msg && typeof row.msg === 'object') return row.msg;
  return null;
}

function mediaOf(row, room, ym) {
  let m = null;
  if (row && row.media && typeof row.media === 'object' && !Array.isArray(row.media)) m = row.media;
  else if (row && Array.isArray(row.media) && row.media.length) m = row.media[0];
  else if (row && row.id && row.y && (row.p !== undefined || row.th !== undefined || row.sz !== undefined)) m = row;
  if (!m) return null;
  return Object.assign({}, m, { room: m.room || room, ym: m.ym || ym });
}

function roomYm(row, msg) {
  const room = row.room || row.roomId || (row.media && row.media.room) || null;
  const t = (msg && msg.t) || row.t || (row.media && row.media.t) || 0;
  const ym = row.ym || (row.media && row.media.ym) || (t ? ymOf(t) : null);
  return { room, ym, t };
}

/** Row of the 파일 tab. */
export function normFileRow(row) {
  const msg = msgOf(row);
  const { room, ym, t } = roomYm(row, msg);
  const media = mediaOf(row, room, ym);
  const f = (msg && msg.f) || row.f || {};
  const name = row.name || f.name || (media && media.nm) || row.nm || '이름 없는 파일';
  const size = row.size ?? f.size ?? (media && media.sz) ?? row.sz ?? null;
  const cat = fileCategory(name, (media && media.mime) || row.mime);
  return {
    room, ym, t,
    k: (msg && msg.k) || row.k || (media && media.k) || null,
    senderId: (msg && msg.s) || row.s || (media && media.s) || null,
    senderName: (msg && msg.n) || row.n || (media && media.n) || '',
    name, size, cat, media,
    available: typeof row.available === 'boolean' ? row.available && !!media : hasFullMedia(media),
    orphan: !!((media && media.orphan) || isOrphan(msg)),
    message: msg,
  };
}

/** Rows of the 링크 tab (one per URL). */
export function normLinkRows(row) {
  const msg = msgOf(row);
  const { room, ym, t } = roomYm(row, msg);
  const urls = row.url ? [row.url] : (row.urls || (msg && msg.l) || row.l || []);
  return urls.map((url) => ({
    room, ym, t, url,
    k: (msg && msg.k) || row.k || null,
    domain: (row.url === url && row.domain) || domainOf(url) || url,
    senderId: (msg && msg.s) || row.s || null,
    senderName: (msg && msg.n) || row.n || '',
    text: (msg && msg.x) || row.x || row.text || '',
    message: msg,
  }));
}

/** Row of the 음성 tab. */
export function normAudioRow(row) {
  const msg = msgOf(row);
  const { room, ym, t } = roomYm(row, msg);
  const media = mediaOf(row, room, ym);
  return {
    room, ym, t,
    k: (msg && msg.k) || row.k || (media && media.k) || null,
    senderId: (msg && msg.s) || row.s || (media && media.s) || null,
    senderName: (msg && msg.n) || row.n || (media && media.n) || '',
    duration: row.duration ?? (media && media.d) ?? row.d ?? null,
    size: (media && media.sz) || null,
    media,
    available: typeof row.available === 'boolean' ? row.available && !!media : hasFullMedia(media),
    orphan: !!((media && media.orphan) || isOrphan(msg)),
    message: msg,
  };
}

/** Normalized search hit {room, ym, message}. */
export function normSearchHit(hit) {
  const msg = msgOf(hit) || hit;
  const { room, ym } = roomYm(hit, msg);
  return { room, ym, message: msg };
}

/**
 * Media that no message owns (export files that matched no line, backup media without a
 * message row). Published with the flag 'orphan' (older archives: a photo/video message
 * with neither sender nor text). Such rows appear in the galleries, never as chat bubbles.
 */
export function isOrphan(m) {
  if (!m) return false;
  if ((m.fl || []).includes('orphan')) return true;
  return !m.s && !m.n && !m.x && (m.y === 'photo' || m.y === 'video' || m.y === 'gif') && Array.isArray(m.m) && m.m.length > 0;
}

const PLACEHOLDER_RE = /^(?:\(?(?:사진|동영상|음성\s?메시지|파일|이모티콘|photos?|videos?|voice message|file)\)?(?:\s*\d+\s*(?:장|개)?)?|사진\s*\d+장|동영상\s*\d+개|(?:photo|video)s?\s*\d*|(?:파일|file)\s*:.*)$/i;

/**
 * Caption to show under a media bubble: '' when the text is only KakaoTalk's placeholder
 * for that kind ('사진', '사진 3장', '동영상', '음성메시지', '파일: a.pdf', the file name).
 */
export function mediaCaption(m) {
  const x = String((m && m.x) || '').trim();
  if (!x) return '';
  if (!['photo', 'video', 'gif', 'audio', 'file'].includes(m.y)) return x;
  if (PLACEHOLDER_RE.test(x)) return '';
  if (m.f && m.f.name && x === m.f.name) return '';
  return x;
}

/** Text shown for a message in lists / quotes. */
export function messagePreview(m) {
  if (!m) return '';
  const fl = m.fl || [];
  if (m.y === 'deleted' || fl.includes('local_deleted')) return '삭제된 메시지입니다.';
  if (fl.includes('hidden')) return '관리자가 가린 메시지입니다.';
  switch (m.y) {
    case 'photo': return m.x || ((m.em || (m.m && m.m.length) || 1) > 1 ? `사진 ${m.em || m.m.length}장` : '사진');
    case 'video': return m.x || '동영상';
    case 'audio': return m.x || '음성메시지';
    case 'file': return (m.f && m.f.name) ? `파일: ${m.f.name}` : (m.x || '파일');
    case 'emoticon': return m.x || '(이모티콘)';
    case 'location': return m.x ? `위치: ${m.x}` : '위치';
    case 'contact': return m.x ? `연락처: ${m.x}` : '연락처';
    case 'call': return m.x || '통화';
    default: return m.x || '';
  }
}

/** Is reference `a` ({t, room, k}) newer than `b`? (ties: a stable, arbitrary order) */
function refNewer(a, b) {
  if (a.t !== b.t) return a.t > b.t;
  const ka = `${a.room || ''}|${a.k || ''}`;
  const kb = `${b.room || ''}|${b.k || ''}`;
  return ka < kb;
}

/**
 * Show each media id once — its newest reference (SPEC §13.2 L9, home '전체' timeline).
 * `rows` are one month's gallery rows (t desc; the first row of an id is its newest
 * reference in that month). `shown` maps media id → {key, t, room, k} of the reference
 * currently shown by some other group (month section) `key`s of the same timeline; it is
 * updated in place. Returns the rows to show for `key` and the keys of other groups whose
 * reference lost to a newer one here (they must drop that row).
 * @param {object[]} rows
 * @param {Map<string, {key:string, t:number, room:string, k:string}>} shown
 * @param {string} key
 * @returns {{rows: object[], stolen: Set<string>}}
 */
export function dedupeNewest(rows, shown, key) {
  const out = [];
  const here = new Set();
  const stolen = new Set();
  for (const r of rows || []) {
    if (!r || !r.id || here.has(r.id)) continue;
    here.add(r.id);
    const cur = shown.get(r.id);
    if (cur && cur.key !== key) {
      if (refNewer(cur, r)) continue;           // a newer reference is shown elsewhere
      stolen.add(cur.key);
    }
    shown.set(r.id, { key, t: r.t, room: r.room, k: r.k });
    out.push(r);
  }
  return { rows: out, stolen };
}

/** Rows of group `key` that are still the shown reference of their media id. */
export function keepShown(rows, shown, key) {
  return (rows || []).filter((r) => { const s = shown.get(r.id); return !s || s.key === key; });
}

// ---------------------------------------------------------------------------
// Low-quality duplicates (chunk media fields `lq` / `lqs`, SPEC §13.5, set by the publisher)
// ---------------------------------------------------------------------------
//
// `lq`  = media id of the BEST copy of the same picture somewhere in the archive, on every
//         strictly worse copy (a thumbnail-only copy of a photo whose original was kept
//         elsewhere, a smaller re-sent/forwarded copy, the poster of a video whose file is
//         kept in another message); the best copy itself never carries it;
// `lqs` = true (only with `lq`) when a strictly better copy is referenced in the SAME room —
//         the best one, or another copy of the same picture (same `lq`) of higher quality.
// Galleries hide these rows by default ("원본화질이 있는 사진은 저화질 중복으로 안보이게");
// chats keep them (the conversation's context) and the media viewer opens the better copy.

/** localStorage preference (dom.js prefs key): show low-quality duplicates in galleries. */
export const SHOW_LQ_PREF = 'gallery.showLq';

/** Media id of the best copy of `row`'s picture (chunk field `lq`) when `row` is a worse copy, else null. */
export function betterCopyId(row) {
  const v = row && row.lq;
  return typeof v === 'string' && v.length > 0 && v.length <= 64 && v !== row.id ? v : null;
}

/** Is `row` a low-quality duplicate at all (a better copy exists somewhere)? */
export function isLowQualityDup(row) {
  return !!row && (betterCopyId(row) !== null || row.lqs === true);
}

/**
 * Does a gallery hide `row` as a low-quality duplicate? `scope` 'all' — the home timeline
 * over every room: a better copy exists anywhere (lq); 'rooms' — one room or a chosen set
 * of rooms: only when the better copy is in the same room (lqs), because a copy in a room
 * that is not shown must never hide the only visible one. Starred rows are never hidden.
 */
export function isHiddenLowQuality(row, scope, starred = false) {
  if (!row || starred) return false;
  if (row.lqs === true) return true;
  return scope === 'all' && betterCopyId(row) !== null;
}

/**
 * Gallery rows without the hidden low-quality duplicates (see isHiddenLowQuality).
 * `isStarred(row)` keeps starred rows; `show` = the '저화질 중복 사진 보기' preference.
 * @returns {{rows: object[], hidden: object[]}} rows kept (same order) and rows hidden
 */
export function hideLowQuality(rows, { scope = 'all', isStarred = null, show = false } = {}) {
  const list = rows || [];
  if (show) return { rows: list, hidden: [] };
  const out = [];
  const hidden = [];
  for (const r of list) {
    if (isHiddenLowQuality(r, scope) && !(isStarred && isStarred(r))) hidden.push(r);
    else out.push(r);
  }
  return { rows: out, hidden };
}

/** Does a media row have something the viewer can load (original or preview)? */
export function hasFullMedia(row) {
  return !!(row && ((row.orig !== false && !!row.p) || row.pv));
}

/**
 * A video whose original was never downloaded (SPEC §13.3): published as y:'video',
 * to:true with the JPEG thumbnail as its file (mime image/jpeg). Shown as a picture with
 * a '동영상 · 썸네일만 보관됨' badge — never in a <video>.
 */
export function isVideoThumb(row) {
  return !!(row && row.y === 'video' && (row.to === true || /^image\//i.test(String(row.mime || ''))));
}

// Types a browser tab may show (same allow-list as sw.js mediaPolicy): photos, video,
// audio, PDF. Everything else (HTML, SVG, XML, text, office files, unknown) would be a
// page in the viewer's own origin — where the Google setup code lives — so it is saved.
const INLINE_IMAGE_RE = /^image\/(?:jpeg|pjpeg|png|gif|webp|heic|heif|avif|bmp|tiff)$/;
const INLINE_AV_RE = /^(?:video|audio)\/[a-z0-9][\w.+-]*$/;
const INLINE_EXT_RE = /\.(?:jpe?g|png|gif|webp|hei[cf]|avif|bmp|tiff?|mp4|m4v|mov|3gp|webm|m4a|aac|mp3|wav|caf|amr|ogg|oga|opus|pdf)$/i;

/** Is `mime` a passive type that may be opened as a page (see sw.js mediaPolicy)? */
export function inlineMime(mime) {
  const s = String(mime || '').split(';')[0].trim().toLowerCase();
  return INLINE_IMAGE_RE.test(s) || INLINE_AV_RE.test(s) || s === 'application/pdf';
}

/**
 * May the file behind ctx.mediaSrc(row) (the original, else the JPEG preview) be opened in
 * a browser tab? Needs a passive type AND a passive file name (a Mac/NAS server picks the
 * Content-Type from the extension).
 */
export function canOpenInline(row) {
  if (!row) return false;
  const orig = !!(row.orig && row.p);
  const mime = orig ? row.mime : row.pv ? 'image/jpeg' : row.mime;
  const path = String((orig ? row.p : row.pv) || '').split(/[?#]/)[0];
  return inlineMime(mime) && (!path || INLINE_EXT_RE.test(path));
}

/**
 * Accessible name of a gallery tile: kind, date & time (what sighted users read from the
 * sticky day header) and sender — '사진, 2026년 9월 27일 일요일 오후 3:05, 엄마'.
 */
export function tileLabel(row) {
  if (!row) return '';
  return [mediaKindLabel(row.y), row.t ? koDateTime(row.t) : '', row.n || ''].filter(Boolean).join(', ');
}

/**
 * File names for saving several rows at once: `downloadName` per row, made unique
 * (photos of one bundle share their timestamp) by numbering repeats: 'a.jpg', 'a_2.jpg'.
 */
export function uniqueNames(names) {
  const seen = new Map();
  return names.map((n) => {
    const name = String(n || 'file');
    const k = name.toLowerCase();
    const c = (seen.get(k) || 0) + 1;
    seen.set(k, c);
    if (c === 1) return name;
    const dot = name.lastIndexOf('.');
    const alt = dot > 0 ? `${name.slice(0, dot)}_${c}${name.slice(dot)}` : `${name}_${c}`;
    seen.set(alt.toLowerCase(), 1);
    return alt;
  });
}
