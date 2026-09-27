// files.js — file icons, open/save/share of originals (Web Share API level 2 with File).
//
// Memory: navigator.share needs the whole file as an in-memory File, so only originals up
// to SHARE_MAX_BYTES take that path (with a 취소 button while downloading). Bigger ones
// are saved through a streaming download link (sw.js '&dl=1' for Drive, the server's own
// URL for the Mac/NAS server) and never enter page memory. Several photos/videos at once
// (gallery 선택 mode) are shared in batches that each need one tap (iOS asks for a user
// gesture per share sheet) and stay under SHARE_BATCH_BYTES.

import { h, icon, clear, toast, actionSheet, confirmDialog, openSheet } from './dom.js';
import { bytes, downloadName, fileCategory, koDateTime, num } from './format.js';
import { canOpenInline, hasFullMedia, starKey, uniqueNames } from './model.js';
import { pathOf } from './router.js';

export const SHARE_MAX_BYTES = 100 * 1024 * 1024;
export const SHARE_BATCH_BYTES = 60 * 1024 * 1024;
export const SHARE_BATCH_FILES = 10;

const CAT_STYLE = {
  pdf: { cls: 'fi-pdf', label: 'PDF' },
  doc: { cls: 'fi-doc', label: 'DOC' },
  sheet: { cls: 'fi-sheet', label: 'XLS' },
  slide: { cls: 'fi-slide', label: 'PPT' },
  zip: { cls: 'fi-zip', label: 'ZIP' },
  image: { cls: 'fi-image', label: 'IMG' },
  video: { cls: 'fi-video', label: 'VID' },
  audio: { cls: 'fi-audio', label: 'AUD' },
  etc: { cls: 'fi-etc', label: 'FILE' },
};

/** Coloured file-type badge (shows the extension when short). */
export function fileIcon(cat) {
  const st = CAT_STYLE[cat && cat.key] || CAT_STYLE.etc;
  const ext = cat && cat.ext && cat.ext.length <= 4 ? cat.ext.toUpperCase() : st.label;
  return h('span', { class: 'file-icon ' + st.cls, 'aria-hidden': 'true' }, icon('file', 30), h('span', { class: 'fi-ext', text: ext }));
}

export function isIOSStandalone() {
  return !!(window.navigator.standalone || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches && /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent) && 'ontouchend' in document));
}

function triggerDownload(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name, style: { display: 'none' } });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/** Save through a URL that streams the file (the page never holds it in memory). */
function linkDownload(url, name) {
  const a = h('a', { href: url, download: name, rel: 'noopener', style: { display: 'none' } });
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Toast text for a failed download (per-file Drive reasons carry their own message). */
function downloadErrorText(err) {
  const code = err && err.code;
  if (err && err.message && err.name === 'DataError' && code && code !== 'data_error') return err.message;
  if (err && err.name === 'NetworkError' && (code === 'quota' || code === 'timeout')) return err.message;
  return '원본을 받지 못했어요. 네트워크 상태를 확인해 주세요.';
}

/**
 * Download the original (archive.downloadBlob) and share it (iOS: 사진 앱에 저장 / 파일에 저장)
 * or fall back to a normal download. Originals over SHARE_MAX_BYTES are saved through a
 * streaming download link instead (never loaded into page memory).
 * Returns 'shared' | 'downloaded' | 'cancelled' | 'failed'.
 */
export async function shareOrSave(ctx, row, { name = null, title = null } = {}) {
  if (!row || !hasFullMedia(row)) {
    toast('이 저장소에는 원본이 없어요.' + (ctx.originalsPolicy() !== 'all' ? ' 원본은 NAS에 보관되어 있어요.' : ''), { kind: 'error' });
    return 'failed';
  }
  const fname = name || downloadName(row);
  const size = row.orig && row.p ? Number(row.sz) || 0 : 0;
  if (size > SHARE_MAX_BYTES) {
    const url = typeof ctx.archive.downloadURL === 'function' ? ctx.archive.downloadURL(row, { name: fname }) : null;
    if (url) {
      linkDownload(url, fname);
      toast(`파일이 커서(${bytes(size)}) 공유 대신 바로 저장해요.`, { duration: 4000 });
      return 'downloaded';
    }
    const go = await confirmDialog({
      title: '큰 파일이에요',
      message: `${bytes(size)} 파일을 한 번에 기기 메모리로 받아야 해요. 휴대폰에서는 앱이 멈출 수 있어요. 계속할까요?`,
      confirmText: '받기',
    });
    if (!go) return 'cancelled';
  }
  const ac = new AbortController();
  const close = toast('원본을 받는 중…', { duration: 600000, action: '취소', onAction: () => ac.abort() });
  let blob;
  try {
    blob = await ctx.archive.downloadBlob(row, { signal: ac.signal });
  } catch (err) {
    close();
    if (err && err.name === 'AbortError') { toast('취소했어요.', { duration: 1500 }); return 'cancelled'; }
    toast(downloadErrorText(err), { kind: 'error' });
    ctx.handleError(err, { quiet: true });
    return 'failed';
  }
  close();
  const type = blob.type || row.mime || 'application/octet-stream';
  let file = null;
  try { file = new File([blob], fname, { type }); } catch (e) { file = null; }
  if (file && navigator.canShare && navigator.share) {
    let can = false;
    try { can = navigator.canShare({ files: [file] }); } catch (e) { can = false; }
    if (can) {
      try {
        await navigator.share({ files: [file], title: title || fname });
        return 'shared';
      } catch (err) {
        if (err && err.name === 'AbortError') return 'cancelled';
        if (err && err.name === 'NotAllowedError') {
          // The download took longer than the tap's user activation: ask for one more tap.
          toast('원본이 준비됐어요.', {
            action: '공유하기', duration: 10000,
            onAction: () => navigator.share({ files: [file], title: title || fname }).catch(() => triggerDownload(blob, fname)),
          });
          return 'shared';
        }
        console.warn('[share] failed, falling back to download', err);
      }
    }
  }
  triggerDownload(blob, fname);
  toast('다운로드를 시작했어요.');
  return 'downloaded';
}

/**
 * Save an original as a download: through a URL that streams it as an attachment when the
 * source has one (sw.js '&dl=1', the Mac/NAS server with <a download>), else via
 * shareOrSave (in-memory Blob → share sheet or download). Never opens it as a page.
 */
export async function saveOriginal(ctx, row, opts = {}) {
  if (!row || !hasFullMedia(row)) { toast('이 저장소에는 원본이 없어요.', { kind: 'error' }); return 'failed'; }
  const fname = opts.name || downloadName(row);
  const url = typeof ctx.archive.downloadURL === 'function' ? ctx.archive.downloadURL(row, { name: fname }) : null;
  if (!url) return shareOrSave(ctx, row, opts);
  linkDownload(url, fname);
  toast('브라우저에서 바로 열 수 없는 형식이라 다운로드했어요.', { duration: 3000 });
  return 'downloaded';
}

/**
 * Open an original in a new tab (desktop) or via the share sheet (iOS home-screen app).
 * Only passive types (photo, video, audio, PDF — model.canOpenInline) are opened as a
 * page: an .html/.svg/… attachment would run in the viewer's own origin, where the Google
 * setup code is stored, so those are downloaded instead (saveOriginal).
 */
export async function openOriginal(ctx, row, opts = {}) {
  if (!row || !hasFullMedia(row)) { toast('이 저장소에는 원본이 없어요.', { kind: 'error' }); return; }
  if (isIOSStandalone()) { await shareOrSave(ctx, row, opts); return; }
  if (!canOpenInline(row)) { await saveOriginal(ctx, row, opts); return; }
  const url = await ctx.mediaSrc(row);
  if (!url) { await shareOrSave(ctx, row, opts); return; }
  // window.open(…, 'noopener') returns null even when the tab opened (so a blocked popup
  // could not be told apart and the file was shared/saved as well): open, then cut the
  // opener link by hand. The page is a passive same-origin file that cannot run scripts.
  const w = window.open(url, '_blank');
  if (!w) { await shareOrSave(ctx, row, opts); return; }
  try { w.opener = null; } catch (e) { /* noopener */ }
}

/** Action sheet for a file: 열기 / 저장·공유 / 중요 표시 / 대화에서 보기. */
export function openFileActions(ctx, { name, size, media, room, ym, k, t, n = null, s = null, inChat = false }) {
  const ok = media && hasFullMedia(media);
  const cat = fileCategory(name, media && media.mime);
  const row = media ? Object.assign({}, media, { room: media.room || room, ym: media.ym || ym, nm: media.nm || name }) : null;
  const sub = [size ? bytes(size) : '', t ? koDateTime(t) : ''].filter(Boolean).join(' · ');
  // ★ of the file itself (media id), like a photo; a file never received stars its message
  const key = room && k ? starKey(room, k, media ? media.id : '') : null;
  const starred = key ? ctx.archive.isStarred(key) : false;
  const inline = ok && canOpenInline(row);
  const layer = actionSheet(null, [
    ok ? { label: inline ? '열기' : '다운로드', icon: inline ? 'external' : 'download', onSelect: () => openOriginal(ctx, row, { name }) } : null,
    ok ? { label: '저장·공유', icon: 'share', onSelect: () => shareOrSave(ctx, row, { name }) } : null,
    key ? {
      label: starred ? '중요 표시 해제' : '중요 표시', icon: starred ? 'star' : 'starFill',
      onSelect: () => ctx.toggleStar(key, { room, ym, k, id: media ? media.id : undefined, t, y: 'file', n: n || (media && media.n) || undefined, s: s || (media && media.s) || undefined, x: name }),
    } : null,
    !inChat && k ? { label: '대화에서 보기', icon: 'chatJump', onSelect: () => ctx.router.go(pathOf('room', room, 'chat'), { ym, k }) } : null,
  ]);
  const head = h('div', { class: 'file-sheet-head' }, fileIcon(cat),
    h('div', { class: 'fsh-main' }, h('p', { class: 'fsh-name', text: name }), sub ? h('p', { class: 'fsh-sub', text: sub }) : null,
      ok ? null : h('p', { class: 'fsh-warn', text: ctx.originalsPolicy() === 'all' ? '원본 파일이 보관되지 않았어요 (휴대폰에서 받지 않았거나 만료됨).' : '이 저장소에는 원본이 없어요. 원본은 NAS에 보관되어 있을 수 있어요.' })));
  layer.body.prepend(head);
  return layer;
}

/**
 * Save several originals (gallery 선택): download one after the other in a sheet (진행 표시;
 * closing the sheet cancels), then share them in batches (≤ SHARE_BATCH_FILES files
 * and ≤ SHARE_BATCH_BYTES each — iOS keeps every shared File in memory) with one button per
 * batch (each share sheet needs its own tap). Without file sharing (desktop) the files are
 * downloaded instead; originals over SHARE_MAX_BYTES get their own streaming download.
 * @returns {Promise<'shared'|'downloaded'|'cancelled'|'failed'>}
 */
export async function shareMany(ctx, rows, { title = null } = {}) {
  const list = (rows || []).filter((r) => r && hasFullMedia(r));
  const skipped = (rows || []).length - list.length;
  if (!list.length) { toast('저장할 수 있는 원본이 없어요.', { kind: 'error' }); return 'failed'; }
  const ac = new AbortController();
  const progress = h('p', { class: 'loading-text', role: 'status', 'aria-live': 'polite', text: '원본을 받는 중…' });
  const body = h('div', { class: 'share-batches' }, h('div', { class: 'loading' }, h('span', { class: 'spin', 'aria-hidden': 'true' }), progress));
  let finished = false;
  const layer = openSheet({ title: `${num(list.length)}개 저장·공유`, content: body, onClose: () => { if (!finished) ac.abort(); } });
  const files = [];
  const names = uniqueNames(list.map((r) => downloadName(r)));
  let failed = 0;
  let bigOnes = 0;
  for (let i = 0; i < list.length; i++) {
    if (ac.signal.aborted) { toast('취소했어요.', { duration: 1500 }); return 'cancelled'; }
    const row = list[i];
    progress.textContent = `원본을 받는 중… ${num(i + 1)}/${num(list.length)}`;
    const size = row.orig && row.p ? Number(row.sz) || 0 : 0;
    const fname = names[i];
    if (size > SHARE_MAX_BYTES) {
      // too big to hold in memory: its own streaming download (if the source can)
      const url = typeof ctx.archive.downloadURL === 'function' ? ctx.archive.downloadURL(row, { name: fname }) : null;
      if (url) { linkDownload(url, fname); bigOnes++; } else failed++;
      continue;
    }
    try {
      const blob = await ctx.archive.downloadBlob(row, { signal: ac.signal });
      files.push(new File([blob], fname, { type: blob.type || row.mime || 'application/octet-stream' }));
    } catch (err) {
      if (err && err.name === 'AbortError') { toast('취소했어요.', { duration: 1500 }); return 'cancelled'; }
      failed++;
      ctx.handleError(err, { quiet: true });
    }
  }
  finished = true;
  const notes = [skipped ? `원본 없는 ${num(skipped)}개 제외` : '', failed ? `${num(failed)}개 받지 못함` : '', bigOnes ? `큰 파일 ${num(bigOnes)}개는 바로 저장` : ''].filter(Boolean).join(' · ');
  clear(body);
  if (!files.length) {
    body.appendChild(h('p', { class: 'note', text: bigOnes ? `다운로드를 시작했어요. (${notes})` : `원본을 받지 못했어요. ${notes}` }));
    return bigOnes ? 'downloaded' : 'failed';
  }
  let shareable = false;
  try { shareable = !!(navigator.canShare && navigator.share) && navigator.canShare({ files: [files[0]] }); } catch (e) { shareable = false; }
  if (!shareable) {
    for (const f of files) triggerDownload(f, f.name);
    layer.close();
    toast(`${num(files.length)}개 다운로드를 시작했어요.${notes ? ` (${notes})` : ''}`);
    return 'downloaded';
  }
  const batches = [];
  let cur = [];
  let curBytes = 0;
  for (const f of files) {
    if (cur.length && (cur.length >= SHARE_BATCH_FILES || curBytes + f.size > SHARE_BATCH_BYTES)) { batches.push(cur); cur = []; curBytes = 0; }
    cur.push(f);
    curBytes += f.size;
  }
  if (cur.length) batches.push(cur);
  body.appendChild(h('p', { class: 'note', text: `${num(files.length)}개 파일이 준비됐어요.${batches.length > 1 ? ` 한 번에 보낼 수 있는 양이 정해져 있어 ${num(batches.length)}번에 나눠 공유해요.` : ''}${notes ? ` (${notes})` : ''}` }));
  const buttons = batches.map((batch, i) => {
    const size = batch.reduce((a, f) => a + f.size, 0);
    const btn = h('button', { type: 'button', class: 'btn btn-block' + (i === 0 ? ' btn-primary' : '') },
      icon('share', 18), batches.length > 1 ? `공유하기 ${i + 1}/${batches.length} · ${num(batch.length)}개 (${bytes(size)})` : `공유하기 · ${num(batch.length)}개 (${bytes(size)})`);
    btn.addEventListener('click', async () => {
      try {
        await navigator.share({ files: batch, title: title || undefined });
      } catch (err) {
        if (err && err.name === 'AbortError') return;
        for (const f of batch) triggerDownload(f, f.name);
      }
      btn.disabled = true;
      btn.classList.remove('btn-primary');
      if (buttons[i + 1]) buttons[i + 1].classList.add('btn-primary');
      if (buttons.every((b) => b.disabled)) layer.close();
    });
    body.appendChild(btn);
    return btn;
  });
  return 'shared';
}
