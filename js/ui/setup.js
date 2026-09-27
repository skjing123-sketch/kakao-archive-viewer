// setup.js — 설정/시작 (#/setup): Google Drive 설정 코드 붙여넣기, 이 Mac 서버에서 보기,
// 데모 보기, (개발용) 가짜 데이터. Shown when no data source is configured.

import { h, icon, iconButton, clear } from './dom.js';

async function exists(url) {
  try {
    const r = await fetch(url, { method: 'GET', cache: 'no-store' });
    return r.ok;
  } catch (e) { return false; }
}

/**
 * Archive base for 직접 입력: a path or URL on this page's own origin, normalised to end
 * with '/'; null for other origins or non-http(s) schemes.
 */
export function sameOriginBase(input) {
  let u;
  try { u = new URL(String(input || '').trim(), location.href); } catch (e) { return null; }
  if (u.origin !== location.origin || (u.protocol !== 'http:' && u.protocol !== 'https:')) return null;
  let path = u.pathname;
  if (!path.endsWith('/')) path += '/';
  return path;
}

/** Development host: tools/devserver.py on localhost (ports 8780/8781) or an explicit ?dev=1. */
export function isDevHost() {
  const hn = location.hostname;
  const local = hn === 'localhost' || hn === '127.0.0.1' || hn === '[::1]';
  return (local && (location.port === '8780' || location.port === '8781')) || /(^|[?&])dev=1(&|$)/.test(location.search);
}

/**
 * ctx.connect(settingsPatch) saves settings and loads the archive; resolves or throws.
 * opts.notice: optional message (e.g. auth expired).
 */
export function createSetup(ctx, opts = {}) {
  const el = h('div', { class: 'screen screen-setup' });
  const hero = h('div', { class: 'setup-hero' },
    h('img', { class: 'setup-logo', src: './icons/icon-192.png', alt: '', width: 72, height: 72 }),
    h('h1', { class: 'setup-title', text: '카톡 보관함' }),
    h('p', { class: 'setup-lead', text: '카카오톡 사진·동영상과 대화를 날짜별로 모아 보는 나만의 보관함이에요.' }));
  const notice = h('div', { class: 'notice', role: 'alert', hidden: true });
  const cards = h('div', { class: 'setup-cards' });
  el.append(hero, notice, cards);
  if (ctx.archive) {
    // Opened from a connected app (read-only banner → 설정 코드 다시 넣기): a way back.
    el.prepend(h('header', { class: 'appbar' }, iconButton('back', '돌아가기', () => ctx.router.back('/')),
      h('h1', { class: 'appbar-title small', text: '다시 연결' })));
  }

  const setNotice = (msg, kind = 'warn') => {
    notice.hidden = !msg;
    notice.className = 'notice notice-' + kind;
    clear(notice);
    if (msg) notice.append(icon(kind === 'error' ? 'alert' : 'info', 18), h('span', { text: msg }));
  };
  if (opts.notice) setNotice(opts.notice, 'error');

  async function run(btn, patch, errEl) {
    const label = btn.textContent;
    btn.disabled = true;
    btn.classList.add('busy');
    btn.textContent = '연결하는 중…';
    if (errEl) errEl.textContent = '';
    try {
      await ctx.connect(patch);
    } catch (err) {
      const msg = (err && (err.userMessage || err.message)) || String(err);
      if (errEl) errEl.textContent = msg; else setNotice(msg, 'error');
    } finally {
      btn.disabled = false;
      btn.classList.remove('busy');
      btn.textContent = label;
    }
  }

  // 0. 이 Mac 서버에서 보기 (auto-detected; shown first when the Mac serves this page) ----
  const macSlot = h('div');
  cards.appendChild(macSlot);

  // 1. Google Drive 설정 코드 ---------------------------------------------------
  const code = h('textarea', {
    class: 'input code-input', rows: 3, placeholder: 'KB1.로 시작하는 설정 코드', 'aria-label': '설정 코드',
    autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off', spellcheck: 'false',
  });
  const codeErr = h('p', { class: 'form-error', role: 'alert' });
  const ok = h('button', { type: 'submit', class: 'btn btn-primary', text: '확인' });
  const paste = h('button', {
    type: 'button', class: 'btn btn-ghost', hidden: !(navigator.clipboard && navigator.clipboard.readText),
    onclick: async () => {
      try { code.value = (await navigator.clipboard.readText()).trim(); code.dispatchEvent(new Event('input')); } catch (e) { codeErr.textContent = '클립보드를 읽을 수 없어요. 입력칸을 길게 눌러 붙여넣어 주세요.'; }
    },
  }, icon('paste', 18), '붙여넣기');
  const form = h('form', { class: 'code-form' }, code, codeErr, h('div', { class: 'btn-row' }, paste, ok));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const v = code.value.replace(/\s+/g, '');
    if (!v) { codeErr.textContent = '설정 코드를 붙여넣어 주세요.'; return; }
    let setup;
    try {
      setup = await ctx.parseSetupCode(v);
    } catch (err) {
      codeErr.textContent = (err && err.message) || '설정 코드가 올바르지 않습니다';
      return;
    }
    await run(ok, { mode: 'drive', setup, httpBase: null }, codeErr);
  });
  code.addEventListener('input', () => { codeErr.textContent = ''; });
  cards.appendChild(h('section', { class: 'card setup-card' },
    h('h2', { class: 'card-title' }, icon('cloud', 20), h('span', { text: 'Google Drive 설정 코드 붙여넣기' })),
    h('p', { class: 'note', text: 'Mac의 카톡 보관함 프로그램에서 ⑤ 휴대폰에서 보기 → "설정 코드 복사"를 누른 뒤, 이 칸에 붙여넣으세요. (같은 Apple 계정이면 Mac에서 복사한 내용을 아이폰에서 바로 붙여넣을 수 있어요.)' }),
    form,
    h('p', { class: 'note small', text: '설정 코드는 이 기기에만 저장되며 Google Drive에서 이 보관함 파일을 읽는 데만 쓰여요. 다른 사람에게 보내지 마세요.' })));

  // 2. 데모 --------------------------------------------------------------------
  const demoSlot = h('div');
  cards.appendChild(demoSlot);

  (async () => {
    let local = null;
    try { local = await ctx.detectLocalConfig(); } catch (e) { local = null; }
    if (local && local.base) {
      const btn = h('button', { type: 'button', class: 'btn btn-primary btn-block', text: '이 Mac 서버에서 보기' });
      const err = h('p', { class: 'form-error', role: 'alert' });
      btn.addEventListener('click', () => run(btn, { mode: 'http', setup: null, httpBase: local.base }, err));
      macSlot.appendChild(h('section', { class: 'card setup-card highlight' },
        h('h2', { class: 'card-title' }, icon('laptop', 20), h('span', { text: '이 Mac 서버에서 보기' })),
        h('p', { class: 'note', text: '지금 Mac의 카톡 보관함 프로그램에 연결되어 있어요. 같은 Wi‑Fi에서 NAS·Mac에 있는 보관함을 바로 볼 수 있어요.' }),
        btn, err));
    }
    // The Mac server never ships a demo: skip the probe there (it only logs a 404).
    if (!(local && local.base) && await exists('./demo/catalog.json')) {
      const btn = h('button', { type: 'button', class: 'btn btn-block', text: '데모 보기' });
      const err = h('p', { class: 'form-error', role: 'alert' });
      btn.addEventListener('click', () => run(btn, { mode: 'demo', setup: null, httpBase: './demo/' }, err));
      demoSlot.appendChild(h('section', { class: 'card setup-card' },
        h('h2', { class: 'card-title' }, icon('sparkle', 20), h('span', { text: '데모 보기' })),
        h('p', { class: 'note', text: '예시 보관함으로 화면을 둘러볼 수 있어요.' }), btn, err));
    }
    if (isDevHost()) {
      const btn = h('button', { type: 'button', class: 'btn btn-ghost btn-block', text: '데모(개발용) — 가짜 데이터' });
      btn.addEventListener('click', () => ctx.connectFake());
      demoSlot.appendChild(h('section', { class: 'card setup-card dev' },
        h('h2', { class: 'card-title' }, icon('sparkle', 20), h('span', { text: '개발용' })),
        h('p', { class: 'note', text: '브라우저에서 만든 가짜 데이터로 화면만 확인해요 (개발 서버 전용).' }), btn));
    }
  })();

  // 3. 직접 주소 입력 (advanced) -----------------------------------------------------
  // Same origin only: the page's Content-Security-Policy (connect-src/img-src 'self')
  // blocks archives on other hosts, so say it up front instead of failing later.
  const urlIn = h('input', { type: 'text', inputmode: 'url', class: 'input', placeholder: '/archive/nas/', 'aria-label': '보관함 주소', autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false' });
  const urlErr = h('p', { class: 'form-error', role: 'alert' });
  const urlBtn = h('button', { type: 'submit', class: 'btn', text: '연결' });
  const urlForm = h('form', { class: 'code-form' }, urlIn, urlErr, h('div', { class: 'btn-row' }, urlBtn));
  urlForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    let base = urlIn.value.trim();
    if (!base) { urlErr.textContent = '보관함 주소를 입력해 주세요.'; return; }
    const same = sameOriginBase(base);
    if (!same) { urlErr.textContent = `이 뷰어와 같은 서버(${location.host})의 주소만 열 수 있어요. 예: /archive/nas/`; return; }
    base = same;
    run(urlBtn, { mode: 'http', setup: null, httpBase: base }, urlErr);
  });
  cards.appendChild(h('details', { class: 'card setup-card advanced' },
    h('summary', { class: 'card-title' }, icon('server', 20), h('span', { text: '보관함 주소 직접 입력' }), icon('chevronDown', 16, 'sum-chev')),
    h('p', { class: 'note', text: 'Mac 프로그램의 "serve" 기능처럼 이 뷰어와 같은 서버가 보관함 폴더(catalog.json이 있는 폴더)를 함께 열어둔 경우 그 경로를 입력하세요. 예: /archive/nas/' }),
    urlForm));

  cards.appendChild(h('p', { class: 'setup-foot', text: '카카오톡 서버에는 접속하지 않아요. 대화와 사진은 내 Google Drive·NAS에만 보관돼요.' }));

  return {
    el, title: '시작하기',
    show(route) { if (route && route.notice) setNotice(route.notice, 'error'); },
    hide() {},
    destroy() {},
    setNotice,
  };
}
