/** Small, local line icons: no network/font dependency or dynamic SVG input. */
const paths = {
  book: '<path d="M12 6c-3-2-6-2-9-1v14c3-1 6-1 9 1 3-2 6-2 9-1V5c-3-1-6-1-9 1Z"/><path d="M12 6v14"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  list: '<path d="M9 5h12M9 12h12M9 19h12M3 5h.01M3 12h.01M3 19h.01"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  series: '<path d="m3 7 9-4 9 4-9 4-9-4Zm0 5 9 4 9-4M3 17l9 4 9-4"/>',
  attention: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 4h.01"/>',
  settings: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="10" cy="18" r="2"/>',
  heart: '<path d="M20.5 5.5c-2-2-5-2-8.5 1-3.5-3-6.5-3-8.5-1-3 3 0 8 8.5 14 8.5-6 11.5-11 8.5-14Z"/>',
  bookmark: '<path d="M6 3h12v18l-6-4-6 4V3Z"/>',
  send: '<path d="m3 10 18-7-7 18-4-7-7-4Zm7 4L21 3"/>',
  queue: '<path d="M3 6h12M3 12h9M3 18h12M18 9v6m-3-3h6"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
  device: '<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M10 18h4"/>',
} as const;

export function libraryIcon(name: keyof typeof paths): string {
  return `<svg class="library-line-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths[name]}</svg>`;
}
