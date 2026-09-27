// more.js — 더보기 (#/more): 마지막 백업(+리포트), 저장소 정보, 화면 테마, 캐시 비우기,
// 데이터 소스 변경(설정 초기화), 앱 버전, 온라인 상태.

import { h, icon, clear, toast, confirmDialog, openSheet, spinner, prefs } from './dom.js';
import { num, bytes, koDateTime, dotDate, originalsLabel, targetTypeLabel, daysAgo, relativeDay } from './format.js';
import { segmented } from './widgets.js';

export const APP_VERSION = '0.1.0';

function parseISO(s) {
  const t = Date.parse(s || '');
  return isFinite(t) ? t / 1000 : null;
}

function row(label, value, opts = {}) {
  return h('div', { class: 'kv' + (opts.warn ? ' warn' : '') },
    h('span', { class: 'kv-k', text: label }),
    h('span', { class: 'kv-v' }, value instanceof Node ? value : String(value ?? '')));
}

/** Non-negative count of a report field, or 0 (fields may be missing in older reports). */
function cnt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// Report wording (SPEC §13.2 L8): media the export did not contain vs. media that expired /
// was never downloaded on the phone.
const NOT_EXPORTED = '내보내기에 포함되지 않음';
const MISSING = '만료·미다운로드';

function card(title, iconName, ...children) {
  return h('section', { class: 'card' },
    h('h2', { class: 'card-title' }, icon(iconName, 18), h('span', { text: title })),
    ...children);
}

const SOURCE_LABEL = { drive: 'Google Drive', http: 'Mac·NAS 서버', demo: '데모 보관함', fake: '개발용 가짜 데이터' };

export function createMore(ctx) {
  const el = h('div', { class: 'screen screen-more' });
  const body = h('div', { class: 'more-body' });
  el.append(h('header', { class: 'appbar' }, h('h1', { class: 'appbar-title', text: '더보기' })), body);

  function render() {
    clear(body);
    const cat = ctx.archive.catalog || {};
    const lb = ctx.archive.lastBackup ? ctx.archive.lastBackup() : cat.last_backup;
    const rooms = ctx.archive.rooms();

    // 마지막 백업 ---------------------------------------------------------
    if (lb) {
      const at = parseISO(lb.at);
      const s = lb.summary || {};
      const ago = at ? Math.max(0, daysAgo(at)) : null;
      const stale = ago !== null && ago >= 14;
      body.appendChild(card('마지막 백업', 'refresh',
        h('p', { class: 'big-when', text: at ? koDateTime(at) : lb.at }),
        ago !== null ? h('p', { class: 'muted' + (stale ? ' warn-text' : ''), text: `${relativeDay(at)} 백업했어요${stale ? ' — 카카오톡 사진은 서버에서 만료될 수 있으니 자주 백업하세요.' : ''}` }) : null,
        h('div', { class: 'stats' + (cnt(s.not_exported) ? ' stats-4' : '') },
          stat('새 메시지', s.new_msgs), stat('새 미디어', s.new_media), stat(MISSING, s.missing_media, cnt(s.missing_media) > 0),
          cnt(s.not_exported) ? stat(NOT_EXPORTED, s.not_exported, true) : null),
        lb.report ? h('button', { type: 'button', class: 'btn btn-block', onclick: () => openReport(lb.report) }, icon('file', 18), '백업 리포트 보기') : null));
    } else {
      body.appendChild(card('마지막 백업', 'refresh', h('p', { class: 'muted', text: '백업 기록이 없어요.' })));
    }

    // 저장소 ------------------------------------------------------------------
    const tgt = cat.target || {};
    const totalBytes = rooms.reduce((a, r) => a + (r.bytes || 0), 0);
    const counts = rooms.reduce((a, r) => { for (const k of ['msg', 'photo', 'video', 'file']) a[k] += (r.counts && r.counts[k]) || 0; return a; }, { msg: 0, photo: 0, video: 0, file: 0 });
    const firsts = rooms.map((r) => r.first_ts).filter(Boolean);
    const lasts = rooms.map((r) => r.last_ts).filter(Boolean);
    const mode = ctx.sourceKind();
    body.appendChild(card('보관함', 'box',
      row('데이터 소스', SOURCE_LABEL[mode] || mode || '알 수 없음'),
      row('저장소', `${targetTypeLabel(tgt.type)}${tgt.id ? ` (${tgt.id})` : ''}`),
      row('원본 보관', originalsLabel(tgt.originals)),
      row('채팅방', `${num(rooms.length)}개${rooms.some((r) => r.left) ? ` (나간 방 ${rooms.filter((r) => r.left).length}개 포함)` : ''}`),
      row('메시지', `${num(counts.msg)}개`),
      row('사진·동영상', `사진 ${num(counts.photo)} · 동영상 ${num(counts.video)}`),
      row('미디어 용량', bytes(totalBytes) || '0 B'),
      firsts.length ? row('기간', `${dotDate(Math.min(...firsts))} ~ ${dotDate(Math.max(...lasts))}`) : null,
      cat.generated_at ? row('보관함 갱신', parseISO(cat.generated_at) ? koDateTime(parseISO(cat.generated_at)) : cat.generated_at) : null,
      starSyncRow(),
      authNote(),
      !authNote() && ctx.archive.offline ? h('p', { class: 'note warn-text', text: '인터넷에 연결되지 않아 이 기기에 저장된 보관함 사본을 보여주고 있어요.' }) : null,
      ctx.archive.refreshing ? h('p', { class: 'note', text: '네트워크가 느려 이 기기에 저장된 보관함을 먼저 보여주고 있어요. 최신 보관함을 받는 중이에요.' }) : null,
      h('button', { type: 'button', class: 'btn btn-block', onclick: () => reload() }, icon('refresh', 18), '보관함 새로 불러오기'),
      tgt.originals && tgt.originals !== 'all' ? h('p', { class: 'note', text: '이 저장소에는 일부 원본이 없어요. 원본은 Mac에 연결된 NAS 보관함에 있어요.' }) : null));

    // 화면 -------------------------------------------------------------------
    const theme = prefs.get('theme', 'system');
    body.appendChild(card('화면', 'sun',
      h('div', { class: 'kv' }, h('span', { class: 'kv-k', text: '테마' }),
        segmented([['system', '시스템'], ['light', '라이트'], ['dark', '다크']], theme, (v) => { prefs.set('theme', v); ctx.applyTheme(); }, '테마'))));

    // 저장공간 ----------------------------------------------------------------
    const storage = h('p', { class: 'muted', text: '사용량 확인 중…' });
    body.appendChild(card('이 기기의 저장공간', 'server',
      storage,
      h('p', { class: 'note', text: '썸네일과 대화는 기기에 캐시되어 오프라인에서도 볼 수 있어요. 캐시를 비워도 보관함의 데이터는 지워지지 않아요.' }),
      h('button', { type: 'button', class: 'btn btn-block', onclick: () => clearCache() }, icon('trash', 18), '캐시 비우기')));
    estimate(storage);

    // 설정 --------------------------------------------------------------------
    body.appendChild(card('설정', 'key',
      h('p', { class: 'note', text: '다른 보관함을 보거나 Google 연결을 다시 설정하려면 설정을 초기화하세요. 이 기기에 저장된 설정 코드가 삭제돼요.' }),
      h('button', { type: 'button', class: 'btn btn-block btn-danger-ghost', onclick: () => reset() }, icon('exit', 18), '데이터 소스 변경 (설정 초기화)')));

    // 앱 정보 -----------------------------------------------------------------
    const online = navigator.onLine;
    body.appendChild(h('footer', { class: 'about' },
      h('p', { class: 'about-name' }, h('img', { src: './icons/icon-192.png', alt: '', width: 28, height: 28 }), '카톡 보관함'),
      h('p', { class: 'muted', text: `버전 ${APP_VERSION}${cat.app_version ? ` · 보관함 형식 ${cat.schema || 1} (백업 프로그램 ${cat.app_version})` : ''}` }),
      h('p', { class: 'status-pill ' + (online ? 'online' : 'offline') }, icon(online ? 'cloud' : 'wifiOff', 14), online ? '온라인' : '오프라인 — 저장된 데이터만 볼 수 있어요'),
      h('p', { class: 'muted small', text: '카카오톡 서버에는 접속하지 않아요. 보관함은 내 Google Drive·NAS에만 저장돼요.' })));
  }

  /** Read-only mode (Google connection expired / server key changed): what to do. */
  function authNote() {
    const err = typeof ctx.authProblem === 'function' ? ctx.authProblem() : null;
    if (!err) return null;
    const server = err.code === 'server_denied' || ctx.sourceKind() === 'http' || ctx.sourceKind() === 'demo';
    return h('p', { class: 'note warn-text', text: server
      ? '보관함 서버가 접근을 거부해 이 기기에 저장된 데이터만 보여주고 있어요. Mac 프로그램이 알려 준 주소(접속 키 포함)로 다시 열어 주세요.'
      : 'Google 연결이 만료되어 이 기기에 저장된 데이터만 보여주고 있어요. Mac 프로그램에서 새 설정 코드를 받아 화면 아래의 "설정 코드 다시 넣기"를 눌러 넣어 주세요.' });
  }

  /** 중요 표시 동기화 상태 (Archive.userStateStatus of the data layer, when available). */
  function starSyncRow() {
    const st = ctx.archive.userStateStatus;
    if (!st) return null;
    let text;
    if (!st.remote) text = '이 기기에만 저장됨 (보관함이 읽기 전용)';
    else if (st.error) text = '이 기기에 저장됨 · 보관함 저장 실패';
    else if (st.pending) text = '저장 대기 중';
    else text = st.syncedAt ? '보관함과 동기화됨' : '이 기기에 저장됨';
    return row('중요 표시', text, { warn: !!st.error });
  }

  function stat(label, value, warn = false) {
    return h('div', { class: 'stat' + (warn ? ' warn' : '') }, h('span', { class: 'stat-v', text: num(cnt(value)) }), h('span', { class: 'stat-k', text: label }));
  }

  async function estimate(target) {
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const e = await navigator.storage.estimate();
        let persisted = null;
        if (navigator.storage.persisted) { try { persisted = await navigator.storage.persisted(); } catch (err) { persisted = null; } }
        target.textContent = `사용 중 ${bytes(e.usage || 0)}${e.quota ? ` / 여유 ${bytes(Math.max(0, e.quota - (e.usage || 0)))}` : ''}${persisted ? ' · 영구 저장' : ''}`;
      } else target.textContent = '사용량을 확인할 수 없어요.';
    } catch (err) { target.textContent = '사용량을 확인할 수 없어요.'; }
  }

  async function reload() {
    const close = toast('보관함을 새로 불러오는 중…', { duration: 30000 });
    try {
      const what = await ctx.reloadCatalog();
      close();
      if (what === 'archive') return;           // app.js rebuilt every screen and said so
      if (ctx.archive.refreshing) toast('네트워크가 느려 저장된 보관함을 먼저 보여 줘요. 최신 보관함을 받는 중이에요.');
      else if (ctx.archive.authExpired) toast('보관함에 접속하지 못해 저장된 데이터를 보여 줘요.', { kind: 'error' });
      else toast('최신 보관함을 불러왔어요.', { kind: 'ok' });
      render();
    } catch (err) {
      close();
      ctx.handleError(err);
    }
  }

  async function clearCache() {
    const ok = await confirmDialog({ title: '캐시를 비울까요?', message: '이 기기에 저장된 썸네일·대화 캐시를 지워요. 다음에 볼 때 다시 받아와요. 설정 코드와 중요 표시는 그대로 남아요.', confirmText: '캐시 비우기' });
    if (!ok) return;
    try {
      await ctx.clearCache();
      toast('캐시를 비웠어요.', { kind: 'ok' });
    } catch (err) {
      toast('캐시를 비우지 못했어요.', { kind: 'error' });
      ctx.handleError(err, { quiet: true });
    }
    render();
  }

  async function reset() {
    const ok = await confirmDialog({ title: '설정을 초기화할까요?', message: '이 기기에 저장된 설정 코드와 캐시가 삭제되고 시작 화면으로 돌아가요. 보관함(Google Drive·NAS)의 데이터는 지워지지 않아요.', confirmText: '초기화', danger: true });
    if (!ok) return;
    await ctx.resetSettings();
  }

  async function openReport(rel) {
    const content = h('div', { class: 'report' }, spinner('리포트를 불러오는 중…'));
    openSheet({ title: '백업 리포트', content, cls: 'sheet-tall' });
    try {
      const rep = await ctx.readJSON(rel);
      clear(content).appendChild(renderReport(rep));
    } catch (err) {
      clear(content).appendChild(h('p', { class: 'form-error', text: '리포트를 불러오지 못했어요. ' + ((err && err.message) || '') }));
    }
  }

  render();
  const onStatus = () => { if (!el.hidden && el.isConnected) render(); };
  ctx.on('catalog-status', onStatus);
  return {
    el, title: '더보기',
    show() { render(); },
    hide() {},
    refresh() { render(); },
    destroy() { ctx.off('catalog-status', onStatus); },
  };
}

/**
 * Friendly target name for a report row. Local targets' labels carry the Mac's absolute
 * folder path (user name, volume names) — show '<종류> (<id>)' instead.
 */
function reportTargetName(tg) {
  const kind = tg.kind || tg.type;
  if (kind === 'local' || kind === 'gdrive') return `${targetTypeLabel(kind)}${tg.target_id ? ` (${tg.target_id})` : ''}`;
  return tg.label || tg.target_id || '저장소';
}

/** Render a run report (archive/report.py build_run_report shape; tolerant of partial data). */
export function renderReport(rep) {
  const box = h('div', { class: 'report-body' });
  if (!rep || typeof rep !== 'object') { box.appendChild(h('p', { text: '리포트 형식을 알 수 없어요.' })); return box; }
  const when = rep.finished_at || rep.started_at;
  box.appendChild(h('p', { class: 'report-when' },
    h('span', { class: 'status-pill ' + (rep.ok === false ? 'offline' : 'online') }, rep.cancelled ? '취소됨' : rep.ok === false ? '문제 있음' : '완료'),
    when ? h('span', { text: ' ' + koDateTime(when) }) : null));
  const arr = (v) => (Array.isArray(v) ? v : []);
  for (const s of arr(rep.sources)) if (s && (s.label || s.source_id)) box.appendChild(h('p', { class: 'muted', text: `가져온 곳: ${s.label || s.source_id}` }));
  const t = rep.totals && typeof rep.totals === 'object' ? rep.totals : {};
  const rooms = Array.isArray(rep.rooms) ? rep.rooms.filter((r) => r && typeof r === 'object') : [];
  // Older reports have no not_exported (their missing_media counted both); totals may lack it
  // while rooms carry it.
  const notExported = cnt(t.not_exported) || rooms.reduce((a, r) => a + cnt(r.not_exported), 0);
  const missing = cnt(t.missing_media);
  const statBox = (value, label, warn = false) => h('div', { class: 'stat' + (warn ? ' warn' : '') },
    h('span', { class: 'stat-v', text: num(value) }), h('span', { class: 'stat-k', text: label }));
  box.appendChild(h('div', { class: 'stats' + (notExported ? ' stats-4' : '') },
    statBox(cnt(t.new_msgs), '새 메시지'),
    statBox(cnt(t.new_photos) + cnt(t.new_videos), '새 사진·동영상'),
    statBox(missing, MISSING, missing > 0),
    notExported ? statBox(notExported, NOT_EXPORTED, true) : null));
  if (rooms.length) {
    box.appendChild(h('h3', { class: 'section-title', text: '대화방별' }));
    const list = h('div', { class: 'report-rooms' });
    for (const r of rooms) {
      const parts = [`새 메시지 ${num(cnt(r.new_msgs))}`];
      if (r.new_photos) parts.push(`사진 ${num(r.new_photos)}`);
      if (r.new_videos) parts.push(`동영상 ${num(r.new_videos)}`);
      if (r.new_audio) parts.push(`음성 ${num(r.new_audio)}`);
      if (r.new_files) parts.push(`파일 ${num(r.new_files)}`);
      list.appendChild(h('div', { class: 'report-room' },
        h('p', { class: 'rr-name', text: r.name || r.room_id }),
        h('p', { class: 'rr-sub', text: parts.join(' · ') }),
        cnt(r.thumb_only) ? h('p', { class: 'rr-warn', text: `썸네일만 있는 사진·동영상 ${num(cnt(r.thumb_only))}개` }) : null,
        cnt(r.missing_media) ? h('p', { class: 'rr-warn', text: `${MISSING} 미디어 ${num(cnt(r.missing_media))}개` }) : null,
        cnt(r.not_exported) ? h('p', { class: 'rr-warn', text: `${NOT_EXPORTED} ${num(cnt(r.not_exported))}개` }) : null,
        cnt(r.orphan_items) ? h('p', { class: 'rr-sub', text: `대화와 연결되지 않은 사진·파일 ${num(cnt(r.orphan_items))}개 (사진·파일 보기에만 표시)` }) : null,
        ...arr(r.errors).slice(0, 3).map((e) => h('p', { class: 'rr-err', text: `오류: ${e}` }))));
    }
    box.appendChild(list);
  }
  const targets = arr(rep.publish && rep.publish.targets).filter((tg) => tg && typeof tg === 'object');
  if (targets.length) {
    box.appendChild(h('h3', { class: 'section-title', text: '저장소' }));
    for (const tg of targets) {
      box.appendChild(h('p', { class: tg.ok ? 'muted' : 'rr-err', text: `${reportTargetName(tg)}: ${tg.ok ? `완료${tg.uploaded_files ? ` — 파일 ${num(tg.uploaded_files)}개 업로드 (${bytes(tg.uploaded_bytes || 0)})` : ''}` : `실패 — ${tg.error || ''}`}` }));
    }
  }
  if (arr(rep.errors).length) {
    box.appendChild(h('h3', { class: 'section-title', text: '오류' }));
    for (const e of arr(rep.errors).slice(0, 20)) box.appendChild(h('p', { class: 'rr-err', text: String(e) }));
  }
  if (missing) {
    box.appendChild(h('p', { class: 'note', text: '카카오톡 서버에서 만료되어 휴대폰에 없던 사진·동영상은 복구할 수 없어요. 중요한 대화방은 백업 전에 휴대폰에서 미리 열어 사진을 받아두세요.' }));
  }
  if (notExported) {
    box.appendChild(h('p', { class: 'note', text: `'${NOT_EXPORTED}'은 대화 내보내기 파일에 들어 있지 않았던 사진·동영상이에요. 휴대폰에 남아 있다면 USB 백업으로 채울 수 있어요.` }));
  }
  return box;
}
