// @index waveform-webview-icons — 波形界面内联 SVG 图标（静态字符串，currentColor 着色，16×16）

const stroke = 'fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"';

function svg(body: string): string {
  return `<svg class="icon" viewBox="0 0 16 16" aria-hidden="true">${body}</svg>`;
}

export const icons = {
  sidebar: svg(`<rect x="2" y="2.5" width="12" height="11" rx="1.5" ${stroke}/><path d="M6 2.5v11" ${stroke}/>`),
  fit: svg(`<path d="M2 3v10M14 3v10M4.5 8h7M6.5 6 4.5 8l2 2M9.5 6l2 2-2 2" ${stroke}/>`),
  zoomIn: svg(`<circle cx="7" cy="7" r="4.5" ${stroke}/><path d="m10.5 10.5 3.5 3.5M5 7h4M7 5v4" ${stroke}/>`),
  zoomOut: svg(`<circle cx="7" cy="7" r="4.5" ${stroke}/><path d="m10.5 10.5 3.5 3.5M5 7h4" ${stroke}/>`),
  previousEdge: svg(`<path d="M3 3v10M13 8H6M9 5 6 8l3 3" ${stroke}/>`),
  nextEdge: svg(`<path d="M13 3v10M3 8h7M7 5l3 3-3 3" ${stroke}/>`),
  previousCycle: svg(`<path d="M1.5 11.5h3v-6h4v6h3" ${stroke}/><path d="M15 2.5 12.5 4.5 15 6.5" ${stroke}/>`),
  nextCycle: svg(`<path d="M4.5 11.5h3v-6h4v6h3" ${stroke}/><path d="M1 2.5 3.5 4.5 1 6.5" ${stroke}/>`),
  marker: svg(`<path d="M4 14V2.5M4 3h8l-2 2.5L12 8H4" ${stroke}/>`),
  reload: svg(`<path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3" ${stroke}/>`),
  help: svg(`<circle cx="8" cy="8" r="6" ${stroke}/><path d="M6.3 6.2a1.8 1.8 0 1 1 2.5 1.7c-.5.2-.8.6-.8 1.1v.4" ${stroke}/><circle cx="8" cy="11.4" r=".5" fill="currentColor"/>`),
  plus: svg(`<path d="M8 3.5v9M3.5 8h9" ${stroke}/>`),
  chevronRight: svg(`<path d="m6 4 4 4-4 4" ${stroke}/>`),
  chevronDown: svg(`<path d="m4 6 4 4 4-4" ${stroke}/>`),
  module: svg(`<rect x="2.5" y="3.5" width="11" height="9" rx="1" ${stroke}/><path d="M2.5 6.5h11" ${stroke}/>`),
  array: svg(`<path d="M5 3H3v10h2M11 3h2v10h-2M6.5 6h3M6.5 8h3M6.5 10h3" ${stroke}/>`),
  parameter: svg(`<path d="M3 5h10M5.5 5v6.5M10.5 5v5a1.5 1.5 0 0 0 2 1.4" ${stroke}/>`),
  wire: svg(`<path d="M2 11h3.5V5h5v6H14" ${stroke}/>`),
  register: svg(`<rect x="3" y="3" width="10" height="10" rx="1" ${stroke}/><path d="M3 10l2.5-2L3 6" ${stroke}/>`),
  group: svg(`<path d="M2 4.5V12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H8L6.5 3.5H3a1 1 0 0 0-1 1Z" ${stroke}/>`),
  search: svg(`<circle cx="7" cy="7" r="4.5" ${stroke}/><path d="m10.5 10.5 3.5 3.5" ${stroke}/>`),
  close: svg(`<path d="m4 4 8 8M12 4l-8 8" ${stroke}/>`),
  trace: svg(`<path d="M3 4h10M3 8h10M3 12h6" ${stroke}/>`),
  clock: svg(`<path d="M1.5 11.5h2.5v-7h4v7h4v-7h2.5" ${stroke}/>`),
  source: svg(`<path d="m6 4.5-3.5 3.5L6 11.5M10 4.5l3.5 3.5-3.5 3.5" ${stroke}/>`)
} as const;

export type IconName = keyof typeof icons;
