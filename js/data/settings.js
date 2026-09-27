// settings.js — viewer settings and the Google Drive setup code (SPEC §7, §9.1, §11).
//
// Settings live in IndexedDB (kv key 'settings'): the service worker reads the Drive
// setup from there to refresh access tokens for the media proxy, and SPEC §11 wants the
// setup code (client secret + refresh token) in IndexedDB of the installed app only.
// loadSettings() must be synchronous, so this module loads the stored settings once with
// a top-level await (bounded by a short timeout) and then serves them from memory.
// SPEC-NOTE: when IndexedDB is unavailable (some private modes) settings fall back to
//            localStorage; Drive video/photo streaming through sw.js then cannot work
//            (the SW has no localStorage), everything else does.

import { APP_ROOT, kvDel, kvGet, kvKeys, kvSet, openDB, requestPersistence, clearAll } from './cache.js';

export const SETTINGS_KEY = 'settings';          // IndexedDB kv key (also read by sw.js)
export const TOKEN_KEY = 'drive-token';          // IndexedDB kv key of the cached access token
export const SETUP_CODE_ERROR = '설정 코드가 올바르지 않습니다';
const LS_KEY = 'kb.settings.v1';
const MODES = new Set(['drive', 'http', 'demo']);

/**
 * @typedef {{v:1, cid:string, cs:string, rt:string, root:string|null}} SetupInfo
 * @typedef {{mode:'drive'|'http'|'demo'|null, setup:SetupInfo|null, httpBase:string|null}} Settings
 */

/** @returns {Settings} */
function emptySettings() {
  return { mode: null, setup: null, httpBase: null };
}

const clone = (s) => ({ mode: s.mode, setup: s.setup ? { ...s.setup } : null, httpBase: s.httpBase });

function validSetup(o) {
  if (!o || typeof o !== 'object') return null;
  const str = (v) => typeof v === 'string' && v.trim() !== '';
  if (!(o.v === 1 || o.v === undefined) || !str(o.cid) || !str(o.cs) || !str(o.rt)) return null;
  if (!(o.root === undefined || o.root === null || str(o.root))) return null;
  return { v: 1, cid: o.cid.trim(), cs: o.cs.trim(), rt: o.rt.trim(), root: o.root ? o.root.trim() : null };
}

/**
 * Normalize arbitrary input into a valid Settings object (invalid parts dropped).
 * 'drive' without a valid setup and 'http' without a base fall back to mode null
 * (→ setup screen).
 * @returns {Settings}
 */
export function normalizeSettings(s) {
  const out = emptySettings();
  if (!s || typeof s !== 'object') return out;
  if (MODES.has(s.mode)) out.mode = s.mode;
  out.setup = validSetup(s.setup);
  if (typeof s.httpBase === 'string' && s.httpBase.trim()) out.httpBase = s.httpBase.trim();
  if ((out.mode === 'drive' && !out.setup) || (out.mode === 'http' && !out.httpBase)) out.mode = null;
  return out;
}

// ---------------------------------------------------------------------------
// storage backend (IndexedDB, localStorage fallback) — loaded once at import
// ---------------------------------------------------------------------------

let current = emptySettings();
let backend = 'memory';            // 'idb' | 'localStorage' | 'memory'
let chain = Promise.resolve();

function lsGet() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
function lsSet(v) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(v)); return true; } catch (e) { return false; }
}
function lsDel() {
  try { localStorage.removeItem(LS_KEY); } catch (e) { /* ignore */ }
}
function hasLS() {
  try { return typeof localStorage !== 'undefined' && localStorage !== null; } catch (e) { return false; }
}

async function init() {
  try {
    await openDB({ timeoutMs: 2500 });
    let stored = await kvGet(SETTINGS_KEY);
    backend = 'idb';
    const legacy = lsGet();
    if (!stored && legacy) {                      // written while IndexedDB was unavailable
      stored = normalizeSettings(legacy);
      await kvSet(SETTINGS_KEY, stored);
    }
    if (legacy) lsDel();
    current = normalizeSettings(stored);
  } catch (e) {
    backend = hasLS() ? 'localStorage' : 'memory';
    current = normalizeSettings(lsGet());
    console.warn('[kb-settings] IndexedDB를 쓸 수 없어 설정을 localStorage에 저장합니다:', e && e.message);
  }
}

await init();

/** Where settings are persisted: 'idb' | 'localStorage' | 'memory'. */
export function settingsBackend() {
  return backend;
}

/** @returns {Settings} current settings (a copy) — synchronous. */
export function loadSettings() {
  return clone(current);
}

async function persist(next, setupChanged) {
  if (backend === 'idb') {
    if (!next.mode && !next.setup && !next.httpBase) await kvDel(SETTINGS_KEY);
    else await kvSet(SETTINGS_KEY, next);
    if (setupChanged) await kvDel(TOKEN_KEY);
  } else if (backend === 'localStorage') {
    if (!next.mode && !next.setup && !next.httpBase) lsDel();
    else if (!lsSet(next)) throw new Error('설정을 저장할 수 없습니다 (저장 공간에 접근할 수 없음)');
  }
}

/**
 * Save settings. The in-memory copy (what loadSettings() returns) changes immediately;
 * the returned promise resolves once the settings are persisted — await it before
 * reloading the page.
 * @param {Partial<Settings>|null} s
 * @returns {Promise<Settings>}
 */
export function saveSettings(s) {
  const prev = current;
  const next = normalizeSettings(s);
  current = next;
  const setupChanged = JSON.stringify(prev.setup) !== JSON.stringify(next.setup);
  const p = chain.then(() => persist(next, setupChanged));
  chain = p.catch((e) => { console.warn('[kb-settings] 설정 저장 실패:', e && e.message); });
  if (next.mode) requestPersistence();
  return p.then(() => clone(next));
}

/**
 * "데이터 소스 변경(설정 초기화)": forget the data source, the setup code and the cached
 * access token. With `clearCaches`, also delete cached archive files and local stars.
 * @param {{clearCaches?: boolean}} [opts]
 */
export async function resetSettings({ clearCaches = false } = {}) {
  await saveSettings(null);
  try {
    await kvDel(TOKEN_KEY);
    if (clearCaches) {
      for (const k of await kvKeys('userstate:')) await kvDel(k);
    }
  } catch (e) { /* IndexedDB unavailable */ }
  if (clearCaches) await clearAll();
  return loadSettings();
}

// ---------------------------------------------------------------------------
// setup code
// ---------------------------------------------------------------------------

function setupError(detail) {
  const e = new Error(SETUP_CODE_ERROR);
  e.code = 'bad_setup_code';
  e.detail = detail;
  return e;
}

function b64urlToText(s) {
  let b = s.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (b.length % 4 === 1) throw setupError('base64 길이');
  if (b.length % 4) b += '='.repeat(4 - (b.length % 4));
  let bin;
  try { bin = atob(b); } catch (e) { throw setupError('base64'); }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (e) {
    throw setupError('utf-8');
  }
}

/**
 * Parse the setup code made by the Mac program (SPEC §7):
 * 'KB1.' + base64url(JSON {"v":1,"cid","cs","rt","root"}). Tolerates whitespace/line
 * breaks, surrounding quotes and base64 padding from copy & paste.
 * @param {string} code
 * @returns {SetupInfo}
 * @throws {Error} message '설정 코드가 올바르지 않습니다' (err.code 'bad_setup_code')
 */
export function parseSetupCode(code) {
  if (typeof code !== 'string') throw setupError('문자열 아님');
  const s = code.replace(/[\s ​-‍⁠﻿]+/g, '').replace(/^["'`<«“‘]+|["'`>»”’.,;]+$/g, '');
  const m = /^KB1\.([A-Za-z0-9_\-+/]+=*)$/i.exec(s);
  if (!m) throw setupError('형식');
  let obj;
  try {
    obj = JSON.parse(b64urlToText(m[1]));
  } catch (e) {
    if (e && e.code === 'bad_setup_code') throw e;
    throw setupError('JSON');
  }
  if (!obj || typeof obj !== 'object' || obj.v !== 1) throw setupError('버전');
  const setup = validSetup(obj);
  if (!setup) throw setupError('필수 항목');
  return setup;
}

/** Inverse of parseSetupCode (used by tests and the dev tools). */
export function makeSetupCode({ cid, cs, rt, root = null }) {
  const json = JSON.stringify({ v: 1, cid, cs, rt, root });
  const bytes = new TextEncoder().encode(json);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return 'KB1.' + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---------------------------------------------------------------------------
// local server detection
// ---------------------------------------------------------------------------

/**
 * Ask the server that serves the viewer whether it also serves an archive
 * (the Mac program's GUI server / devserver answer ./local-config.json with
 * {"source":"http","base":"/archive/<target>/"}). Never throws.
 * @param {{timeoutMs?: number, fetch?: typeof fetch}} [opts]
 * @returns {Promise<{source:'http', base:string, target?:string}|null>}
 */
export async function detectLocalConfig({ timeoutMs = 3000, fetch: fetchFn } = {}) {
  const f = fetchFn || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
  if (!f) return null;
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const r = await f(new URL('local-config.json', APP_ROOT).href, {
      cache: 'no-store', credentials: 'same-origin', signal: ctrl ? ctrl.signal : undefined,
    });
    if (!r.ok) return null;
    const j = JSON.parse(await r.text());
    if (!j || j.source !== 'http' || typeof j.base !== 'string' || !j.base.trim()) return null;
    const out = { source: 'http', base: j.base.trim() };
    if (typeof j.target === 'string') out.target = j.target;
    return out;
  } catch (e) {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
