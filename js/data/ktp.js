// ktp.js — "KTP1" thumbnail packs (SPEC §5.4) and object-URL lifecycle.
//
// Layout: bytes[0:4] = "KTP1", bytes[4:8] = uint32 LE header length H,
// bytes[8:8+H] = UTF-8 JSON {"v":1,"mime":"image/webp","items":[{"id","o","l","w","h"}]},
// then the WebP blobs. `o` is ABSOLUTE from the start of the file, so a thumbnail is just
// pack.slice(o, o + l) — Blob.slice does not copy, and URL.createObjectURL of the slice
// is cheap. Object URLs pin memory until revoked, so they live in an LRU that revokes on
// eviction (and per pack when a month scrolls far away).

import { DataFormatError } from './source.js';

export const KTP_MAGIC = 'KTP1';
export const KTP_MIME = 'image/webp';
const MAX_HEADER = 64 * 1024 * 1024;

/**
 * @typedef {{id:string, o:number, l:number, w:number, h:number}} KtpItem
 * @typedef {{v:number, mime:string, items:KtpItem[], dataStart:number, headerLength:number}} KtpHeader
 */

function u8Of(buf) {
  if (buf instanceof Uint8Array) return buf;
  if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
  if (ArrayBuffer.isView(buf)) return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  throw new TypeError('ArrayBuffer 또는 Uint8Array가 필요합니다');
}

/** Header length H from the first 8 bytes (validates the magic). */
export function ktpHeaderLength(prefix) {
  const u8 = u8Of(prefix);
  if (u8.length < 8 || u8[0] !== 0x4b || u8[1] !== 0x54 || u8[2] !== 0x50 || u8[3] !== 0x31) {
    throw new DataFormatError('썸네일 팩(KTP1) 형식이 아닙니다.', { code: 'bad_ktp' });
  }
  const h = new DataView(u8.buffer, u8.byteOffset, 8).getUint32(4, true);
  if (h > MAX_HEADER) throw new DataFormatError('썸네일 팩 헤더 길이가 비정상입니다.', { code: 'bad_ktp' });
  return h;
}

/**
 * Parse a KTP1 header from the whole pack or at least its first 8+H bytes.
 * @param {ArrayBuffer|Uint8Array} buf
 * @param {number} [totalSize] full pack size, to validate item ranges
 * @returns {KtpHeader}
 */
export function parseKtpHeader(buf, totalSize) {
  const u8 = u8Of(buf);
  const h = ktpHeaderLength(u8);
  if (u8.length < 8 + h) throw new DataFormatError('썸네일 팩 헤더가 잘려 있습니다.', { code: 'bad_ktp' });
  let json;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(u8.subarray(8, 8 + h)));
  } catch (e) {
    throw new DataFormatError('썸네일 팩 헤더(JSON)를 읽을 수 없습니다.', { code: 'bad_ktp', cause: e });
  }
  if (!json || json.v !== 1 || !Array.isArray(json.items)) {
    throw new DataFormatError('지원하지 않는 썸네일 팩 버전입니다.', { code: 'bad_ktp' });
  }
  const dataStart = 8 + h;
  const size = totalSize ?? (u8.length > dataStart ? u8.length : undefined);
  for (const it of json.items) {
    if (!it || typeof it.id !== 'string' || !Number.isInteger(it.o) || !Number.isInteger(it.l)
        || it.o < dataStart || it.l < 0 || (size !== undefined && it.o + it.l > size)) {
      throw new DataFormatError('썸네일 팩 항목의 위치가 잘못되었습니다.', { code: 'bad_ktp' });
    }
  }
  return { v: json.v, mime: json.mime || KTP_MIME, items: json.items, dataStart, headerLength: h };
}

/** Read and parse the header of a pack Blob (reads only the header bytes). */
export async function readKtpHeader(blob) {
  const prefix = await blob.slice(0, 8).arrayBuffer();
  const h = ktpHeaderLength(prefix);
  const head = await blob.slice(0, 8 + h).arrayBuffer();
  return parseKtpHeader(head, blob.size);
}

/** Thumbnail Blob for an index entry / th object ({o, l}). */
export function ktpSlice(blob, entry, mime = KTP_MIME) {
  if (!entry || !Number.isInteger(entry.o) || !Number.isInteger(entry.l) || entry.o < 8 || entry.l <= 0
      || entry.o + entry.l > blob.size) {
    throw new DataFormatError('썸네일 팩이 손상되었거나 위치가 잘못되었습니다.', { code: 'bad_ktp' });
  }
  return blob.slice(entry.o, entry.o + entry.l, mime);
}

/** A parsed pack: header + blob, with id lookup. */
export class KtpPack {
  /** @param {Blob} blob @param {KtpHeader} header */
  constructor(blob, header) {
    this.blob = blob;
    this.header = header;
    this.byId = new Map(header.items.map((it) => [it.id, it]));
  }

  static async fromBlob(blob) {
    return new KtpPack(blob, await readKtpHeader(blob));
  }

  get size() { return this.blob.size; }

  /** @param {string|KtpItem} idOrEntry */
  slice(idOrEntry) {
    const entry = typeof idOrEntry === 'string' ? this.byId.get(idOrEntry) : idOrEntry;
    if (!entry) return null;
    return ktpSlice(this.blob, entry, this.header.mime || KTP_MIME);
  }
}

/**
 * LRU of object URLs: revokes the least recently used URL when more than `max` exist.
 * Entries can be grouped (e.g. by pack path) to release a whole month at once.
 */
export class ObjectURLCache {
  constructor({ max = 2500, createURL, revokeURL } = {}) {
    this.max = max;
    this._map = new Map();            // key → {url, group}
    this._create = createURL || ((b) => URL.createObjectURL(b));
    this._revoke = revokeURL || ((u) => URL.revokeObjectURL(u));
  }

  get size() { return this._map.size; }

  has(key) { return this._map.has(key); }

  /** URL for key (moves it to most-recent) or null. */
  get(key) {
    const e = this._map.get(key);
    if (!e) return null;
    this._map.delete(key);
    this._map.set(key, e);
    return e.url;
  }

  /**
   * Existing URL for `key`, or a new one for `makeBlob()` (called only when missing).
   * @param {string} key
   * @param {() => Blob} makeBlob
   * @param {string} [group]
   */
  getOrCreate(key, makeBlob, group = '') {
    const hit = this.get(key);
    if (hit) return hit;
    const url = this._create(makeBlob());
    this._map.set(key, { url, group });
    this._trim();
    return url;
  }

  _trim() {
    while (this._map.size > this.max) {
      const [k, e] = this._map.entries().next().value;
      this._map.delete(k);
      try { this._revoke(e.url); } catch (err) { /* ignore */ }
    }
  }

  delete(key) {
    const e = this._map.get(key);
    if (!e) return false;
    this._map.delete(key);
    try { this._revoke(e.url); } catch (err) { /* ignore */ }
    return true;
  }

  /** Revoke every URL of a group; returns how many. */
  deleteGroup(group) {
    let n = 0;
    for (const [k, e] of [...this._map]) {
      if (e.group === group) { this._map.delete(k); try { this._revoke(e.url); } catch (err) { /* ignore */ } n++; }
    }
    return n;
  }

  clear() {
    for (const e of this._map.values()) { try { this._revoke(e.url); } catch (err) { /* ignore */ } }
    this._map.clear();
  }
}
