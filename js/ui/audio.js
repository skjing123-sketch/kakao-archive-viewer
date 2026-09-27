// audio.js — compact voice-message player backed by one shared <audio> element.
//
// Only one clip plays at a time (like KakaoTalk). Each player widget shows play/pause,
// a seek bar and the time; the <audio> element itself is inline in the page so iOS
// treats it as regular inline media.

import { h, icon, toast } from './dom.js';
import { duration } from './format.js';

let shared = null;
let owner = null;       // widget currently bound to the shared element

function audioEl() {
  if (!shared) {
    shared = h('audio', { preload: 'none', class: 'shared-audio' });
    shared.setAttribute('playsinline', '');
    document.body.appendChild(shared);
    shared.addEventListener('timeupdate', () => owner && owner._tick());
    shared.addEventListener('durationchange', () => owner && owner._tick());
    shared.addEventListener('play', () => owner && owner._state(true));
    shared.addEventListener('pause', () => owner && owner._state(false));
    shared.addEventListener('ended', () => { if (owner) { owner._state(false); owner._tick(true); } });
    shared.addEventListener('waiting', () => owner && owner.el.classList.add('buffering'));
    shared.addEventListener('playing', () => owner && owner.el.classList.remove('buffering'));
    shared.addEventListener('error', () => {
      if (!owner) return;
      owner.el.classList.remove('buffering');
      owner._state(false);
      toast('음성 파일을 재생할 수 없어요.', { kind: 'error' });
    });
  }
  return shared;
}

/** Stop whatever is playing (e.g. when the media viewer opens). */
export function stopAudio() {
  if (shared && !shared.paused) shared.pause();
}

/**
 * Create a player widget. `getURL()` returns the media URL (or null when unavailable).
 * opts: {duration, compact}
 */
export function audioPlayer(getURL, opts = {}) {
  const btn = h('button', { type: 'button', class: 'ap-btn', 'aria-label': '재생' }, icon('play', 18));
  const seek = h('input', { type: 'range', class: 'ap-seek', min: '0', max: '1000', value: '0', step: '1', 'aria-label': '재생 위치' });
  const time = h('span', { class: 'ap-time', text: opts.duration ? duration(opts.duration) : '0:00' });
  const el = h('div', { class: 'aplayer' + (opts.compact ? ' compact' : '') }, btn, seek, time);
  const w = {
    el,
    _state(playing) {
      el.classList.toggle('playing', playing);
      btn.setAttribute('aria-label', playing ? '일시정지' : '재생');
      btn.replaceChildren(icon(playing ? 'pause' : 'play', 18));
    },
    _tick(reset = false) {
      const a = audioEl();
      const d = isFinite(a.duration) && a.duration > 0 ? a.duration : (opts.duration || 0);
      const cur = reset ? 0 : a.currentTime;
      seek.value = d ? String(Math.round((cur / d) * 1000)) : '0';
      seek.style.setProperty('--p', `${d ? Math.min(100, (cur / d) * 100) : 0}%`);
      time.textContent = playingOrStarted() ? duration(cur) + (d ? ' / ' + duration(d) : '') : (d ? duration(d) : '0:00');
    },
  };
  const playingOrStarted = () => owner === w && audioEl().currentTime > 0;
  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const a = audioEl();
    if (owner === w) {
      if (a.paused) a.play().catch(() => {}); else a.pause();
      return;
    }
    if (owner) { owner._state(false); owner._tick(true); }
    owner = w;
    el.classList.add('buffering');
    const start = (url) => {
      if (owner !== w) return;
      if (!url) {
        el.classList.remove('buffering');
        owner = null;
        toast('이 음성 파일은 이 저장소에 원본이 없어요.', { kind: 'error' });
        return;
      }
      a.src = url;
      a.play().catch((err) => {
        console.warn('[audio] play failed', err);
        el.classList.remove('buffering');
        w._state(false);
      });
    };
    const src = getURL();
    if (src && typeof src.then === 'function') src.then(start); else start(src);   // sync: keeps the tap's user activation
  });
  seek.addEventListener('input', (ev) => {
    ev.stopPropagation();
    if (owner !== w) return;
    const a = audioEl();
    if (isFinite(a.duration) && a.duration > 0) a.currentTime = (Number(seek.value) / 1000) * a.duration;
  });
  seek.addEventListener('click', (ev) => ev.stopPropagation());
  return el;
}
