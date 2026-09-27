// icons.js — inline SVG icon set (24×24, stroke = currentColor). Static, trusted markup only.

const P = {
  photo: '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="8.5" cy="9.5" r="1.8"/><path d="M21 16l-5.2-5.2a1.5 1.5 0 0 0-2.1 0L5 19.5"/>',
  chats: '<path d="M4 15.5V6.8C4 5.3 5.3 4 6.8 4h8.4C16.7 4 18 5.3 18 6.8v5.4c0 1.5-1.3 2.8-2.8 2.8H8.5L4 18.5z"/><path d="M8 18.2c.5 1 1.6 1.8 2.9 1.8h5.6l3.5 2.5V12.4c0-1-.5-1.8-1.3-2.3"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.3-4.3"/>',
  star: '<path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/>',
  starFill: '<path fill="currentColor" d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/>',
  more: '<circle cx="5.5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="18.5" cy="12" r="1.3" fill="currentColor"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  forward: '<path d="M9 5l7 7-7 7"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  filter: '<path d="M4 6h16M7 12h10M10 18h4"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
  chevronUp: '<path d="M6 15l6-6 6 6"/>',
  chevronRight: '<path d="M9 6l6 6-6 6"/>',
  share: '<path d="M12 3.5v11M8 7.5l4-4 4 4"/><path d="M6.5 11H6a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-.5"/>',
  download: '<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5"/><path d="M5 19.5h14"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5"/><circle cx="12" cy="7.8" r=".9" fill="currentColor"/>',
  play: '<path fill="currentColor" stroke="none" d="M8 5.6v12.8c0 .8.9 1.3 1.6.8l10-6.4a1 1 0 0 0 0-1.6l-10-6.4c-.7-.5-1.6 0-1.6.8z"/>',
  pause: '<path fill="currentColor" stroke="none" d="M7 5h3.2v14H7zM13.8 5H17v14h-3.2z"/>',
  video: '<rect x="3" y="6" width="13" height="12" rx="2.5"/><path d="M16 10.5l5-3v9l-5-3"/>',
  file: '<path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z"/><path d="M14 3.5V8h4.5"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.2 1.2"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.2-1.2"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
  wave: '<path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2"/>',
  users: '<circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19c.6-3 2.8-4.8 5.5-4.8s4.9 1.8 5.5 4.8"/><path d="M15.5 5.6a3.2 3.2 0 0 1 0 5.9M17.2 14.4c1.8.5 3 2.1 3.3 4.6"/>',
  user: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c.7-3.6 3.5-5.6 7-5.6s6.3 2 7 5.6"/>',
  me: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="10" r="2.8"/><path d="M7 17.7c1.2-1.8 2.9-2.7 5-2.7s3.8.9 5 2.7"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.5 3.5 5.3 3.5 8.5s-1.1 6-3.5 8.5c-2.4-2.5-3.5-5.3-3.5-8.5s1.1-6 3.5-8.5z"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4h-4"/>',
  trash: '<path d="M4.5 7h15M10 11v6M14 11v6"/><path d="M6.5 7l.8 11.2a2 2 0 0 0 2 1.8h5.4a2 2 0 0 0 2-1.8L17.5 7M9.5 7V4.5h5V7"/>',
  cloud: '<path d="M7 18.5h10.5a4 4 0 0 0 .6-8 6 6 0 0 0-11.5 1.3A3.4 3.4 0 0 0 7 18.5z"/>',
  server: '<rect x="4" y="4" width="16" height="7" rx="2"/><rect x="4" y="13" width="16" height="7" rx="2"/><path d="M8 7.5h.01M8 16.5h.01"/>',
  laptop: '<rect x="5" y="5" width="14" height="10" rx="1.5"/><path d="M3 18.5h18"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6L6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4"/>',
  moon: '<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  list: '<path d="M9 6.5h11M9 12h11M9 17.5h11"/><circle cx="4.8" cy="6.5" r=".9" fill="currentColor"/><circle cx="4.8" cy="12" r=".9" fill="currentColor"/><circle cx="4.8" cy="17.5" r=".9" fill="currentColor"/>',
  sort: '<path d="M7 4v16M3.5 16.5L7 20l3.5-3.5M17 20V4M13.5 7.5L17 4l3.5 3.5"/>',
  external: '<path d="M14 4h6v6M20 4l-8.5 8.5"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5"/>',
  chatJump: '<path d="M4 17.5V7a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v6.5a3 3 0 0 1-3 3H8.5z"/><path d="M8.5 9h7M8.5 12.5h4.5"/>',
  alert: '<path d="M12 4l9 15.5H3z"/><path d="M12 10v4.2"/><circle cx="12" cy="16.8" r=".9" fill="currentColor"/>',
  imageOff: '<path d="M4 4l16 16"/><path d="M20.5 16.5V7a3 3 0 0 0-3-3H8M3.5 7v10a3 3 0 0 0 3 3H17"/><path d="M3.5 17l5-5 2.5 2.5"/>',
  wifiOff: '<path d="M4 4l16 16"/><path d="M8.5 12.6a5.5 5.5 0 0 1 3.5-1.1M5.5 9.6a9.8 9.8 0 0 1 3-1.8M18.5 9.6a9.8 9.8 0 0 0-4.6-2.3M10.2 15.6a2.6 2.6 0 0 1 3.6 0"/><circle cx="12" cy="18.6" r=".9" fill="currentColor"/>',
  exit: '<path d="M14 4h3.5a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H14"/><path d="M10 8l-4 4 4 4M6 12h9"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  phone: '<path d="M6.5 4h2.8l1.4 4-2 1.3a10 10 0 0 0 6 6l1.3-2 4 1.4v2.8a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.5 6.2 2 2 0 0 1 6.5 4z"/>',
  pin: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  contact: '<rect x="4" y="3.5" width="16" height="17" rx="2.5"/><circle cx="12" cy="10" r="2.6"/><path d="M8 16.5c.7-1.6 2.2-2.4 4-2.4s3.3.8 4 2.4"/>',
  smile: '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 14c.9 1.3 2 2 3.5 2s2.6-.7 3.5-2"/><circle cx="9" cy="10" r=".9" fill="currentColor"/><circle cx="15" cy="10" r=".9" fill="currentColor"/>',
  reply: '<path d="M9.5 7L4.5 12l5 5"/><path d="M4.5 12h9a6 6 0 0 1 6 6v1"/>',
  zoomIn: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.3-4.3M11 8.5v5M8.5 11h5"/>',
  lowres: '<rect x="3.5" y="3.5" width="17" height="17" rx="2.5"/><path d="M3.5 12h17M12 3.5v17"/>',
  box: '<path d="M4 8.5l8-4.5 8 4.5v7l-8 4.5-8-4.5z"/><path d="M4 8.5l8 4.5 8-4.5M12 13v7"/>',
  key: '<circle cx="8" cy="15" r="3.5"/><path d="M10.5 12.5L19 4M16 7l2.5 2.5M14 9l2 2"/>',
  paste: '<rect x="6" y="5" width="12" height="15.5" rx="2"/><path d="M9.5 5V4a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1"/><path d="M9 11h6M9 14.5h4"/>',
  sparkle: '<path d="M12 3.5l1.8 5.2 5.2 1.8-5.2 1.8L12 17.5l-1.8-5.2L5 10.5l5.2-1.8z"/><path d="M18.5 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>',
  gif: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10 10.2a2 2 0 1 0 0 3.6v-1.6H9M13 9.8v4.4M16 14.2V9.8h2.2M16 12h1.8"/>',
};

/** SVG markup for an icon name. Unknown names render an empty icon (never throw). */
export function svg(name, size = 24) {
  // Only names of the static table reach the markup (this string goes through innerHTML).
  const known = typeof name === 'string' && Object.prototype.hasOwnProperty.call(P, name);
  const body = known ? P[name] : '';
  name = known ? name : 'none';
  size = Number(size) > 0 ? Number(size) : 24;
  return `<svg class="ic ic-${name}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}

export const ICON_NAMES = Object.keys(P);
